import { NextResponse } from "next/server";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import { buildRangeContent, renderReportHtml, ReportContent, RiskItem } from "@/lib/monthlyReport";

export const runtime = "nodejs";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// TBM 회의록 종합분석 보고서 HTML 렌더 (미리보기용).
// Pro + 기간이 있으면 실제 데이터(+위험성평가표 items), 아니면 샘플.
export async function POST(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const from = DATE_RE.test(String(body?.from)) ? String(body.from) : "";
  const to = DATE_RE.test(String(body?.to)) ? String(body.to) : from;
  const items: RiskItem[] = Array.isArray(body?.items) ? body.items : [];
  const company = (user.user_metadata as { company_name?: string })?.company_name || "";

  if (!isPro || !from) {
    return NextResponse.json({ html: renderReportHtml(sampleMinutes(company)) });
  }

  const admin = getAdminClient();
  const content = await buildRangeContent(admin, user.id, company || null, from, to);
  if (content.stats.total === 0) {
    return NextResponse.json({ html: "", empty: true });
  }
  if (items.length > 0) content.riskItems = items;
  return NextResponse.json({ html: renderReportHtml(content) });
}

function sampleMinutes(company: string): ReportContent {
  return {
    companyName: company || "○○건설 ○○현장",
    periodLabel: "예시 기간",
    stats: { total: 16, high: 5, mid: 9 },
    keywords: [
      { word: "고소작업 중 추락", count: 7 },
      { word: "중량물 취급 중 협착", count: 4 },
      { word: "전동공구 사용 중 감전", count: 3 },
    ],
    hazards: [
      { factor: "고소작업 중 추락", level: "상", measure: "안전대 100% 체결, 작업발판·안전난간 점검", process: "철골 고소작업", date: "2026-06-02" },
      { factor: "중량물 취급 중 협착·끼임", level: "상", measure: "신호수 배치, 인양구 결속 확인, 하부 출입통제", process: "자재 인양", date: "2026-06-05" },
      { factor: "전동공구 사용 중 감전", level: "중", measure: "누전차단기 설치, 공구 절연 점검", process: "전기 배관", date: "2026-06-08" },
    ],
    aiSummary:
      "이번 기간은 고소작업 추락과 중량물 협착 위험이 반복적으로 지적되었습니다. 안전대 체결과 신호수 배치를 강화하고, 작업 전 안전점검 체크리스트를 정착시킬 것을 권고합니다.",
  };
}
