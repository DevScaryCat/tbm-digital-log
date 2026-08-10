// app/api/org/attach/route.ts — 기존 계정의 조직 편입 수락/거절 (대상 계정 본인이 호출)
// 순서(리뷰 A 반영): ① 가드(대상이 org owner면 거부, 상위 구독 유효성) → ② 좌석 점유(claim)
// → ③ 개인 구독 정산(grandfather 스킵+지위 기록) → ④ org_seat 미러 upsert → ⑤ 초대 소진.
// 좌석 확보 전에 환불·해지하면 편입 실패 시 구독만 증발하므로 반드시 claim이 먼저다.
// 미러 upsert 실패 시 초대를 소진하지 않고 500 — 재수락으로 자가 복구(claim·정산은 멱등).
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, subscriptionAllows, isBillablePlan } from "@/lib/portone";
import { cancelUserSubscription } from "@/lib/cancelSubscription";
import { isStoreSource, checkSeatCapacity, CAPACITY_FULL_MESSAGE } from "@/lib/billing";
import { markGrandfatherForRestore } from "@/lib/grandfather";

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
      .select("status, plan, current_period_end, billing_key, source, store_seat_capacity")
      .eq("user_id", inviterOwnerId)
      .maybeSingle();
    // isBillablePlan: 초대한 감독자가 grandfather(영구 무료·카드 등록 불가)면 편입을 막는다 —
    // 좌석 몫을 청구할 결제 수단이 없어 무과금 좌석이 된다(invites POST와 동일 게이트)
    if (!ownerSub || !isBillablePlan(ownerSub.plan) || !subscriptionAllows(ownerSub)) {
      return NextResponse.json({ error: "초대한 회사의 구독이 유효하지 않습니다. 회사 감독자에게 문의하세요." }, { status: 409 });
    }
    // 스토어 정원제(seats-NN)면 카드가 없어도 된다 — 좌석 값까지 스토어가 이미 받았다.
    // 대신 **정원**이 자격 조건이다(invites POST와 동일 규칙). 이 검사를 빼면 편입이
    // 정원을 무제한 우회하는 통로가 된다. 최종 방어선은 아래 claim_org_seat의 over_capacity.
    // 정원은 **스토어 출처일 때만** 존재한다 — 스토어를 떠나 웹 카드로 돌아온 계정에 남은
    // 죽은 정원을 상한으로 쓰면 정당한 편입이 막힌다(lib/billing.ts getStoreSeatCapacity와 같은 기준).
    const ownerCapacity = isStoreSource((ownerSub as { source?: string | null }).source)
      ? (((ownerSub as { store_seat_capacity?: number | null }).store_seat_capacity ?? null) as number | null)
      : null;
    if (ownerCapacity != null) {
      const cap = await checkSeatCapacity(admin, { userId: inviterOwnerId, capacity: ownerCapacity, count: 1 });
      if (!cap.ok) {
        return NextResponse.json(
          { error: "초대한 회사의 현장 계정 정원이 가득 찼어요. 회사 감독자에게 문의하세요." },
          { status: 409 }
        );
      }
    } else if (isStoreSource((ownerSub as { source?: string | null }).source) && !ownerSub.billing_key) {
      // 인앱결제(구글·애플) 소유주가 좌석 청구용 카드 없이 편입으로 좌석을 늘리는 무과금 경로 차단
      // (invites POST와 동일 게이트 — 편입 수락 시점에도 소유주 카드가 있어야 한다)
      return NextResponse.json(
        { error: "초대한 회사에 등록된 결제수단이 없습니다. 회사 감독자에게 문의하세요." },
        { status: 409 }
      );
    }

    // 스토어 구독(구글·애플) 보유자는 편입 불가 — **좌석 점유 전에** 막아야 한다.
    // 서버는 스토어 구독을 해지할 수 없다(권한이 스토어에 있음). 그대로 통과시키면 ③의
    // cancelUserSubscription이 storeManaged로 무동작 반환하고, 그 실패를 로그만 찍고 지나가
    // ④가 좌석 미러로 덮어써 버린다 → 스토어가 본인에게 4,900원, 감독자 카드가 같은 좌석에
    // 3,900원. 한 자리에 무기한 이중청구다(2026-08-10 적대적 검수 발견).
    // ⚠️ 이 검사를 ②(claim_org_seat) 뒤로 내리면 409로 막을 때 점유한 좌석이 반환되지 않아
    //    유령 좌석이 남는다 — 반드시 점유 전이다.
    const { data: myStoreSub } = await admin
      .from("subscriptions")
      .select("status, source")
      .eq("user_id", user.id)
      .maybeSingle();
    if (
      myStoreSub &&
      isStoreSource(myStoreSub.source) &&
      ["active", "trialing", "past_due"].includes(myStoreSub.status)
    ) {
      return NextResponse.json(
        {
          error:
            myStoreSub.source === "app_store"
              ? "앱스토어 구독 중인 계정은 바로 편입할 수 없어요. 설정 > Apple 계정 > 구독에서 해지한 뒤 다시 시도해주세요."
              : "Google Play 구독 중인 계정은 바로 편입할 수 없어요. Play 스토어 > 정기 결제에서 해지한 뒤 다시 시도해주세요.",
        },
        { status: 409 }
      );
    }

    // ② 좌석 점유 (advisory lock) — 실패 시 아무 것도 건드리지 않은 상태로 종료
    const { data: claim, error: claimErr } = await admin.rpc("claim_org_seat", {
      p_org: invite.org_id,
      p_member: user.id,
      p_capacity: ownerCapacity,
    });
    if (claimErr || claim !== "ok") {
      const msg =
        claim === "no_seat"
          ? "조직에 남은 좌석이 없습니다. 안전관리자에게 좌석 추가를 요청하세요."
          : claim === "over_capacity"
            ? CAPACITY_FULL_MESSAGE
            : claim === "other_org"
              ? "이미 다른 조직에 소속된 계정입니다."
              : "좌석 배정에 실패했습니다.";
      return NextResponse.json({ error: msg }, { status: 409 });
    }

    // ③ 기존 개인 구독 정산 (grandfather는 스킵 + detach 시 복원용 지위 기록 §9.3)
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, plan, status, billing_key, source")
      .eq("user_id", user.id)
      .maybeSingle();
    if (sub?.plan === "grandfather") {
      // 표식은 서버 전용 자리(app_metadata)에 남긴다 — user_metadata는 클라이언트가 직접 쓸 수 있어
      // 영구 무료 자가 발급 통로가 된다(lib/grandfather.ts와 같은 규율). 헬퍼가 두 자리를 함께 관리한다.
      await markGrandfatherForRestore(admin, user.id);
    } else if (sub && ["active", "trialing", "past_due"].includes(sub.status)) {
      const r = await cancelUserSubscription(admin, user.id, {
        reason: "조직 편입에 따른 개인 구독 정산",
      });
      if (!r.ok && !r.alreadyCanceled) {
        console.error("attach: 개인 구독 정산 실패(편입은 계속 진행)", r);
      }
    }

    // 회사 공통 설정 상속(문서 형식 + 근로자 구분·업종·공종) — 편입 계정의 개인 값을 감독자 값으로 덮는다.
    // ③에서 prev_plan을 썼을 수 있어 요청 시점 스냅샷이 아닌 최신 메타데이터를 다시 읽는다. 비치명.
    try {
      const { data: ownerUser } = await admin.auth.admin.getUserById(inviterOwnerId);
      const om = (ownerUser?.user?.user_metadata ?? {}) as Record<string, unknown>;
      const ownerFormat = String(om.preferred_export_format ?? "") || null;
      const shared = {
        ...(ownerFormat ? { preferred_export_format: ownerFormat } : {}),
        ...(om.worker_type ? { worker_type: om.worker_type } : {}),
        ...(om.industry ? { industry: om.industry } : {}),
        ...(om.work_category ? { work_category: om.work_category } : {}),
      };
      if (Object.keys(shared).length > 0) {
        const { data: me } = await admin.auth.admin.getUserById(user.id);
        const meMeta = (me?.user?.user_metadata ?? {}) as Record<string, unknown>;
        await admin.auth.admin.updateUserById(user.id, {
          user_metadata: { ...meMeta, ...shared },
        });
      }
    } catch { /* 비치명 — 감독자가 다음에 저장하면 동기화된다 */ }

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
