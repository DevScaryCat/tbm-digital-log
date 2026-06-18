import { NextResponse } from "next/server";
import { getUserAndSubscription } from "@/lib/portone";
import { renderReportHtml, ReportContent } from "@/lib/monthlyReport";

export const runtime = "nodejs";

// 월간 보고서가 어떻게 발송되는지 미리보기 (샘플 데이터, AI 호출 없음)
export async function GET(request: Request) {
  // 샘플 데이터(실제 데이터·AI 호출 없음)라 베이직 사용자도 '예시 화면'으로 미리볼 수 있게 허용
  const { user } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const now = new Date();
  const company = (user.user_metadata as any)?.company_name || "○○건설 ○○현장";

  const sample: ReportContent = {
    companyName: company,
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    stats: { total: 16, high: 5, mid: 9 },
    keywords: [
      { word: "고소작업 중 추락", count: 7 },
      { word: "중량물 취급 중 협착", count: 4 },
      { word: "전동공구 사용 중 감전", count: 3 },
      { word: "정리정돈 미흡 전도", count: 2 },
    ],
    hazards: [
      { factor: "고소작업 중 추락", level: "상", measure: "안전대 100% 체결, 작업발판·안전난간 점검", process: "철골 고소작업", date: "2026-06-02" },
      { factor: "중량물 취급 중 협착·끼임", level: "상", measure: "신호수 배치, 인양구 결속 확인, 하부 출입통제", process: "자재 인양", date: "2026-06-05" },
      { factor: "전동공구 사용 중 감전", level: "중", measure: "누전차단기 설치, 공구 절연 점검", process: "전기 배관", date: "2026-06-08" },
      { factor: "정리정돈 미흡으로 전도", level: "중", measure: "통로 확보, 적치장 분리, 작업 후 정리정돈", process: "공통", date: "2026-06-11" },
    ],
    aiSummary:
      "이번 달은 총 16건의 TBM 회의록이 작성되어 현장 소통이 꾸준히 이행되었습니다. 고소작업 추락과 중량물 협착 위험이 반복적으로 지적되어 안전대 체결과 신호수 배치 강화가 필요합니다. 다음 달에는 작업 전 안전점검 체크리스트 정착을 권고합니다.",
  };

  return NextResponse.json({ html: renderReportHtml(sample) });
}
