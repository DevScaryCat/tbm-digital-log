import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // 결재서류 PDF용 한글 폰트(lib/fonts)를 서버리스 함수 번들에 포함시킨다.
  outputFileTracingIncludes: {
    "/api/**": ["./lib/fonts/**"],
  },
};

export default nextConfig;
