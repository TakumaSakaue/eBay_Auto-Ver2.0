import { NextRequest, NextResponse } from "next/server";
import { fetchWatchCountForRow } from "@/lib/ebay/browseAxios";

export async function POST(request: NextRequest) {
  try {
    const { urls } = await request.json();
    
    if (!Array.isArray(urls)) {
      return NextResponse.json({ error: "URLs array is required" }, { status: 400 });
    }

    console.log(`[debug] Testing watch count extraction for ${urls.length} URLs`);

    const results = [];
    
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`[debug] Processing URL ${i + 1}/${urls.length}: ${url}`);
      
      // URLからitemIdを抽出
      const itemIdMatch = url.match(/\/itm\/(\d+)/);
      if (!itemIdMatch) {
        results.push({
          url,
          success: false,
          error: "Invalid eBay URL format",
          watchCount: null
        });
        continue;
      }

      const legacyId = itemIdMatch[1];
      const itemId = `v1|${legacyId}|0`;
      
      // NormalizedRowオブジェクトを作成
      const row = {
        itemId,
        title: null,
        priceValue: null,
        priceCurrency: null,
        url,
        seller: null,
        itemCreationDate: null,
        watchCount: null
      };

      try {
        const watchCount = await fetchWatchCountForRow(row);
        
        results.push({
          url,
          success: true,
          watchCount,
          itemId,
          legacyId
        });
        
        console.log(`[debug] Success for ${url}: watchCount = ${watchCount}`);
        
      } catch (error) {
        console.error(`[debug] Error processing ${url}:`, error);
        results.push({
          url,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          watchCount: null,
          itemId,
          legacyId
        });
      }

      // 次のリクエスト前に待機（ボット検出回避）
      if (i < urls.length - 1) {
        const delay = 8000 + Math.random() * 10000; // 8-18秒のランダム待機
        console.log(`[debug] Waiting ${Math.round(delay)}ms before next request`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    const successCount = results.filter(r => r.success && r.watchCount !== null).length;
    console.log(`[debug] Test completed. Success rate: ${successCount}/${urls.length} (${Math.round(successCount/urls.length*100)}%)`);

    return NextResponse.json({
      success: true,
      results,
      summary: {
        total: urls.length,
        successful: successCount,
        successRate: Math.round(successCount/urls.length*100)
      }
    });

  } catch (error) {
    console.error("[debug] API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
