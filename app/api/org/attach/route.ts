// app/api/org/attach/route.ts — 기존 계정의 조직 편입 수락/거절 (대상 계정 본인이 호출)
// 순서(리뷰 A 반영): ① 가드(대상이 org owner면 거부, 상위 구독 유효성) → ② 좌석 점유(claim)
// → ③ 개인 구독 정산(grandfather 스킵+지위 기록) → ④ org_seat 미러 upsert → ⑤ 초대 소진.
// 좌석 확보 전에 환불·해지하면 편입 실패 시 구독만 증발하므로 반드시 claim이 먼저다.
// 미러 upsert 실패 시 초대를 소진하지 않고 500 — 재수락으로 자가 복구(claim·정산은 멱등).
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, subscriptionAllows, isBillablePlan } from "@/lib/portone";
import { cancelUserSubscription } from "@/lib/cancelSubscription";
import { isStoreSource, checkSeatCapacity, CAPACITY_FULL_MESSAGE } from "@/lib/billing";
import { isStoreSelfPaid } from "@/lib/orgSeats";
import { orgSeatMirrorRow } from "@/lib/org";
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
    // 스토어 구독(구글·애플) 보유자의 편입 — **차단하지 않는다**(2026-08-11 정책 통일).
    //
    // 종전에는 여기서 409로 막았다. 이유는 옳았다: 서버는 스토어 구독을 해지할 권한이 없으므로
    // ③의 cancelUserSubscription이 무동작으로 지나가고 ④가 좌석 미러로 덮어써, 스토어가 본인에게
    // 4,900원 · 감독자 카드가 같은 좌석에 3,900원인 무기한 이중청구가 됐다.
    // ⚠️ 그 전제가 이번 변경으로 **사실이 아니게 됐다**: 좌석 회계(public.org_seat_states)가
    //    자가 스토어 결제자를 감독자 청구·정원·미러 **전부에서** 빼므로, 편입해도 회사는 그 좌석
    //    요금을 받지 않고 미러도 씌우지 않는다. 이중청구가 성립할 자리가 없다.
    //    (이 주석을 고치지 않고 409만 지우면, 다음 편집자가 옛 주석을 믿고 되돌린다.)
    //
    // 그래서 '해지하고 오세요'라는 막다른 길을 없애고, 편입과 복원이 **같은 결과**를 내게 한다.
    // 판정은 여기서 다시 적지 않고 같은 SQL 함수(is_store_self_paid)를 부른다.
    // 점유 전에 확정한다 — ③④의 분기 근거이고, 실패해도 좌석을 건드리기 전이어야 한다.
    let selfStorePaid = false;
    try {
      selfStorePaid = await isStoreSelfPaid(admin, user.id);
    } catch (e) {
      // 판정을 못 하면 좌석을 건드리지 않는다 — 모르는 채 미러를 씌우면 그게 이중청구다
      console.error("attach: 자가 결제 판정 실패", e);
      return NextResponse.json(
        { error: "구독 상태를 확인하지 못했어요. 잠시 후 다시 시도해주세요." },
        { status: 503 }
      );
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
      // ⚠️ 사전검사가 claim_org_seat과 **같은 수**를 세야 한다. 자가 스토어 결제자는 정원을 먹지
      // 않으므로(RPC의 v_self가 0) 여기서도 이번 요청분을 0으로 센다 — 안 그러면 정원이 꽉 찬
      // 회사에 자가 결제자가 편입하려 할 때 RPC는 통과시키는데 이 줄이 409를 내는, 서버가 스스로
      // 두 말을 하는 상태가 된다.
      const cap = await checkSeatCapacity(admin, {
        userId: inviterOwnerId,
        capacity: ownerCapacity,
        count: selfStorePaid ? 0 : 1,
      });
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
    if (selfStorePaid) {
      // 본인 스토어 구독은 그대로 둔다 — 서버가 해지할 권한도 없고, 해지할 이유도 없다.
      // 회사는 이 좌석을 청구하지 않는다(좌석 회계에서 self_store로 빠진다).
      console.warn("SELF_PAID_SEAT_ATTACH", { orgId: invite.org_id, memberUserId: user.id });
    } else if (sub?.plan === "grandfather") {
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

    // ④ 미러 구독 — 실패하면 초대를 소진하지 않고 500 (재수락 시 ②③이 멱등이라 자가 복구).
    // 자가 스토어 결제자에게는 씌우지 않는다: 덮으면 그 사람의 스토어 구독 행이 사라져 RTDN이
    // 갈 곳을 잃고, 스토어는 계속 청구한다. 행 모양은 lib/org.ts의 미러 복원과 **같은 것**을 쓴다
    // (스토어 잔재 청산 포함 — 안 지우면 RTDN이 미러의 status·기간을 덮어 좌석이 잠긴다).
    const now = new Date().toISOString();
    if (!selfStorePaid) {
      const { error: mirrorErr } = await admin
        .from("subscriptions")
        .upsert(orgSeatMirrorRow(user.id, now), { onConflict: "user_id" });
      if (mirrorErr) {
        console.error("attach mirror sub upsert error:", mirrorErr);
        return NextResponse.json(
          { error: "편입 처리 중 오류가 발생했습니다. 잠시 후 다시 수락해주세요." },
          { status: 500 }
        );
      }
    }

    // ⑤ 초대 소진
    await admin.from("org_invites").update({ used_at: now }).eq("id", invite.id);

    return NextResponse.json({
      success: true,
      orgName: String((invite as any).organizations?.name ?? ""),
      selfStorePaid,
      // 화면·앱이 이 문구를 그대로 띄운다 — 편입했는데 스토어 청구가 계속되는 이유를
      // 사용자가 알 수 있어야 한다(그리고 그만두는 방법도).
      notice: selfStorePaid
        ? "본인 스토어 구독이 그대로 유지돼요. 회사는 이 계정 요금을 청구하지 않아요. 스토어에서 구독을 해지하면 회사 좌석으로 자동 전환됩니다."
        : undefined,
    });
  } catch (e) {
    console.error("org attach error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
