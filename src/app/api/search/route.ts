import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { z } from "zod";
import { env } from "@/lib/env";
import { searchBySellersAxios } from "@/lib/ebay/browseAxios";
import { fetchSellerSoldItems } from "@/lib/ebay/soldWeb";

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
  soldOnly: z.coerce.boolean().optional(),
});

export const dynamic = "force-dynamic";

function normalizeLatin(input: string): string {
  try {
    // アクセント記号を除去（Pokémon -> pokemon など）
    return input.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  } catch {
    return input.toLowerCase();
  }
}

function expandAliases(term: string): string[] {
  const t = term.toLowerCase();
  const aliases: string[] = [];
  // Pokemon 同義語（大小/アクセント/日本語）
  const pokemonSet = new Set(["pokemon", "pokémon", "ポケモン"]);
  if (pokemonSet.has(t) || pokemonSet.has(normalizeLatin(t))) {
    aliases.push(...Array.from(pokemonSet));
  }
  return aliases;
}

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
    // /str/<store-name>/... はストア名を優先的に抽出
    const strIdx = segments.indexOf("str");
    if (strIdx !== -1) {
      const candidate = segments[strIdx + 1];
      if (candidate && candidate !== "_i.html") {
        return decodeURIComponent(candidate);
      }
      // 末尾がカテゴリや _i.html の場合でも、/str/ の直後を優先
      if (candidate) return decodeURIComponent(candidate);
      return ""; // 解決保留
    }
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
    const { sellers, maxPerSeller, titleSearch, soldOnly } = BodySchema.parse(json);
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

    console.log(`[debug] Starting search for sellers: ${normalized.join(", ")}`);
    // セラーごとに個別検索
    let rows = await searchBySellersAxios(normalized, limit);
    console.log(`[debug] Search completed. Found ${rows.length} items`);
    
    if (soldOnly) {
      const soldRows: typeof rows = [] as any;
      for (const s of normalized) {
        const r = await fetchSellerSoldItems(s, limit);
        soldRows.push(...r);
      }
      rows = soldRows;
    }
    if (rows.length === 0) {
      try {
        console.warn(
          JSON.stringify({ level: "warn", msg: "no items from ebay", sellers: normalized })
        );
      } catch {
        console.warn("no items from ebay", normalized);
      }
    }
    // 取得件数が少ないときの追加ログ
    if (rows.length < limit) {
      try {
        console.warn(
          JSON.stringify({ level: "warn", msg: "underfilled results", sellers: normalized, requested: limit, got: rows.length })
        );
      } catch {}
    }
    
    // タイトル検索フィルタリング
    let filteredRows = rows as typeof rows;
    if (titleSearch && titleSearch.trim()) {
      const raw = titleSearch.trim();
      const terms = [raw, ...expandAliases(raw)];
      filteredRows = rows.filter((row) => {
        const title = row.title ?? "";
        const titleLower = title.toLowerCase();
        const titleNoAcc = normalizeLatin(title);
        return terms.some((t) => {
          const low = t.toLowerCase();
          const noAcc = normalizeLatin(t);
          return titleLower.includes(low) || titleNoAcc.includes(noAcc);
        });
      });
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


