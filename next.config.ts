import type { NextConfig } from "next";

// 결재서류 PDF(lib/approvalPdf)의 한글 폰트(lib/fonts, 약 4MB)를 **그 폰트를 실제로 쓰는
// 라우트에만** 번들한다. 종전 "/api/**" 글롭은 API 함수 71개 전부에 4MB를 실어
// 배포 ~252MiB 낭비 + 모든 함수의 콜드스타트를 늦췄다(2026-08-19 성능 감사).
// 새 라우트가 buildReportAttachments / buildEducationAttachments / approvalPdf를 쓰게 되면
// 반드시 여기 추가할 것 — 누락 시 send류는 PDF 첨부만 조용히 빠지고(try-catch),
// download류는 500이 난다. approvalPdf의 폰트 로드 실패 메시지가 이 파일을 가리킨다.
const PDF_FONT_ROUTES = [
  "/api/reports/minutes/download",
  "/api/reports/education/download",
  "/api/reports/send",
  "/api/reports/risk-assessment/send",
  "/api/cron/monthly-report",
  "/api/cron/weekly-report",
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  outputFileTracingIncludes: Object.fromEntries(PDF_FONT_ROUTES.map((r) => [r, ["./lib/fonts/**"]])),
};

export default nextConfig;
