import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import ClientShell from "./components/ClientShell";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "eBayセラー商品抽出ツール",
  description: "Browse APIでセラーのアクティブ出品を取得・並び替え・エクスポート",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // layoutはServer Componentのため、クライアントのオーバーレイは下のClientShellで描画
  return (
    <html lang="ja">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <div className="liquid-bg" />
        <ClientShell>{children}</ClientShell>
      </body>
    </html>
  );
}

// client shell moved to its own client component to avoid server importing the store
