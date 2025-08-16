import axios from "axios";
import { env } from "@/lib/env";
import { getAppAccessToken } from "@/lib/ebay/auth";
import type { NormalizedRow } from "@/lib/ebay/browseAxios";

async function searchWebForLegacyIdsSold(username: string, desired: number): Promise<number[]> {
  try {
    const res = await axios.get("https://www.ebay.com/sch/i.html", {
      params: { _ssn: username, LH_Sold: 1, LH_Complete: 1, _sop: 10, _ipg: 200 },
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
      /\/itm\/(\d+)[\/?]/g, // /itm/123456789012/
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

async function fetchItemsByLegacyIds(ids: number[]): Promise<NormalizedRow[]> {
  const token = await getAppAccessToken();
  const rows: NormalizedRow[] = [];
  for (const id of ids) {
    try {
      const res = await axios.get(`${env.EBAY_ENV === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com"}/buy/browse/v1/item/get_item_by_legacy_id`, {
        params: { legacy_item_id: String(id) },
        headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": env.EBAY_MARKETPLACE_ID },
        timeout: 20000,
      });
      const it = res.data as {
        itemId?: string;
        title?: string;
        price?: { value?: string; currency?: string };
        itemWebUrl?: string;
        seller?: { username?: string };
        itemCreationDate?: string;
      };
      rows.push({
        itemId: it.itemId ?? null,
        title: it.title ?? null,
        priceValue: it.price?.value ?? null,
        priceCurrency: it.price?.currency ?? null,
        url: it.itemWebUrl ?? null,
        seller: it.seller?.username ?? null,
        itemCreationDate: it.itemCreationDate ?? null,
        watchCount: null,
      });
    } catch {
      // ignore individual failures
    }
  }
  return rows;
}

export async function fetchSellerSoldItems(seller: string, maxPerSeller: number): Promise<NormalizedRow[]> {
  const ids = await searchWebForLegacyIdsSold(seller, maxPerSeller);
  if (ids.length === 0) return [];
  const items = await fetchItemsByLegacyIds(ids);
  return items.slice(0, maxPerSeller);
}


