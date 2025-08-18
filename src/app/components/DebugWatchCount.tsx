"use client";

import { useState } from "react";

export default function DebugWatchCount() {
  const [url, setUrl] = useState("https://www.ebay.com/itm/146716939745?amdata=enc%3AAQAKAAAAoFkggFvd1GGDu0w3yXCmi1cxvSm66xlVGIQ3P3dt4%2Fy2uiKq3g11Avp1c6UwOcAAomTKs026EzWLa3yuhBt8zg3cX7SZSoYqkJxu5%2Bd2zkYp4QGUCZlPWa7c%2FMal9EMpjhiENFBV7y4Mnned2ZL8uMllxkmncPjII0AO3u20%2F%2Be60yDHuHUli6x1FC9Hu8dS1Ix6P50vFuKQ7a3Gbrxyjoc%3D");
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const testWatchCount = async () => {
    setLoading(true);
    setResult(null);
    
    try {
      const response = await fetch("/api/debug-watchcount", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });
      
      const data = await response.json();
      setResult(data);
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : "Unknown error" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <h2 className="text-xl font-bold mb-4">ウォッチ数取得デバッグ</h2>
      
      <div className="mb-4">
        <label className="block text-sm font-medium mb-2">テストURL:</label>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="w-full p-2 border border-gray-300 rounded"
          placeholder="eBay URLを入力"
        />
      </div>
      
      <button
        onClick={testWatchCount}
        disabled={loading}
        className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-400"
      >
        {loading ? "テスト中..." : "ウォッチ数取得テスト"}
      </button>
      
      {result && (
        <div className="mt-4 p-4 border rounded">
          <h3 className="font-bold mb-2">結果:</h3>
          <pre className="bg-gray-100 p-2 rounded text-sm overflow-auto">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
