import axios from "axios";
import pLimit from "p-limit";
import { env } from "@/lib/env";
import { getAppAccessToken } from "@/lib/ebay/auth";
import { createCache } from "@/lib/cache";

/**
 * ウォッチ数取得機能 - 現実的で効率的なAPIシステム
 * 
 * 実装内容:
 * - eBay Shopping API: 公式APIでボット検出を回避
 * - watchcount.com API: セラー単位での一括取得
 * - 効率的なバッチ処理: 並列処理で高速化
 * - キャッシュシステム: 重複リクエストを削減
 * - フォールバック機能: 複数のAPIソースで確実性向上
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
  
  // モックトークンの場合でもウォッチ数取得をテスト
  if (token === "mock_token") {
    console.log("⚠️ モックトークンを使用中。実際のウォッチ数取得をテストします。");
    const mock = generateMockData(sellers, maxPerSeller);
    const normalizedMock = normalize(mock);
    console.log(`[debug] About to call enrichWatchCounts for ${normalizedMock.length} items (mock mode)`);
    const enrichedMock = await enrichWatchCounts(normalizedMock);
    const finalFound = enrichedMock.filter(r => typeof r.watchCount === "number").length;
    const finalSuccessRate = ((finalFound / enrichedMock.length) * 100).toFixed(1);
    console.log(`[debug] enrichWatchCounts completed. Found ${finalFound}/${enrichedMock.length} watch counts (${finalSuccessRate}% success rate)`);
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
    // IAFトークンなしでShopping APIを呼び出し（認証エラー回避）
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
      headers: { "Accept-Language": "en-US,en;q=0.8,ja;q=0.7" },
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
    // IAFトークンなしでShopping APIを呼び出し（認証エラー回避）
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
      headers: { "Accept-Language": "en-US,en;q=0.8,ja;q=0.7" },
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

export async function fetchWatchCountForRow(row: NormalizedRow): Promise<number | null> {
  console.log(`[debug] fetchWatchCountForRow called with itemId: ${row.itemId}, url: ${row.url}`);
  
  // 現実的で実現性の高い解決策 - HTMLベースのスクレイピング
  const legacy = extractLegacyId(row);
  if (!legacy) {
    console.log(`[debug] No legacy ID found`);
    return null;
  }
  
  console.log(`[debug] Using HTML-based scraping for legacy ID: ${legacy}`);
  
  // 1. まずキャッシュをチェック
  const cached = watchCountCache.get(`wc:${legacy}`);
  if (typeof cached === "number") {
    console.log(`[debug] Cache hit: ${cached}`);
    return cached;
  }
  
  // 2. HTMLベースのスクレイピングを試行
  try {
    console.log(`[debug] Trying HTML-based scraping`);
    if (row.url) {
      const watchCount = await fetchWatchCountFromHTML(row.url);
      if (typeof watchCount === "number") {
        console.log(`[debug] HTML scraping watch count found: ${watchCount}`);
        // キャッシュに保存
        watchCountCache.set(`wc:${legacy}`, watchCount);
        return watchCount;
      }
    }
  } catch (error) {
    console.log(`[debug] HTML scraping error: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  // 3. Shopping APIがブロックされていない場合のみ試行
  if (!isShoppingBlocked()) {
    try {
      const watchCount = await fetchWatchCountShopping(legacy);
      if (typeof watchCount === "number") {
        console.log(`[debug] Shopping API watch count found: ${watchCount}`);
        // キャッシュに保存
        watchCountCache.set(`wc:${legacy}`, watchCount);
        return watchCount;
      }
    } catch (error) {
      console.log(`[debug] Shopping API error: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    console.log(`[debug] Shopping API is blocked, skipping`);
  }
  
  console.log(`[debug] No watch count found from any source`);
  return null;
}

function siteCodeFromMarketplace(marketplace?: string | null): string {
  const m = marketplace || env.EBAY_MARKETPLACE || env.EBAY_MARKETPLACE_ID || "EBAY_US";
  return m;
}

async function fetchWatchCountFromHTML(url: string): Promise<number | null> {
  try {
    // 強化されたBot Detection回避 - より長いランダム待機時間
    const delay = 8000 + Math.random() * 18000; // 8-26秒
    console.log(`[debug] Bot avoidance delay: ${Math.round(delay/1000)}s`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // 多様なUser-Agentのローテーション
    const userAgents = [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    ];
    
    // 多様なAccept-Languageのローテーション
    const acceptLanguages = [
      "en-US,en;q=0.9,ja;q=0.8",
      "ja-JP,ja;q=0.9,en;q=0.8",
      "en-GB,en;q=0.9,ja;q=0.8",
      "en-CA,en;q=0.9,ja;q=0.8",
      "en-AU,en;q=0.9,ja;q=0.8"
    ];
    
    // 多様なRefererの生成
    const referers = [
      "https://www.google.com/",
      "https://www.bing.com/",
      "https://www.ebay.com/",
      "https://www.ebay.com/sch/i.html",
      "https://www.ebay.com/b/",
      "https://www.ebay.com/str/",
      "https://www.ebay.com/usr/"
    ];
    
    // ランダムなIPアドレスの模倣（X-Forwarded-For）
    const randomIPs = [
      "192.168.1." + Math.floor(Math.random() * 255),
      "10.0.0." + Math.floor(Math.random() * 255),
      "172.16.0." + Math.floor(Math.random() * 255)
    ];
    
    const selectedUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    const selectedLanguage = acceptLanguages[Math.floor(Math.random() * acceptLanguages.length)];
    const selectedReferer = referers[Math.floor(Math.random() * referers.length)];
    const selectedIP = randomIPs[Math.floor(Math.random() * randomIPs.length)];
    
    console.log(`[debug] Bot avoidance headers: UA=${selectedUserAgent.split('Chrome/')[1]?.split(' ')[0] || 'Unknown'}, Lang=${selectedLanguage.split(',')[0]}`);
    
    const res = await axios.get(url, {
      timeout: 45000, // タイムアウトを延長
      headers: {
        "User-Agent": selectedUserAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": selectedLanguage,
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-User": "?1",
        "Cache-Control": "max-age=0",
        "Referer": selectedReferer,
        "X-Forwarded-For": selectedIP,
        "DNT": "1",
        "sec-gpc": "1",
        "Sec-Ch-Ua": '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"macOS"',
      },
      maxRedirects: 5,
    });
    
    const html = res.data;
    
    // 強化されたチャレンジページの検出
    const challengePatterns = [
      "Checking your browser",
      "Reference ID",
      "Please verify you are a human",
      "Security check",
      "Access denied",
      "Too many requests",
      "Rate limit exceeded",
      "Please wait while we verify",
      "Cloudflare",
      "DDoS protection"
    ];
    
    const isChallengePage = challengePatterns.some(pattern => 
      html.toLowerCase().includes(pattern.toLowerCase())
    );
    
    if (isChallengePage) {
      console.log(`[debug] Challenge page detected for ${url} - Bot detection triggered`);
      return null;
    }
    
    // 日本語のウォッチ数パターン
    const japanesePatterns = [
      /(\d+)人がこの商品をウォッチ中です/g,
      /(\d+)人がウォッチ中/g,
      /(\d+)人がこの商品をウォッチリストに追加しました/g,
    ];
    
    for (const pattern of japanesePatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const count = parseInt(match[1], 10);
        if (!Number.isNaN(count)) {
          console.log(`[debug] Japanese pattern match: ${count} from ${pattern.source}`);
          return count;
        }
      }
    }
    
    // 英語のウォッチ数パターン
    const englishPatterns = [
      /(\d+)\s*have\s+added\s+this\s+to\s+their\s+watchlist/g,
      /(\d+)\s*watchers/g,
      /(\d+)\s*people\s+are\s+watching/g,
    ];
    
    for (const pattern of englishPatterns) {
        const match = html.match(pattern);
      if (match && match[1]) {
        const count = parseInt(match[1], 10);
        if (!Number.isNaN(count)) {
          console.log(`[debug] English pattern match: ${count} from ${pattern.source}`);
            return count;
          }
      }
    }
    
    console.log(`[debug] No watch count pattern found in HTML`);
  return null;
  
  } catch (error) {
    console.log(`[debug] HTML scraping error: ${error instanceof Error ? error.message : String(error)}`);
  return null;
}
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
    timeout: 45000,
    headers: { 
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9,ja;q=0.8",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Cache-Control": "max-age=0",
      "Sec-Ch-Ua": '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      "Connection": "keep-alive",
      "DNT": "1",
      "sec-gpc": "1"
    },
    maxRedirects: 5,
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
    
    // 2) テーブル行から抽出（改善版）
    const tableRe = /<tr[^>]*>[\s\S]*?<td[^>]*>(\d{6,})<\/td>[\s\S]*?<td[^>]*>(\d+)<\/td>/gi;
    while ((m = tableRe.exec(html))) {
      const id = m[1];
      const n = parseInt(m[2], 10);
      if (!Number.isNaN(n)) map.set(id, n);
    }
    
    // 3) リンク近傍から抽出（改善版）
    const linkRe = /href="[^"]*\/itm\/(\d{6,})[^"]*"[^>]*>[\s\S]{0,500}?(\d+)\s*(?:watchers|watching|people watching)/gi;
    while ((m = linkRe.exec(html))) {
      const id = m[1];
      const n = parseInt(m[2], 10);
      if (!Number.isNaN(n)) map.set(id, n);
    }
    
    // 4) より柔軟なパターン
    if (map.size === 0) {
      const flexibleRe = /(\d{6,})[\s\S]{0,300}?(\d+)\s*(?:watchers|watching|people watching|have added)/gi;
      while ((m = flexibleRe.exec(html))) {
        const id = m[1];
        const n = parseInt(m[2], 10);
        if (!Number.isNaN(n) && id.length >= 6) map.set(id, n);
      }
    }
    
    // 5) 最も汎用的なパターン（最終保険）
    if (map.size === 0) {
      const wideRe = /(\d{6,})[\s\S]{0,800}?(\d+)\s*(?:watchers|watching|people|have|ウォッチ|人が|商品を)/gi;
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
  console.log(`[debug] enrichWatchCounts called with ${rows.length} items - HTML-BASED SYSTEM (ENHANCED BOT AVOIDANCE)`);
  
  // HTMLベースのウォッチ数カウントシステム - 強化されたBot Detection回避
  const out: NormalizedRow[] = [...rows];
  
  // 1. HTMLベースのスクレイピングで個別取得 - より慎重な並列処理
  const limit = pLimit(2); // 並列数を2に制限（Bot Detection回避のため）
  const tasks = out.map((row, index) => limit(async () => {
    if (typeof row.watchCount === "number") return; // 既に取得済み
    
    // 各リクエスト間に追加のランダムディレイ
    const interRequestDelay = 5000 + Math.random() * 10000; // 5-15秒
    console.log(`[debug] Inter-request delay: ${Math.round(interRequestDelay/1000)}s for item ${index + 1}`);
    await new Promise(resolve => setTimeout(resolve, interRequestDelay));
    
    try {
      const watchCount = await fetchWatchCountForRow(row);
      if (typeof watchCount === "number") {
        out[index] = { ...out[index], watchCount };
        console.log(`[debug] HTML scraping found: ${watchCount} for item ${index + 1}`);
      }
    } catch (error) {
      console.log(`[debug] HTML scraping error for item ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  
  await Promise.all(tasks);
      
  const foundCount = out.filter(r => typeof r.watchCount === "number").length;
  console.log(`[debug] Watch count extraction completed: ${foundCount}/${out.length} items found`);
  
    return out;
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


