import { NextResponse } from "next/server";
import { getUserAndSubscription } from "@/lib/portone";
import { renderReportHtml, ReportContent } from "@/lib/monthlyReport";

export const runtime = "nodejs";

// 월간 보고서가 어떻게 발송되는지 미리보기 (샘플 데이터, AI 호출 없음)
export async function GET(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!isPro) return NextResponse.json({ error: "Pro 플랜 기능입니다." }, { status: 403 });

  const now = new Date();
  const company = (user.user_metadata as any)?.company_name || "○○건설 ○○현장";

  const sample: ReportContent = {
    companyName: company,
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    stats: { logCount: 18, minutesCount: 6, riskCount: 3, activeDays: 20, educationHours: "12.5" },
    topHazards: [
      { name: "고소작업 중 추락", count: 7 },
      { name: "중량물 취급 중 협착", count: 4 },
      { name: "전동공구 감전", count: 3 },
      { name: "정리정돈 미흡 전도", count: 2 },
    ],
    aiSummary:
      "이번 달은 총 24건의 TBM과 3건의 위험성평가가 실시되어 안전활동이 꾸준히 이행되었습니다. 고소작업 추락 위험이 반복적으로 지적되어 안전대 체결과 작업발판 점검 강화가 필요합니다. 다음 달에는 중량물 취급 시 신호수 배치를 정착시킬 것을 권고합니다.",
  };

  return NextResponse.json({ html: renderReportHtml(sample) });
}
