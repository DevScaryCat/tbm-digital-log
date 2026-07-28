import type { MetadataRoute } from "next";

// 토큰 기반 공개 문서(월간 보고서·수신 동의·이메일 인증·초대 가입)는 검색엔진에 나오면 안 된다.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/admin/", "/report/", "/consent/", "/verify-email/", "/join/"],
    },
    sitemap: "https://www.safetalk.kr/sitemap.xml",
  };
}
