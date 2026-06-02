// lib/billing.ts — 빌링키 과금 + 구독/결제 상태 갱신 (수동 charge & cron 공용)
import { SupabaseClient } from "@supabase/supabase-js";
import {
  chargeWithBillingKey,
  addOneMonth,
  PLAN,
} from "@/lib/portone";

export const MAX_FAILED_ATTEMPTS = 3;

export interface SubscriptionRow {
  id: string;
  user_id: string;
  billing_key: string | null;
  amount: number;
  status: string;
  current_period_end: string | null;
  failed_attempts?: number;
}

export interface ChargeResult {
  ok: boolean;
  paymentId: string;
  status: "paid" | "failed" | "skipped";
  detail?: any;
}

/** 결제 대상 기간을 식별하는 결정적 키 (같은 기간 재시도 시 동일 paymentId → 중복결제 방지) */
function periodPaymentId(sub: SubscriptionRow): string {
  const base = sub.current_period_end ? new Date(sub.current_period_end) : new Date(0);
  const key = `${base.getUTCFullYear()}${String(base.getUTCMonth() + 1).padStart(2, "0")}${String(
    base.getUTCDate()
  ).padStart(2, "0")}`;
  return `sub_${sub.id}_${key}`;
}

/**
 * 한 구독을 빌링키로 과금하고 결과를 DB에 기록한다. (멱등)
 * - 동일 기간 paymentId가 이미 paid면 스킵 (중복결제 방지)
 * - 성공 시 active + 다음 결제일(+1개월), 낙관적 잠금으로 이중 진행 방지
 * - 실패 시 failed_attempts 증가, 한도 초과 시 canceled, 아니면 past_due
 */
export async function chargeSubscription(
  admin: SupabaseClient,
  sub: SubscriptionRow,
  opts: { amount?: number; customerEmail?: string } = {}
): Promise<ChargeResult> {
  const amount = opts.amount ?? sub.amount ?? PLAN.amount;
  const paymentId = periodPaymentId(sub);
  const now = new Date();

  if (!sub.billing_key) {
    return { ok: false, paymentId, status: "failed", detail: "빌링키 없음" };
  }

  // 멱등성: 이 기간에 대해 이미 성공한 결제가 있으면 재청구하지 않음
  const { data: existing } = await admin
    .from("payments")
    .select("status")
    .eq("payment_id", paymentId)
    .maybeSingle();
  if (existing?.status === "paid") {
    return { ok: true, paymentId, status: "skipped", detail: "이미 결제됨" };
  }

  const res = await chargeWithBillingKey({
    paymentId,
    billingKey: sub.billing_key,
    orderName: PLAN.name,
    amount,
    customer: { id: sub.user_id, email: opts.customerEmail },
  });

  // 성공 판정: HTTP 2xx 뿐 아니라 PG 상태가 PAID인지까지 확인 (거절이 2xx로 오는 경우 방지)
  const body: any = res.body || {};
  const pgStatus = String(body?.payment?.status ?? body?.status ?? "").toUpperCase();
  const paid = res.ok && (pgStatus === "" || pgStatus === "PAID");

  // 결제 내역 기록 (paymentId 충돌 시 갱신)
  const { error: payErr } = await admin.from("payments").upsert(
    {
      subscription_id: sub.id,
      user_id: sub.user_id,
      payment_id: paymentId,
      amount,
      status: paid ? "paid" : "failed",
      pg_raw: body,
      paid_at: paid ? now.toISOString() : null,
    },
    { onConflict: "payment_id" }
  );
  if (payErr) {
    // 기록 실패 시 기간을 진행시키지 않음 (결제는 됐는데 기록 없음 방지 → 다음 재시도가 멱등 처리)
    console.error("payment insert error:", payErr);
    return { ok: false, paymentId, status: "failed", detail: payErr };
  }

  if (paid) {
    const base =
      sub.current_period_end && new Date(sub.current_period_end) > now
        ? new Date(sub.current_period_end)
        : now;
    // 낙관적 잠금: 우리가 본 current_period_end 그대로일 때만 진행 (동시 실행 이중 진행 방지)
    let q = admin
      .from("subscriptions")
      .update({
        status: "active",
        current_period_end: addOneMonth(base).toISOString(),
        failed_attempts: 0,
        updated_at: now.toISOString(),
      })
      .eq("id", sub.id);
    q = sub.current_period_end
      ? q.eq("current_period_end", sub.current_period_end)
      : q.is("current_period_end", null);
    await q;
  } else {
    const attempts = (sub.failed_attempts ?? 0) + 1;
    await admin
      .from("subscriptions")
      .update({
        status: attempts >= MAX_FAILED_ATTEMPTS ? "canceled" : "past_due",
        failed_attempts: attempts,
        ...(attempts >= MAX_FAILED_ATTEMPTS ? { canceled_at: now.toISOString() } : {}),
        updated_at: now.toISOString(),
      })
      .eq("id", sub.id);
  }

  return { ok: paid, paymentId, status: paid ? "paid" : "failed", detail: body };
}
