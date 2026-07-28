import type { MetadataRoute } from "next";

// 공개 페이지만 — 앱 내부 화면은 로그인 뒤라 검색 대상이 아니다.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://www.safetalk.kr";
  return [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/pricing`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/start`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/login`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
