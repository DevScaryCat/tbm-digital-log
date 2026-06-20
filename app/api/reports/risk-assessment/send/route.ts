import { NextResponse } from "next/server";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import { sendMail, mailerConfigured } from "@/lib/mailer";
import { buildRangeContent, renderReportHtml, buildReportAttachments, RiskItem, ReportContent } from "@/lib/monthlyReport";

export const runtime = "nodejs";
export const maxDuration = 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!isPro) return NextResponse.json({ error: "보고서 발송은 Pro 플랜 기능입니다." }, { status: 403 });
  if (!mailerConfigured()) return NextResponse.json({ error: "메일 설정이 없습니다." }, { status: 500 });

  const body = await request.json().catch(() => ({}));
  const items: RiskItem[] = Array.isArray(body?.items) ? body.items : [];
  const rawRecipients: string[] = Array.isArray(body?.recipients)
    ? body.recipients.map((e: any) => String(e).trim()).filter(Boolean)
    : [];
  const recipients: string[] = [...new Set(rawRecipients)];
  const period = String(body?.period || "").trim() || "위험성평가";
  const company = String(body?.company || "").trim();
  const from = DATE_RE.test(String(body?.from)) ? String(body.from) : "";
  const to = DATE_RE.test(String(body?.to)) ? String(body.to) : from;
  const date = new Date().toISOString().slice(0, 10);

  if (items.length === 0) return NextResponse.json({ error: "보낼 위험성평가 내용이 없습니다." }, { status: 400 });
  if (recipients.length === 0) return NextResponse.json({ error: "받는 사람 이메일을 입력해주세요." }, { status: 400 });
  const invalid = recipients.find((e) => !EMAIL_RE.test(e));
  if (invalid) return NextResponse.json({ error: `이메일 형식 오류: ${invalid}` }, { status: 400 });

  const admin = getAdminClient();

  // 통합 템플릿: 그 기간 TBM 회의록 종합분석 + 위험성평가 엑셀표
  const content: ReportContent = from
    ? await buildRangeContent(admin, user.id, company || null, from, to)
    : { companyName: company || null, periodLabel: period, stats: { total: 0, high: 0, mid: 0 }, keywords: [], hazards: [], aiSummary: "" };
  content.riskItems = items;

  const html = renderReportHtml(content);
  const docTitle = `${company ? company + " " : ""}TBM 회의록 종합분석 · 위험성평가 결재 보고서`;
  const attachments = await buildReportAttachments(content, docTitle, date);

  const sent = await sendMail({
    to: recipients,
    subject: `[안전톡톡e] ${company ? company + " " : ""}TBM 회의록 분석 · 위험성평가 (${content.periodLabel})`,
    html,
    attachments,
  });
  if (!sent.ok) return NextResponse.json({ error: "메일 발송 실패: " + (sent.error ?? "") }, { status: 502 });

  return NextResponse.json({ success: true, sent: recipients.length });
}
