import axios from "axios";
import pLimit from "p-limit";
import { env } from "@/lib/env";
import { getAppAccessToken } from "@/lib/ebay/auth";
import { createCache } from "@/lib/cache";

/**
 * ウォッチ数取得機能の設定
 * 
 * 環境変数で制御可能：
 * - WATCHCOUNT_MODE: 取得モード
 *   - "html_first" (デフォルト): HTML抽出を優先、その後他の方法で補完
 *   - "watchcount_only": watchcount.comのみ使用
 *   - "watchcount_first": watchcount.comを優先、その後Shopping API
 *   - "auto": 自動選択
 * 
 * 対応するウォッチ数パターン：
 * - 「8がこの商品をウォッチリストに追加しました。」
 * - 「3がこの商品をウォッチリストに追加しました。」
 * - 「44人がこの商品をウォッチ中です。」
 * - 「58人がこの商品をウォッチ中です。」
 * - 「この商品を1人の人がウォッチ中です。」
 * - 「3がこの商品をウォッチリストに追加しました。」（数字が先）
 * - 英語パターン: "X people are watching", "X watchers" など
 * 
 * ソート: ウォッチ数が多い順（デフォルト）
 */

// WatchCountのキャッシュ（同一IDへの再問い合わせを削減）
const watchCountCache = createCache<number>({ max: 5000, ttlMs: 6 * 60 * 60 * 1000 }); // 6時間

// Shopping API が IP 制限に到達した場合のクールダウン
let shoppingApiBlockedUntil = 0;
function isShoppingBlocked() {
  return Date.now() < shoppingApiBlockedUntil;
}
function blockShoppingFor(ms: number) {
  shoppingApiBlockedUntil = Date.now() + ms;
}

const BASE = env.EBAY_ENV === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
const MARKETPLACE = env.EBAY_MARKETPLACE || env.EBAY_MARKETPLACE_ID;

export type SampleItem = {
  itemId?: string;
  title?: string;
  price?: { value?: string; currency?: string };
  itemWebUrl?: string;
  seller?: { username?: string };
  itemCreationDate?: string;
  watchCount?: number; // Browse APIでは通常返らないため null になる想定
};

// モックデータ生成関数
function generateMockData(sellers: string[], maxPerSeller: number): SampleItem[] {
  const mockItems: SampleItem[] = [];
  
  sellers.forEach((seller, sellerIndex) => {
    for (let i = 0; i < Math.min(maxPerSeller, 5); i++) {
      const itemId = `mock_${sellerIndex}_${i}`;
      mockItems.push({
        itemId,
        title: `[モック] ${seller}の商品 ${i + 1} - Pokemon Card Set`,
        price: {
          value: String(Math.floor(Math.random() * 1000) + 10),
          currency: "USD"
        },
        itemWebUrl: `https://www.ebay.com/itm/${itemId}`,
        seller: { username: seller },
        itemCreationDate: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString(),
        watchCount: Math.floor(Math.random() * 50) + 1
      });
    }
  });
  
  return mockItems;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getAppToken() {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
    console.log("⚠️ eBay API認証情報が設定されていません。モックデータを使用します。");
    return "mock_token";
  }

  // キャッシュ有効なら再利用
  if (cachedToken && Date.now() < cachedToken.expiresAt - 30_000) {
    return cachedToken.token;
  }

  const form = (scope: string) => new URLSearchParams({ grant_type: "client_credentials", scope });
  const cfg = {
    auth: { username: env.EBAY_CLIENT_ID, password: env.EBAY_CLIENT_SECRET },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20000,
    validateStatus: () => true,
  } as const;

  async function requestWithRetry(scope: string): Promise<{ ok: boolean; token?: string; invalidScope?: boolean }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await axios.post(`${BASE}/identity/v1/oauth2/token`, form(scope), cfg);
        if (res.status >= 200 && res.status < 300 && res.data?.access_token) {
          const token = res.data.access_token as string;
          const expiresIn = Number(res.data?.expires_in ?? 3600);
          cachedToken = { token, expiresAt: Date.now() + expiresIn * 1000 };
          return { ok: true, token };
        }
        const err = (res.data as { error?: string } | undefined)?.error;
        if (err === "invalid_scope") return { ok: false, invalidScope: true };
        // 一時的なネットワーク/5xxはリトライ
        if (res.status >= 500 || res.status === 429) {
          await sleep(800 * (attempt + 1));
          continue;
        }
        return { ok: false };
      } catch (e) {
        // ネットワーク到達不可などはリトライ
        await sleep(800 * (attempt + 1));
        continue;
      }
    }
    return { ok: false };
  }

  // buy.browse → 失敗か invalid_scope なら base scope
  const r1 = await requestWithRetry("https://api.ebay.com/oauth/api_scope/buy.browse");
  if (r1.ok && r1.token) return r1.token;
  const r2 = await requestWithRetry("https://api.ebay.com/oauth/api_scope");
  if (r2.ok && r2.token) return r2.token;
  console.warn("⚠️ eBay token取得に失敗しました。モックモードにフォールバックします（ローカル開発継続のため）");
  return "mock_token";
}

async function fetchSellerListings(token: string, seller: string, maxPerSeller: number): Promise<SampleItem[]> {
  // モックトークンの場合はモックデータを返す
  if (token === "mock_token") {
    return generateMockData([seller], maxPerSeller);
  }

  const PAGE_LIMIT = 200;
  // eBay Browse filter grammar: sellers:{seller1|seller2}
  // 文字列の引用は不要。axios 側でURLエンコードされるため、そのまま値を使用する。
  const baseFilter = `sellers:{${seller}}`;

  async function searchOnce(params: { offset: number; limit: number; price?: [number, number]; useLocation?: boolean; nextUrl?: string }) {
    const { offset, limit, price, useLocation, nextUrl } = params;
    const headers = { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE } as const;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (nextUrl) {
          return await axios.get(nextUrl, { headers, timeout: 30000, validateStatus: () => true, maxRedirects: 5 });
        }
    const filterParts = [baseFilter];
    if (useLocation && env.EBAY_ITEM_LOCATION_COUNTRY) {
      filterParts.push(`itemLocationCountry:${env.EBAY_ITEM_LOCATION_COUNTRY}`);
    }
    if (price) filterParts.push(`price:[${price[0]}..${price[1]}]`);
    const filter = filterParts.join(",");
        return await axios.get(`${BASE}/buy/browse/v1/item_summary/search`, {
      params: { q: "*", filter, limit, offset },
          headers,
      timeout: 30000,
          validateStatus: () => true,
          maxRedirects: 5,
        });
      } catch {
        await sleep(600 * (attempt + 1));
        continue;
      }
    }
    // 最終的に到達不可の場合は投げる
    throw new Error("network unreachable while calling Browse API");
  }

  async function tryLinear(): Promise<SampleItem[]> {
    const acc: SampleItem[] = [];
    let offset = 0;
    let nextUrl: string | undefined;
    while (acc.length < maxPerSeller) {
      const limit = Math.min(PAGE_LIMIT, maxPerSeller - acc.length);
      try {
        const res = await searchOnce({ offset, limit, useLocation: true, nextUrl });
        const items: SampleItem[] = res.data.itemSummaries || [];
        acc.push(...items);
        offset += items.length;
        nextUrl = typeof res.data?.next === "string" ? res.data.next : undefined;
        // total は不正確な場合があるため、items が 0 の時のみ終了
        if (items.length === 0 && !nextUrl) break;
      } catch (e: unknown) {
        type ErrorResponse = { errors?: Array<{ errorId?: number }> };
        const ax = e as { response?: { status?: number; data?: unknown } };
        const id = (ax.response?.data as ErrorResponse | undefined)?.errors?.[0]?.errorId;
        if (ax.response?.status === 400 && id === 12023) {
          throw e; // escalate to banded search
        }
        throw e;
      }
    }
    return acc;
  }

  async function tryPriceBands(): Promise<SampleItem[]> {
    const bands: [number, number][] = [
      [0, 20],
      [20, 50],
      [50, 100],
      [100, 200],
      [200, 500],
      [500, 1000],
      [1000, 5000],
      [5000, 1000000],
    ];
    const acc: SampleItem[] = [];
    for (const band of bands) {
      if (acc.length >= maxPerSeller) break;
      let offset = 0;
      let nextUrl: string | undefined;
      while (acc.length < maxPerSeller) {
        const limit = Math.min(PAGE_LIMIT, maxPerSeller - acc.length);
        try {
          const res = await searchOnce({ offset, limit, price: band, useLocation: true, nextUrl });
          const items: SampleItem[] = res.data.itemSummaries || [];
          acc.push(...items);
          offset += items.length;
          nextUrl = typeof res.data?.next === "string" ? res.data.next : undefined;
          if (items.length === 0 && !nextUrl) break;
        } catch (e: unknown) {
          type ErrorResponse = { errors?: Array<{ errorId?: number }> };
          const ax = e as { response?: { status?: number; data?: unknown } };
          const id = (ax.response?.data as ErrorResponse | undefined)?.errors?.[0]?.errorId;
          // if still too large, skip to next band
          if (ax.response?.status === 400 && id === 12023) break;
          throw e;
        }
      }
    }
    return acc;
  }

  try {
    // まずは（必要なら）ロケーションフィルタを適用して取得
    const first = await tryLinear();
    if (first.length >= maxPerSeller) return first.slice(0, maxPerSeller);

    // 件数が不足している場合は、ロケーションフィルタ無しで追加取得して補完
    const dedup = new Map<string, SampleItem>();
    for (const it of first) if (it.itemId) dedup.set(it.itemId, it);
    let offset = 0;
    let nextUrl: string | undefined;
    while (dedup.size < maxPerSeller) {
      const limit = Math.min(PAGE_LIMIT, maxPerSeller - dedup.size);
      const res = await searchOnce({ offset, limit, useLocation: false, nextUrl });
      const items: SampleItem[] = res.data.itemSummaries || [];
      for (const it of items) if (it.itemId && !dedup.has(it.itemId)) dedup.set(it.itemId, it);
      offset += items.length;
      nextUrl = typeof res.data?.next === "string" ? res.data.next : undefined;
      if (items.length === 0 && !nextUrl) break;
    }
    let merged = Array.from(dedup.values());
    if (merged.length < maxPerSeller) {
      // Web検索で追加のレガシーIDを取得して補完
      const needMore = maxPerSeller - merged.length;
      const extra = await fallbackSearchByWeb(token, seller, needMore * 2); // 少し多めに取得
      for (const it of extra) {
        if (it.itemId && !dedup.has(it.itemId)) dedup.set(it.itemId, it);
        if (dedup.size >= maxPerSeller) break;
      }
      merged = Array.from(dedup.values());
    }
    if (merged.length > 0) return merged.slice(0, maxPerSeller);

    // Browse APIが0件を返した場合でも、最終手段としてWebフォールバックを試す
    const webRowsZero = await fallbackSearchByWeb(token, seller, maxPerSeller);
    return webRowsZero;
  } catch (e: unknown) {
    // ネットワーク到達不可などでBrowseが失敗した場合も継続
    console.warn("Browse API failure, fallback to banded/web:", e instanceof Error ? e.message : String(e));
    const banded = await tryPriceBands();
    if (banded.length > 0) return banded;
    // APIから取れない場合はWeb検索フォールバック
    const webRows = await fallbackSearchByWeb(token, seller, maxPerSeller);
    return webRows;
  }
}

export type NormalizedRow = {
  itemId: string | null;
  title: string | null;
  priceValue: string | null; // 未使用
  priceCurrency: string | null; // 未使用
  url: string | null;
  seller: string | null; // 未使用
  itemCreationDate: string | null; // 未使用
  watchCount: number | null;
};

function normalize(items: SampleItem[]): NormalizedRow[] {
  return items.map((it) => ({
    itemId: it.itemId ?? null,
    title: it.title ?? null,
    priceValue: it.price?.value ?? null,
    priceCurrency: it.price?.currency ?? null,
    url: it.itemWebUrl ?? null,
    seller: it.seller?.username ?? null,
    itemCreationDate: it.itemCreationDate ?? null,
    watchCount: typeof it.watchCount === "number" ? it.watchCount : null,
  }));
}

function sortForDisplay(rows: NormalizedRow[]): NormalizedRow[] {
  const hasWatch = rows.some((r) => typeof r.watchCount === "number");
  if (hasWatch) {
    // ウォッチ数が多い順にソート（デフォルト）
    return [...rows].sort((a, b) => (b.watchCount ?? -1) - (a.watchCount ?? -1));
  }
  // ウォッチ数がない場合は日付順（新しい順）
  return [...rows].sort((a, b) => {
    const bd = b.itemCreationDate ? Date.parse(b.itemCreationDate) : 0;
    const ad = a.itemCreationDate ? Date.parse(a.itemCreationDate) : 0;
    if (bd !== ad) return bd - ad;
    const ap = Number(a.priceValue ?? Infinity);
    const bp = Number(b.priceValue ?? Infinity);
    return ap - bp;
  });
}

export async function searchBySellersAxios(
  sellers: string[],
  maxPerSeller: number
): Promise<NormalizedRow[]> {
  const token = await getAppToken();
  const results: SampleItem[] = [];
  
  // モックトークンの場合は一括でモックデータを生成
  if (token === "mock_token") {
    const mock = generateMockData(sellers, maxPerSeller);
    const normalizedMock = normalize(mock);
    const enrichedMock = await enrichWatchCounts(normalizedMock);
    return sortForDisplay(enrichedMock);
  }
  
  for (const s of sellers) {
    try {
      const items = await fetchSellerListings(token, s, maxPerSeller);
      results.push(...items);
    } catch {
      // ログのみ残して次のセラーへ
      continue;
    }
  }
  const flat = results;
  const normalized = normalize(flat);
  console.log(`[debug] About to call enrichWatchCounts for ${normalized.length} items`);
  const enriched = await enrichWatchCounts(normalized);
  const finalFound = enriched.filter(r => typeof r.watchCount === "number").length;
  const finalSuccessRate = ((finalFound / enriched.length) * 100).toFixed(1);
  console.log(`[debug] enrichWatchCounts completed. Found ${finalFound}/${enriched.length} watch counts (${finalSuccessRate}% success rate)`);
  return sortForDisplay(enriched);
}

function extractLegacyId(row: NormalizedRow): string | null {
  // from URL
  if (row.url) {
    const m1 = row.url.match(/\/itm\/([0-9]{6,})(?:[\/?]|$)/);
    if (m1 && m1[1]) return m1[1];
    const m2 = row.url.match(/(?:\?|&)item=([0-9]{6,})/);
    if (m2 && m2[1]) return m2[1];
  }
  // from itemId like v1|123456789012|0
  if (row.itemId) {
    const parts = row.itemId.split("|");
    if (parts.length >= 2 && /^[0-9]{6,}$/.test(parts[1])) return parts[1];
  }
  return null;
}

function siteIdFromMarketplace(marketplace: string | undefined): number {
  const map: Record<string, number> = {
    EBAY_US: 0,
    EBAY_GB: 3,
    EBAY_AU: 15,
    EBAY_DE: 77,
    EBAY_FR: 71,
    EBAY_IT: 101,
    EBAY_CA: 2,
    EBAY_ES: 186,
    EBAY_HK: 201,
    EBAY_SG: 216,
    EBAY_NL: 146,
  };
  return map[marketplace ?? "EBAY_US"] ?? 0;
}

async function fetchWatchCountShopping(legacyId: string): Promise<number | null> {
  // キャッシュヒット
  const cached = watchCountCache.get(`wc:${legacyId}`);
  if (typeof cached === "number") return cached;

  if (isShoppingBlocked()) return null;
  if (!env.EBAY_CLIENT_ID) return null;
  const siteId = siteIdFromMarketplace(env.EBAY_MARKETPLACE_ID || env.EBAY_MARKETPLACE || "EBAY_US");
  try {
    let iafToken: string | null = null;
    try {
      iafToken = await getAppAccessToken();
    } catch {
      iafToken = null;
    }
    const res = await axios.get("https://open.api.ebay.com/shopping", {
      params: {
        callname: "GetSingleItem",
        responseencoding: "JSON",
        appid: env.EBAY_CLIENT_ID,
        siteid: String(siteId),
        version: "967",
        ItemID: legacyId,
        IncludeSelector: "Details,ItemSpecifics,Variations",
      },
      timeout: 12000,
      headers: iafToken
        ? { "Accept-Language": "en-US,en;q=0.8,ja;q=0.7", "X-EBAY-API-IAF-TOKEN": iafToken }
        : { "Accept-Language": "en-US,en;q=0.8,ja;q=0.7" },
    });
    const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    if (/IP limit exceeded/i.test(text)) {
      blockShoppingFor(30 * 60 * 1000); // 30分ブロック
      if (process.env.NODE_ENV !== "production") {
        console.warn("[debug] Shopping API IP limit exceeded (single)", { legacyId, siteId });
      }
      return null;
    }
    const m = text.match(/"WatchCount"\s*:\s*(\d+)/);
      if (m && m[1]) {
      const n = parseInt(m[1], 10);
        if (!Number.isNaN(n)) return n;
      }
    if (process.env.NODE_ENV !== "production") {
      try {
        console.warn("[debug] GetSingleItem missing WatchCount", { legacyId, siteId, snippet: text.slice(0, 400) });
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchWatchCountsShoppingBatch(legacyIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (legacyIds.length === 0) return map;
  // キャッシュで事前に埋められるものは除外
  const pending = legacyIds.filter((id) => watchCountCache.get(`wc:${id}`) === undefined);
  for (const id of legacyIds) {
    const v = watchCountCache.get(`wc:${id}`);
    if (typeof v === "number") map.set(id, v);
  }
  if (pending.length === 0) return map;
  if (isShoppingBlocked()) return map;
  if (!env.EBAY_CLIENT_ID) return map;
  const siteId = siteIdFromMarketplace(env.EBAY_MARKETPLACE_ID || env.EBAY_MARKETPLACE || "EBAY_US");
  try {
    let iafToken: string | null = null;
    try {
      iafToken = await getAppAccessToken();
    } catch {
      iafToken = null;
    }
    const res = await axios.get("https://open.api.ebay.com/shopping", {
      params: {
        callname: "GetMultipleItems",
        responseencoding: "JSON",
        appid: env.EBAY_CLIENT_ID,
        siteid: String(siteId),
        version: "967",
        ItemID: pending.join(","),
        IncludeSelector: "Details,ItemSpecifics,Variations",
      },
      timeout: 15000,
      headers: iafToken
        ? { "Accept-Language": "en-US,en;q=0.8,ja;q=0.7", "X-EBAY-API-IAF-TOKEN": iafToken }
        : { "Accept-Language": "en-US,en;q=0.8,ja;q=0.7" },
      maxRedirects: 3,
    });
    const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    if (/IP limit exceeded/i.test(text)) {
      blockShoppingFor(30 * 60 * 1000);
      if (process.env.NODE_ENV !== "production") {
        console.warn("[debug] Shopping API IP limit exceeded (batch)", { count: pending.length, siteId });
      }
      return map;
    }
    // "ItemID":"123...","WatchCount":57 をすべて拾う
    const re = /"ItemID"\s*:\s*"(\d{6,})"[\s\S]{0,120}?"WatchCount"\s*:\s*(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const id = m[1];
      const n = parseInt(m[2], 10);
      if (id && !Number.isNaN(n)) map.set(id, n);
    }
    // キャッシュへ保存
    for (const [id, n] of map.entries()) {
      watchCountCache.set(`wc:${id}`, n, 6 * 60 * 60 * 1000);
    }
    if (map.size === 0 && process.env.NODE_ENV !== "production") {
      try {
        console.warn("[debug] GetMultipleItems missing WatchCount", { count: legacyIds.length, siteId, snippet: text.slice(0, 400) });
      } catch {}
    }
  } catch {
    // ignore batch error
  }
  return map;
}

async function fetchWatchCountForRow(row: NormalizedRow): Promise<number | null> {
  const candidateUrls: string[] = [];
  const legacy = extractLegacyId(row);
  if (row.url) candidateUrls.push(row.url);
  if (legacy) {
    candidateUrls.push(`https://www.ebay.com/itm/${legacy}`);
    candidateUrls.push(`https://m.ebay.com/itm/${legacy}`);
    // より多くのURLパターンを試行
    candidateUrls.push(`https://www.ebay.com/itm/${legacy}?`);
    candidateUrls.push(`https://m.ebay.com/itm/${legacy}?`);
    // 追加のURLパターン
    candidateUrls.push(`https://www.ebay.com/itm/${legacy}&`);
    candidateUrls.push(`https://m.ebay.com/itm/${legacy}&`);
  }
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Referer": "https://www.ebay.com/",
  } as const;
  
  // より多くのパターンを追加（日本語を優先）
  const patterns: RegExp[] = [
    // 日本語パターン（優先）- 提供された例に基づいて強化
    /([0-9,]+)\s*がこの商品をウォッチリストに追加しました。?/,
    /([0-9,]+)\s*人がこの商品をウォッチリストに追加しました。?/,
    /([0-9,]+)\s*がウォッチリストに追加しました。?/,
    /([0-9,]+)\s*人がウォッチリストに追加しました。?/,
    /([0-9,]+)\s*がこの商品をウォッチしました。?/,
    /([0-9,]+)\s*人がこの商品をウォッチしました。?/,
    /([0-9,]+)\s*がウォッチしました。?/,
    /([0-9,]+)\s*人がウォッチしました。?/,
    /([0-9,]+)\s*人がこの商品をウォッチ中です。?/,
    /([0-9,]+)\s*がこの商品をウォッチ中です。?/,
    /([0-9,]+)\s*ウォッチャー/i,
    /([0-9,]+)\s*フォロワー/i,
    
    // より柔軟な日本語パターン
    /([0-9,]+)\s*[が人]\s*[この商品を]*ウォッチ[リスト]*[にを]*追加しました。?/,
    /([0-9,]+)\s*[が人]\s*[この商品を]*ウォッチ[リスト]*[にを]*追加/,
    /([0-9,]+)\s*[が人]\s*[この商品を]*ウォッチしました。?/,
    /([0-9,]+)\s*[が人]\s*[この商品を]*ウォッチ中です。?/,
    // より具体的なパターン（提供された例に基づいて）
    /([0-9,]+)\s*人がこの商品をウォッチ中です。?/,
    /([0-9,]+)\s*がこの商品をウォッチ中です。?/,
    /([0-9,]+)\s*人がこの商品をウォッチリストに追加しました。?/,
    /([0-9,]+)\s*がこの商品をウォッチリストに追加しました。?/,
    // 追加のパターン（提供された例に基づいて）
    /([0-9,]+)\s*人がこの商品をウォッチ中です。?/,
    /([0-9,]+)\s*がこの商品をウォッチ中です。?/,
    // 新しいパターン（提供された例に基づいて）
    /この商品を([0-9,]+)人の人がウォッチ中です。?/,
    /この商品を([0-9,]+)人がウォッチ中です。?/,
    /この商品を([0-9,]+)人の人がウォッチリストに追加しました。?/,
    /この商品を([0-9,]+)人がウォッチリストに追加しました。?/,
    // 追加のパターン（提供された例に基づいて）
    /([0-9,]+)\s*がこの商品をウォッチリストに追加しました。?/,
    /([0-9,]+)\s*人がこの商品をウォッチリストに追加しました。?/,
    
    // 英語パターン
    /([0-9,]+)\s*watchers/i,
    /([0-9,]+)[^0-9]{0,40}?watching/i,
    /([0-9,]+)\s*people\s*watching/i,
    /([0-9,]+)\s*viewers/i,
    /([0-9,]+)\s*people\s*are\s*watching/i,
    
    // JSON/APIパターン
    /"watchCount"\s*:\s*(\d+)/i,
    /"watchingCount"\s*:\s*(\d+)/i,
    /data-testid="x-item-watch-count"[^>]*>\s*([0-9,]+)/i,
    /class="[^"]*watch[^"]*"[^>]*>\s*([0-9,]+)/i,
    /watch[^>]*>\s*([0-9,]+)/i,
    // より広範囲のHTMLパターン
    /([0-9,]+)\s*[が人]\s*[この商品を]*[ウォッチ|watch][リスト]*[にを]*[追加|add]/i,
    /([0-9,]+)\s*[が人]\s*[この商品を]*[ウォッチ|watch][中|ing]/i,
    /([0-9,]+)\s*[が人]\s*[この商品を]*[ウォッチ|watch]/i,
    // より柔軟なパターン（順序が逆の場合も対応）
    /この商品を([0-9,]+)[人の]*[人が]*[ウォッチ|watch][中|ing]/i,
    /この商品を([0-9,]+)[人の]*[人が]*[ウォッチ|watch][リスト]*[にを]*[追加|add]/i,
    // より広範囲のパターン（数字が先に来る場合）
    /([0-9,]+)\s*[が人]\s*[この商品を]*[ウォッチ|watch][リスト]*[にを]*[追加|add]/i,
    /([0-9,]+)\s*[が人]\s*[この商品を]*[ウォッチ|watch][中|ing]/i,
  ];
  
  // まずHTML抽出を試行
  for (const u of candidateUrls) {
    if (!u) continue;
    try {
      const res = await axios.get(u, { headers, timeout: 30000, maxRedirects: 5, validateStatus: () => true });
      const html: string = res.data as string;
      
      if (process.env.NODE_ENV !== "production") {
        console.log(`[debug] HTML fetched for ${u}, length: ${html.length}`);
        // ウォッチ数関連のテキストを検索してデバッグ情報を表示
        const watchPatterns = [
          /[0-9,]+[が人][この商品を]*ウォッチ/,
          /[0-9,]+[が人][この商品を]*watch/i,
          /この商品を[0-9,]+[人の]*[人が]*ウォッチ/,
          /この商品を[0-9,]+[人の]*[人が]*watch/i,
          /[0-9,]+[が人][この商品を]*ウォッチリスト/,
          /[0-9,]+[が人][この商品を]*watchlist/i,
          /watching/i,
          /watchers/i
        ];
        for (const pattern of watchPatterns) {
          const matches = html.match(pattern);
          if (matches) {
            console.log(`[debug] Found potential watch text: "${matches[0]}"`);
          }
        }
      }
      
      // チャレンジページ検出を強化
      if (/Please verify yourself to continue/i.test(html) || 
          /Checking your browser before you access eBay\./i.test(html) ||
          /Redirecting/i.test(html) ||
          /challenge/i.test(html)) {
        if (process.env.NODE_ENV !== "production") {
          console.log(`[debug] Challenge page detected for ${u}`);
        }
        continue;
      }
      
      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) {
          const count = parseInt(match[1].replace(/,/g, ''));
          if (!isNaN(count) && count > 0) {
            if (process.env.NODE_ENV !== "production") {
              console.log(`[debug] HTML watch count found: ${count} (pattern: ${pattern.source})`);
              console.log(`[debug] Matched text: "${match[0]}"`);
            }
            return count;
          }
        }
      }
    } catch (e) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[debug] HTML fetch error for ${u}:`, e instanceof Error ? e.message : String(e));
      }
      continue;
    }
  }
  
  // HTML抽出が失敗した場合のみShopping APIを試行
  if (legacy && !isShoppingBlocked()) {
    const shoppingCount = await fetchWatchCountShopping(legacy);
    if (typeof shoppingCount === "number") return shoppingCount;
  }
  
  return null;
}

function siteCodeFromMarketplace(marketplace?: string | null): string {
  const m = marketplace || env.EBAY_MARKETPLACE || env.EBAY_MARKETPLACE_ID || "EBAY_US";
  return m;
}

async function fetchWatchCountsFromWatchcount(seller: string, keyword?: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const site = siteCodeFromMarketplace(undefined);
    const kwSeg = keyword && keyword.trim() ? encodeURIComponent(keyword.trim()) : "-";
    const url = `https://www.watchcount.com/live/${kwSeg}/-/all?seller=${encodeURIComponent(seller)}&site=${encodeURIComponent(site)}`;
    
    if (process.env.NODE_ENV !== "production") {
      console.log(`[debug] Fetching watchcount.com: ${url}`);
    }
    
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.8,ja;q=0.7" },
      maxRedirects: 3,
      validateStatus: () => true,
    });
    const html: string = String(res.data ?? "");
    
    if (process.env.NODE_ENV !== "production") {
      console.log(`[debug] watchcount.com response length: ${html.length}`);
      console.log(`[debug] watchcount.com response preview: ${html.slice(0, 500)}`);
    }
    
    let m: RegExpExecArray | null;
    
    // 1) JSON埋め込みから抽出（優先）
    const jsonRe = /"ItemID"\s*:\s*"(\d{6,})"[\s\S]{0,200}?"WatchCount"\s*:\s*(\d+)/g;
    while ((m = jsonRe.exec(html))) {
      const id = m[1];
      const n = parseInt(m[2], 10);
      if (!Number.isNaN(n)) map.set(id, n);
    }
    
    // 2) テーブル行から抽出
    const tableRe = /<tr[^>]*>[\s\S]*?<td[^>]*>(\d{6,})<\/td>[\s\S]*?<td[^>]*>(\d+)<\/td>/gi;
    while ((m = tableRe.exec(html))) {
      const id = m[1];
      const n = parseInt(m[2], 10);
      if (!Number.isNaN(n)) map.set(id, n);
    }
    
    // 3) リンク近傍から抽出
    const linkRe = /href="[^"]*\/itm\/(\d{6,})[^"]*"[^>]*>[\s\S]{0,300}?(\d+)\s*(?:watchers|watching)/gi;
    while ((m = linkRe.exec(html))) {
      const id = m[1];
      const n = parseInt(m[2], 10);
      if (!Number.isNaN(n)) map.set(id, n);
    }
    
    // 4) 汎用的なパターン（保険）
    if (map.size === 0) {
      const genericRe = /\/(?:itm|i)\/(\d{6,})[\s\S]{0,200}?([0-9,]+)\s*(?:watchers|watching)/gi;
      while ((m = genericRe.exec(html))) {
        const id = m[1];
        const numStr = m[2];
        if (id && numStr) {
          const n = parseInt(numStr.replace(/,/g, ""), 10);
          if (!Number.isNaN(n)) map.set(id, n);
        }
      }
    }
    
    // 5) より広範囲のパターン（最終保険）
    if (map.size === 0) {
      const wideRe = /(\d{6,})[\s\S]{0,500}?(\d+)\s*(?:watchers|watching|people watching)/gi;
      while ((m = wideRe.exec(html))) {
        const id = m[1];
        const n = parseInt(m[2], 10);
        if (!Number.isNaN(n) && id.length >= 6) map.set(id, n);
      }
    }
    
    if (process.env.NODE_ENV !== "production") {
      console.log(`[debug] watchcount.com found ${map.size} items for seller ${seller}`);
      if (map.size > 0) {
        console.log(`[debug] watchcount.com items:`, Array.from(map.entries()).slice(0, 3));
      }
    }
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[debug] watchcount.com error for ${seller}:`, e instanceof Error ? e.message : String(e));
    }
  }
  return map;
}

async function enrichWatchCounts(rows: NormalizedRow[]): Promise<NormalizedRow[]> {
  const mode = (process.env.WATCHCOUNT_MODE || "html_first").toLowerCase();
  
  // HTML抽出を最初に実行（日本語の「〇〇がこの商品をウォッチリストに追加しました。」を優先）
  if (mode === "html_first" || mode === "default" || mode === "auto") {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[debug] Starting HTML-first mode for ${rows.length} items`);
    }
    const out: NormalizedRow[] = [...rows];
    const limit = pLimit(2); // 並列数を2に増やして効率化（安定性も考慮）
    const tasks = out.map((row, i) => limit(async () => {
      if (typeof row.watchCount === "number") return;
      if (process.env.NODE_ENV !== "production") {
        console.log(`[debug] Processing HTML for item ${i}: ${row.itemId}`);
      }
      let wc: number | null = null;
      for (let t = 0; t < 3; t++) { // リトライ回数を3回に増加
        try {
          wc = await fetchWatchCountForRow(row);
          if (typeof wc === "number") {
            if (process.env.NODE_ENV !== "production") {
              console.log(`[debug] HTML watch count found for item ${i}: ${wc}`);
            }
            break;
          }
        } catch (error) {
          if (process.env.NODE_ENV !== "production") {
            console.warn(`[debug] HTML fetch error for item ${i}:`, error instanceof Error ? error.message : String(error));
          }
        }
        await new Promise((res) => setTimeout(res, 800 * (t + 1))); // 指数バックオフ
      }
      if (typeof wc === "number") out[i] = { ...out[i], watchCount: wc };
    }));
    await Promise.all(tasks);
    
    if (process.env.NODE_ENV !== "production") {
      const htmlFound = out.filter(r => typeof r.watchCount === "number").length;
      const successRate = ((htmlFound / out.length) * 100).toFixed(1);
      console.log(`[debug] HTML extraction completed. Found: ${htmlFound}/${out.length} (${successRate}% success rate)`);
    }
    
    // HTML抽出で取得できなかったアイテムのみ、他の方法を試行
    const remaining = out.filter((r) => typeof r.watchCount !== "number");
    if (remaining.length > 0) {
      // watchcount.comで補完
      const missingBySeller = new Map<string, number[]>();
      for (let i = 0; i < out.length; i++) {
        const s = out[i].seller || "";
        if (!s || typeof out[i].watchCount === "number") continue;
        if (!missingBySeller.has(s)) missingBySeller.set(s, []);
        missingBySeller.get(s)!.push(i);
      }
      for (const [seller, idxs] of missingBySeller.entries()) {
        const map = await fetchWatchCountsFromWatchcount(seller);
        for (const i of idxs) {
          const legacy = extractLegacyId(out[i]);
          if (legacy && map.has(legacy)) out[i] = { ...out[i], watchCount: map.get(legacy)! };
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      
      // 最後にShopping APIで補完
      const stillMissing = out.filter((r) => typeof r.watchCount !== "number");
      if (stillMissing.length > 0 && !isShoppingBlocked()) {
        const idToIndex = new Map<string, number[]>();
        const legacyIds: string[] = [];
        stillMissing.forEach((r, idx) => {
          const legacy = extractLegacyId(r);
          if (legacy) {
            if (!idToIndex.has(legacy)) idToIndex.set(legacy, []);
            idToIndex.get(legacy)!.push(idx);
            legacyIds.push(legacy);
          }
        });
        const uniqueIds = Array.from(new Set(legacyIds));
        const batches: string[][] = [];
        for (let i = 0; i < uniqueIds.length; i += 20) {
          batches.push(uniqueIds.slice(i, i + 20));
        }
        const byId = new Map<string, number>();
        for (const batch of batches) {
          const partial = await fetchWatchCountsShoppingBatch(batch);
          for (const [id, wc] of partial.entries()) byId.set(id, wc);
          if (isShoppingBlocked()) break;
        }
        for (let i = 0; i < out.length; i++) {
          if (typeof out[i].watchCount === "number") continue;
          const legacy = extractLegacyId(out[i]);
          if (legacy && byId.has(legacy)) out[i] = { ...out[i], watchCount: byId.get(legacy)! };
        }
      }
    }
    return out;
  }
  
  // モックモードを無効化（ダミー数を避けるため）
  // if (mode === "mock_fallback" || process.env.NODE_ENV === "development") {
  //   const out: NormalizedRow[] = [...rows];
  //   for (let i = 0; i < out.length; i++) {
  //     if (typeof out[i].watchCount !== "number") {
  //       // レガシーIDから一貫性のあるモック値を生成
  //       const legacy = extractLegacyId(out[i]);
  //       if (legacy) {
  //         const hash = legacy.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
  //         const mockCount = (hash % 50) + 1; // 1-50の範囲
  //         out[i] = { ...out[i], watchCount: mockCount };
  //       }
  //     }
  //   }
  //   if (process.env.NODE_ENV !== "production") {
  //     console.log(`[debug] Using mock watch counts for ${out.filter(r => typeof r.watchCount === "number").length} items`);
  //   }
  //   return out;
  // }
  
  if (mode === "watchcount_only") {
    // 先に watchcount.com だけで最大限埋め、その後HTML保険
    const out: NormalizedRow[] = [...rows];
    const missingBySeller = new Map<string, number[]>();
    for (let i = 0; i < out.length; i++) {
      const s = out[i].seller || "";
      if (!s || typeof out[i].watchCount === "number") continue;
      if (!missingBySeller.has(s)) missingBySeller.set(s, []);
      missingBySeller.get(s)!.push(i);
    }
    for (const [seller, idxs] of missingBySeller.entries()) {
      const map = await fetchWatchCountsFromWatchcount(seller);
      for (const i of idxs) {
        const legacy = extractLegacyId(out[i]);
        if (legacy && map.has(legacy)) out[i] = { ...out[i], watchCount: map.get(legacy)! };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    // HTML保険
    const limit = pLimit(2);
    const tasks = out.map((row, i) => limit(async () => {
      if (typeof row.watchCount === "number") return;
      let wc: number | null = null;
      for (let t = 0; t < 2; t++) {
        wc = await fetchWatchCountForRow(row);
        if (typeof wc === "number") break;
        await new Promise((res) => setTimeout(res, 1500));
      }
      if (typeof wc === "number") out[i] = { ...out[i], watchCount: wc };
    }));
    await Promise.all(tasks);
    return out;
  }
  if (mode === "watchcount_first") {
    // watchcount.com を優先、その後 Shopping API（IP制限回避）
    const out: NormalizedRow[] = [...rows];
    const missingBySeller = new Map<string, number[]>();
    for (let i = 0; i < out.length; i++) {
      const s = out[i].seller || "";
      if (!s || typeof out[i].watchCount === "number") continue;
      if (!missingBySeller.has(s)) missingBySeller.set(s, []);
      missingBySeller.get(s)!.push(i);
    }
    for (const [seller, idxs] of missingBySeller.entries()) {
      const map = await fetchWatchCountsFromWatchcount(seller);
      for (const i of idxs) {
        const legacy = extractLegacyId(out[i]);
        if (legacy && map.has(legacy)) out[i] = { ...out[i], watchCount: map.get(legacy)! };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    // 残りを Shopping API で補完（IP制限検知で即中断）
    const remaining = out.filter((r) => typeof r.watchCount !== "number");
    if (remaining.length > 0 && !isShoppingBlocked()) {
      const idToIndex = new Map<string, number[]>();
      const legacyIds: string[] = [];
      remaining.forEach((r, idx) => {
        const legacy = extractLegacyId(r);
        if (legacy) {
          if (!idToIndex.has(legacy)) idToIndex.set(legacy, []);
          idToIndex.get(legacy)!.push(idx);
          legacyIds.push(legacy);
        }
      });
      const uniqueIds = Array.from(new Set(legacyIds));
      const batches: string[][] = [];
      for (let i = 0; i < uniqueIds.length; i += 20) {
        batches.push(uniqueIds.slice(i, i + 20));
      }
      const byId = new Map<string, number>();
      for (const batch of batches) {
        const partial = await fetchWatchCountsShoppingBatch(batch);
        for (const [id, wc] of partial.entries()) byId.set(id, wc);
        if (isShoppingBlocked()) break;
      }
      for (let i = 0; i < out.length; i++) {
        if (typeof out[i].watchCount === "number") continue;
        const legacy = extractLegacyId(out[i]);
        if (legacy && byId.has(legacy)) out[i] = { ...out[i], watchCount: byId.get(legacy)! };
      }
    }
    // 最後にHTML保険
    const limit = pLimit(2);
    const tasks = out.map((row, i) => limit(async () => {
      if (typeof row.watchCount === "number") return;
      let wc: number | null = null;
      for (let t = 0; t < 2; t++) {
        wc = await fetchWatchCountForRow(row);
        if (typeof wc === "number") break;
        await new Promise((res) => setTimeout(res, 1500));
      }
      if (typeof wc === "number") out[i] = { ...out[i], watchCount: wc };
    }));
    await Promise.all(tasks);
    return out;
  }
  // 1) Shopping API（GetMultipleItems）を優先してバッチで取得（HTMLは使わない）
  const idToIndex = new Map<string, number[]>();
  const legacyIds: string[] = [];
  rows.forEach((r, idx) => {
    const legacy = extractLegacyId(r);
    if (legacy) {
      if (!idToIndex.has(legacy)) idToIndex.set(legacy, []);
      idToIndex.get(legacy)!.push(idx);
      legacyIds.push(legacy);
    }
  });
  const uniqueIds = Array.from(new Set(legacyIds));
  const batches: string[][] = [];
  for (let i = 0; i < uniqueIds.length; i += 20) {
    batches.push(uniqueIds.slice(i, i + 20));
  }

  // まず watchcount.com で可能な限り埋める（Shopping API呼び出し数を削減）
  const out: NormalizedRow[] = [...rows];
  const missingBySellerPre = new Map<string, number[]>();
  for (let i = 0; i < out.length; i++) {
    if (typeof out[i].watchCount === "number") continue;
    const s = out[i].seller || "";
    const legacy = extractLegacyId(out[i]);
    if (!legacy) continue;
    const cached = watchCountCache.get(`wc:${legacy}`);
    if (typeof cached === "number") {
      out[i] = { ...out[i], watchCount: cached };
      continue;
    }
    if (!s) continue;
    if (!missingBySellerPre.has(s)) missingBySellerPre.set(s, []);
    missingBySellerPre.get(s)!.push(i);
  }
  for (const [seller, idxs] of missingBySellerPre.entries()) {
    const map = await fetchWatchCountsFromWatchcount(seller);
    if (map.size === 0) continue;
    for (const i of idxs) {
      const legacy = extractLegacyId(out[i]);
      if (legacy && map.has(legacy)) {
        const n = map.get(legacy)!;
        watchCountCache.set(`wc:${legacy}`, n);
        out[i] = { ...out[i], watchCount: n };
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // 次に Shopping API バッチ（残りのみ）
  const byId = new Map<string, number>();
  for (const batch of batches) {
    const partial = await fetchWatchCountsShoppingBatch(batch);
    for (const [id, wc] of partial.entries()) byId.set(id, wc);
  }

  const enriched1 = out.map((r) => {
    const legacy = extractLegacyId(r);
    if (legacy && byId.has(legacy)) return { ...r, watchCount: byId.get(legacy)! };
    return r;
  });

  // 2) バッチで埋まらなかったものは GetSingleItem を制限付き並列でリトライ（IP制限検知で即中断）
  const out2: NormalizedRow[] = [...enriched1];
  {
    const limit = pLimit(1);
    const tasks = out2.map((row, i) => limit(async () => {
      if (typeof row.watchCount === "number") return;
      const legacy = extractLegacyId(row);
      if (!legacy) return;
      if (isShoppingBlocked()) return;
      let wc: number | null = null;
      for (let t = 0; t < 3; t++) {
        wc = await fetchWatchCountShopping(legacy);
        if (typeof wc === "number") break;
        await new Promise((res) => setTimeout(res, 1500 * (t + 1)));
        if (isShoppingBlocked()) break;
      }
      if (typeof wc === "number") {
        watchCountCache.set(`wc:${legacy}`, wc);
        out2[i] = { ...out2[i], watchCount: wc };
      }
    }));
    await Promise.all(tasks);
  }
  // 3) watchcount.com による補完（セラー単位でまとめて）
  const missingBySeller = new Map<string, number[]>();
  for (let i = 0; i < out.length; i++) {
    if (typeof out[i].watchCount === "number") continue;
    const s = out[i].seller || "";
    if (!s) continue;
    if (!missingBySeller.has(s)) missingBySeller.set(s, []);
    missingBySeller.get(s)!.push(i);
  }
  for (const [seller, idxs] of missingBySeller.entries()) {
    const map = await fetchWatchCountsFromWatchcount(seller);
    if (map.size === 0) continue;
    for (const i of idxs) {
      const legacy = extractLegacyId(out[i]);
      if (legacy && map.has(legacy)) out[i] = { ...out[i], watchCount: map.get(legacy)! };
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // 4) 最後にHTML直接抽出（最小回数）
  {
    const limit = pLimit(2);
    const tasks = out2.map((row, i) => limit(async () => {
      if (typeof row.watchCount === "number") return;
      let wc: number | null = null;
      for (let t = 0; t < 2; t++) {
        wc = await fetchWatchCountForRow(row);
        if (typeof wc === "number") break;
        await new Promise((res) => setTimeout(res, 1500));
      }
      if (typeof wc === "number") out2[i] = { ...out2[i], watchCount: wc };
    }));
    await Promise.all(tasks);
  }

  return out2;
}

async function searchWebForLegacyIds(username: string, desired: number): Promise<number[]> {
  try {
    const res = await axios.get("https://www.ebay.com/sch/i.html", {
      params: { _ssn: username, _sop: 10, _ipg: 200 },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      },
      timeout: 15000,
      maxRedirects: 5,
    });
    const html: string = res.data as string;
    const ids = new Set<number>();
    const patterns: RegExp[] = [
      /\/itm\/(\d+)[\/\?]/g, // /itm/123456789012/
      /item=(\d+)/g, // ...&item=123456789012
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(html))) {
        const id = parseInt(m[1], 10);
        if (!Number.isNaN(id)) {
          ids.add(id);
          if (ids.size >= desired) break;
        }
      }
      if (ids.size >= desired) break;
    }
    return Array.from(ids).slice(0, desired);
  } catch {
    return [];
  }
}

async function fetchItemsByLegacyIds(token: string, ids: number[]): Promise<SampleItem[]> {
  const limit = pLimit(3);
  const tasks = ids.map((id) =>
    limit(async () => {
      try {
        const res = await axios.get(`${BASE}/buy/browse/v1/item/get_item_by_legacy_id`, {
          params: { legacy_item_id: String(id) },
          headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE },
          timeout: 20000,
        });
        return res.data as SampleItem;
      } catch {
        return null;
      }
    })
  );
  const results = await Promise.all(tasks);
  return results.filter((r): r is SampleItem => Boolean(r));
}

async function fallbackSearchByWeb(token: string, seller: string, maxPerSeller: number): Promise<SampleItem[]> {
  const ids = await searchWebForLegacyIds(seller, maxPerSeller);
  if (ids.length === 0) return [];
  const items = await fetchItemsByLegacyIds(token, ids);
  return items.slice(0, maxPerSeller);
}


// Debug/probe helper: single row watch count enrichment
export async function probeWatchCount(row: NormalizedRow): Promise<number | null> {
  const [r] = await enrichWatchCounts([row]);
  return r.watchCount ?? null;
}


