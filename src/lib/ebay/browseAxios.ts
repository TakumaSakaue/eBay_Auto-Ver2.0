import axios from "axios";
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
  watchCount?: number;
};

async function getAppToken() {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
    throw new Error(".env に EBAY_CLIENT_ID / EBAY_CLIENT_SECRET を設定してください。");
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
  const PAGE_LIMIT = 200;
  const quoteSeller = (u: string) => JSON.stringify(u); // ensure spaces/specials are quoted
  const baseFilter = `sellers:{${quoteSeller(seller)}}`;

  async function searchOnce(params: { offset: number; limit: number; price?: [number, number] }) {
    const { offset, limit, price } = params;
    const filterParts = [baseFilter];
    // JP相当の代理条件: itemLocationCountryをJPにする（US市場APIでの近似）
    if (env.EBAY_ITEM_LOCATION_COUNTRY) {
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
        const res = await searchOnce({ offset, limit });
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
          const res = await searchOnce({ offset, limit, price: band });
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
    return await tryLinear();
  } catch {
    // Fallback to banded search if linear triggers 12023
    return await tryPriceBands();
  }
}

export type NormalizedRow = {
  itemId: string | null;
  title: string | null;
  priceValue: string | null;
  priceCurrency: string | null;
  url: string | null;
  seller: string | null;
  itemCreationDate: string | null;
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
  return sortForDisplay(normalize(flat));
}


