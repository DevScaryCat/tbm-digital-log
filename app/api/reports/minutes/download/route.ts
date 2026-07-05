import { NextResponse } from "next/server";
import { formatRangeLabelKo } from "@/lib/utils";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import { buildRangeContent, buildRiskCsv, RiskItem } from "@/lib/monthlyReport";

export const runtime = "nodejs";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// TBM 회의록 종합분석(+위험성평가표)을 파일로 내려받기 (Pro).
// PDF = 결재서류(보고서 형식, 잘림 없음), CSV = 위험성평가표.
export async function POST(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!isPro) return NextResponse.json({ error: "Pro 플랜 기능입니다." }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const from = DATE_RE.test(String(body?.from)) ? String(body.from) : "";
  const to = DATE_RE.test(String(body?.to)) ? String(body.to) : from;
  const fmt = body?.format === "csv" ? "csv" : "pdf";
  const items: RiskItem[] = Array.isArray(body?.items) ? body.items : [];
  const company = (user.user_metadata as { company_name?: string })?.company_name || "";
  if (!from) return NextResponse.json({ error: "기간이 올바르지 않습니다." }, { status: 400 });

  const date = new Date().toISOString().slice(0, 10);
  const periodLabel = formatRangeLabelKo(from, to);

  if (fmt === "csv") {
    if (items.length === 0) return NextResponse.json({ error: "AI 분석 보고서 내용이 없습니다." }, { status: 400 });
    const csv = buildRiskCsv(items, { company, period: `${periodLabel} 종합`, date });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": `attachment; filename="risk_assessment_${date}.csv"`,
      },
    });
  }

  const admin = getAdminClient();
  const content = await buildRangeContent(admin, user.id, company || null, from, to);
  if (content.stats.total === 0) return NextResponse.json({ error: "해당 기간에 회의록이 없습니다." }, { status: 404 });
  if (items.length > 0) content.riskItems = items;

  const { renderApprovalPdf } = await import("@/lib/approvalPdf");
  const pdf = await renderApprovalPdf(content, `${company ? company + " " : ""}${periodLabel} TBM 회의록 종합분석 · AI 분석 보고서`);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="minutes_report_${date}.pdf"`,
    },
  });
}
