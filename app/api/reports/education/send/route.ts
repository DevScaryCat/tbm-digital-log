import { NextResponse } from "next/server";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import { generateAndSendEducationReport } from "@/lib/educationReport";
import { resolveReportTarget } from "@/lib/org";
import { resolveMyReportEmail } from "@/lib/myEmail";
import { isValidEmail } from "@/lib/emailVerification";

export const runtime = "nodejs";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 안전보건교육일지 기간 종합 보고서 발송 — Pro 전용. (회의록 위험성평가 발송과 한 쌍)
export async function POST(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!isPro) return NextResponse.json({ error: "보고서 발송은 Pro 플랜 기능입니다." }, { status: 403 });

  const body = await request.json().catch(() => ({}));
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
  const company = String(body?.company || "").trim();
  const from = DATE_RE.test(String(body?.from)) ? String(body.from) : "";
  const to = DATE_RE.test(String(body?.to)) ? String(body.to) : from;

  if (!from) return NextResponse.json({ error: "기간이 올바르지 않습니다." }, { status: 400 });
  // 내 이메일도 없고 추가 수신자도 없으면 조용히 성공하지 않고 명시적으로 거절
  if (recipients.length === 0) return NextResponse.json({ error: "받는 이메일을 입력해주세요." }, { status: 400 });

  const admin = getAdminClient();
  // 역할 게이트(§4-C): member 발송 불가, owner는 대상 현장 지정
  const tgt = await resolveReportTarget(user.id, body?.targetUserId, admin);
  if (!tgt.ok) return NextResponse.json({ error: tgt.error }, { status: tgt.status });
  const result = await generateAndSendEducationReport(
    admin,
    tgt.targetId,
    recipients,
    (tgt.targetSiteName || company) || null,
    from,
    to
  );

  // 해당 기간에 교육일지가 없으면 발송 생략 (오류 아님 — 회의록만 있는 기간일 수 있음)
  if (result.status === "no_data") return NextResponse.json({ success: true, sent: 0, skipped: "no_data" });
  if (result.status === "mail_failed") return NextResponse.json({ error: "메일 발송 실패: " + (result.detail ?? "") }, { status: 502 });
  return NextResponse.json({ success: true, sent: recipients.length });
}
