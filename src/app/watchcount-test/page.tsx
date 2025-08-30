"use client";

import { useState } from "react";

export default function WatchCountTestPage() {
  const [urls, setUrls] = useState<string>("");
  const [results, setResults] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const urlList = urls.split('\n').filter(url => url.trim());
    if (urlList.length === 0) {
      alert('URLを入力してください');
      return;
    }

    setLoading(true);
    setResults(null);

    try {
      const response = await fetch('/api/watchcount-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ urls: urlList }),
      });

      const data = await response.json();
      setResults(data);
    } catch (error) {
      console.error('Error:', error);
      setResults({ error: 'リクエストに失敗しました' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <h1 className="text-3xl font-bold mb-6">eBay ウォッチ数取得テスト（API効率版）</h1>
      
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <h2 className="text-lg font-semibold text-blue-800 mb-2">🎯 現実的で効率的なAPIシステム</h2>
        <ul className="text-blue-700 space-y-1">
          <li>• <strong>eBay Shopping API</strong>: 公式APIでボット検出を回避</li>
          <li>• <strong>watchcount.com API</strong>: セラー単位での一括取得</li>
          <li>• <strong>効率的なバッチ処理</strong>: 並列処理で高速化</li>
          <li>• <strong>キャッシュシステム</strong>: 重複リクエストを削減</li>
          <li>• <strong>フォールバック機能</strong>: 複数のAPIソースで確実性向上</li>
        </ul>
      </div>
      
      <form onSubmit={handleSubmit} className="mb-8">
        <div className="mb-4">
          <label htmlFor="urls" className="block text-sm font-medium mb-2">
            eBay URL（1行に1つ）
          </label>
                  <textarea
          id="urls"
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          className="w-full h-32 p-3 border border-gray-300 rounded-md"
          placeholder="https://www.ebay.com/itm/146571920035&#10;https://www.ebay.com/itm/146571931599&#10;https://www.ebay.com/itm/146571910867&#10;https://www.ebay.com/itm/146571897215&#10;https://www.ebay.com/itm/146571879511&#10;https://www.ebay.com/itm/146571871173&#10;https://www.ebay.com/itm/146571857274"
        />
        </div>
        
        <button
          type="submit"
          disabled={loading}
          className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded disabled:opacity-50"
        >
          {loading ? '処理中...（API効率版）' : 'ウォッチ数を取得（API効率版）'}
        </button>
      </form>

      {results && (
        <div className="space-y-6">
          {results.error ? (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
              {results.error}
            </div>
          ) : (
            <>
              {results.summary && (
                <div className="bg-blue-100 border border-blue-400 text-blue-700 px-4 py-3 rounded">
                  <h3 className="font-bold">結果サマリー</h3>
                  <p>総数: {results.summary.total}</p>
                  <p>成功: {results.summary.successful}</p>
                  <p>成功率: {results.summary.successRate}%</p>
                </div>
              )}

              <div className="space-y-4">
                <h3 className="text-xl font-semibold">詳細結果</h3>
                {results.results?.map((result: any, index: number) => (
                  <div
                    key={index}
                    className={`p-4 border rounded-lg ${
                      result.success && result.watchCount !== null
                        ? 'bg-green-50 border-green-200'
                        : 'bg-red-50 border-red-200'
                    }`}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <span className="font-medium">
                        {result.success && result.watchCount !== null ? '✅ 成功' : '❌ 失敗'}
                      </span>
                      {result.watchCount !== null && (
                        <span className="text-lg font-bold text-green-600">
                          ウォッチ数: {result.watchCount}
                        </span>
                      )}
                    </div>
                    
                    <div className="text-sm text-gray-600 mb-2">
                      <div>URL: {result.url}</div>
                      {result.itemId && <div>Item ID: {result.itemId}</div>}
                      {result.legacyId && <div>Legacy ID: {result.legacyId}</div>}
                    </div>
                    
                    {result.error && (
                      <div className="text-sm text-red-600">
                        エラー: {result.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
