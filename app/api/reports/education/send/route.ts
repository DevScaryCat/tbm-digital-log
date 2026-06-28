import { NextResponse } from "next/server";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import { sendMail, mailerConfigured } from "@/lib/mailer";
import { buildEducationRangeContent, renderEducationReportHtml, buildEducationAttachments } from "@/lib/educationReport";

export const runtime = "nodejs";
export const maxDuration = 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 안전교육일지 기간 종합 보고서 발송 — Pro 전용. (회의록 위험성평가 발송과 한 쌍)
export async function POST(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!isPro) return NextResponse.json({ error: "보고서 발송은 Pro 플랜 기능입니다." }, { status: 403 });
  if (!mailerConfigured()) return NextResponse.json({ error: "메일 설정이 없습니다." }, { status: 500 });

  const body = await request.json().catch(() => ({}));
  const rawRecipients: string[] = Array.isArray(body?.recipients)
    ? body.recipients.map((e: any) => String(e).trim()).filter(Boolean)
    : [];
  const recipients: string[] = [...new Set(rawRecipients)];
  const company = String(body?.company || "").trim();
  const from = DATE_RE.test(String(body?.from)) ? String(body.from) : "";
  const to = DATE_RE.test(String(body?.to)) ? String(body.to) : from;
  const date = new Date().toISOString().slice(0, 10);

  if (!from) return NextResponse.json({ error: "기간이 올바르지 않습니다." }, { status: 400 });
  if (recipients.length === 0) return NextResponse.json({ error: "받는 사람 이메일을 입력해주세요." }, { status: 400 });
  const invalid = recipients.find((e) => !EMAIL_RE.test(e));
  if (invalid) return NextResponse.json({ error: `이메일 형식 오류: ${invalid}` }, { status: 400 });

  const admin = getAdminClient();
  const periodLabel = from === to ? from : `${from} ~ ${to}`;

  const content = await buildEducationRangeContent(admin, user.id, company || null, from, to, `${periodLabel} 종합`);
  // 해당 기간에 교육일지가 없으면 발송 생략 (오류 아님 — 회의록만 있는 기간일 수 있음)
  if (!content) return NextResponse.json({ success: true, sent: 0, skipped: "no_data" });

  const html = renderEducationReportHtml(content);
  const docTitle = `${company ? company + " " : ""}안전교육일지 종합 보고서`;
  const attachments = await buildEducationAttachments(content, docTitle, date);

  const sent = await sendMail({
    to: recipients,
    subject: `[안전톡톡e] ${company ? company + " " : ""}안전교육일지 종합 보고서 (${content.periodLabel})`,
    html,
    attachments,
  });
  if (!sent.ok) return NextResponse.json({ error: "메일 발송 실패: " + (sent.error ?? "") }, { status: 502 });

  return NextResponse.json({ success: true, sent: recipients.length });
}
