import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";

// 구독 해지: 다음 결제일까지는 이용 가능, 이후 자동결제 중단
export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }

    const admin = getAdminClient();
    const { data: sub, error } = await admin
      .from("subscriptions")
      .select("id, status, plan")
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

    const { error: updErr } = await admin
      .from("subscriptions")
      .update({
        status: "canceled",
        canceled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", sub.id);

    if (updErr) {
      return NextResponse.json({ error: "해지 처리 실패" }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("cancel route error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
