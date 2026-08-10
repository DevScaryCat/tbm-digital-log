// app/api/org/seat-preview/route.ts — 현장 계정 추가 시 '지금 결제될 금액' 미리보기 (조회 전용)
//
// 발급 화면(/org/members)이 자체 계산식을 들고 있으면 서버 청구식과 조용히 어긋난다:
// 좌석을 가진 스토어(구글·애플) 감독자가 한 개를 더 추가할 때 기존 좌석의 이번 주기 소급분
// (lib/billing.ts periodBase)이 미리보기에서 빠져, 예고한 '남은 기간 요금'보다 훨씬 큰 금액이
// 즉시 승인됐다(결제 분쟁 소지). 그래서 실제 청구와 **같은 함수**(resolveSeatCharge)로 계산해
// 돌려준다. 여기서 돈은 움직이지 않는다 — PG 호출도, payments 기록도 없다.
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, subscriptionAllows, isBillablePlan } from "@/lib/portone";
import { getOrgContext } from "@/lib/org";
import { resolveSeatCharge, getStoreSeatCapacity, type SeatBlockReason } from "@/lib/billing";

export const runtime = "nodejs";

/** bulk 라우트의 MAX_BULK와 같은 상한 — 화면도 20에서 멈춘다 */
const MAX_COUNT = 20;

export async function GET(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

    const admin = getAdminClient();
    const ctx = await getOrgContext(user.id, admin);
    if (ctx.kind === "member") {
      return NextResponse.json({ error: "소속 현장 계정은 결제 주체가 아닙니다." }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const raw = Math.floor(Number(searchParams.get("count")));
    const count = Number.isFinite(raw) ? Math.min(MAX_COUNT, Math.max(1, raw)) : 1;

    // 발급 라우트(bulk)와 같은 셀렉트·같은 자격 판정 — 미리보기가 발급보다 관대하면
    // "금액은 보이는데 만들면 402"가 된다.
    const { data: sub, error: subErr } = await admin
      .from("subscriptions")
      .select("id, user_id, status, plan, current_period_end, billing_key, source, store_seat_capacity, store_pending_seat_capacity")
      .eq("user_id", user.id)
      .maybeSingle();
    // 조회 실패를 '구독 없음'으로 삼키면 안 된다 — 아래 deny("subscription")이 200으로 나가면
    // 화면은 그걸 서버의 확정 판정으로 믿고 위저드를 닫는다. DB가 한 번 흔들렸을 뿐인데 유료
    // 감독자에게 "구독이 확인되지 않아요"라고 단정하게 된다. 5xx로 돌려보내 화면의 '모르면 막지
    // 않는다' 규율(res.ok 실패 → seatGate=null → 열어둠)에 합류시킨다.
    if (subErr) {
      console.error("seat preview: subscription lookup failed:", subErr);
      return NextResponse.json({ error: "구독 정보를 확인하지 못했어요." }, { status: 503 });
    }
    // plan과 **사유 코드(reason)**를 같이 돌려준다.
    // 종전에는 자격 거절 세 가지(구독 없음·구독 만료·요금제 부적격)를 한 문장으로 뭉쳐서 돌려줬고,
    // 화면은 그 한국어 문장을 되짚어 "결제 문제인가 보다" 하고 /account 링크를 붙였다.
    // 그래서 legacy monthly_basic(1,900원, 결제는 멀쩡히 되는 활성 구독)이 "구독 및 결제로 가기"를
    // 안내받는데, /account에는 요금제를 바꿀 수단이 없고 /pricing은 구독자에게 결제 버튼을 숨긴다
    // — 링크가 붙은 만큼 더 나쁜 막다른 길이었다(검수 2026-08-10 지적 1).
    // 이제 사유는 서버가 코드로 말하고, 화면은 코드로만 분기한다(문장은 그대로 보여줄 사람용).
    const plan = ((sub as any)?.plan as string | null) ?? null;
    const deny = (reason: SeatBlockReason, error: string) =>
      NextResponse.json({ chargeable: false, plan, reason, error });

    // 구독 자체가 없거나 만료·정지 — 결제 화면에서 되살릴 수 있다
    if (!sub || !subscriptionAllows(sub)) {
      return deny("subscription", "구독이 확인되지 않아요. 구독 및 결제에서 상태를 확인해주세요.");
    }
    // 요금제가 좌석을 살 수 없는 종류다(grandfather 영구무료 / legacy monthly_basic).
    // 결제수단을 바꿔도 풀리지 않으므로 결제 화면으로 보내지 않는다 — 문구도 '구독 확인'을 말하지 않는다.
    if (!isBillablePlan(plan)) {
      return deny("plan", "현재 요금제로는 현장 계정을 추가할 수 없어요.");
    }

    // 미리보기 시점에는 아직 좌석을 점유하지 않았다 → seatsClaimed: false
    const charge = await resolveSeatCharge(admin, sub as any, { count, seatsClaimed: false });
    const seatCapacity = await getStoreSeatCapacity(admin, sub as any);
    // 예약된 감액(다음 결제일부터 줄어드는 정원). 정원제일 때만 의미가 있다 —
    // 웹 화면이 이걸 모르면, 앱에서 5→4 감액을 예약한 감독자가 웹에서 5번째 계정을 만들고
    // 갱신일에 RTDN이 정원 4를 반영하면서 그 계정이 조용히 잠긴다(reconcileCapacitySeats가
    // 최근 합류 순으로 접는다). 게이트에는 쓰지 않는다 — 이미 산 정원을 못 쓰게 하는 쪽이라
    // 안내로 충분하다(2026-08-10 검수).
    const pendingRaw = (sub as { store_pending_seat_capacity?: number | null } | null)
      ?.store_pending_seat_capacity;
    const pendingSeatCapacity =
      seatCapacity != null && pendingRaw != null ? Number(pendingRaw) : null;
    return NextResponse.json({
      chargeable: charge.ok,
      plan,
      // reason='capacity'는 결제수단 문제가 아니다 — 화면은 /account가 아니라 앱의 정원 스테퍼로 안내한다
      reason: charge.ok ? undefined : charge.reason,
      error: charge.ok ? undefined : charge.error,
      amount: charge.amount,
      prorated: charge.prorated,
      periodBase: charge.periodBase,
      // 스토어 정원제면 이번 발급이 0원인 이유를 화면이 설명할 수 있게 한다(NULL이면 기존 카드 경로).
      // 컬럼 값을 그대로 내리지 않고 getStoreSeatCapacity를 쓴다 — 정원의 존재 조건(스토어 출처)을
      // 화면·청구가 **같은 함수**로 판정해야 "0원이라더니 3,900원이 승인됐다"가 생기지 않는다.
      seatCapacity,
      pendingSeatCapacity,
    });
  } catch (e) {
    console.error("seat preview error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
