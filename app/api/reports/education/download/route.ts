import { NextResponse } from "next/server";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import { buildEducationRangeContent, buildEducationCsv } from "@/lib/educationReport";

export const runtime = "nodejs";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 안전보건교육일지 종합을 파일로 내려받기 (Pro) — 위험성평가 페이지 '교육일지 종합' 내보내기용.
export async function GET(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!isPro) return NextResponse.json({ error: "Pro 플랜 기능입니다." }, { status: 403 });

  const url = new URL(request.url);
  const from = DATE_RE.test(url.searchParams.get("from") || "") ? url.searchParams.get("from")! : "";
  const to = DATE_RE.test(url.searchParams.get("to") || "") ? url.searchParams.get("to")! : from;
  const fmt = url.searchParams.get("format") === "pdf" ? "pdf" : "csv";
  const company = (user.user_metadata as { company_name?: string })?.company_name || "";
  if (!from) return NextResponse.json({ error: "기간이 올바르지 않습니다." }, { status: 400 });

  const admin = getAdminClient();
  const periodLabel = from === to ? from : `${from} ~ ${to}`;
  const content = await buildEducationRangeContent(admin, user.id, company || null, from, to, `${periodLabel} 종합`);
  if (!content) return NextResponse.json({ error: "해당 기간에 작성된 교육일지가 없습니다." }, { status: 404 });

  const date = new Date().toISOString().slice(0, 10);

  if (fmt === "pdf") {
    const { renderEducationApprovalPdf } = await import("@/lib/approvalPdf");
    const pdf = await renderEducationApprovalPdf(content, `${company ? company + " " : ""}안전보건교육일지 종합 보고서`);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="education_summary_${date}.pdf"`,
      },
    });
  }

  // buildEducationCsv는 BOM 포함 문자열을 반환
  return new NextResponse(buildEducationCsv(content), {
    headers: {
      "Content-Type": "text/csv;charset=utf-8",
      "Content-Disposition": `attachment; filename="education_summary_${date}.csv"`,
    },
  });
}
