// lib/cancelSubscription.ts — 구독 해지 공용 로직 (라우트 + 편입(attach) 흐름에서 재사용)
// - 무료체험 중(결제 이력 없음): 다음 결제일까지 이용 가능, 자동결제만 중단
// - 유료 기간 중: 잔여 기간 일할 환불 후 즉시 종료
// 환불 기준은 정기결제 건(payment_id 'sub_%')만 사용한다 — 좌석 증설 일할결제('seat_%')가
// 마지막 paid가 되면 환불 기준액·주기 시작일이 왜곡되므로(검증 F5) 정기 건과 분리 정산한다.
import { SupabaseClient } from "@supabase/supabase-js";
import { cancelPayment, deleteBillingKey } from "@/lib/portone";

const DAY = 24 * 60 * 60 * 1000;

/** 청약철회 기간 — 전자상거래법 제17조① (7일 이내) */
const WITHDRAWAL_DAYS = 7;

/**
 * 이번 결제분에 대해 '청약철회'로 봐야 하는지 판정한다.
 *
 * 결제 후 7일 이내에 서비스를 한 번도 쓰지 않았다면 중도해지(일할 공제)가 아니라
 * 청약철회(전액 환불)다. 시간 단위로 일할을 떼면 "3시간 썼으니 25원 공제" 같은 결과가
 * 나오는데, 미사용 청약철회에 그걸 적용하면 분쟁에서 방어가 안 된다.
 *
 * 운영상으로도 전액취소가 낫다 — 당일 전액취소는 매입 전이라 승인취소로 처리돼
 * 카드 명세에서 아예 사라지지만, 부분취소는 원 승인이 남고 취소 전표가 며칠 뒤에
 * 따로 붙어서 "환불이 안 됐다"는 문의를 만든다.
 */
async function isUnusedWithdrawal(
  admin: SupabaseClient,
  userId: string,
  paidAt: Date,
  now: Date
): Promise<boolean> {
  if (now.getTime() - paidAt.getTime() > WITHDRAWAL_DAYS * DAY) return false;
  const since = paidAt.toISOString();
  const [minutes, logs, ra] = await Promise.all([
    admin.from("tbm_minutes").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", since),
    admin.from("tbm_logs").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", since),
    admin.from("tbm_risk_assessments").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", since),
  ]);
  // 조회 실패는 '사용함'으로 간주 — 못 셌다고 전액 환불해버리면 어뷰징 경로가 열린다
  if (minutes.error || logs.error || ra.error) {
    console.error("청약철회 사용량 조회 실패 — 일할 환불로 진행", {
      userId, m: minutes.error, l: logs.error, r: ra.error,
    });
    return false;
  }
  return (minutes.count ?? 0) === 0 && (logs.count ?? 0) === 0 && (ra.count ?? 0) === 0;
}

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

    // 결제 후 7일 이내 + 이번 주기 미사용 = 청약철회 → 일할 공제 없이 전액.
    // 정기 건과 좌석 추가 건 모두에 같은 판정을 적용한다(같은 계약의 같은 주기라서).
    const withdrawal = lastPay?.paid_at
      ? await isUnusedWithdrawal(admin, userId, new Date(lastPay.paid_at), now)
      : false;

    if (lastPay?.payment_id && (lastPay.amount ?? 0) > 0) {
      const paidAmount = lastPay.amount as number;
      let amt = 0;
      if (withdrawal) {
        amt = paidAmount;
      } else {
        const total = end.getTime() - periodStart.getTime();
        const remaining = end.getTime() - now.getTime();
        if (total > 0 && remaining > 0) {
          amt = Math.min(Math.max(0, Math.floor((paidAmount * remaining) / total)), paidAmount);
        }
      }

      if (amt > 0) {
        const res = await cancelPayment({
          paymentId: lastPay.payment_id,
          // 전액이면 amount를 넘기지 않는다 — 부분취소가 아니라 전체취소로 처리돼야
          // 매입 전 승인취소가 되고 카드 명세에 흔적이 남지 않는다
          amount: amt >= paidAmount ? undefined : amt,
          reason: withdrawal ? "청약철회 - 미사용 전액 환불" : reason,
        });
        if (res.ok) {
          refunded += amt;
          const { error: payUpdErr } = await admin
            .from("payments")
            .update({ status: amt >= paidAmount ? "canceled" : "partial_canceled" })
            .eq("payment_id", lastPay.payment_id);
          // 이 UPDATE가 조용히 실패하면 PG에는 환불이 있는데 우리 장부만 'paid'로 남는다
          if (payUpdErr) console.error("환불 기록 갱신 실패(PG 환불은 완료됨):", lastPay.payment_id, payUpdErr);
        } else {
          refundFailed = true;
          console.error("정기결제 환불 실패:", res.body);
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
      let amt: number;
      if (withdrawal) {
        amt = p.amount;
      } else {
        const pStart = new Date(p.paid_at);
        const total = end.getTime() - pStart.getTime();
        const remaining = end.getTime() - now.getTime();
        if (total <= 0 || remaining <= 0) continue;
        amt = Math.min(Math.max(0, Math.floor((p.amount * remaining) / total)), p.amount);
      }
      if (amt <= 0) continue;
      const res = await cancelPayment({
        paymentId: p.payment_id,
        amount: amt >= p.amount ? undefined : amt,
        reason,
      });
      if (res.ok) {
        refunded += amt;
        const { error: seatUpdErr } = await admin
          .from("payments")
          .update({ status: amt >= p.amount ? "canceled" : "partial_canceled" })
          .eq("payment_id", p.payment_id);
        if (seatUpdErr) console.error("환불 기록 갱신 실패(PG 환불은 완료됨):", p.payment_id, seatUpdErr);
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
