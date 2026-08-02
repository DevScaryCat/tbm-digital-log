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
    .select("org_id, kind, expires_at, used_at, site_names, organizations!inner(name, seat_count)")
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

  // 감독자가 정해둔 현장명 목록 — 이미 활성 멤버가 쓰는 이름은 빼고 내려준다
  // (완벽한 선점 잠금은 아니지만, 두 명이 같은 이름을 고르는 흔치 않은 경우는
  //  감독자가 현장 관리에서 바로잡을 수 있고, 가입 자체는 막히지 않는 쪽이 낫다)
  let siteNames: string[] = [];
  const rawNames: unknown = (inv as { site_names?: unknown }).site_names;
  const preset = Array.isArray(rawNames) ? rawNames.map((n) => String(n)) : [];
  if (preset.length > 0) {
    const { data: memberRows } = await admin
      .from("org_members")
      .select("member_user_id")
      .eq("org_id", inv.org_id)
      .eq("status", "active");
    const taken = new Set<string>();
    for (const m of (memberRows ?? []) as { member_user_id: string }[]) {
      try {
        const { data: u } = await admin.auth.admin.getUserById(m.member_user_id);
        const meta = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
        const nm = String(meta.company_name ?? "").trim().toLowerCase();
        if (nm) taken.add(nm);
      } catch { /* 조회 실패한 멤버는 이름 미점유로 본다 */ }
    }
    siteNames = preset.filter((n) => !taken.has(n.trim().toLowerCase()));
  }

  return NextResponse.json({
    valid: true,
    orgName: String((inv as any).organizations?.name ?? ""),
    seatsLeft,
    siteNames,
  });
}
