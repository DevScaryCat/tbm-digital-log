import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, cancelPayment, deleteBillingKey } from "@/lib/portone";

export const runtime = "nodejs";

const DAY = 24 * 60 * 60 * 1000;

// 구독 해지
// - 무료체험 중(결제 이력 없음): 다음 결제일까지 이용 가능, 자동결제만 중단
// - 유료 기간 중: 이용하지 않은 잔여 기간을 일할 계산해 환불하고 즉시 종료
export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }

    const admin = getAdminClient();
    const { data: sub, error } = await admin
      .from("subscriptions")
      .select("id, status, plan, amount, current_period_end, billing_key")
      .eq("user_id", user.id)
      .single();

    if (error || !sub) {
      return NextResponse.json({ error: "구독을 찾을 수 없습니다." }, { status: 404 });
    }
    if (sub.plan === "grandfather") {
      return NextResponse.json({ error: "해당 계정은 해지 대상이 아닙니다." }, { status: 400 });
    }
    if (sub.status === "canceled") {
      return NextResponse.json({ success: true, alreadyCanceled: true });
    }

    const now = new Date();
    const end = sub.current_period_end ? new Date(sub.current_period_end) : null;

    // --- 이용 기간에 따른 환불 계산 ---
    // 현재 유료 기간이 아직 남아있고 결제된 내역이 있으면, 잔여 기간만큼 일할 환불
    let refundAmount = 0;
    let paymentToRefund: string | null = null;
    let paidAmount = 0;
    if (end && end.getTime() > now.getTime()) {
      const { data: lastPay } = await admin
        .from("payments")
        .select("payment_id, amount, paid_at")
        .eq("user_id", user.id)
        .eq("status", "paid")
        .order("paid_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastPay?.payment_id && (lastPay.amount ?? 0) > 0) {
        // 이번 결제 주기: 시작 = 마지막 결제일(없으면 종료-30일), 끝 = current_period_end
        const start = lastPay.paid_at ? new Date(lastPay.paid_at) : new Date(end.getTime() - 30 * DAY);
        const total = end.getTime() - start.getTime();
        const remaining = end.getTime() - now.getTime();
        if (total > 0 && remaining > 0) {
          paidAmount = lastPay.amount;
          refundAmount = Math.floor((paidAmount * remaining) / total);
          refundAmount = Math.max(0, Math.min(refundAmount, paidAmount));
          paymentToRefund = lastPay.payment_id;
        }
      }
    }

    // --- 환불 실행 (PortOne) ---
    let refunded = 0;
    let refundFailed = false;
    if (paymentToRefund && refundAmount > 0) {
      const res = await cancelPayment({
        paymentId: paymentToRefund,
        amount: refundAmount,
        reason: "구독 중도 해지 - 잔여 기간 일할 환불",
      });
      if (res.ok) {
        refunded = refundAmount;
        await admin
          .from("payments")
          .update({ status: refunded >= paidAmount ? "canceled" : "partial_canceled" })
          .eq("payment_id", paymentToRefund);
      } else {
        refundFailed = true;
        console.error("환불 실패:", res.body);
      }
    }

    // --- 빌링키 폐기 (PG측 위임 회수) ---
    // 해지 후엔 자동결제가 없어야 하므로 키를 남겨둘 이유가 없다. 재구독은 항상 새 키 발급 경로.
    // PG측 폐기 실패는 로그만 — DB에서 키를 지우면 우리 쪽에선 어차피 과금 불가.
    if (sub.billing_key) {
      const del = await deleteBillingKey(sub.billing_key);
      if (!del.ok) console.error("빌링키 PG측 폐기 실패(해지는 계속 진행):", del.status, del.body);
    }

    // --- 구독 상태 갱신 ---
    const update: Record<string, any> = {
      status: "canceled",
      canceled_at: now.toISOString(),
      updated_at: now.toISOString(),
      // 결제수단 표시·재과금 근거 제거 — 해지 화면에 '결제수단: 토스페이'가 남던 버그의 원인
      billing_key: null,
      card_info: null,
    };
    // 환불에 성공했으면(잔여 기간 정산 완료) 즉시 종료, 무환불/실패면 기간 만료까지 이용
    if (refunded > 0) update.current_period_end = now.toISOString();

    const { error: updErr } = await admin
      .from("subscriptions")
      .update(update)
      .eq("id", sub.id);

    if (updErr) {
      return NextResponse.json({ error: "해지 처리 실패" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      refunded,
      ...(refundFailed
        ? {
            refundNotice:
              "해지는 완료되었으나 자동 환불에 실패했습니다. 고객센터로 문의해주시면 잔여 기간을 환불해 드립니다.",
          }
        : {}),
    });
  } catch (e) {
    console.error("cancel route error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
