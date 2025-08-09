"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
// Excel出力は不要のため削除

type Item = {
  sellerId: string | null;
  itemId: string | null;
  title: string | null;
  priceValue: number | null; // 使わないが型は保持
  priceCurrency: string | null; // 使わないが型は保持
  watchCount: number | null;
  url: string | null;
  listedAt?: string | null;
};

export default function ResultsClient({ initialSellers, initialMaxPerSeller }: { initialSellers: string[]; initialMaxPerSeller: number }) {
  const sellers = initialSellers;
  const maxPerSeller = initialMaxPerSeller;
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const run = async () => {
      try {
        setLoading(true);
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sellers, maxPerSeller }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        setItems(data.items as Item[]);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    };
    if (sellers.length) run();
  }, [sellers, maxPerSeller]);

  function exportCSV() {
    const header = ["title", "watchCount", "url"]; // 商品名, Watch数, URL
    const rows = items.map((it) => [
      it.title ?? "",
      it.watchCount ?? "",
      it.url ?? "",
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
          <h2 className="text-2xl md:text-3xl font-semibold accent-text">検索結果</h2>
          <p className="text-xs text-gray-600 mt-1">セラー: {sellers.join(", ")}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={exportCSV}
            disabled={items.length === 0}
            className="rounded-lg border py-2 px-3 input-glass hover:bg-white/40 transition disabled:opacity-50"
          >
            CSV
          </button>
        </div>
      </header>

      <section className="aurora-panel rounded-xl p-4 md:p-5 border shadow-sm overflow-auto">
        {loading && <p>読み込み中...</p>}
        {error && <p className="text-red-600">{error}</p>}
        {!loading && !error && (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-gray-600">
                <th className="px-2 py-2 text-center">商品名</th>
                <th className="px-2 py-2 text-center">Watch数</th>
                <th className="px-2 py-2 text-center">URL</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={`${it.itemId}-${idx}`} className="odd:bg-white/40 even:bg-white/20">
                  <td className="px-2 py-2 max-w-[520px] text-center">{it.title ?? "-"}</td>
                  <td className="px-2 py-2 whitespace-nowrap text-center">{it.watchCount ?? "-"}</td>
                  <td className="px-2 py-2 max-w-[280px] truncate text-center">
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
              {items.length === 0 && !loading && !error && (
                <tr>
                  <td className="px-2 py-6 text-center text-gray-600" colSpan={3}>該当する出品は見つかりませんでした。</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}


