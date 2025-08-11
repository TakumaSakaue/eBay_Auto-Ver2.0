"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
// Excel出力は不要のため削除

type Item = {
  sellerId: string | null;
  itemId: string | null;
  title: string | null;
  priceValue: number | null;
  priceCurrency: string | null;
  watchCount: number | null;
  url: string | null;
  listedAt?: string | null;
};

type SortField = 'price' | 'date' | null;
type SortDirection = 'asc' | 'desc';

type ResultsMeta = {
  sellers: string[];
  maxPerSeller: number;
  total: number;
  titleSearch: string | null;
  originalTotal: number;
  isMockMode?: boolean;
};

export default function ResultsClient({ 
  initialSellers, 
  initialMaxPerSeller, 
  initialTitleSearch 
}: { 
  initialSellers: string[]; 
  initialMaxPerSeller: number; 
  initialTitleSearch: string;
}) {
  const sellers = initialSellers;
  const maxPerSeller = initialMaxPerSeller;
  const titleSearch = initialTitleSearch;
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<ResultsMeta | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [sortField, setSortField] = useState<SortField>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  useEffect(() => {
    const run = async () => {
      try {
        setLoading(true);
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            sellers, 
            maxPerSeller,
            titleSearch: titleSearch.trim()
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        setItems(data.items as Item[]);
        setMeta(data.meta);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    };
    if (sellers.length) run();
  }, [sellers, maxPerSeller, titleSearch]);

  // お気に入りをローカルに永続化（検索を跨いでも保持）
  useEffect(() => {
    try {
      const raw = localStorage.getItem("ebay_favorites_item_ids");
      if (raw) {
        const arr: string[] = JSON.parse(raw);
        setFavorites(new Set(arr.filter(Boolean)));
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const arr = Array.from(favorites);
      localStorage.setItem("ebay_favorites_item_ids", JSON.stringify(arr));
    } catch {}
  }, [favorites]);

  // お気に入りを切り替える関数
  const toggleFavorite = (itemId: string) => {
    setFavorites(prev => {
      const newFavorites = new Set(prev);
      if (newFavorites.has(itemId)) {
        newFavorites.delete(itemId);
      } else {
        newFavorites.add(itemId);
      }
      return newFavorites;
    });
  };

  // ソート機能
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  // アイテムをソート
  const sortItems = (items: Item[]): Item[] => {
    if (!sortField) return items;

    return [...items].sort((a, b) => {
      let aValue: number = 0;
      let bValue: number = 0;

      if (sortField === 'price') {
        aValue = a.priceValue ?? 0;
        bValue = b.priceValue ?? 0;
      } else if (sortField === 'date') {
        aValue = a.listedAt ? new Date(a.listedAt).getTime() : 0;
        bValue = b.listedAt ? new Date(b.listedAt).getTime() : 0;
      } else {
        return 0;
      }

      if (sortDirection === 'asc') {
        return aValue - bValue;
      } else {
        return bValue - aValue;
      }
    });
  };

  // お気に入り商品のみをフィルタリング
  const filteredItems = showFavoritesOnly 
    ? items.filter(item => item.itemId && favorites.has(item.itemId))
    : items;

  // ソートを適用
  const sortedItems = sortItems(filteredItems);

  // 日付をフォーマットする関数
  const formatDate = (dateString?: string | null): string => {
    if (!dateString) return "-";
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).replace(/\//g, '/');
    } catch {
      return "-";
    }
  };

  // 価格をフォーマットする関数
  const formatPrice = (price: number | null, currency: string | null): string => {
    if (price === null) return "-";
    const currencySymbol = currency === 'USD' ? '$' : currency || '$';
    return `${currencySymbol}${price.toFixed(2)}`;
  };

  function exportCSV() {
    const header = ["sellerId", "title", "price", "listedAt", "url", "favorite"]; // セラーID, 商品名, 価格, 出品日, URL, お気に入り
    const rows = items.map((it) => [
      it.sellerId ?? "",
      it.title ?? "",
      formatPrice(it.priceValue, it.priceCurrency),
      formatDate(it.listedAt ?? null),
      it.url ?? "",
      it.itemId && favorites.has(it.itemId) ? "★" : "",
    ]);
    const csv = [header, ...rows]
      .map((r) =>
        r
          .map((v) => (typeof v === "string" && v.includes(",")) ? `"${v.replaceAll('"', '""')}"` : String(v))
          .join(",")
      )
      .join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ebay_seller_items.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // セラーごとにアイテムをグループ化
  const itemsBySeller = sortedItems.reduce((acc, item) => {
    const sellerId = item.sellerId || "Unknown";
    if (!acc[sellerId]) {
      acc[sellerId] = [];
    }
    acc[sellerId].push(item);
    return acc;
  }, {} as Record<string, Item[]>);

  // ソートボタンコンポーネント
  const SortButton = ({ field, label }: { field: SortField; label: string }) => {
    const isActive = sortField === field;
    const direction = isActive ? sortDirection : null;
    
    return (
      <button
        onClick={() => handleSort(field)}
        className={`px-2 py-1 text-xs rounded border transition-colors flex items-center gap-1 ${
          isActive 
            ? 'bg-blue-100 border-blue-300 text-blue-700' 
            : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
        }`}
        title={`${label}でソート (${direction === 'asc' ? '昇順' : '降順'})`}
      >
        {label}
        {isActive && (
          <svg 
            className={`w-3 h-3 transition-transform ${direction === 'asc' ? 'rotate-180' : ''}`}
            fill="none" 
            stroke="currentColor" 
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
          </svg>
        )}
      </button>
    );
  };

  // Excel出力は削除

  return (
    <div className="min-h-screen px-6 py-10 max-w-7xl mx-auto">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="inline-flex items-center justify-center w-9 h-9 rounded-full input-glass border hover:bg-white/40 transition" aria-label="Home">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-slate-700">
              <path d="M11.47 3.84a.75.75 0 0 1 1.06 0l8.69 8.69a.75.75 0 1 1-1.06 1.06l-.9-.9V20.5a2 2 0 0 1-2 2h-3.25a.75.75 0 0 1-.75-.75v-4.5a.75.75 0 0 0-.75-.75h-2.5a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 1-.75.75H4.5a2 2 0 0 1-2-2v-7.81l-.9.9a.75.75 0 1 1-1.06-1.06l8.69-8.69Z"/>
            </svg>
          </Link>
          <div>
            <h2 className="text-2xl md:text-3xl font-semibold accent-text">検索結果</h2>
            <div className="text-xs text-gray-600 mt-1">
              <p>セラー: {sellers.join(", ")}</p>
              {titleSearch && (
                <p>タイトル検索: 「{titleSearch}」</p>
              )}
              {meta && (
                <p>
                  表示件数: {filteredItems.length}件
                  {showFavoritesOnly && (
                    <span className="text-yellow-600"> (★: {favorites.size}件)</span>
                  )}
                  {meta.originalTotal !== meta.total && (
                    <span className="text-gray-500"> (全{meta.originalTotal}件からフィルタリング)</span>
                  )}
                </p>
              )}
              {meta?.isMockMode && (
                <p className="text-orange-600 font-medium">
                  ⚠️ モックモード: eBay API認証情報が設定されていないため、テスト用のサンプルデータを表示しています
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
            className={`rounded-lg border p-2 input-glass hover:bg-white/40 transition ${
              showFavoritesOnly ? 'bg-yellow-100 border-yellow-300' : ''
            }`}
            aria-label={showFavoritesOnly ? "★フィルタ解除" : "★のみ表示"}
            title={showFavoritesOnly ? "★フィルタ解除" : "★のみ表示"}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill={showFavoritesOnly ? "currentColor" : "none"}
              stroke="currentColor"
              className={`w-5 h-5 ${showFavoritesOnly ? 'text-yellow-600' : 'text-gray-600'}`}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
              />
            </svg>
          </button>
          <button
            onClick={exportCSV}
            disabled={items.length === 0}
            className="rounded-lg border py-2 px-3 input-glass hover:bg-white/40 transition disabled:opacity-50"
          >
            CSV
          </button>
        </div>
      </header>

      {loading && (
        <section className="aurora-panel rounded-xl p-4 md:p-5 border shadow-sm">
          <p>読み込み中...</p>
        </section>
      )}
      
      {error && (
        <section className="aurora-panel rounded-xl p-4 md:p-5 border shadow-sm">
          <p className="text-red-600">{error}</p>
        </section>
      )}
      
      {!loading && !error && (
        <div className="space-y-6">
          {Object.keys(itemsBySeller).length === 0 ? (
            <section className="aurora-panel rounded-xl p-4 md:p-5 border shadow-sm">
              <p className="text-center text-gray-600">
                {showFavoritesOnly 
                  ? "★に登録された商品はありません。" 
                  : titleSearch 
                    ? `「${titleSearch}」を含む商品は見つかりませんでした。` 
                    : "該当する出品は見つかりませんでした。"
                }
              </p>
            </section>
          ) : (
            Object.entries(itemsBySeller).map(([sellerId, sellerItems]) => (
              <section key={sellerId} className="aurora-panel rounded-xl p-4 md:p-5 border shadow-sm">
                <div className="mb-4">
                  <h3 className="text-lg font-semibold text-blue-700 mb-2">セラー: {sellerId}</h3>
                  <p className="text-sm text-gray-600">
                    商品数: {sellerItems.length}件
                  </p>
                </div>
                
                <div className="overflow-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-gray-600 border-b">
                        <th className="px-2 py-2 text-center w-12">★</th>
                        <th className="px-2 py-2 text-left">商品名</th>
                        <th className="px-2 py-2 text-center">
                          <div className="flex items-center justify-center gap-1">
                            Price
                            <SortButton field="price" label="価格" />
                          </div>
                        </th>
                        <th className="px-2 py-2 text-center">
                          <div className="flex items-center justify-center gap-1">
                            出品日
                            <SortButton field="date" label="日付" />
                          </div>
                        </th>
                        <th className="px-2 py-2 text-center">URL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sellerItems.map((it, idx) => (
                        <tr key={`${it.itemId}-${idx}`} className="odd:bg-white/40 even:bg-white/20">
                          <td className="px-2 py-2 text-center">
                            {it.itemId && (
                              <button
                                onClick={() => toggleFavorite(it.itemId!)}
                                className="p-1 hover:bg-yellow-100 rounded transition-colors"
                                title={favorites.has(it.itemId!) ? "★から削除" : "★に追加"}
                              >
                                <svg 
                                  xmlns="http://www.w3.org/2000/svg" 
                                  viewBox="0 0 24 24" 
                                  fill={favorites.has(it.itemId!) ? "currentColor" : "none"}
                                  stroke="currentColor"
                                  className={`w-4 h-4 ${favorites.has(it.itemId!) ? 'text-yellow-500' : 'text-gray-400'}`}
                                >
                                  <path 
                                    strokeLinecap="round" 
                                    strokeLinejoin="round" 
                                    strokeWidth={2} 
                                    d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" 
                                  />
                                </svg>
                              </button>
                            )}
                          </td>
                          <td className="px-2 py-2 max-w-[400px]">{it.title ?? "-"}</td>
                          <td className="px-2 py-2 whitespace-nowrap text-center font-medium">
                            {formatPrice(it.priceValue, it.priceCurrency)}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap text-center">
                            {formatDate(it.listedAt ?? null)}
                          </td>
                          <td className="px-2 py-2 max-w-[200px] truncate text-center">
                            {it.url ? (
                              <a className="text-blue-700 underline" href={it.url} target="_blank" rel="noreferrer">
                                Link
                              </a>
                            ) : (
                              "-"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))
          )}
        </div>
      )}
    </div>
  );
}


