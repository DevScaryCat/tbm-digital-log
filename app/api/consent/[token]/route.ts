import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/portone";
import { getConsentByToken, respondConsent } from "@/lib/consent";

export const runtime = "nodejs";

function maskEmail(e: string): string {
  const [u, d] = e.split("@");
  if (!d) return e;
  const head = u.length <= 2 ? u : u.slice(0, 2) + "*".repeat(Math.max(1, u.length - 2));
  return `${head}@${d}`;
}

// 승인 페이지가 표시할 정보 (무인증 — 토큰이 곧 권한)
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const admin = getAdminClient();
  const info = await getConsentByToken(admin, token);
  if (!info) return NextResponse.json({ error: "잘못된 링크입니다." }, { status: 404 });
  return NextResponse.json({
    site: info.site,
    email: maskEmail(info.consent.recipient_email),
    status: info.consent.status,
  });
}

// 수신자 응답(승인/거부) — 변경은 POST에서만 (GET 프리페치로 자동 승인되지 않도록)
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = await req.json().catch(() => ({}));
  const admin = getAdminClient();
  const r = await respondConsent(admin, token, body?.approve === true);
  if (!r.ok) return NextResponse.json({ error: "처리 실패 — 잘못되었거나 만료된 링크입니다." }, { status: 400 });
  return NextResponse.json({ success: true, status: r.status });
}
