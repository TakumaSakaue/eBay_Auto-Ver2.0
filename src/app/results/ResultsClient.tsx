"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import * as XLSX from "xlsx";

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

export default function ResultsClient() {
  const sp = useSearchParams();
  const sellers = useMemo(
    () => (sp.get("sellers") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    [sp]
  );
  const maxPerSeller = Number(sp.get("maxPerSeller") ?? "50");
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
    const header = [
      "sellerId",
      "itemId",
      "title",
      "priceValue",
      "priceCurrency",
      "watchCount",
      "url",
      "listedAt",
    ];
    const rows = items.map((it) => [
      it.sellerId ?? "",
      it.itemId ?? "",
      it.title ?? "",
      it.priceValue ?? "",
      it.priceCurrency ?? "",
      it.watchCount ?? "",
      it.url ?? "",
      it.listedAt ?? "",
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

  function exportXLSX() {
    const rows = items.map((it) => ({
      sellerId: it.sellerId ?? "",
      itemId: it.itemId ?? "",
      title: it.title ?? "",
      priceValue: it.priceValue ?? "",
      priceCurrency: it.priceCurrency ?? "",
      watchCount: it.watchCount ?? "",
      url: it.url ?? "",
      listedAt: it.listedAt ?? "",
    }));
    const sheet = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Items");
    const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([wbout], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ebay_seller_items.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen px-6 py-10 max-w-7xl mx-auto">
      <header className="mb-6 flex items-center justify-between">
        <div>
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
          <button
            onClick={exportXLSX}
            disabled={items.length === 0}
            className="rounded-lg border py-2 px-3 input-glass hover:bg-white/40 transition disabled:opacity-50"
          >
            Excel
          </button>
        </div>
      </header>

      <section className="aurora-panel rounded-xl p-4 md:p-5 border shadow-sm overflow-auto">
        {loading && <p>読み込み中...</p>}
        {error && <p className="text-red-600">{error}</p>}
        {!loading && !error && (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-600">
                <th className="px-2 py-2">Title</th>
                <th className="px-2 py-2">Price</th>
                <th className="px-2 py-2">WatchCount</th>
                <th className="px-2 py-2">URL</th>
                <th className="px-2 py-2">Seller</th>
                <th className="px-2 py-2">Listing Date</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={`${it.itemId}-${idx}`} className="odd:bg-white/40 even:bg-white/20">
                  <td className="px-2 py-2 max-w-[520px]">{it.title ?? "-"}</td>
                  <td className="px-2 py-2 text-right whitespace-nowrap">
                    {it.priceValue != null && it.priceCurrency
                      ? `${it.priceValue} ${it.priceCurrency}`
                      : "-"}
                  </td>
                  <td className="px-2 py-2 text-center">
                    {typeof it.watchCount === "number" ? it.watchCount : "—"}
                  </td>
                  <td className="px-2 py-2 max-w-[280px] truncate">
                    {it.url ? (
                      <a className="text-blue-700 underline" href={it.url} target="_blank" rel="noreferrer">
                        Link
                      </a>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="px-2 py-2">{it.sellerId ?? "-"}</td>
                  <td className="px-2 py-2">{it.listedAt ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}


