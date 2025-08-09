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
  const res = await axios.post(
    `${BASE}/identity/v1/oauth2/token`,
    new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope/buy.browse",
    }),
    {
      auth: { username: env.EBAY_CLIENT_ID, password: env.EBAY_CLIENT_SECRET },
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    }
  );
  return res.data.access_token as string;
}

async function fetchAllActiveListingsBySellers(token: string, sellers: string[]): Promise<SampleItem[]> {
  const joined = sellers.join("|");
  const filter = `sellers:{${joined}}`;
  const all: SampleItem[] = [];
  const LIMIT = 200;
  let offset = 0;

  while (true) {
    const res = await axios.get(`${BASE}/buy/browse/v1/item_summary/search`, {
      params: { filter, limit: LIMIT, offset },
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE,
      },
      timeout: 30000,
    });

    const items: SampleItem[] = res.data.itemSummaries || [];
    all.push(...items);
    const total: number = res.data.total || 0;
    offset += items.length;
    if (items.length === 0 || offset >= total) break;
  }
  return all;
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

export async function searchBySellersAxios(sellers: string[]) {
  const token = await getAppToken();
  const raw = await fetchAllActiveListingsBySellers(token, sellers);
  return sortForDisplay(normalize(raw));
}


