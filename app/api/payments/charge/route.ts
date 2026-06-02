import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { chargeSubscription, SubscriptionRow } from "@/lib/billing";

// 수동/테스트 과금: 로그인 사용자의 구독을 빌링키로 즉시 1회 과금
export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }

    const admin = getAdminClient();
    const { data: sub, error } = await admin
      .from("subscriptions")
      .select("id, user_id, billing_key, amount, status, current_period_end, failed_attempts")
      .eq("user_id", user.id)
      .single();

    if (error || !sub) {
      return NextResponse.json({ error: "구독을 찾을 수 없습니다." }, { status: 404 });
    }
    if (sub.status === "canceled") {
      return NextResponse.json({ error: "해지된 구독입니다." }, { status: 400 });
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
