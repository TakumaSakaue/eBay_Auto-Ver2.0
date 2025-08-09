import { Suspense } from "react";
import ResultsClient from "./ResultsClient";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

function ReadParams() {
  const url = typeof window !== "undefined" ? new URL(window.location.href) : undefined;
  const sellers = url ? (url.searchParams.get("sellers") ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];
  const maxPerSeller = url ? Number(url.searchParams.get("maxPerSeller") ?? "50") : 50;
  return <ResultsClient initialSellers={sellers} initialMaxPerSeller={maxPerSeller} />;
}

export default function ResultsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen px-6 py-10 max-w-7xl mx-auto"><p>読み込み中...</p></div>}>
      <ReadParams />
    </Suspense>
  );
}


