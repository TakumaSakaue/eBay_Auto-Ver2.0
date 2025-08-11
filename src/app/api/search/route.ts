import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
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
  titleSearch: z.string().optional(),
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
    // /str/<store-name> はストア名のため、ここでは未確定（後段のWeb解決で取得）
    if (segments.includes("str")) return ""; // 解決保留
    if (segments.length > 0) return decodeURIComponent(segments[segments.length - 1]);
  } catch {
    return t;
  }
  return null;
}

async function resolveSellerTokens(tokens: string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const raw of tokens) {
    const base = normalizeSellerToken(raw);
    if (base && base.length > 0) {
      resolved.push(base);
      continue;
    }
    // /str/ ストアURLなどでユーザー名未特定の場合はWebから取得
    try {
      if (/^https?:\/\/[^\s]+\/str\//i.test(raw)) {
        const res = await axios.get(raw, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
          },
          timeout: 15000,
          maxRedirects: 5,
        });
        const html: string = res.data as string;
        const mUsr = html.match(/\/usr\/([^\"'/?<\s]+)/);
        const mSsn = html.match(/[?&]_ssn=([^&\"']+)/);
        const user = mUsr?.[1] || mSsn?.[1];
        if (user) {
          resolved.push(decodeURIComponent(user));
          continue;
        }
      }
    } catch {
      // ignore and fallback to last segment
    }
    // 最後の手段として末尾セグメント
    try {
      const u = new URL(raw);
      const seg = u.pathname.split("/").filter(Boolean).pop();
      if (seg) resolved.push(decodeURIComponent(seg));
    } catch {
      // そのまま追加
      resolved.push(raw.trim());
    }
  }
  return resolved;
}

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const { sellers, maxPerSeller, titleSearch } = BodySchema.parse(json);
    const normalized = (await resolveSellerTokens(sellers)).filter(Boolean);
    if (normalized.length === 0) {
      return NextResponse.json({ error: "有効なセラー入力がありません。URL もしくはユーザー名を指定してください。" }, { status: 400 });
    }
    const limit = Math.min(maxPerSeller ?? env.MAX_RESULTS_PER_SELLER, 1000);

    // eBay API認証情報のチェック（モックモード対応）
    const isMockMode = !env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET;
    if (isMockMode) {
      console.log("⚠️ モックモードで実行中: eBay API認証情報が設定されていません");
    }

    // セラーごとに個別検索して大規模レスポンス回避
    const rows = await searchBySellersAxios(normalized, limit);
    if (rows.length === 0) {
      try {
        console.warn(
          JSON.stringify({ level: "warn", msg: "no items from ebay", sellers: normalized })
        );
      } catch {
        console.warn("no items from ebay", normalized);
      }
    }
    
    // タイトル検索フィルタリング
    let filteredRows = rows as typeof rows;
    if (titleSearch && titleSearch.trim()) {
      const searchTerm = titleSearch.trim().toLowerCase();
      filteredRows = rows.filter((row) =>
        row.title && row.title.toLowerCase().includes(searchTerm)
      );
    }
    
    const limited = filteredRows;

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
      meta: { 
        sellers: normalized, 
        maxPerSeller: limit, 
        total: limited.length,
        titleSearch: titleSearch?.trim() || null,
        originalTotal: rows.length,
        isMockMode
      },
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


