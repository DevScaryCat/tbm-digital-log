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
import { paymentsEnabled } from "@/lib/utils";

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
    if (!info.ok) {
      // 실제 PortOne 사유를 화면에 노출해 진단 가능하게 (pgCode/pgMessage/message/type)
      const b = info.body as { message?: string; type?: string; pgCode?: string; pgMessage?: string } | null;
      const reason =
        [b?.pgCode, b?.pgMessage].filter(Boolean).join(" ") ||
        b?.message ||
        b?.type ||
        `HTTP ${info.status}`;
      console.error("billing-key verify failed:", { method, status: info.status, body: info.body });
      return NextResponse.json({ error: `빌링키 검증 실패: ${reason}`, detail: info.body }, { status: 400 });
    }

    // 1-1) 소유권 검증: 발급 시 customerId=user.id로 묶으므로 응답 customer.id가 요청 유저와 일치해야 함.
    // 남의 빌링키를 제출해 타인 카드로 결제되는 것을 차단. (customer 정보가 없는 예외적 응답은 허용하되 경고)
    const keyCustomerId = (info.body as { customer?: { id?: string } })?.customer?.id;
    if (keyCustomerId && keyCustomerId !== user.id) {
      console.warn("billing-key ownership mismatch", { keyCustomerId, userId: user.id });
      return NextResponse.json({ error: "본인 명의로 발급된 결제수단이 아닙니다." }, { status: 403 });
    }
    const cardInfo =
      extractCardInfo(info.body) ||
      (method ? { provider: PROVIDER_LABEL[method] ?? method } : null);

    const now = new Date();
    const admin = getAdminClient();

    // --- 결제수단 변경: 빌링키/카드정보만 교체 ---
    if (mode === "update") {
      const { error } = await admin
        .from("subscriptions")
        .update({ billing_key: billingKey, card_info: cardInfo, updated_at: now.toISOString() })
        .eq("user_id", user.id);
      if (error) {
        console.error("billing-key update error:", error);
        return NextResponse.json({ error: "결제수단 변경 실패" }, { status: 500 });
      }
      return NextResponse.json({ success: true, updated: true });
    }

    // 기존 구독 조회 (체험 사용 여부 + 카드 없는 체험 진행 여부)
    const { data: existing } = await admin
      .from("subscriptions")
      .select("trial_used, status, billing_key, plan, current_period_end")
      .eq("user_id", user.id)
      .maybeSingle();
    const trialUsed = existing?.trial_used === true;

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
            billing_key: billingKey,
            card_info: cardInfo,
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
    const { data: sub, error: upErr } = await admin
      .from("subscriptions")
      .upsert(
        {
          user_id: user.id,
          plan: selectedPlan.id,
          status: "active",
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
