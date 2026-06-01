import { NextResponse } from "next/server";
import {
  getAdminClient,
  getUserFromRequest,
  getBillingKeyInfo,
  extractCardInfo,
  addOneMonth,
  PLAN,
} from "@/lib/portone";

// 카드 등록(빌링키 발급) 완료 후 호출: 빌링키 검증 → 구독 생성(무료체험)
export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }

    const { billingKey, method } = await request.json();
    if (!billingKey) {
      return NextResponse.json({ error: "billingKey가 없습니다." }, { status: 400 });
    }

    const PROVIDER_LABEL: Record<string, string> = {
      card: "카드",
      kakaopay: "카카오페이",
      naverpay: "네이버페이",
      tosspay: "토스페이",
    };

    // 1) 빌링키 발급 검증 (PortOne)
    const info = await getBillingKeyInfo(billingKey);
    if (!info.ok) {
      return NextResponse.json(
        { error: "빌링키 검증 실패", detail: info.body },
        { status: 400 }
      );
    }
    const cardInfo =
      extractCardInfo(info.body) ||
      (method ? { provider: PROVIDER_LABEL[method] ?? method } : null);

    // 2) 구독 생성/갱신 (무료체험: 1개월 뒤 첫 과금)
    const now = new Date();
    const nextChargeAt = addOneMonth(now);
    const admin = getAdminClient();

    const { data, error } = await admin
      .from("subscriptions")
      .upsert(
        {
          user_id: user.id,
          plan: PLAN.id,
          status: "trialing",
          billing_key: billingKey,
          card_info: cardInfo,
          amount: PLAN.amount,
          currency: PLAN.currency,
          trial_end: nextChargeAt.toISOString(),
          current_period_end: nextChargeAt.toISOString(),
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
  } catch (e: any) {
    console.error("billing-key route error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
