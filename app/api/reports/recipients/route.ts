import { NextResponse } from "next/server";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import { normMethod, normMatrix } from "@/lib/riskMatrix";
import { requestConsent, listAccountConsents } from "@/lib/consent";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function getRiskSettings(admin: ReturnType<typeof getAdminClient>, userId: string, isPro: boolean) {
  const { data } = await admin
    .from("subscriptions")
    .select("risk_assessment_method, risk_matrix")
    .eq("user_id", userId)
    .maybeSingle();
  return {
    riskMethod: isPro ? normMethod(data?.risk_assessment_method) : "level3",
    riskMatrix: normMatrix(data?.risk_matrix),
  };
}

// GET: 수신처(승인 상태 포함) + 위험성평가 방법
export async function GET(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const admin = getAdminClient();
  const recipients = await listAccountConsents(admin, user.id);
  const risk = await getRiskSettings(admin, user.id, isPro);
  return NextResponse.json({ recipients, ...risk, isPro });
}

// POST: 수신처 추가(승인요청 메일)/삭제 + 위험성평가 방법 저장 (Pro 전용)
export async function POST(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!isPro) return NextResponse.json({ error: "보고서 설정은 Pro 플랜 기능입니다." }, { status: 403 });

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

  // ① 위험성평가 방법·매트릭스
  const subUpdate: Record<string, unknown> = {};
  if (body.riskMethod !== undefined) subUpdate.risk_assessment_method = normMethod(body.riskMethod);
  if (body.riskMatrix !== undefined) subUpdate.risk_matrix = normMatrix(body.riskMatrix);
  if (Object.keys(subUpdate).length > 0) {
    subUpdate.updated_at = new Date().toISOString();
    await admin.from("subscriptions").update(subUpdate).eq("user_id", user.id);
  }

  // ② 수신처 추가 → 승인 요청 메일 (수신자가 승인해야 실제 발송)
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

  // ③ 확인 메일 재발송 (대기중 수신처)
  if (body.resendRecipient !== undefined) {
    const r = await requestConsent(admin, user.id, String(body.resendRecipient).trim(), await companyNameOf(), baseUrl);
    if (!r.mailed) mailNote = r.error || "확인 메일을 보내지 못했습니다.";
  }

  // ④ 수신처 삭제
  if (body.removeRecipient !== undefined) {
    await admin
      .from("report_recipient_consents")
      .delete()
      .eq("account_user_id", user.id)
      .eq("recipient_email", String(body.removeRecipient).trim());
  }

  const recipients = await listAccountConsents(admin, user.id);
  const risk = await getRiskSettings(admin, user.id, isPro);
  return NextResponse.json({ success: true, recipients, ...risk, mailed: !mailNote, mailNote });
}
