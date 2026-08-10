// app/api/org/invites/route.ts — 초대 관리 (안전관리자 전용)
// kind='link'  : 신규 가입용 다회용 링크 (14일 만료, 좌석 상한은 가입 시 claim_org_seat가 검증)
// kind='attach': 기존 계정 편입 초대 — 아이디({id}@tbm.com)로 대상 지정, 대상이 로그인 후 수락
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, subscriptionAllows, isBillablePlan } from "@/lib/portone";
import { getOrgContext } from "@/lib/org";
import { isStoreSource, checkSeatCapacity, getStoreSeatCapacity } from "@/lib/billing";

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
    let ctx = await getOrgContext(user.id, admin);
    if (ctx.kind === "member") {
      return NextResponse.json({ error: "소속 현장 계정은 초대할 수 없습니다. 회사 감독자에게 문의하세요." }, { status: 403 });
    }
    // 구독 검사가 조직 생성보다 먼저 — legacy 계정이 초대를 눌렀다고 organizations 행이
    // 남아 요금이 바뀌는 사고 방지 (members 라우트와 동일한 순서 규칙)
    {
      const { data: sub } = await admin
        .from("subscriptions")
        .select("status, plan, current_period_end, billing_key, source, store_seat_capacity")
        .eq("user_id", user.id)
        .maybeSingle();
      // isBillablePlan: grandfather(영구 무료·카드 등록 불가)는 초대로도 좌석을 못 만든다
      // (사유는 lib/portone.ts isBillablePlan 주석 — 무과금 좌석 방지)
      if (!sub || !subscriptionAllows(sub) || !isBillablePlan(sub.plan)) {
        return NextResponse.json({ error: "현재 요금제로는 현장을 초대할 수 없어요. 구독을 먼저 확인해주세요." }, { status: 402 });
      }
      // 스토어 정원제(seats-NN)는 카드가 없어도 된다 — 좌석 값까지 스토어가 이미 받았다.
      // 대신 **정원**이 자격 조건이 된다(lib/billing.ts SeatBlockReason 주석).
      // 이 검사를 빼면 초대 링크가 정원을 무제한 우회하는 통로가 된다.
      // source를 같이 넘긴다 — 정원은 **스토어 출처일 때만** 존재한다(getStoreSeatCapacity 주석).
      // 넘기지 않으면 함수가 출처를 확인하려고 한 번 더 조회한다.
      const capacity = await getStoreSeatCapacity(admin, {
        user_id: user.id,
        source: (sub as any).source ?? null,
        store_seat_capacity: (sub as any).store_seat_capacity,
      });
      if (capacity != null) {
        const cap = await checkSeatCapacity(admin, { userId: user.id, capacity, count: 1 });
        if (!cap.ok) {
          return NextResponse.json({ error: cap.error, reason: "capacity" }, { status: 402 });
        }
      } else if (isStoreSource((sub as { source?: string | null }).source) && !sub.billing_key) {
        // 인앱결제(구글·애플) 소유주는 좌석 청구용 카드가 필수 — 없으면 초대 경로로 만든 좌석이
        // 월 청구 크론(billing_key NOT NULL 필터)에서 영영 빠져 무기한 무과금이 된다.
        return NextResponse.json({ error: "등록된 결제수단이 없습니다." }, { status: 402 });
      }
    }
    // 첫 현장을 초대 링크/편입으로 시작하는 경우 — 회사가 아직 없으면 여기서 만든다.
    // (직접 발급만 조직을 만들 수 있으면, 온보딩이 안내하는 세 경로 중 둘이 403으로 죽는다)
    if (ctx.kind === "solo" && !ctx.orgLapsed) {
      const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
      const name = String(meta.company_name ?? "").trim() || String(meta.full_name ?? "").trim() || "우리 회사";
      const { error: orgErr } = await admin
        .from("organizations")
        .upsert({ owner_user_id: user.id, name, seat_count: 1, pending_seat_count: null }, { onConflict: "owner_user_id" });
      if (orgErr) {
        console.error("org lazy-create error (invites):", orgErr);
        return NextResponse.json({ error: "회사 생성에 실패했습니다." }, { status: 500 });
      }
      ctx = await getOrgContext(user.id, admin);
    }
    if (ctx.kind !== "owner" || !ctx.org) {
      return NextResponse.json({ error: "초대를 만들 수 없습니다. 잠시 후 다시 시도해주세요." }, { status: 500 });
    }

    const body = await request.json().catch(() => ({}));
    const kind = String(body.kind ?? "link");

    if (kind === "link") {
      // 감독자가 미리 정한 현장명 목록(Chris) — 가입자는 이 중에서 고르기만 한다
      const siteNames = Array.isArray(body.siteNames)
        ? body.siteNames.map((n: unknown) => String(n ?? "").trim()).filter((n: string) => n.length > 0).slice(0, 20)
        : [];
      // 좌석 상한 없음 — 과금이 "실제 계정 수 × 단가"라 초대 수를 미리 제한할 이유가 없다
      const { data, error } = await admin
        .from("org_invites")
        .insert({ org_id: ctx.org.id, kind: "link", ...(siteNames.length ? { site_names: siteNames } : {}) })
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
        return NextResponse.json({ error: "이미 회사를 운영 중인 계정은 편입할 수 없습니다." }, { status: 400 });
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
