import { NextResponse } from "next/server";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import { requestConsent, listAccountConsents } from "@/lib/consent";
import { getOrgContext } from "@/lib/org";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET: 수신처(승인 상태 포함)
export async function GET(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const admin = getAdminClient();
  // 역할 게이트(§4-C): 조직 하위는 보고서 설정 접근 불가 (owner·solo 전용)
  const ctx = await getOrgContext(user.id, admin);
  if (ctx.kind === "member") {
    return NextResponse.json({ error: "조직 소속 계정입니다. 보고서 설정은 회사 안전관리자가 관리합니다." }, { status: 403 });
  }
  const recipients = await listAccountConsents(admin, user.id);
  return NextResponse.json({ recipients, isPro });
}

// POST: 수신처 추가(승인요청 메일)/삭제 (Pro 전용)
export async function POST(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!isPro) return NextResponse.json({ error: "보고서 설정은 Pro 플랜 기능입니다." }, { status: 403 });
  {
    // 역할 게이트(§4-C): 조직 하위는 수신처 등록 불가 (메뉴 숨김만으론 URL 직접 접근이 뚫림)
    const ctx = await getOrgContext(user.id);
    if (ctx.kind === "member") {
      return NextResponse.json({ error: "조직 소속 계정입니다. 보고서 설정은 회사 안전관리자가 관리합니다." }, { status: 403 });
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

  // ② 확인 메일 재발송 (대기중 수신처)
  if (body.resendRecipient !== undefined) {
    const r = await requestConsent(admin, user.id, String(body.resendRecipient).trim(), await companyNameOf(), baseUrl);
    if (!r.mailed) mailNote = r.error || "확인 메일을 보내지 못했습니다.";
  }

  // ③ 수신처 삭제
  if (body.removeRecipient !== undefined) {
    await admin
      .from("report_recipient_consents")
      .delete()
      .eq("account_user_id", user.id)
      .eq("recipient_email", String(body.removeRecipient).trim());
  }

  const recipients = await listAccountConsents(admin, user.id);
  return NextResponse.json({ success: true, recipients, mailed: !mailNote, mailNote });
}
