import ResultsClient from "./ResultsClient";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const sellersRaw = sp.sellers;
  const sellersParam = Array.isArray(sellersRaw) ? sellersRaw.join(",") : (sellersRaw ?? "");
  const sellers = sellersParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const mpsRaw = sp.maxPerSeller;
  const mpsStr = Array.isArray(mpsRaw) ? mpsRaw[0] : mpsRaw;
  const maxPerSeller = Number(mpsStr ?? "50");
  return <ResultsClient initialSellers={sellers} initialMaxPerSeller={maxPerSeller} />;
}


