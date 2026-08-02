import { NextResponse } from "next/server";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import { requestConsent, listAccountConsents, ensureSelfConsent } from "@/lib/consent";
import { resolveMyReportEmail } from "@/lib/myEmail";
import { getOrgContext } from "@/lib/org";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET: 수신처(승인 상태 포함)
export async function GET(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const admin = getAdminClient();
  // 역할 게이트(§4-C): 조직 하위는 출력/발송 설정 접근 불가 (owner·solo 전용)
  const ctx = await getOrgContext(user.id, admin);
  if (ctx.kind === "member") {
    return NextResponse.json({ error: "조직 소속 계정입니다. 출력/발송 설정은 회사 안전관리자가 관리합니다." }, { status: 403 });
  }
  // 내 이메일은 늘 목록에 있어야 한다 — 인증만 해두고 여기 안 보이면 화면이 어긋난다.
  // 기존 계정도 이 조회 한 번으로 따라온다(멱등).
  await ensureSelfConsent(admin, user.id, resolveMyReportEmail(user as never));
  const recipients = await listAccountConsents(admin, user.id);
  return NextResponse.json({ recipients, isPro, myEmail: resolveMyReportEmail(user as never) });
}

// POST: 수신처 추가(승인요청 메일)/삭제 (Pro 전용)
export async function POST(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!isPro) return NextResponse.json({ error: "출력/발송 설정은 Pro 플랜 기능입니다." }, { status: 403 });
  {
    // 역할 게이트(§4-C): 조직 하위는 수신처 등록 불가 (메뉴 숨김만으론 URL 직접 접근이 뚫림)
    const ctx = await getOrgContext(user.id);
    if (ctx.kind === "member") {
      return NextResponse.json({ error: "조직 소속 계정입니다. 출력/발송 설정은 회사 안전관리자가 관리합니다." }, { status: 403 });
    }
  }

  const body = await request.json().catch(() => ({}));
  const admin = getAdminClient();

  // 확인 메일 링크 주소를 요청 host에서 유도 (NEXT_PUBLIC_APP_URL 의존 제거)
  const proto = request.headers.get("x-forwarded-proto") || "https";
  const host = request.headers.get("host");
  const baseUrl = host ? `${proto}://${host}` : undefined;
  let mailNote: string | null = null;
  const companyNameOf = async (): Promise<string | null> => {
    try {
      const { data: u } = await admin.auth.admin.getUserById(user.id);
      return (u?.user?.user_metadata as any)?.company_name ?? null;
    } catch {
      return null;
    }
  };

  // ① 수신처 추가 → 승인 요청 메일 (수신자가 승인해야 실제 발송)
  if (body.addRecipient !== undefined) {
    const email = String(body.addRecipient).trim();
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "이메일 형식이 올바르지 않습니다." }, { status: 400 });
    }
    const existing = await listAccountConsents(admin, user.id);
    const dup = existing.find((r) => r.email === email);
    if (dup && dup.status !== "declined") {
      return NextResponse.json({ error: "이미 등록된 수신처입니다." }, { status: 400 });
    }
    if (existing.filter((r) => r.status !== "declined").length >= 5) {
      return NextResponse.json({ error: "수신처는 최대 5개까지 등록할 수 있습니다." }, { status: 400 });
    }
    const r = await requestConsent(admin, user.id, email, await companyNameOf(), baseUrl);
    if (!r.ok) {
      return NextResponse.json({ error: r.error || "수신처 등록에 실패했습니다." }, { status: 500 });
    }
    if (!r.mailed) mailNote = r.error || "확인 메일을 보내지 못했습니다.";
  }

  // ② 확인 메일 재발송 — 이미 등록된 '미승인' 수신처에 한정한다.
  // 무검증으로 requestConsent에 넘기면 임의 주소 무제한 발송 + 신규 upsert로 5개 상한·형식 검증까지 우회된다.
  if (body.resendRecipient !== undefined) {
    const email = String(body.resendRecipient).trim();
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "이메일 형식이 올바르지 않습니다." }, { status: 400 });
    }
    const existing = await listAccountConsents(admin, user.id);
    const row = existing.find((r) => r.email === email);
    if (!row) {
      return NextResponse.json({ error: "등록된 수신처가 아닙니다. 먼저 추가해주세요." }, { status: 400 });
    }
    if (row.status === "approved") {
      return NextResponse.json({ error: "이미 승인된 수신처예요. 재발송이 필요 없습니다." }, { status: 400 });
    }
    // 거부한 수신자에게 버튼 한 번으로 계속 조를 수 없게 — 재요청은 삭제 후 다시 추가로만.
    // (메일 본문이 "받지 않기를 누르면 앞으로 발송되지 않습니다"라고 약속한다)
    if (row.status === "declined") {
      return NextResponse.json({ error: "수신을 거부한 주소예요. 다시 요청하려면 삭제 후 추가해주세요." }, { status: 400 });
    }
    // 발송 쿨다운 60초 — 확인 메일도 남의 메일함으로 나가는 메일이라 연타를 막는다
    const { data: last } = await admin
      .from("report_recipient_consents")
      .select("last_sent_at")
      .eq("account_user_id", user.id)
      .eq("recipient_email", email)
      .maybeSingle();
    if (last?.last_sent_at && Date.now() - new Date(last.last_sent_at).getTime() < 60 * 1000) {
      return NextResponse.json({ error: "잠시 후 다시 시도해주세요. (재발송은 1분에 한 번)" }, { status: 429 });
    }
    const r = await requestConsent(admin, user.id, email, await companyNameOf(), baseUrl);
    if (!r.mailed) mailNote = r.error || "확인 메일을 보내지 못했습니다.";
  }

  // ③ 수신처 삭제
  if (body.removeRecipient !== undefined) {
    const target = String(body.removeRecipient).trim();
    // 내 이메일은 지울 수 없다(Chris) — 지우면 "설정은 다 했는데 아무도 못 받는" 상태가 다시 생긴다.
    // 받고 싶지 않으면 발송 주기를 끄면 된다(그쪽이 의도를 정확히 표현한다).
    const mine = resolveMyReportEmail(user as never);
    if (mine && target.toLowerCase() === mine.toLowerCase()) {
      return NextResponse.json(
        { error: "내 이메일은 수신처에서 뺄 수 없어요. 받지 않으려면 발송 주기를 꺼주세요." },
        { status: 400 }
      );
    }
    await admin
      .from("report_recipient_consents")
      .delete()
      .eq("account_user_id", user.id)
      .eq("recipient_email", target);
  }

  const recipients = await listAccountConsents(admin, user.id);
  return NextResponse.json({ success: true, recipients, mailed: !mailNote, mailNote });
}
