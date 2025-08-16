// using global fetch; no need to import undici request/Response in Next.js runtime
import { env } from "@/lib/env";
import { getAppAccessToken } from "@/lib/ebay/auth";
import { createLimiter, withRetry } from "@/lib/rateLimiter";

export type EbayItemSummary = {
  itemId?: string;
  title?: string;
  seller?: { username?: string };
  price?: { value?: string; currency?: string };
  itemWebUrl?: string;
  watchCount?: number;
  listingMarketplaceId?: string;
  itemCreationDate?: string; // not guaranteed; optional
  // other fields are ignored
};

export type NormalizedItem = {
  sellerId: string | null;
  itemId: string | null;
  title: string | null;
  priceValue: number | null;
  priceCurrency: string | null;
  watchCount: number | null;
  url: string | null;
  listedAt?: string | null;
};

function getApiBase() {
  return env.EBAY_ENV === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}

type SearchResponse = {
  itemSummaries?: EbayItemSummary[];
  href?: string;
  next?: string;
  total?: number;
  limit?: number;
  offset?: number;
};

async function doBrowseSearch(params: URLSearchParams, signal?: AbortSignal): Promise<SearchResponse> {
  const token = await getAppAccessToken();
  const endpoint = `${getApiBase()}/buy/browse/v1/item_summary/search?${params.toString()}`;

  const res = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": env.EBAY_MARKETPLACE_ID,
    },
    signal,
  });

  if (res.status === 429 || res.status >= 500) {
    const body = await res.text();
    throw new Error(`Upstream temporary error ${res.status}: ${body}`);
  }

  if (!res.ok) {
    const text = await res.text();
    console.error(
      JSON.stringify({ level: "error", msg: "ebay browse error", status: res.status, text })
    );
    throw new Error(`eBay Browse error: ${res.status}`);
  }

  return (await res.json()) as SearchResponse;
}

const retryingBrowseSearch = withRetry(doBrowseSearch);

export async function fetchSellerActiveListings(
  sellerId: string,
  maxResults: number
): Promise<NormalizedItem[]> {
  const results: NormalizedItem[] = [];
  let offset = 0;
  const pageSize = Math.min(200, maxResults); // Browse API page limit is typically up to 200

  while (results.length < maxResults) {
    const params = new URLSearchParams();
    // Some implementations require q. Using wildcard to ensure results when filtering only by sellers
    params.set("q", "*");
    params.set("sellers", sellerId);
    params.set("limit", String(Math.min(pageSize, maxResults - results.length)));
    params.set("offset", String(offset));

    const data = await retryingBrowseSearch(params);
    const items = data.itemSummaries ?? [];

    for (const it of items) {
      const normalized: NormalizedItem = {
        sellerId: it.seller?.username ?? sellerId ?? null,
        itemId: it.itemId ?? null,
        title: it.title ?? null,
        priceValue: it.price?.value ? Number(it.price.value) : null,
        priceCurrency: it.price?.currency ?? null,
        watchCount: typeof (it as unknown as { watchCount?: number }).watchCount === "number"
          ? (it as unknown as { watchCount?: number }).watchCount!
          : null,
        url: it.itemWebUrl ?? null,
        listedAt: (it as unknown as { itemCreationDate?: string }).itemCreationDate ?? null,
      };
      results.push(normalized);
      if (results.length >= maxResults) break;
    }

    if (!data.next || items.length === 0) break;
    offset += items.length;
  }

  return results;
}

export async function fetchSellersListings(
  sellers: string[],
  maxResultsPerSeller: number
): Promise<NormalizedItem[]> {
  const limiter = createLimiter();
  const tasks = sellers.map((s) => limiter(() => fetchSellerActiveListings(s, maxResultsPerSeller)));
  const arrays = await Promise.all(tasks);
  return arrays.flat();
}

export function sortItemsWithFallback(items: NormalizedItem[]): NormalizedItem[] {
  const byWatch = items.some((i) => typeof i.watchCount === "number");
  if (byWatch) {
    // ウォッチ数が多い順にソート（デフォルト）
    return [...items].sort((a, b) => (b.watchCount ?? -1) - (a.watchCount ?? -1));
  }
  // Fallback: newer first if listedAt present, then price asc, then title asc
  return [...items].sort((a, b) => {
    const ad = a.listedAt ? Date.parse(a.listedAt) : 0;
    const bd = b.listedAt ? Date.parse(b.listedAt) : 0;
    if (ad !== bd) return bd - ad;
    const ap = a.priceValue ?? Number.POSITIVE_INFINITY;
    const bp = b.priceValue ?? Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    return (a.title ?? "").localeCompare(b.title ?? "");
  });
}


