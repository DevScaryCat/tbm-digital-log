// app/layout.tsx
import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Footer } from "@/components/Footer";
import { ConsentGate } from "@/components/ConsentGate";
import { DialogHost } from "@/components/DialogHost";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://www.safetalk.kr"),
  title: "안톡 — 현장 안전관리 AI",
  description: "더 많은 대화로 더 안전한 현장을. TBM 회의록·안전보건교육일지·AI 분석 보고서·월간 안전 보고서까지 AI로 한 번에.",
  applicationName: "안톡",
  manifest: "/manifest.json",
  openGraph: {
    title: "안톡 — 현장 안전관리 AI",
    description: "더 많은 대화로 더 안전한 현장을. TBM 회의록·안전보건교육일지·AI 분석 보고서·월간 안전 보고서까지 AI로 한 번에.",
    url: "https://www.safetalk.kr",
    siteName: "안톡",
    locale: "ko_KR",
    type: "website",
  },
};

// 구글에 사이트명 '안톡'(구 안전톡톡e)을 알리는 구조화 데이터 —
// 리브랜딩 직후 검색 결과에 옛 이름이 남는 문제의 코드 쪽 해법 (나머지는 재크롤 대기)
const SITE_JSONLD = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "안톡",
  alternateName: ["안전톡톡", "안전톡톡e", "AnTok"],
  url: "https://www.safetalk.kr",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} antialiased bg-cur-canvas text-cur-body font-sans`}
      >
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(SITE_JSONLD) }}
        />
        {children}
        <Footer />
        <ConsentGate />
        {/* 기본 alert()/confirm() 대체 — 전역에 하나만 */}
        <DialogHost />
      </body>
    </html>
  );
}