// app/api/org/attach/route.ts — 기존 계정의 조직 편입 수락/거절 (대상 계정 본인이 호출)
// 순서(리뷰 A 반영): ① 가드(대상이 org owner면 거부, 상위 구독 유효성) → ② 좌석 점유(claim)
// → ③ 개인 구독 정산(grandfather 스킵+지위 기록) → ④ org_seat 미러 upsert → ⑤ 초대 소진.
// 좌석 확보 전에 환불·해지하면 편입 실패 시 구독만 증발하므로 반드시 claim이 먼저다.
// 미러 upsert 실패 시 초대를 소진하지 않고 500 — 재수락으로 자가 복구(claim·정산은 멱등).
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, subscriptionAllows , isProPlan} from "@/lib/portone";
import { cancelUserSubscription } from "@/lib/cancelSubscription";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

    const { token, accept } = await request.json();
    if (typeof token !== "string" || !token) {
      return NextResponse.json({ error: "초대 정보가 없습니다." }, { status: 400 });
    }

    const admin = getAdminClient();
    const { data: invite } = await admin
      .from("org_invites")
      .select("id, org_id, kind, target_user_id, expires_at, used_at, organizations!inner(name, owner_user_id)")
      .eq("token", token)
      .eq("kind", "attach")
      .maybeSingle();

    if (!invite || invite.target_user_id !== user.id) {
      return NextResponse.json({ error: "유효한 편입 초대가 아닙니다." }, { status: 404 });
    }
    if (invite.used_at) {
      return NextResponse.json({ error: "이미 처리된 초대입니다." }, { status: 409 });
    }
    if (new Date(invite.expires_at) <= new Date()) {
      return NextResponse.json({ error: "만료된 초대입니다. 안전관리자에게 재발급을 요청하세요." }, { status: 410 });
    }

    // 거절: 초대만 소진
    if (accept === false) {
      await admin.from("org_invites").update({ used_at: new Date().toISOString() }).eq("id", invite.id);
      return NextResponse.json({ success: true, declined: true });
    }

    // ① 가드 — 다른 조직의 안전관리자 계정은 편입 불가 (수락 오클릭으로 회사 전체 구독이
    // 환불·해지되는 사고 방지, 리뷰 A/의심). 초대한 조직의 상위 구독도 유효해야 한다.
    const { data: myOrg } = await admin
      .from("organizations")
      .select("id")
      .eq("owner_user_id", user.id)
      .maybeSingle();
    if (myOrg) {
      return NextResponse.json({ error: "안전관리자 계정은 다른 조직에 편입할 수 없습니다." }, { status: 400 });
    }
    const inviterOwnerId = String((invite as any).organizations?.owner_user_id ?? "");
    const { data: ownerSub } = await admin
      .from("subscriptions")
      .select("status, plan, current_period_end, billing_key")
      .eq("user_id", inviterOwnerId)
      .maybeSingle();
    if (!ownerSub || !isProPlan(ownerSub.plan) || !subscriptionAllows(ownerSub)) {
      return NextResponse.json({ error: "초대한 회사의 구독이 유효하지 않습니다. 회사 감독자에게 문의하세요." }, { status: 409 });
    }

    // ② 좌석 점유 (advisory lock) — 실패 시 아무 것도 건드리지 않은 상태로 종료
    const { data: claim, error: claimErr } = await admin.rpc("claim_org_seat", {
      p_org: invite.org_id,
      p_member: user.id,
    });
    if (claimErr || claim !== "ok") {
      const msg =
        claim === "no_seat"
          ? "조직에 남은 좌석이 없습니다. 안전관리자에게 좌석 추가를 요청하세요."
          : claim === "other_org"
            ? "이미 다른 조직에 소속된 계정입니다."
            : "좌석 배정에 실패했습니다.";
      return NextResponse.json({ error: msg }, { status: 409 });
    }

    // ③ 기존 개인 구독 정산 (grandfather는 스킵 + detach 시 복원용 지위 기록 §9.3)
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, plan, status, billing_key")
      .eq("user_id", user.id)
      .maybeSingle();
    if (sub?.plan === "grandfather") {
      try {
        const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
        await admin.auth.admin.updateUserById(user.id, { user_metadata: { ...meta, prev_plan: "grandfather" } });
      } catch { /* 비치명 */ }
    } else if (sub && ["active", "trialing", "past_due"].includes(sub.status)) {
      const r = await cancelUserSubscription(admin, user.id, {
        reason: "조직 편입에 따른 개인 구독 정산",
      });
      if (!r.ok && !r.alreadyCanceled) {
        console.error("attach: 개인 구독 정산 실패(편입은 계속 진행)", r);
      }
    }

    // 회사 공통 문서 형식 상속 — 편입 계정의 개인 형식을 감독자 형식으로 덮는다.
    // ③에서 prev_plan을 썼을 수 있어 요청 시점 스냅샷이 아닌 최신 메타데이터를 다시 읽는다. 비치명.
    try {
      const { data: ownerUser } = await admin.auth.admin.getUserById(inviterOwnerId);
      const ownerFormat = String((ownerUser?.user?.user_metadata as Record<string, unknown> | undefined)?.preferred_export_format ?? "") || null;
      if (ownerFormat) {
        const { data: me } = await admin.auth.admin.getUserById(user.id);
        const meMeta = (me?.user?.user_metadata ?? {}) as Record<string, unknown>;
        await admin.auth.admin.updateUserById(user.id, {
          user_metadata: { ...meMeta, preferred_export_format: ownerFormat },
        });
      }
    } catch { /* 비치명 — 감독자가 다음에 형식을 저장하면 동기화된다 */ }

    // ④ 미러 구독 — 실패하면 초대를 소진하지 않고 500 (재수락 시 ②③이 멱등이라 자가 복구)
    const now = new Date().toISOString();
    const { error: mirrorErr } = await admin.from("subscriptions").upsert(
      {
        user_id: user.id,
        plan: "org_seat",
        pending_plan: null,
        status: "active",
        billing_key: null,
        card_info: null,
        amount: 0,
        currency: "KRW",
        current_period_end: null,
        failed_attempts: 0,
        canceled_at: null,
        updated_at: now,
      },
      { onConflict: "user_id" }
    );
    if (mirrorErr) {
      console.error("attach mirror sub upsert error:", mirrorErr);
      return NextResponse.json(
        { error: "편입 처리 중 오류가 발생했습니다. 잠시 후 다시 수락해주세요." },
        { status: 500 }
      );
    }

    // ⑤ 초대 소진
    await admin.from("org_invites").update({ used_at: now }).eq("id", invite.id);

    return NextResponse.json({
      success: true,
      orgName: String((invite as any).organizations?.name ?? ""),
    });
  } catch (e) {
    console.error("org attach error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
