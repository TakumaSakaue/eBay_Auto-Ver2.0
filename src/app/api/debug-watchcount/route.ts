import { NextRequest, NextResponse } from "next/server";
import { fetchWatchCountForRow } from "@/lib/ebay/browseAxios";

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();
    
    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    // テスト用のNormalizedRowを作成
    const testRow = {
      itemId: "146716939745",
      title: "Test Item",
      priceValue: null,
      priceCurrency: null,
      url: url,
      seller: null,
      itemCreationDate: null,
      watchCount: null
    };

    console.log(`[debug] Testing watch count extraction for URL: ${url}`);
    console.log(`[debug] Test row:`, testRow);
    
    const watchCount = await fetchWatchCountForRow(testRow);
    
    console.log(`[debug] Result: ${watchCount}`);
    console.log(`[debug] Result type: ${typeof watchCount}`);
    
    return NextResponse.json({
      url,
      watchCount,
      success: typeof watchCount === "number"
    });
    
  } catch (error) {
    console.error("[debug] Error:", error);
    return NextResponse.json({ 
      error: error instanceof Error ? error.message : "Unknown error" 
    }, { status: 500 });
  }
}
