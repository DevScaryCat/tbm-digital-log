import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, getPlan } from "@/lib/portone";
import { paymentsEnabled } from "@/lib/utils";

export const runtime = "nodejs";

// 기존 구독자의 플랜 변경(업그레이드/다운그레이드).
// 카드 재등록 없이 plan/amount만 교체 — 다음 결제일부터 새 금액 적용.
export async function POST(request: Request) {
  try {
    if (!paymentsEnabled()) {
      return NextResponse.json({ error: "결제 기능 준비 중입니다." }, { status: 403 });
    }
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }

    const { plan } = await request.json();
    const selectedPlan = getPlan(plan);

    const admin = getAdminClient();
    const { data: existing, error: selErr } = await admin
      .from("subscriptions")
      .select("id, status, plan, current_period_end")
      .eq("user_id", user.id)
      .maybeSingle();
    if (selErr) {
      console.error("change-plan select error:", selErr);
      return NextResponse.json({ error: "구독 조회 실패" }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: "구독을 찾을 수 없습니다." }, { status: 404 });
    }
    if (existing.status === "canceled") {
      return NextResponse.json(
        { error: "해지된 구독은 플랜을 변경할 수 없습니다. 다시 구독해주세요." },
        { status: 400 }
      );
    }
    if (existing.plan === "grandfather") {
      return NextResponse.json(
        { error: "평생 무료 회원은 플랜 변경이 필요 없습니다." },
        { status: 400 }
      );
    }

    // 즉시 전환하지 않고 '다음 결제일에 적용'으로 예약 (즉시 전환 악용 방지).
    // 현재 플랜과 같으면 예약 취소.
    const pending = existing.plan === selectedPlan.id ? null : selectedPlan.id;

    const { error: upErr } = await admin
      .from("subscriptions")
      .update({ pending_plan: pending, updated_at: new Date().toISOString() })
      .eq("user_id", user.id);
    if (upErr) {
      console.error("change-plan update error:", upErr);
      return NextResponse.json({ error: "플랜 변경 실패" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      pendingPlan: pending,
      effectiveDate: existing.current_period_end,
    });
  } catch (e: any) {
    console.error("change-plan route error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
