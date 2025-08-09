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
  maxPerSeller: z.coerce.number().int().positive().max(1000).optional(),
});

export const dynamic = "force-dynamic";

function normalizeSellerToken(token: string): string | null {
  const t = token.trim();
  if (!t) return null;
  if (!/^https?:\/\//i.test(t)) return t;
  try {
    const u = new URL(t);
    const ssn = u.searchParams.get("_ssn");
    if (ssn) return ssn.trim();
    const segments = u.pathname.split("/").filter(Boolean);
    const usrIdx = segments.indexOf("usr");
    if (usrIdx !== -1 && segments[usrIdx + 1]) return decodeURIComponent(segments[usrIdx + 1]);
    const schIdx = segments.indexOf("sch");
    if (schIdx !== -1 && segments[schIdx + 1]) return decodeURIComponent(segments[schIdx + 1]);
    if (segments.length > 0) return decodeURIComponent(segments[segments.length - 1]);
  } catch {
    return t;
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const { sellers, maxPerSeller } = BodySchema.parse(json);
    const normalized = sellers
      .map(normalizeSellerToken)
      .filter((v): v is string => Boolean(v));
    if (normalized.length === 0) {
      return NextResponse.json({ error: "有効なセラー入力がありません。URL もしくはユーザー名を指定してください。" }, { status: 400 });
    }
    const limit = Math.min(maxPerSeller ?? env.MAX_RESULTS_PER_SELLER, 1000);

    if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
      return NextResponse.json(
        { error: "EBAY_CLIENT_ID/EBAY_CLIENT_SECRET が未設定です。サーバーの環境変数(.env / Vercel)を確認してください。" },
        { status: 400 }
      );
    }

    // セラーごとに個別検索して大規模レスポンス回避
    const rows = await searchBySellersAxios(normalized, limit);
    const limited = rows;

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
      meta: { sellers: normalized, maxPerSeller: limit, total: limited.length },
    });
  } catch (err: unknown) {
    // Zod バリデーションエラーは 400 を返す
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid request body", details: err.issues },
        { status: 400 }
      );
    }
    // axios error details if present
    type AxiosLike = { response?: { status?: number; statusText?: string; data?: unknown } };
    const ax = err as AxiosLike;
    const status = ax.response?.status;
    const statusText = ax.response?.statusText;
    const data = ax.response?.data;
    const message = err instanceof Error ? err.message : String(err);
    // JSON.stringifyが失敗するのを防ぐ
    let safeLogData: unknown = data;
    try {
      // 循環参照を排除
      safeLogData = data ? JSON.parse(JSON.stringify(data)) : data;
    } catch {
      safeLogData = "[unserializable response.data]";
    }
    const safeDetails = typeof data === "string" ? data : safeLogData ?? message;
    try {
      console.error(
        JSON.stringify({ level: "error", msg: "search error", status, statusText, data: safeLogData, error: message })
      );
    } catch {
      console.error({ level: "error", msg: "search error", status, statusText, error: message });
    }
    return NextResponse.json(
      {
        error:
          status && data
            ? `eBay API エラー: ${status} ${statusText || ""}`
            : "検索に失敗しました。後でもう一度お試しください。",
        details: safeDetails,
      },
      { status: status && status >= 400 ? status : 500 }
    );
  }
}


