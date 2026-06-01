// lib/billing.ts — 빌링키 과금 + 구독/결제 상태 갱신 (수동 charge & cron 공용)
import { SupabaseClient } from "@supabase/supabase-js";
import {
  chargeWithBillingKey,
  newPaymentId,
  addOneMonth,
  PLAN,
} from "@/lib/portone";

export interface SubscriptionRow {
  id: string;
  user_id: string;
  billing_key: string | null;
  amount: number;
  status: string;
  current_period_end: string | null;
}

export interface ChargeResult {
  ok: boolean;
  paymentId: string;
  status: "paid" | "failed";
  detail?: any;
}

/**
 * 한 구독을 빌링키로 과금하고 결과를 DB에 기록한다.
 * 성공 시 구독을 active + 다음 결제일(+1개월)로 갱신, 실패 시 past_due.
 */
export async function chargeSubscription(
  admin: SupabaseClient,
  sub: SubscriptionRow,
  opts: { amount?: number; customerEmail?: string } = {}
): Promise<ChargeResult> {
  const amount = opts.amount ?? sub.amount ?? PLAN.amount;
  const paymentId = newPaymentId();

  if (!sub.billing_key) {
    return { ok: false, paymentId, status: "failed", detail: "빌링키 없음" };
  }

  const res = await chargeWithBillingKey({
    paymentId,
    billingKey: sub.billing_key,
    orderName: PLAN.name,
    amount,
    customer: { id: sub.user_id, email: opts.customerEmail },
  });

  const paid = res.ok;
  const now = new Date();

  // 결제 내역 기록
  await admin.from("payments").insert({
    subscription_id: sub.id,
    user_id: sub.user_id,
    payment_id: paymentId,
    amount,
    status: paid ? "paid" : "failed",
    pg_raw: res.body,
    paid_at: paid ? now.toISOString() : null,
  });

  // 구독 상태 갱신
  if (paid) {
    const base =
      sub.current_period_end && new Date(sub.current_period_end) > now
        ? new Date(sub.current_period_end)
        : now;
    await admin
      .from("subscriptions")
      .update({
        status: "active",
        current_period_end: addOneMonth(base).toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("id", sub.id);
  } else {
    await admin
      .from("subscriptions")
      .update({ status: "past_due", updated_at: now.toISOString() })
      .eq("id", sub.id);
  }

  return {
    ok: paid,
    paymentId,
    status: paid ? "paid" : "failed",
    detail: res.body,
  };
}
