// app/api/auth/email/route.ts — 실이메일 인증 메일 발송/재발송 (로그인 필요)
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { sendRealEmailVerification, isValidEmail } from "@/lib/emailVerification";
import { resolveMyReportEmail } from "@/lib/myEmail";
import { hasLinkVerifiedRecoveryEmail } from "@/lib/accountRecovery";

export const runtime = "nodejs";

/** 지금 내 보고서 수신 이메일 상태 — 내 정보 수정 화면이 읽는다 */
export async function GET(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const current = typeof meta.real_email === "string" ? meta.real_email.trim() : "";
  // 계정 복구가 실제로 가능한가 — 보고서 수신 가능(real_email_verified_at)과 기준이 다르다.
  // 온보딩은 인증 없이도 그 시각을 찍으므로, 복구는 '메일 링크를 눌렀다는 증거'까지 요구한다
  // (lib/accountRecovery.hasLinkVerifiedRecoveryEmail — 재설정 발송 조건과 같은 판정).
  const recoveryReady = current
    ? await hasLinkVerifiedRecoveryEmail(getAdminClient(), user.id, current)
    : false;
  return NextResponse.json({
    // 인증까지 끝나 실제로 보고서를 받을 수 있는 주소
    email: resolveMyReportEmail(user as never),
    // 입력은 했지만 아직 **복구가 가능하지 않은** 주소 — 화면이 '인증 대기'를 말할 수 있게.
    //
    // ⚠️ 기준은 real_email_verified_at이 아니라 recoveryReady다(2026-08-11 Chris 실기기 버그).
    //    온보딩(/api/onboarding)은 링크 인증 없이도 verified_at을 찍는다 — 바로 위 주석이 말하는
    //    그 사실이다. 그래서 종전 조건(`!verified_at`)으로는 온보딩에서 이메일을 넣은 계정이
    //    **verified도 pending도 아닌** 상태가 됐고, 앱 배너가 "복구 이메일을 등록해 두면…"이라는
    //    **등록조차 안 한 사람용 문구**를 띄웠다. 실제로는 주소가 저장돼 있고 인증만 안 끝난 것이라
    //    맞는 문구는 "인증이 아직 안 끝났어요"다. 두 값이 갈라지는 유일한 경우가 정확히
    //    이 온보딩 경로라, 판정을 recoveryReady 하나로 모은다.
    pending: current && !recoveryReady ? current : null,
    recoveryReady,
  });
}

export async function POST(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const { email } = await request.json().catch(() => ({}));
  const target = String(email ?? "").trim();
  if (!isValidEmail(target)) {
    return NextResponse.json({ error: "이메일 형식이 올바르지 않습니다." }, { status: 400 });
  }
  // 발급 계정의 가짜 도메인 — 여기로는 어떤 메일도 도착하지 않는다
  if (target.toLowerCase().endsWith("@tbm.com")) {
    return NextResponse.json({ error: "실제로 받아볼 수 있는 이메일 주소를 입력해주세요." }, { status: 400 });
  }

  const proto = request.headers.get("x-forwarded-proto") || "https";
  const host = request.headers.get("host");
  const baseUrl = host ? `${proto}://${host}` : undefined;

  const admin = getAdminClient();

  // 발송 남용 방지 3중 — 임의 주소로 보낼 수 있는 구조라(본인 수신용 이메일 입력) 폭탄 방지가 필수.
  // phone/send 라우트와 같은 DB-count 패턴: ① 60초 쿨다운(연타 차단) ② 시간당 5회 ③ 일 10회.
  const now = Date.now();
  const { data: latest } = await admin
    .from("email_verifications")
    .select("created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest?.created_at && now - new Date(latest.created_at).getTime() < 60 * 1000) {
    return NextResponse.json({ error: "잠시 후 다시 시도해주세요. (재발송은 1분에 한 번)" }, { status: 429 });
  }
  const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const [{ count: hourCount }, { count: dayCount }] = await Promise.all([
    admin.from("email_verifications").select("id", { count: "exact", head: true }).eq("user_id", user.id).gte("created_at", hourAgo),
    admin.from("email_verifications").select("id", { count: "exact", head: true }).eq("user_id", user.id).gte("created_at", dayAgo),
  ]);
  if ((hourCount ?? 0) >= 5 || (dayCount ?? 0) >= 10) {
    return NextResponse.json({ error: "인증 메일을 너무 자주 요청했습니다. 잠시 후 다시 시도해주세요." }, { status: 429 });
  }
  const r = await sendRealEmailVerification(admin, user.id, target, baseUrl);
  if (!r.ok) return NextResponse.json({ error: r.error || "인증 메일 발송 실패" }, { status: 500 });
  return NextResponse.json({ success: true, pending: target });
}
