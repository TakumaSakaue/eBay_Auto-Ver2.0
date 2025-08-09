"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

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

export default function Home() {
  const [sellersInput, setSellersInput] = useState("");
  const [maxPerSeller, setMaxPerSeller] = useState<number>(50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const sellersArray = useMemo(
    () =>
      sellersInput
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    [sellersInput]
  );

  async function onSearch() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellers: sellersArray, maxPerSeller }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || "検索に失敗しました");
      }
      const data = await res.json();
      const params = new URLSearchParams();
      params.set("sellers", sellersArray.join(","));
      params.set("maxPerSeller", String(maxPerSeller));
      router.push(`/results?${params.toString()}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  // トップページは検索のみのシンプルUIに

  return (
    <div className="min-h-screen px-6 py-10 max-w-6xl mx-auto">
      <header className="mb-10 text-center">
        <h1 className="text-3xl md:text-5xl font-semibold accent-text tracking-tight heading-hero">eBayセラー商品抽出ツール</h1>
        <p className="text-sm md:text-base text-gray-600 mt-3">Browse APIでセラーのアクティブ出品を取得して並び替え・エクスポート</p>
      </header>

      <section className="aurora-panel rounded-2xl p-5 md:p-7 border shadow-lg">
        <div className="grid md:grid-cols-[1fr_260px] gap-4 items-start">
          <div>
            <label className="block text-sm font-medium mb-2">セラーID（カンマ/改行区切り, 最大100件）</label>
            <textarea
              className="w-full rounded-xl p-3 border input-glass placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-300/60"
              placeholder="seller1, seller2\nまたは改行で入力"
              value={sellersInput}
              onChange={(e) => setSellersInput(e.target.value)}
            />
          </div>
          <div className="space-y-3">
            <label className="block text-sm font-medium">最大取得件数/セラー</label>
            <input
              type="number"
              min={1}
              max={1000}
              className="w-full rounded-xl p-2.5 border input-glass focus:outline-none focus:ring-2 focus:ring-blue-300/60"
              value={maxPerSeller}
              onChange={(e) => setMaxPerSeller(Number(e.target.value))}
            />
            <button
              onClick={onSearch}
              disabled={loading || sellersArray.length === 0}
              className="w-full rounded-xl py-3 btn-primary font-medium transition shadow-md"
            >
              {loading ? "検索中..." : "検索"}
            </button>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        </div>
      </section>
      {/* トップは検索のみ。結果表示は /results に遷移 */}
    </div>
  );
}
