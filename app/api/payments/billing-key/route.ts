import { NextResponse } from "next/server";
import {
  getAdminClient,
  getUserFromRequest,
  getBillingKeyInfo,
  extractCardInfo,
  addOneMonth,
  getPlan,
} from "@/lib/portone";
import { chargeSubscription, isStoreSource } from "@/lib/billing";
import { getOrgContext, restoreOrgSeatMirrors } from "@/lib/org";
import { isSelfPaid } from "@/lib/orgSeats";
import { paymentsEnabled } from "@/lib/utils";
import { phoneAuthEnabled } from "@/lib/phoneAuth";

export const runtime = "nodejs";
// 카카오페이 빌링키 검증 재시도(백오프 ~9s)를 위해 실행시간 여유 확보
export const maxDuration = 30;

/**
 * 스토어(구글·애플) 잔재를 비우는 패치 조각 — **source를 'portone'으로 되돌리는 자리에서만** 쓴다.
 *
 * 스토어 구독이 끝난 계정이 웹 카드로 재구독하면 청구 주체가 우리 크론으로 돌아온다.
 * 이때 store_seat_capacity가 남아 있으면 lib/billing.ts의 정원 분기가 그 값을 보고
 * "좌석 값은 스토어가 이미 받았다"고 판정해 카드 감독자의 발급이 전부 무과금이 되고,
 * 동시에 죽은 정원이 상한이 되어 정당한 발급이 CAPACITY_FULL로 막힌다(2026-08-10 검수).
 * store_purchase_token을 남기면 그 구독의 RTDN이 이 행을 찾아 status·기간을 덮어쓴다.
 */
const STORE_FIELDS_CLEARED = {
  store_seat_capacity: null,
  store_base_plan_id: null,
  store_pending_seat_capacity: null,
  store_purchase_token: null,
  store_product_id: null,
} as const;

const PROVIDER_LABEL: Record<string, string> = {
  card: "카드",
  kakaopay: "카카오페이",
  naverpay: "네이버페이",
  tosspay: "토스페이",
};

// 카드 등록(빌링키 발급) 완료 후 호출.
// mode='update' : 결제수단만 교체(구독 상태/체험/결제일 유지)
// 그 외        : 신규 구독(첫 달 무료) 또는 재구독(체험 소진 시 즉시 결제)
export async function POST(request: Request) {
  try {
    if (!paymentsEnabled()) {
      return NextResponse.json({ error: "결제 기능 준비 중입니다." }, { status: 403 });
    }
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }

    const { billingKey, method, mode, plan } = await request.json();
    if (!billingKey) {
      return NextResponse.json({ error: "billingKey가 없습니다." }, { status: 400 });
    }
    // 신규/재구독 시 선택한 플랜 (모르는 값이면 getPlan이 monthly_pro로 폴백 — lib/portone.ts)
    const selectedPlan = getPlan(plan);
    // org/org_seat를 body로 밀어넣는 우회 차단 — 회사 플랜 결제는 /api/org/checkout 전용
    if (!selectedPlan.selectable) {
      return NextResponse.json({ error: "선택할 수 없는 플랜입니다." }, { status: 400 });
    }

    const admin = getAdminClient();

    // 기존 구독 조회 (영구무료 차단 + 체험 사용 여부 + 조직 플랜 가드에 공용).
    // PortOne 검증(아래)보다 **앞**에 둔다 — 거절할 요청이면 PG 왕복(최대 9초 재시도)을
    // 시작하기 전에 끊어야 하고, 발급된 빌링키가 붕 뜬 채 남지도 않는다.
    const { data: existing } = await admin
      .from("subscriptions")
      .select("trial_used, status, billing_key, plan, current_period_end, source, trial_end")
      .eq("user_id", user.id)
      .maybeSingle();

    // --- 영구 무료(grandfather)는 결제수단을 등록할 수 없다 (2026-08-10 Chris) ---
    // 이 계정들은 "결제 시스템만 빠진 유료 계정"이다: 기능·한도가 이미 유료와 동일(200/30/20)해서
    // 카드를 걸 이유가 없고, 걸리면 오히려 두 가지가 망가진다.
    //  (a) 아래 upsert가 plan을 monthly_pro로 덮어써 영구 무료 지위가 행에서 사라진다.
    //  (b) isBillablePlan이 true가 되며 좌석·조직이 열려 청구 구조가 바뀐다.
    // UI(/pricing·/account·SubscribeButtons)에서 버튼을 지웠지만, 그건 이 라우트를 직접
    // 치는 우회를 막지 못한다 — 그래서 서버가 최종 방벽이다.
    // 409(Conflict): 요청이 틀린 게 아니라 계정 상태가 결제와 양립하지 않는다는 뜻.
    if (existing?.plan === "grandfather") {
      return NextResponse.json(
        {
          error:
            "영구 무료 계정은 결제수단을 등록하지 않아요. 정책 변경 전까지 무료로 사용 가능합니다.",
        },
        { status: 409 }
      );
    }

    // 1) 빌링키 발급 검증 (PortOne)
    // 카카오페이 등 간편결제는 발급 직후 GET /billing-keys 가 잠깐 UNAUTHORIZED/미조회로 뜰 수 있다
    // (PortOne 전파 지연 — 키 자체는 정상 발급됨). 백오프로 여러 번 재시도해 그 창을 넘긴다.
    // 카드(KG이니시스)는 즉시 조회되므로 재시도 없이 통과.
    let info = await getBillingKeyInfo(billingKey);
    const retryDelays = [1500, 3000, 4500];
    for (let i = 0; !info.ok && i < retryDelays.length; i++) {
      await new Promise((r) => setTimeout(r, retryDelays[i]));
      info = await getBillingKeyInfo(billingKey);
    }
    // 낙관수용(발급직후 UNAUTHORIZED)한 키는 소유권 미확인 상태 → billing_key_verified=false로 저장하고
    // 첫 과금 직전 cron(chargeSubscription)이 소유권을 재검증한다. (즉시결제 경로는 아래에서 차단)
    let acceptedUnverified = false;
    if (!info.ok) {
      const b = info.body as { message?: string; type?: string; pgCode?: string; pgMessage?: string } | null;
      if (b?.type === "UNAUTHORIZED") {
        // 발급은 성공(존재)했으나 발급 직후 조회 인가 전파가 지연되는 케이스(간편결제/카카오페이).
        // 재시도로도 안 넘어가면 낙관적으로 진행한다: UNAUTHORIZED는 '키는 존재하나 지금은 조회 권한 없음'이라
        // 조회 불가한 남의/타스토어 키는 실제 결제 시점에 어차피 실패(타인 과금 위험 없음)하고,
        // 정상 키는 곧 조회 가능해져 다음 결제일에 정상 청구된다. (info.body가 없으므로 소유권·카드정보는 스킵/폴백)
        acceptedUnverified = true;
        console.warn("billing-key verify UNAUTHORIZED after retries — accepting optimistically", { billingKey, method });
      } else {
        // NOT_FOUND 등 그 외 사유는 진짜 실패 → PortOne 사유를 화면에 노출
        const reason =
          [b?.pgCode, b?.pgMessage].filter(Boolean).join(" ") ||
          b?.message ||
          b?.type ||
          `HTTP ${info.status}`;
        console.error("billing-key verify failed:", { method, status: info.status, body: info.body });
        return NextResponse.json({ error: `빌링키 검증 실패: ${reason}`, detail: info.body }, { status: 400 });
      }
    }

    // 1-1) 소유권 검증: 발급 시 customerId=user.id로 묶으므로 응답 customer.id가 요청 유저와 일치해야 함.
    // 남의 빌링키를 제출해 타인 카드로 결제되는 것을 차단. (조회 실패/UNAUTHORIZED 낙관수용 시 customer가 없어 스킵)
    const keyCustomerId = info.ok ? (info.body as { customer?: { id?: string } })?.customer?.id : undefined;
    if (keyCustomerId && keyCustomerId !== user.id) {
      console.warn("billing-key ownership mismatch", { keyCustomerId, userId: user.id });
      return NextResponse.json({ error: "본인 명의로 발급된 결제수단이 아닙니다." }, { status: 403 });
    }
    const cardInfo =
      extractCardInfo(info.body) ||
      (method ? { provider: PROVIDER_LABEL[method] ?? method } : null);

    const now = new Date();

    // 소속 현장은 감독자가 대신 결제한다 — 본인이 카드를 걸면 미러 행이 덮여 조용히
    // 조직에서 분리되고 감독자는 계속 그 계정 요금을 낸다. plan 문자열이 아니라 실제
    // 소속(org_members)으로 판정한다(단일 요금제 이후 plan은 신뢰할 수 있는 키가 아니다).
    const ctx = await getOrgContext(user.id, admin);
    // 예외: **본인이 직접 결제 중인** 소속 계정(seat_state='self_store')은 자기 구독을 관리할
    // 수 있어야 한다. 회사가 그 좌석을 청구하지도, 미러를 씌우지도 않으므로(public.is_self_paid가
    // 청구·정원·미러 세 곳에서 함께 제외한다) 위 주석의 사고가 성립할 자리가 없다.
    // 이걸 막으면 돈을 내는 사람이 카드조차 못 바꾸는 막다른 길이 된다.
    if (ctx.kind === "member" && !(await isSelfPaid(admin, user.id))) {
      return NextResponse.json(
        { error: "소속 현장 계정입니다. 구독·결제는 회사 감독자가 관리합니다." },
        { status: 403 }
      );
    }
    // 감독자(회사 소유)도 여기서 결제한다. 청구액은 chargeSubscription이
    // 실제 계정 수로 재계산하므로 별도 라우트가 필요 없다.
    // (구 구현은 여기서 400을 내고 /api/org/checkout으로 보냈는데, 그 라우트가 사라진 뒤로는
    //  해지된 회사 계정이 재결제할 방법이 아예 없는 막다른 길이 됐다)

    // --- 결제수단 변경: 빌링키/카드정보만 교체 ---
    if (mode === "update") {
      const { error } = await admin
        .from("subscriptions")
        .update({
          billing_key: billingKey,
          card_info: cardInfo,
          billing_key_verified: !acceptedUnverified,
          updated_at: now.toISOString(),
        })
        .eq("user_id", user.id);
      if (error) {
        console.error("billing-key update error:", error);
        return NextResponse.json({ error: "결제수단 변경 실패" }, { status: 500 });
      }
      return NextResponse.json({ success: true, updated: true });
    }

    // 첫 달 무료(카드 등록형 체험)는 휴대폰 인증 게이트가 켜져 있으면 인증된 계정에만 —
    // 인증 없는 대량 계정 생성(manager 모드 등)으로 체험이 무한 발급되는 우회 차단 (리뷰 E)
    const phoneVerified = !!(user.user_metadata as any)?.phone_verified_at;
    const trialUsed = existing?.trial_used === true || (phoneAuthEnabled() && !phoneVerified);

    // --- 카드 없는 체험(휴대폰인증 가입) 진행 중에 결제수단 등록 ---
    // 즉시 결제하지 않는다: 체험 종료일에 cron이 첫 과금. 플랜을 바꿔 선택했으면
    // pending_plan으로 예약해 첫 과금부터 새 플랜 금액이 적용된다(chargeSubscription 로직).
    if (
      existing &&
      existing.status === "trialing" &&
      !existing.billing_key &&
      existing.current_period_end &&
      new Date(existing.current_period_end) > now
    ) {
      const { error } = await admin
        .from("subscriptions")
        .update({
          billing_key: billingKey,
          card_info: cardInfo,
          billing_key_verified: !acceptedUnverified,
          pending_plan: selectedPlan.id !== existing.plan ? selectedPlan.id : null,
          failed_attempts: 0,
          updated_at: now.toISOString(),
        })
        .eq("user_id", user.id);
      if (error) {
        console.error("trial attach billing-key error:", error);
        return NextResponse.json({ error: "결제수단 등록 실패" }, { status: 500 });
      }
      return NextResponse.json({ success: true, attachedToTrial: true });
    }

    // (여기 있던 markGrandfatherForRestore 호출은 삭제했다 — 위에서 grandfather를 409로
    //  끊으므로 도달할 수 없는 코드였고, 남겨두면 "카드로도 구독할 수 있다"는 거짓 신호가 된다.
    //  스토어 인앱결제·조직 편입 경로는 여전히 그 표식을 남긴다: app/api/billing/{apple,google}/verify,
    //  app/api/org/attach. 복원은 lib/grandfather.ts restoreGrandfatherIfEligible.)

    // --- 살아 있는 구독 보호 (2026-08-14 검수 확정) ---
    // 모바일 PG 리디렉션 복귀가 새 브라우저 컨텍스트로 떨어지면 sessionStorage의
    // {mode:'update'}가 유실되고 클라이언트가 mode를 기본값 'subscribe'로 보낸다
    // (BillingRedirectHandler). 그 순간 '결제수단 변경'이 아래 신규/재구독 분기로 들어가
    //  · 스토어(google_play) 구독자 → source 원복 + STORE_FIELDS_CLEARED로 RTDN 연결이
    //    끊기고, 구글 4,900 + 카드 3,900 이중청구가 조용히 지속된다.
    //  · 기간이 남은 카드 구독자 → cpe가 now로 덮여 이미 낸 기간이 소멸하고 같은 달을
    //    두 번 결제한다. /api/payments/charge에는 있는 '기간 남으면 청구 금지' 가드가
    //    이 경로에만 없었다.
    // 클라이언트가 보낸 mode를 믿지 않고 서버가 상태로 의도를 재판정한다:
    // 살아 있는 구독이면 결제수단 교체로만 처리한다. 이 가드는 반드시 첫 체험 분기보다
    // 앞에 있어야 한다 — 스토어 구독자는 서버 trial_used가 false일 수 있어 첫 체험
    // 분기에서도 같은 파괴가 일어난다.
    const hasRemaining =
      !!existing?.current_period_end && new Date(existing.current_period_end) > now;
    if (
      existing &&
      ["active", "trialing", "past_due"].includes(existing.status) &&
      (isStoreSource(existing.source) || hasRemaining)
    ) {
      const { error } = await admin
        .from("subscriptions")
        .update({
          billing_key: billingKey,
          card_info: cardInfo,
          billing_key_verified: !acceptedUnverified,
          failed_attempts: 0,
          updated_at: now.toISOString(),
        })
        .eq("user_id", user.id);
      if (error) {
        console.error("live-sub billing-key swap error:", error);
        return NextResponse.json({ error: "결제수단 변경 실패" }, { status: 500 });
      }
      return NextResponse.json({ success: true, updated: true });
    }

    // --- 해지 후 기간이 남은 계정: 재활성 (청구 없음, 기간 보존) ---
    // 종전에는 이 상태가 곧장 재구독 분기로 가서, '무료체험 중이면 남은 기간까지 그대로
    // 이용할 수 있다'는 해지 안내를 믿고 마음을 바꾼 사용자가 남은 기간을 잃고 즉시
    // 전액을 결제했다. 이미 확보된 기간은 보존하고 자동갱신만 되살린다 — 다음 청구는
    // 기간 종료일에 크론이 한다.
    if (existing && existing.status === "canceled" && hasRemaining) {
      const stillTrial = !!existing.trial_end && new Date(existing.trial_end) > now;
      const { data: revived, error } = await admin
        .from("subscriptions")
        .update({
          status: stillTrial ? "trialing" : "active",
          billing_key: billingKey,
          card_info: cardInfo,
          billing_key_verified: !acceptedUnverified,
          pending_plan: selectedPlan.id !== existing.plan ? selectedPlan.id : null,
          failed_attempts: 0,
          canceled_at: null,
          updated_at: now.toISOString(),
        })
        .eq("user_id", user.id)
        .select()
        .single();
      if (error || !revived) {
        console.error("canceled-sub revive error:", error);
        return NextResponse.json({ error: "구독 재개 실패" }, { status: 500 });
      }
      if (ctx.kind === "owner" && ctx.org) {
        const r = await restoreOrgSeatMirrors(ctx.org.id, admin);
        if (r.failed > 0) console.error("billing-key revive: 미러 복원 일부 실패(다음 크론 스윕이 수습)", r);
      }
      return NextResponse.json({
        success: true,
        revived: true,
        subscription: {
          status: revived.status,
          card_info: revived.card_info,
          current_period_end: revived.current_period_end,
        },
      });
    }

    if (!trialUsed) {
      // --- 최초 구독: 첫 달 무료 체험 ---
      const nextChargeAt = addOneMonth(now);
      const { data, error } = await admin
        .from("subscriptions")
        .upsert(
          {
            user_id: user.id,
            plan: selectedPlan.id,
            status: "trialing",
            // 이 upsert는 '우리 크론이 청구하는 정기결제'를 개통하는 것 — 출처를 명시해야
            // 과거 인앱결제(google_play) 이력이 남은 계정이 크론의 source=portone 필터에서
            // 빠져 영영 무과금이 되는 구멍이 없다.
            source: "portone",
            // 출처를 되돌리는 자리에서 스토어 잔재도 같이 지운다(2026-08-10 검수).
            // 남겨두면 죽은 정원이 상한으로 살아남아 (a) 카드 좌석 발급이 전부 무과금이 되고
            // (b) 정당한 발급이 CAPACITY_FULL로 막힌다. 스토어 토큰도 지운다 — 남기면 그
            // 구독의 RTDN(만료·환불)이 이 행의 status·기간을 덮어 카드 구독을 끊는다.
            ...STORE_FIELDS_CLEARED,
            billing_key: billingKey,
            card_info: cardInfo,
            billing_key_verified: !acceptedUnverified,
            amount: selectedPlan.amount,
            currency: selectedPlan.currency,
            trial_end: nextChargeAt.toISOString(),
            current_period_end: nextChargeAt.toISOString(),
            trial_used: true,
            failed_attempts: 0,
            canceled_at: null,
            updated_at: now.toISOString(),
          },
          { onConflict: "user_id" }
        )
        .select()
        .single();
      if (error) {
        console.error("subscription upsert error:", error);
        return NextResponse.json({ error: "구독 저장 실패" }, { status: 500 });
      }
      // 미러 복원 대상은 좌석 회계(뷰)가 고른다 — 본인 스토어 구독으로 사는 현장은 여기서
      // 걸러진다(덮으면 스토어 4,900 + 감독자 카드 3,900의 이중청구). 감독자 청구액도 같은
      // 회계를 쓰므로 그 사람은 청구 좌석 수에서도 함께 빠진다.
      if (ctx.kind === "owner" && ctx.org) {
        const r = await restoreOrgSeatMirrors(ctx.org.id, admin);
        if (r.failed > 0) console.error("billing-key: 미러 복원 일부 실패(다음 크론 스윕이 수습)", r);
      }
      return NextResponse.json({
        success: true,
        subscription: {
          status: data.status,
          card_info: data.card_info,
          current_period_end: data.current_period_end,
        },
      });
    }

    // --- 재구독(체험 이미 사용): 즉시 결제 후 활성화 (새 무료달 부여 안 함) ---
    // 즉시 결제 경로는 cron 재검증 안전망이 없으므로 미검증(낙관수용) 키로는 결제하지 않는다.
    // 카카오페이 전파는 보통 수십 초 내 끝나므로 잠시 후 재시도하면 정상 검증 경로로 진행된다.
    if (acceptedUnverified) {
      return NextResponse.json(
        { error: "결제수단을 확인하는 중입니다. 잠시 후(약 30초) 다시 시도해주세요." },
        { status: 409 }
      );
    }
    const { data: sub, error: upErr } = await admin
      .from("subscriptions")
      .upsert(
        {
          user_id: user.id,
          plan: selectedPlan.id,
          status: "active",
          // 재구독도 우리 크론 청구로 개통 — 인앱결제에서 웹 결제로 돌아온 계정의 출처 원복
          source: "portone",
          // 출처를 되돌리는 자리에서 스토어 잔재도 같이 지운다 — 위 신규 구독 upsert와 같은 이유
          ...STORE_FIELDS_CLEARED,
          billing_key: billingKey,
          card_info: cardInfo,
          amount: selectedPlan.amount,
          currency: selectedPlan.currency,
          current_period_end: now.toISOString(),
          trial_used: true,
          failed_attempts: 0,
          canceled_at: null,
          updated_at: now.toISOString(),
        },
        { onConflict: "user_id" }
      )
      .select()
      .single();
    if (upErr || !sub) {
      console.error("resubscribe upsert error:", upErr);
      return NextResponse.json({ error: "구독 저장 실패" }, { status: 500 });
    }

    const charge = await chargeSubscription(admin, sub as any, {
      customerEmail: user.email ?? undefined,
    });
    if (!charge.ok) {
      return NextResponse.json(
        { error: "결제에 실패했습니다. 카드를 확인해주세요." },
        { status: 402 }
      );
    }

    // 재결제 성공 → 활성 소속 현장의 미러 구독 복원.
    // 청구는 이미 (본인 + 활성 소속 현장) 수로 계산됐으므로, 복원하지 않으면
    // 돈은 받고 그 현장들은 잠겨 있는 상태가 된다.
    // 대상 선정은 뷰가 한다(위 신규 구독 분기와 같은 이유). 일부가 실패해도 다음 날
    // 크론의 미러 복원 스윕이 같은 후보를 다시 집어 수습한다 — 막다른 길이 아니다.
    if (ctx.kind === "owner" && ctx.org) {
      const r = await restoreOrgSeatMirrors(ctx.org.id, admin);
      if (r.failed > 0) console.error("billing-key: 미러 복원 일부 실패(다음 크론 스윕이 수습)", r);
    }

    const { data: updated } = await admin
      .from("subscriptions")
      .select("status, card_info, current_period_end")
      .eq("user_id", user.id)
      .maybeSingle();
    return NextResponse.json({ success: true, subscription: updated });
  } catch (e: any) {
    console.error("billing-key route error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
