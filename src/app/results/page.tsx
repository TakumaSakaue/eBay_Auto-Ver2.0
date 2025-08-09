import { Suspense } from "react";
import ResultsClient from "./ResultsClient";
export const dynamic = "force-dynamic";

export default function ResultsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen px-6 py-10 max-w-7xl mx-auto"><p>読み込み中...</p></div>}>
      <ResultsClient />
    </Suspense>
  );
}


