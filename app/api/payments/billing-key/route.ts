import { NextResponse } from "next/server";
import {
  getAdminClient,
  getUserFromRequest,
  getBillingKeyInfo,
  extractCardInfo,
  addOneMonth,
  getPlan,
} from "@/lib/portone";
import { chargeSubscription } from "@/lib/billing";
import { getOrgContext, restoreOrgSeatMirrors } from "@/lib/org";
import { paymentsEnabled } from "@/lib/utils";
import { phoneAuthEnabled } from "@/lib/phoneAuth";

export const runtime = "nodejs";
// 카카오페이 빌링키 검증 재시도(백오프 ~9s)를 위해 실행시간 여유 확보
export const maxDuration = 30;

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
    // 신규/재구독 시 선택한 플랜 (모르는 값이면 베이직으로 폴백)
    const selectedPlan = getPlan(plan);
    // org/org_seat를 body로 밀어넣는 우회 차단 — 회사 플랜 결제는 /api/org/checkout 전용
    if (!selectedPlan.selectable) {
      return NextResponse.json({ error: "선택할 수 없는 플랜입니다." }, { status: 400 });
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
    const admin = getAdminClient();

    // 기존 구독 조회 (체험 사용 여부 + 조직 플랜 가드에 공용)
    const { data: existing } = await admin
      .from("subscriptions")
      .select("trial_used, status, billing_key, plan, current_period_end")
      .eq("user_id", user.id)
      .maybeSingle();

    // 소속 현장은 감독자가 대신 결제한다 — 본인이 카드를 걸면 미러 행이 덮여 조용히
    // 조직에서 분리되고 감독자는 계속 그 계정 요금을 낸다. plan 문자열이 아니라 실제
    // 소속(org_members)으로 판정한다(단일 요금제 이후 plan은 신뢰할 수 있는 키가 아니다).
    const ctx = await getOrgContext(user.id, admin);
    if (ctx.kind === "member") {
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
      if (ctx.kind === "owner" && (ctx.memberIds ?? []).length > 0) {
        await restoreOrgSeatMirrors(ctx.memberIds ?? [], admin);
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
    if (ctx.kind === "owner" && (ctx.memberIds ?? []).length > 0) {
      await restoreOrgSeatMirrors(ctx.memberIds ?? [], admin);
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
