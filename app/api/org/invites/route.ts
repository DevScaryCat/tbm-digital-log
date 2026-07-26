// app/api/org/invites/route.ts — 초대 관리 (안전관리자 전용)
// kind='link'  : 신규 가입용 다회용 링크 (14일 만료, 좌석 상한은 가입 시 claim_org_seat가 검증)
// kind='attach': 기존 계정 편입 초대 — 아이디({id}@tbm.com)로 대상 지정, 대상이 로그인 후 수락
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, subscriptionAllows , isProPlan} from "@/lib/portone";
import { getOrgContext } from "@/lib/org";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const admin = getAdminClient();
  const ctx = await getOrgContext(user.id, admin);
  if (ctx.kind !== "owner" || !ctx.org) {
    return NextResponse.json({ error: "안전관리자 계정만 초대를 관리할 수 있습니다." }, { status: 403 });
  }
  const { data } = await admin
    .from("org_invites")
    .select("id, token, kind, target_user_id, expires_at, used_at, created_at")
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: false })
    .limit(20);
  return NextResponse.json({ invites: data ?? [] });
}

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

    const admin = getAdminClient();
    const ctx = await getOrgContext(user.id, admin);
    if (ctx.kind !== "owner" || !ctx.org) {
      return NextResponse.json({ error: "안전관리자 계정만 초대할 수 있습니다." }, { status: 403 });
    }
    // 구독이 유효하지 않은 owner는 신규 좌석 발급·편입 불가 — 해지 후에도 하루치 무료
    // 미러가 만들어지는 경로 차단 (리뷰 C)
    {
      const { data: sub } = await admin
        .from("subscriptions")
        .select("status, plan, current_period_end, billing_key")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!sub || !subscriptionAllows(sub) || !isProPlan(sub.plan)) {
        return NextResponse.json({ error: "구독이 유효하지 않습니다. 결제를 먼저 확인해주세요." }, { status: 402 });
      }
    }

    const body = await request.json().catch(() => ({}));
    const kind = String(body.kind ?? "link");

    if (kind === "link") {
      const seatsLeft = ctx.org.seatCount - (ctx.memberIds ?? []).length;
      if (seatsLeft <= 0) {
        return NextResponse.json(
          { error: "남은 좌석이 없습니다. 좌석을 추가한 뒤 초대해주세요." },
          { status: 409 }
        );
      }
      const { data, error } = await admin
        .from("org_invites")
        .insert({ org_id: ctx.org.id, kind: "link" })
        .select("token, expires_at")
        .single();
      if (error || !data) {
        console.error("invite create error:", error);
        return NextResponse.json({ error: "초대 링크 생성 실패" }, { status: 500 });
      }
      return NextResponse.json({ success: true, token: data.token, expiresAt: data.expires_at });
    }

    if (kind === "attach") {
      const loginId = String(body.loginId ?? "").trim().toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(loginId)) {
        return NextResponse.json({ error: "아이디 형식이 올바르지 않습니다." }, { status: 400 });
      }
      const { data: targetId, error: findErr } = await admin.rpc("find_user_id_by_login_email", {
        p_email: `${loginId}@tbm.com`,
      });
      if (findErr || !targetId) {
        return NextResponse.json({ error: "해당 아이디의 계정을 찾을 수 없습니다." }, { status: 404 });
      }
      if (targetId === user.id) {
        return NextResponse.json({ error: "본인 계정은 편입할 수 없습니다." }, { status: 400 });
      }
      // 다른 조직의 안전관리자 계정은 편입 대상 불가 — 수락 시 그 회사 구독이 통째로
      // 정산·해지되는 사고 방지 (리뷰 A/의심; attach 수락 쪽에도 동일 가드)
      const { data: targetOrg } = await admin
        .from("organizations")
        .select("id")
        .eq("owner_user_id", targetId)
        .maybeSingle();
      if (targetOrg) {
        return NextResponse.json({ error: "안전관리자 계정은 편입할 수 없습니다." }, { status: 400 });
      }
      // 이미 다른 조직 소속이면 안내
      const { data: existingMember } = await admin
        .from("org_members")
        .select("org_id, status")
        .eq("member_user_id", targetId)
        .eq("status", "active")
        .maybeSingle();
      if (existingMember && existingMember.org_id !== ctx.org.id) {
        return NextResponse.json({ error: "이미 다른 조직에 소속된 계정입니다." }, { status: 409 });
      }
      if (existingMember && existingMember.org_id === ctx.org.id) {
        return NextResponse.json({ error: "이미 우리 조직에 소속된 계정입니다." }, { status: 400 });
      }
      const seatsLeft = ctx.org.seatCount - (ctx.memberIds ?? []).length;
      if (seatsLeft <= 0) {
        return NextResponse.json(
          { error: "남은 좌석이 없습니다. 좌석을 추가한 뒤 편입해주세요." },
          { status: 409 }
        );
      }
      const { data, error } = await admin
        .from("org_invites")
        .insert({ org_id: ctx.org.id, kind: "attach", target_user_id: targetId })
        .select("id, expires_at")
        .single();
      if (error || !data) {
        console.error("attach invite create error:", error);
        return NextResponse.json({ error: "편입 초대 생성 실패" }, { status: 500 });
      }
      return NextResponse.json({
        success: true,
        inviteId: data.id,
        expiresAt: data.expires_at,
        notice: "대상 계정이 다음 로그인 때 수락하면 편입됩니다.",
      });
    }

    return NextResponse.json({ error: "알 수 없는 초대 종류입니다." }, { status: 400 });
  } catch (e) {
    console.error("org invites error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const admin = getAdminClient();
  const ctx = await getOrgContext(user.id, admin);
  if (ctx.kind !== "owner" || !ctx.org) {
    return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const inviteId = searchParams.get("id");
  if (!inviteId) return NextResponse.json({ error: "id가 없습니다." }, { status: 400 });
  await admin.from("org_invites").delete().eq("id", inviteId).eq("org_id", ctx.org.id);
  return NextResponse.json({ success: true });
}
