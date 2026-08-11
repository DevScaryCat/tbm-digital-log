// app/api/profile/usage/route.ts — 사용 형태(usage_type)의 단일 변경 창구
//
// usage_type은 '혼자/여러 현장'의 단일 진실이다(웹·앱이 함께 읽는다). 온보딩·가입 마무리가
// 최초 기록을 남기고, 이후 변경은 이 라우트 하나로만 한다 — 로컬 마커(localStorage 등)로
// 상태를 흉내 내면 저장소 3곳이 다시 어긋난다(2026-08 감사에서 확정된 결함).
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, subscriptionAllows } from "@/lib/portone";
import { getOrgContext } from "@/lib/org";
import { isStoreSource } from "@/lib/billing";

export const runtime = "nodejs";

export async function PATCH(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const usage = body.usage === "solo" || body.usage === "multi" ? (body.usage as "solo" | "multi") : null;
  if (!usage) return NextResponse.json({ error: "사용 형태 값이 올바르지 않습니다." }, { status: 400 });

  const admin = getAdminClient();

  // multi→solo: 활성 현장 계정이 남아 있으면 서버가 막는다 — 화면 비활성화는 우회 가능하고,
  // 연결이 남은 채 solo가 되면 '혼자'라면서 회사 좌석 청구가 계속되는 모순 상태가 된다.
  if (usage === "solo") {
    const ctx = await getOrgContext(user.id, admin);
    if (ctx.kind === "owner" && (ctx.memberIds ?? []).length > 0) {
      return NextResponse.json({ error: "현장 계정 연결을 먼저 해제해주세요." }, { status: 409 });
    }

    // 스토어 좌석 정원이 **살아 있으면** 막는다 — 연결된 현장이 0이어도 정원 N개 요금제는
    // 계속 청구되므로, '혼자 쓴다'면서 N개 값을 내는 모순이 된다. 앱이 같은 규칙으로 먼저
    // 설명하지만(org-members 사용 형태 카드) 웹·직접 호출은 여기서만 막힌다.
    // ⚠️ '살아 있는' 정원만 본다. store_seat_capacity는 구독이 만료·해제된 뒤에도 남고
    //    (청산하는 곳은 웹 재구독 경로 하나뿐), 죽은 잔재로 막으면 아무 청구도 없는 사람이
    //    영구히 solo로 못 돌아간다 — 앱 쪽 soloBlockReason과 같은 기준을 쓴다.
    const { data: sub } = await admin
      .from("subscriptions")
      .select("status, plan, current_period_end, source, store_seat_capacity")
      .eq("user_id", user.id)
      .maybeSingle();
    const cap = (sub as { store_seat_capacity?: number | null } | null)?.store_seat_capacity ?? null;
    if (cap != null && cap > 1 && isStoreSource((sub as any)?.source) && subscriptionAllows(sub as any)) {
      return NextResponse.json(
        { error: `현장 계정 정원이 ${cap}개로 설정돼 있어요. 정원을 1로 줄이면 바꿀 수 있어요.` },
        { status: 409 }
      );
    }
  }

  try {
    // admin update는 metadata 전체 치환 — 최신 값을 읽어 usage_type만 병합한다.
    // 다른 키(동의 캐시·이메일 인증 등)에는 어떤 부작용도 없어야 한다.
    const { data: u } = await admin.auth.admin.getUserById(user.id);
    const meta = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
    const { error } = await admin.auth.admin.updateUserById(user.id, {
      user_metadata: { ...meta, usage_type: usage },
    });
    if (error) throw error;
  } catch (e) {
    console.error("usage_type update 실패:", e);
    return NextResponse.json({ error: "저장에 실패했습니다. 잠시 후 다시 시도해주세요." }, { status: 500 });
  }

  return NextResponse.json({ success: true, usage });
}
