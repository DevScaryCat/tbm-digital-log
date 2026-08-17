// app/api/org/members/reattach/route.ts — 해제(detached)된 현장 계정 다시 연결 (감독자 전용)
//
// detach(멤버십 detached + 미러 canceled)의 역방향인데, 규칙은 **발급 경로를 재사용**한다:
//   자격 게이트(subscriptionAllows + isBillablePlan) → 청구 dry-run(resolveSeatCharge)
//   → 좌석 재점유(claim_org_seat — detached 행은 on conflict UPDATE로 active 복귀)
//   → 일할 청구(chargeProratedAccount) → 미러 복원(orgSeatMirrorRow) → seat_count 동기화.
// "재연결은 무료"라는 별도 경로를 만들지 않는다 — 카드 청구 조직은 발급과 똑같이 일할 청구,
// 스토어 정원제는 정원 안이면 발급과 똑같이 무과금이다(resolveSeatCharge가 이미 그렇게 가른다).
//
// 발급과 다른 점 둘뿐이다:
//  · 계정을 만들지 않는다 — 롤백도 deleteUser가 아니라 '원래 detached 상태 복원'이다.
//  · 해제돼 있던 사이 자가 결제(is_self_paid)·grandfather가 된 계정은 청구·미러를 건너뛴다.
//    미러를 씌우면 살아 있는 본인 구독 행(billing_key·store token)을 0원으로 덮는 그 사고이고
//    (2026-08-13 마이그레이션 주석의 ②), 청구하면 회사가 제공하지 않는 좌석에 받는 이중청구다.
//    판정은 좌석 회계 뷰(org_seat_states)와 **같은 SQL**(is_self_paid · plan='grandfather')을 쓴다
//    — 재연결 직후 뷰가 self_store/grandfather로 분류할 사람에게만 건너뛴다(규칙 사본 금지).
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, subscriptionAllows, isBillablePlan } from "@/lib/portone";
import { getOrgContext, orgSeatMirrorRow } from "@/lib/org";
import { resolveOrgSeatAccountingByOwner, isSelfPaid } from "@/lib/orgSeats";
import {
  chargeProratedAccount,
  resolveSeatCharge,
  getStoreSeatCapacity,
  CAPACITY_FULL_MESSAGE,
  isStoreSource,
} from "@/lib/billing";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const admin = getAdminClient();
    const ctx = await getOrgContext(user.id, admin);

    if (ctx.kind === "member") {
      return NextResponse.json(
        { error: "소속 현장 계정은 현장 관리를 할 수 없습니다. 회사 감독자에게 문의하세요." },
        { status: 403 }
      );
    }

    // 자격 게이트 — 발급(members POST requireOwner)과 동일. source·store_seat_capacity 포함
    // 셀렉트도 동일하다(빠지면 gseat 주기 키 선점·정원 판정이 조용히 빠진다 — bulk 라우트 주석).
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, user_id, status, plan, current_period_end, billing_key, source, store_seat_capacity")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!sub || !subscriptionAllows(sub) || !isBillablePlan((sub as any).plan)) {
      return NextResponse.json(
        { error: "현재 요금제로는 현장 계정을 다시 연결할 수 없어요. 구독을 먼저 확인해주세요." },
        { status: 402 }
      );
    }

    // 해제된 계정이 있다는 것 자체가 회사가 이미 있다는 뜻 — 발급의 lazy-create는 필요 없다.
    if (ctx.kind !== "owner" || !ctx.org) {
      return NextResponse.json({ error: "회사 정보가 없습니다." }, { status: 404 });
    }
    const org = ctx.org;

    const body = await request.json().catch(() => ({}));
    const userId = String(body.userId ?? "").trim();
    if (!userId) return NextResponse.json({ error: "대상 계정이 없습니다." }, { status: 400 });

    // 대상 검증 — ctx.memberIds는 active만 담으므로(getOrgContext) 행을 직접 읽는다.
    // 원래 joined_at·detached_at을 여기서 붙잡아 둔다: claim이 joined_at을 now로 밀기 때문에
    // 결제 실패 롤백은 이 스냅샷으로 되돌린다(발급의 deleteUser 롤백에 대응하는 자리).
    const { data: row } = await admin
      .from("org_members")
      .select("org_id, status, joined_at, detached_at")
      .eq("member_user_id", userId)
      .maybeSingle();
    if (!row || row.org_id !== org.id) {
      return NextResponse.json({ error: "우리 조직의 현장 계정이 아닙니다." }, { status: 403 });
    }
    if (row.status !== "detached") {
      return NextResponse.json({ error: "이미 연결돼 있는 현장 계정입니다." }, { status: 409 });
    }

    // 자가 결제 판정 — 못 하면 좌석을 건드리지 않는다(attach 라우트와 같은 규율:
    // 모르는 채 미러를 씌우면 그게 이중청구다).
    let selfPaid = false;
    try {
      selfPaid = await isSelfPaid(admin, userId);
    } catch (e) {
      console.error("reattach: 자가 결제 판정 실패", e);
      return NextResponse.json(
        { error: "구독 상태를 확인하지 못했어요. 잠시 후 다시 시도해주세요." },
        { status: 503 }
      );
    }
    // grandfather는 detach가 지위를 복원해 뒀다(cancelOrgSeatMirrors §9.3) — 뷰와 같은 판정 키(plan).
    const { data: memberSub } = await admin
      .from("subscriptions")
      .select("plan")
      .eq("user_id", userId)
      .maybeSingle();
    const grandfather = (memberSub as { plan?: string | null } | null)?.plan === "grandfather";
    const chargeable = !selfPaid && !grandfather;

    // 청구 dry-run — 발급과 같은 함수·같은 자리(좌석을 건드리기 전). 실패 사유(reason)도 발급과
    // 같은 코드로 내려 앱이 문장이 아니라 코드로 분기하게 한다.
    // 자가 결제자는 건너뛴다: 회사가 청구·미러를 하지 않는 좌석이라 결제 자격이 필요 없고,
    // 스토어 자가 결제자는 정원도 안 먹는데(count 1로 검사하면) 만석 회사에서 오탐 402가 난다
    // — claim_org_seat의 v_self(is_store_self_paid ? 0 : 1)와 어긋나는 사전검사를 만들지 않는다.
    if (!selfPaid) {
      const gate = await resolveSeatCharge(admin, sub as any, { count: 1, seatsClaimed: false });
      if (!gate.ok) {
        // 스토어 구독인데 정원 요금제(seats-NN)가 아니면 dry-run이 카드 경로로 떨어져
        // "등록된 결제 수단이 없습니다"를 낸다 — 스토어 구독자에게 카드 안내는 오답이고
        // 진짜 할 일은 자리(정원) 요금제로 바꾸는 것이다(2026-08-17 QA 실측: 기본 구독
        // 상태에서 재연결 시도). reason을 capacity로 내려 앱이 '구독 및 결제' 링크를 잡게 한다.
        if (isStoreSource((sub as { source?: string | null }).source)) {
          return NextResponse.json(
            {
              error: "현장 계정 자리(정원)가 있는 요금제가 아니에요. 자리를 늘린 뒤 다시 연결해주세요.",
              reason: "capacity",
            },
            { status: 402 }
          );
        }
        return NextResponse.json(
          { error: gate.error ?? "결제에 실패했습니다.", reason: gate.reason },
          { status: 402 }
        );
      }
    }

    // 좌석 재점유 — 정원의 최종 방어선은 여기다(advisory lock 안). detached 행은 RPC의
    // on conflict UPDATE가 org_id 유지·status active·detached_at null로 되살린다(실측: 20260813 정의).
    const seatCapacity = await getStoreSeatCapacity(admin, sub as any);
    const { data: claim, error: claimErr } = await admin.rpc("claim_org_seat", {
      p_org: org.id,
      p_member: userId,
      p_capacity: seatCapacity,
    });
    if (claimErr || claim !== "ok") {
      // 실패 시 RPC는 행을 건드리기 전에 반환한다 — 되돌릴 것이 없다.
      if (claim === "over_capacity") {
        return NextResponse.json({ error: CAPACITY_FULL_MESSAGE, reason: "capacity" }, { status: 402 });
      }
      if (claim === "other_org") {
        return NextResponse.json({ error: "이미 다른 회사에 소속된 계정입니다." }, { status: 409 });
      }
      console.error("reattach claim error:", claim, claimErr);
      return NextResponse.json({ error: "현장 배정에 실패했습니다." }, { status: 500 });
    }

    // 결제 실패 롤백 — 발급의 rollback(좌석+계정 삭제)에 대응하되, 여기선 계정을 만든 적이
    // 없으므로 '요청 전 상태(detached)'로만 되돌린다. 청구 없이 살아나는 좌석을 남기지 않는다.
    const rollbackToDetached = async () => {
      const { error } = await admin
        .from("org_members")
        .update({
          status: "detached",
          joined_at: row.joined_at,
          detached_at: row.detached_at ?? new Date().toISOString(),
        })
        .eq("member_user_id", userId);
      if (error) console.error("reattach rollback error:", userId, error);
    };

    let charged = 0;
    if (chargeable) {
      // 잔여기간 일할 청구 — 발급과 같은 함수·같은 규칙(스토어 정원제·무료체험은 이 안에서 0원).
      const charge = await chargeProratedAccount(admin, sub as any, {
        customerEmail: user.email ?? undefined,
      });
      if (!charge.ok) {
        await rollbackToDetached();
        return NextResponse.json({ error: charge.error ?? "결제에 실패했습니다." }, { status: 402 });
      }
      charged = charge.charged;

      // 미러 구독 복원 — 행 모양은 발급·편입·복원 스윕과 같은 것(orgSeatMirrorRow) 하나만 쓴다.
      // 실패는 비치명(발급 POST와 동일) — 매일 크론의 미러 복원 스윕이 같은 뷰로 되살린다.
      const now = new Date().toISOString();
      const { error: mirrorErr } = await admin
        .from("subscriptions")
        .upsert(orgSeatMirrorRow(userId, now), { onConflict: "user_id" });
      if (mirrorErr) console.error("reattach mirror sub upsert error:", mirrorErr);
    }
    // 자가 결제·grandfather는 청구도 미러도 없다 — 본인 구독 행을 그대로 둔다.
    // 좌석 회계 뷰가 self_store/grandfather로 분류해 청구·정원·미러 셋 다에서 함께 빠진다.

    // 표시용 계정 수 동기화 — 청구 단위(1 + 청구 대상 좌석)와 같은 수(발급 경로 계산 그대로).
    const acc = await resolveOrgSeatAccountingByOwner(admin, user.id);
    const accountCount = 1 + (acc?.billableSeats ?? 1);
    await admin
      .from("organizations")
      .update({ seat_count: accountCount, pending_seat_count: null })
      .eq("id", org.id);

    return NextResponse.json({ success: true, userId, charged });
  } catch (e) {
    console.error("reattach error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
