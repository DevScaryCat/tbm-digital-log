// app/api/auth/email/route.ts — 실이메일 인증 메일 발송/재발송 (로그인 필요)
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { sendRealEmailVerification, isValidEmail } from "@/lib/emailVerification";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const { email } = await request.json().catch(() => ({}));
  const target = String(email ?? "").trim();
  if (!isValidEmail(target)) {
    return NextResponse.json({ error: "이메일 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const proto = request.headers.get("x-forwarded-proto") || "https";
  const host = request.headers.get("host");
  const baseUrl = host ? `${proto}://${host}` : undefined;

  const admin = getAdminClient();

  // 발송 남용 방지: 계정당 시간당 5회 (스팸 발신지화 + 토큰 행 무한 증가 차단)
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await admin
    .from("email_verifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("created_at", hourAgo);
  if ((count ?? 0) >= 5) {
    return NextResponse.json({ error: "인증 메일을 너무 자주 요청했습니다. 잠시 후 다시 시도해주세요." }, { status: 429 });
  }
  const r = await sendRealEmailVerification(admin, user.id, target, baseUrl);
  if (!r.ok) return NextResponse.json({ error: r.error || "인증 메일 발송 실패" }, { status: 500 });
  return NextResponse.json({ success: true });
}
