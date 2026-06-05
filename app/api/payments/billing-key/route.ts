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

export const runtime = "nodejs";

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
    const info = await getBillingKeyInfo(billingKey);
    if (!info.ok) {
      return NextResponse.json({ error: "빌링키 검증 실패", detail: info.body }, { status: 400 });
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

    // 기존 구독 조회 (체험 사용 여부)
    const { data: existing } = await admin
      .from("subscriptions")
      .select("trial_used")
      .eq("user_id", user.id)
      .maybeSingle();
    const trialUsed = existing?.trial_used === true;

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
