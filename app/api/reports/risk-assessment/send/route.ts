import { NextResponse } from "next/server";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import { sendMail, mailerConfigured } from "@/lib/mailer";
import { buildRangeContent, renderReportHtml, buildReportAttachments, RiskItem, ReportContent, sanitizeRiskItems } from "@/lib/monthlyReport";
import { resolveReportTarget } from "@/lib/org";
import { resolveMyReportEmail } from "@/lib/myEmail";
import { isValidEmail } from "@/lib/emailVerification";

export const runtime = "nodejs";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!isPro) return NextResponse.json({ error: "보고서 발송은 Pro 플랜 기능입니다." }, { status: 403 });
  if (!mailerConfigured()) return NextResponse.json({ error: "메일 설정이 없습니다." }, { status: 500 });

  const body = await request.json().catch(() => ({}));
  const items: RiskItem[] = sanitizeRiskItems(body?.items);
  // 수신자 결정은 서버가 보장: 내 이메일(인증 real_email > 카카오) 자동 포함 + 추가 수신자는 최대 3명으로 절단
  const myEmail = resolveMyReportEmail(user);
  // 클라이언트(분석 보고서 페이지)는 emails로 보낸다 — recipients는 구버전 탭 호환 폴백
  const rawList = Array.isArray(body?.emails) ? body.emails : Array.isArray(body?.recipients) ? body.recipients : [];
  const rawRecipients: string[] = rawList.map((e: unknown) => String(e).trim()).filter(Boolean);
  // 중복·상한 판정은 소문자 키로 — 표기만 다른 같은 주소에 2통 가거나, 추가 칸에 적은
  // 내 이메일이 3명 상한 슬롯을 잡아먹으면 안 된다 (발송 주소는 입력 원문 유지)
  const seen = new Set<string>(myEmail ? [myEmail.toLowerCase()] : []);
  const extras: string[] = [];
  for (const e of rawRecipients) {
    const k = e.toLowerCase();
    if (seen.has(k) || extras.length >= 3) continue;
    seen.add(k);
    extras.push(e);
  }
  const invalid = extras.find((e) => !isValidEmail(e));
  if (invalid) return NextResponse.json({ error: `이메일 형식 오류: ${invalid}` }, { status: 400 });
  const recipients: string[] = myEmail ? [myEmail, ...extras] : extras;
  const period = String(body?.period || "").trim() || "AI 분석 보고서";
  const company = String(body?.company || "").trim();
  const from = DATE_RE.test(String(body?.from)) ? String(body.from) : "";
  const to = DATE_RE.test(String(body?.to)) ? String(body.to) : from;
  const date = new Date().toISOString().slice(0, 10);

  if (items.length === 0) return NextResponse.json({ error: "보낼 AI 분석 보고서 내용이 없습니다." }, { status: 400 });
  // 내 이메일도 없고 추가 수신자도 없으면 조용히 성공하지 않고 명시적으로 거절
  if (recipients.length === 0) return NextResponse.json({ error: "받는 이메일을 입력해주세요." }, { status: 400 });

  const admin = getAdminClient();

  // 역할 게이트(§4-C): member는 발송 불가(임의 이메일 발송 차단 — 결정 4), owner는 대상 현장 지정
  const tgt = await resolveReportTarget(user.id, body?.targetUserId, admin);
  if (!tgt.ok) return NextResponse.json({ error: tgt.error }, { status: tgt.status });
  const companyName = tgt.targetSiteName || company;

  // 통합 템플릿: 그 기간 TBM 회의록 종합분석 + 위험요인 분석 표
  const content: ReportContent = from
    ? await buildRangeContent(admin, tgt.targetId, companyName || null, from, to)
    : { companyName: companyName || null, periodLabel: period, stats: { total: 0, high: 0, mid: 0 }, keywords: [], hazards: [], aiSummary: "" };
  content.riskItems = items;

  const html = renderReportHtml(content);
  const docTitle = `${companyName ? companyName + " " : ""}TBM 회의록 종합분석 · AI 분석 보고서(결재)`;
  const attachments = await buildReportAttachments(content, docTitle, date);

  const sent = await sendMail({
    to: recipients,
    subject: `[안톡] ${companyName ? companyName + " " : ""}TBM 회의록 분석 · AI 분석 보고서 (${content.periodLabel})`,
    html,
    attachments,
  });
  if (!sent.ok) return NextResponse.json({ error: "메일 발송 실패: " + (sent.error ?? "") }, { status: 502 });

  return NextResponse.json({ success: true, sent: recipients.length });
}
