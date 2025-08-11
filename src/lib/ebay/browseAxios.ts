import axios from "axios";
import pLimit from "p-limit";
import { env } from "@/lib/env";

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

async function getAppToken() {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
    // モックモード: 認証情報が設定されていない場合はモックデータを使用
    console.log("⚠️ eBay API認証情報が設定されていません。モックデータを使用します。");
    return "mock_token";
  }
  // Try with buy.browse first; if invalid_scope, fall back to base scope
  const form = (scope: string) =>
    new URLSearchParams({ grant_type: "client_credentials", scope });
  const cfg = {
    auth: { username: env.EBAY_CLIENT_ID, password: env.EBAY_CLIENT_SECRET },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20000,
  } as const;
  try {
    const res = await axios.post(
      `${BASE}/identity/v1/oauth2/token`,
      form("https://api.ebay.com/oauth/api_scope/buy.browse"),
      cfg
    );
    return res.data.access_token as string;
  } catch (e: unknown) {
    const ax = e as { response?: { data?: { error?: string } } };
    if (ax.response?.data?.error === "invalid_scope") {
      const res2 = await axios.post(
        `${BASE}/identity/v1/oauth2/token`,
        form("https://api.ebay.com/oauth/api_scope"),
        cfg
      );
      return res2.data.access_token as string;
    }
    throw e;
  }
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

  async function searchOnce(params: { offset: number; limit: number; price?: [number, number]; useLocation?: boolean }) {
    const { offset, limit, price, useLocation } = params;
    const filterParts = [baseFilter];
    if (useLocation && env.EBAY_ITEM_LOCATION_COUNTRY) {
      filterParts.push(`itemLocationCountry:${env.EBAY_ITEM_LOCATION_COUNTRY}`);
    }
    if (price) filterParts.push(`price:[${price[0]}..${price[1]}]`);
    const filter = filterParts.join(",");
    return axios.get(`${BASE}/buy/browse/v1/item_summary/search`, {
      params: { q: "*", filter, limit, offset },
      headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE },
      timeout: 30000,
    });
  }

  async function tryLinear(): Promise<SampleItem[]> {
    const acc: SampleItem[] = [];
    let offset = 0;
    while (acc.length < maxPerSeller) {
      const limit = Math.min(PAGE_LIMIT, maxPerSeller - acc.length);
      try {
        const res = await searchOnce({ offset, limit, useLocation: true });
        const items: SampleItem[] = res.data.itemSummaries || [];
        acc.push(...items);
        const total: number = res.data.total || 0;
        offset += items.length;
        if (items.length === 0 || offset >= total) break;
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
      while (acc.length < maxPerSeller) {
        const limit = Math.min(PAGE_LIMIT, maxPerSeller - acc.length);
        try {
          const res = await searchOnce({ offset, limit, price: band, useLocation: true });
          const items: SampleItem[] = res.data.itemSummaries || [];
          acc.push(...items);
          const total: number = res.data.total || 0;
          offset += items.length;
          if (items.length === 0 || offset >= total) break;
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
    const first = await tryLinear();
    if (first.length > 0) return first;
    // 位置フィルタで0件の場合は、位置フィルタ無しで再試行
    const acc: SampleItem[] = [];
    let offset = 0;
    while (acc.length < maxPerSeller) {
      const limit = Math.min(PAGE_LIMIT, maxPerSeller - acc.length);
      const res = await searchOnce({ offset, limit, useLocation: false });
      const items: SampleItem[] = res.data.itemSummaries || [];
      acc.push(...items);
      const total: number = res.data.total || 0;
      offset += items.length;
      if (items.length === 0 || offset >= total) break;
    }
    if (acc.length > 0) return acc;
    // Browse APIが0件を返した場合でも、最終手段としてWebフォールバックを試す
    const webRowsZero = await fallbackSearchByWeb(token, seller, maxPerSeller);
    return webRowsZero;
  } catch {
    // Fallback to banded search if linear triggers 12023
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
    return [...rows].sort((a, b) => (b.watchCount ?? -1) - (a.watchCount ?? -1));
  }
  return [...rows].sort((a, b) => {
    const bd = b.itemCreationDate ? Date.parse(b.itemCreationDate) : 0;
    const ad = a.itemCreationDate ? Date.parse(a.itemCreationDate) : 0;
    if (bd !== ad) return bd - ad;
    const ap = Number(a.priceValue ?? Infinity);
    const bp = Number(b.priceValue ?? Infinity);
    return ap - bp;
  });
}

export async function searchBySellersAxios(sellers: string[], maxPerSeller: number) {
  const token = await getAppToken();
  const results: SampleItem[] = [];
  
  // モックトークンの場合は一括でモックデータを生成
  if (token === "mock_token") {
    return generateMockData(sellers, maxPerSeller);
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
  const enriched = await enrichWatchCounts(normalized);
  return sortForDisplay(enriched);
}

async function fetchWatchCountFromPage(url: string): Promise<number | null> {
  try {
    const res = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      },
      timeout: 15000,
      maxRedirects: 5,
    });
    const html: string = res.data as string;
    const patterns = [
      /([0-9,]+)\s*watchers/i,
      /([0-9,]+)\s*人がこの商品をウォッチ中です。?/,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) {
        const n = parseInt(m[1].replace(/,/g, ""), 10);
        if (!Number.isNaN(n)) return n;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function enrichWatchCounts(rows: NormalizedRow[]): Promise<NormalizedRow[]> {
  const limit = pLimit(3);
  const tasks = rows.map((r) =>
    limit(async () => {
      if (!r.url) return r;
      const wc = await fetchWatchCountFromPage(r.url);
      return { ...r, watchCount: wc ?? r.watchCount };
    })
  );
  return Promise.all(tasks);
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


