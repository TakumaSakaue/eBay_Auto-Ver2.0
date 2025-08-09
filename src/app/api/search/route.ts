import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { searchBySellersAxios } from "@/lib/ebay/browseAxios";

const BodySchema = z.object({
  sellers: z
    .union([
      z.string(),
      z.array(z.string()),
    ])
    .transform((val) => {
      if (Array.isArray(val)) return val;
      return val
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
    })
    .pipe(z.array(z.string()).min(1, "At least one seller is required").max(100)),
  maxPerSeller: z.number().int().positive().max(1000).optional(),
});

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const { sellers, maxPerSeller } = BodySchema.parse(json);
    const limit = Math.min(maxPerSeller ?? env.MAX_RESULTS_PER_SELLER, 1000);

    // Axios版で一括取得。limit制御は現状API側で200/ページのため、取得後slice
    const rows = await searchBySellersAxios(sellers);
    const limited = rows.slice(0, sellers.length * limit);

    return NextResponse.json({
      items: limited.map((r) => ({
        sellerId: r.seller,
        itemId: r.itemId,
        title: r.title,
        priceValue: r.priceValue ? Number(r.priceValue) : null,
        priceCurrency: r.priceCurrency,
        watchCount: r.watchCount,
        url: r.url,
        listedAt: r.itemCreationDate,
      })),
      meta: { sellers, maxPerSeller: limit, total: limited.length },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({ level: "error", msg: "search error", error: message })
    );
    return NextResponse.json(
      { error: "検索に失敗しました。後でもう一度お試しください。" },
      { status: 500 }
    );
  }
}


