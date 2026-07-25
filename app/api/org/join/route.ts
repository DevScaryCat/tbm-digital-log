// app/api/org/join/route.ts — 초대 링크 정보 조회 (무로그인, /join/[token] 가입 위저드용)
// 토큰 유효성 + 조직명 + 좌석 여유만 노출한다. 민감정보 없음.
import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/portone";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");
  if (!token) return NextResponse.json({ valid: false, error: "토큰이 없습니다." }, { status: 400 });

  const admin = getAdminClient();
  const { data: inv } = await admin
    .from("org_invites")
    .select("org_id, kind, expires_at, used_at, organizations!inner(name, seat_count)")
    .eq("token", token)
    .eq("kind", "link")
    .maybeSingle();

  if (!inv || new Date(inv.expires_at) <= new Date()) {
    return NextResponse.json({ valid: false, error: "초대 링크가 유효하지 않거나 만료되었습니다." });
  }

  const { count } = await admin
    .from("org_members")
    .select("member_user_id", { count: "exact", head: true })
    .eq("org_id", inv.org_id)
    .eq("status", "active");
  const seatCount = Number((inv as any).organizations?.seat_count) || 1;
  const seatsLeft = Math.max(0, seatCount - (count ?? 0));

  return NextResponse.json({
    valid: true,
    orgName: String((inv as any).organizations?.name ?? ""),
    seatsLeft,
  });
}
