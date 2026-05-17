// app/layout.tsx
import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
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
  title: "안전톡톡",
  description: "TBM부터 AI 제안까지 한 번에",
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
        {children}
        <footer className="w-full text-center py-16 text-[14px] text-cur-muted bg-cur-canvas border-t border-cur-hairline">
          © {new Date().getFullYear()} EHS Friends. All rights reserved.
        </footer>
      </body>
    </html>
  );
}