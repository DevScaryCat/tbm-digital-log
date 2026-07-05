import { NextResponse } from "next/server";
import { formatRangeLabelKo } from "@/lib/utils";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import { buildEducationRangeContent, renderEducationReportHtml, EducationReportContent } from "@/lib/educationReport";

export const runtime = "nodejs";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 안전보건교육일지 종합 보고서 HTML 렌더 (미리보기용).
// Pro + 기간이 있으면 실제 데이터, 아니면 샘플.
export async function POST(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const from = DATE_RE.test(String(body?.from)) ? String(body.from) : "";
  const to = DATE_RE.test(String(body?.to)) ? String(body.to) : from;
  const company = (user.user_metadata as { company_name?: string })?.company_name || "";

  if (!isPro || !from) {
    return NextResponse.json({ html: renderEducationReportHtml(sampleEducation(company)) });
  }

  const admin = getAdminClient();
  const periodLabel = formatRangeLabelKo(from, to);
  const content = await buildEducationRangeContent(admin, user.id, company || null, from, to, `${periodLabel} 종합`);
  if (!content) return NextResponse.json({ html: "", empty: true });
  return NextResponse.json({ html: renderEducationReportHtml(content) });
}

function sampleEducation(company: string): EducationReportContent {
  return {
    companyName: company || "○○건설 ○○현장",
    periodLabel: "예시 기간",
    stats: { sessions: 38, days: 24, headcount: 152, avg: "4.0" },
    types: [{ type: "TBM", count: 35 }, { type: "정기 안전교육", count: 3 }],
    days: [
      { date: "2026-06-09", sessions: 1, summary: "락카칠 작업 안전·물품운반 허리부상 예방" },
      { date: "2026-06-03", sessions: 1, summary: "방독마스크 착용·요추부상 예방, 화학물질 보호" },
      { date: "2026-06-02", sessions: 2, summary: "안전화 착용·호흡보호구 필수, 미세먼지 대비" },
    ],
    keywords: ["호흡보호구 착용", "안전화 착용", "요추부상 예방", "화학물질 안전", "물품운반 안전"],
  };
}
