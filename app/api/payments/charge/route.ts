import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { chargeSubscription, SubscriptionRow } from "@/lib/billing";
import { paymentsEnabled } from "@/lib/utils";

// 수동/테스트 과금: 로그인 사용자의 구독을 빌링키로 즉시 1회 과금
export async function POST(request: Request) {
  try {
    // 다른 결제 라우트(billing-key/change-plan)와 동일하게 결제 비활성 시 차단
    if (!paymentsEnabled()) {
      return NextResponse.json({ error: "결제 기능이 아직 활성화되지 않았습니다." }, { status: 403 });
    }

    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }

    const admin = getAdminClient();
    const { data: sub, error } = await admin
      .from("subscriptions")
      .select("id, user_id, plan, pending_plan, billing_key, amount, status, current_period_end, failed_attempts")
      .eq("user_id", user.id)
      .single();

    if (error || !sub) {
      return NextResponse.json({ error: "구독을 찾을 수 없습니다." }, { status: 404 });
    }
    if (sub.status === "canceled") {
      return NextResponse.json({ error: "해지된 구독입니다." }, { status: 400 });
    }
    // 아직 이용 기간이 남아 있으면(=이번 기간 결제 완료) 추가 청구하지 않는다.
    // 매 성공마다 current_period_end가 미래로 이동하므로, 이 가드가 없으면
    // 이 라우트를 반복 호출해 카드에 반복 청구(선결제 루프)가 가능하다.
    if (sub.current_period_end && new Date(sub.current_period_end) > new Date()) {
      return NextResponse.json(
        { error: "이미 이용 기간이 남아 있어 추가 결제가 필요하지 않습니다." },
        { status: 400 }
      );
    }

    const result = await chargeSubscription(admin, sub as SubscriptionRow, {
      customerEmail: user.email ?? undefined,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: "결제 실패", detail: result.detail },
        { status: 402 }
      );
    }
    return NextResponse.json({ success: true, paymentId: result.paymentId });
  } catch (e: any) {
    console.error("charge route error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
