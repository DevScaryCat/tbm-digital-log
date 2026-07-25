// lib/cancelSubscription.ts — 구독 해지 공용 로직 (라우트 + 편입(attach) 흐름에서 재사용)
// - 무료체험 중(결제 이력 없음): 다음 결제일까지 이용 가능, 자동결제만 중단
// - 유료 기간 중: 잔여 기간 일할 환불 후 즉시 종료
// 환불 기준은 정기결제 건(payment_id 'sub_%')만 사용한다 — 좌석 증설 일할결제('seat_%')가
// 마지막 paid가 되면 환불 기준액·주기 시작일이 왜곡되므로(검증 F5) 정기 건과 분리 정산한다.
import { SupabaseClient } from "@supabase/supabase-js";
import { cancelPayment, deleteBillingKey } from "@/lib/portone";

const DAY = 24 * 60 * 60 * 1000;

export interface CancelResult {
  ok: boolean;
  alreadyCanceled?: boolean;
  notFound?: boolean;
  grandfather?: boolean;
  refunded: number;
  refundFailed: boolean;
}

export async function cancelUserSubscription(
  admin: SupabaseClient,
  userId: string,
  opts: { reason?: string } = {}
): Promise<CancelResult> {
  const reason = opts.reason ?? "구독 중도 해지 - 잔여 기간 일할 환불";
  const { data: sub, error } = await admin
    .from("subscriptions")
    .select("id, status, plan, amount, current_period_end, billing_key")
    .eq("user_id", userId)
    .single();

  if (error || !sub) return { ok: false, notFound: true, refunded: 0, refundFailed: false };
  if (sub.plan === "grandfather") return { ok: false, grandfather: true, refunded: 0, refundFailed: false };
  if (sub.status === "canceled") return { ok: true, alreadyCanceled: true, refunded: 0, refundFailed: false };

  const now = new Date();
  const end = sub.current_period_end ? new Date(sub.current_period_end) : null;

  let refunded = 0;
  let refundFailed = false;

  if (end && end.getTime() > now.getTime()) {
    // ① 정기결제 건 일할 환불 — 이번 주기: 시작 = 정기 건 결제일(없으면 종료-30일)
    const { data: lastPay } = await admin
      .from("payments")
      .select("payment_id, amount, paid_at")
      .eq("user_id", userId)
      .eq("status", "paid")
      .like("payment_id", "sub_%")
      .order("paid_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const periodStart = lastPay?.paid_at ? new Date(lastPay.paid_at) : new Date(end.getTime() - 30 * DAY);
    if (lastPay?.payment_id && (lastPay.amount ?? 0) > 0) {
      const total = end.getTime() - periodStart.getTime();
      const remaining = end.getTime() - now.getTime();
      if (total > 0 && remaining > 0) {
        let amt = Math.floor(((lastPay.amount as number) * remaining) / total);
        amt = Math.max(0, Math.min(amt, lastPay.amount as number));
        if (amt > 0) {
          const res = await cancelPayment({ paymentId: lastPay.payment_id, amount: amt, reason });
          if (res.ok) {
            refunded += amt;
            await admin
              .from("payments")
              .update({ status: amt >= (lastPay.amount as number) ? "canceled" : "partial_canceled" })
              .eq("payment_id", lastPay.payment_id);
          } else {
            refundFailed = true;
            console.error("정기결제 환불 실패:", res.body);
          }
        }
      }
    }

    // ② 이번 주기의 좌석 증설 일할결제('seat_%') 환불 — 각 건의 자체 기간(결제일~주기말) 기준
    const { data: seatPays } = await admin
      .from("payments")
      .select("payment_id, amount, paid_at")
      .eq("user_id", userId)
      .eq("status", "paid")
      .like("payment_id", "seat_%")
      .gte("paid_at", periodStart.toISOString());
    for (const p of seatPays ?? []) {
      if (!p.paid_at || !(p.amount > 0)) continue;
      const pStart = new Date(p.paid_at);
      const total = end.getTime() - pStart.getTime();
      const remaining = end.getTime() - now.getTime();
      if (total <= 0 || remaining <= 0) continue;
      let amt = Math.floor((p.amount * remaining) / total);
      amt = Math.max(0, Math.min(amt, p.amount));
      if (amt <= 0) continue;
      const res = await cancelPayment({ paymentId: p.payment_id, amount: amt, reason });
      if (res.ok) {
        refunded += amt;
        await admin
          .from("payments")
          .update({ status: amt >= p.amount ? "canceled" : "partial_canceled" })
          .eq("payment_id", p.payment_id);
      } else {
        refundFailed = true;
        console.error("좌석 일할결제 환불 실패:", res.body);
      }
    }
  }

  // 빌링키 폐기 (PG측 위임 회수) — 실패해도 해지는 진행
  if (sub.billing_key) {
    const del = await deleteBillingKey(sub.billing_key);
    if (!del.ok) console.error("빌링키 PG측 폐기 실패(해지는 계속 진행):", del.status, del.body);
  }

  const update: Record<string, any> = {
    status: "canceled",
    canceled_at: now.toISOString(),
    updated_at: now.toISOString(),
    billing_key: null,
    card_info: null,
  };
  if (refunded > 0) update.current_period_end = now.toISOString();

  const { error: updErr } = await admin.from("subscriptions").update(update).eq("id", sub.id);
  if (updErr) {
    console.error("해지 상태 갱신 실패:", updErr);
    return { ok: false, refunded, refundFailed };
  }

  return { ok: true, refunded, refundFailed };
}
