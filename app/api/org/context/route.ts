// app/api/org/context/route.ts — 클라이언트 컴포넌트용 역할 판정 엔드포인트.
// 홈 스왑(owner=관제 대시보드), 헤더 메뉴 분기, attach 수락 모달이 이걸 소비한다.
// 앱(안드로이드)의 '현장 계정 정원' 스테퍼도 여기서 판정값을 받는다 — 앱은 규칙을 손으로
// 베끼지 않고 서버가 내려준 값을 그대로 쓴다(베끼면 반드시 어긋난다는 기존 규율).
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, subscriptionAllows, isBillablePlan } from "@/lib/portone";
import { getOrgContext } from "@/lib/org";
import { isStoreSource, capacityIssueBlocked, STORE_GRACE_MESSAGE } from "@/lib/billing";

export const runtime = "nodejs";

/**
 * 요금제 표(store_products)는 요청마다 바뀌지 않는다 — 상시 경로(헤더·홈 스왑·attach 모달이
 * 전부 이 라우트를 부른다)에서 매번 30행을 읽을 이유가 없다. 모듈 스코프 TTL 캐시로 접는다.
 * (콘솔에 요금제를 새로 seed한 날은 최대 5분 뒤 반영된다 — 스테퍼가 그만큼 늦게 나타날 뿐이다)
 */
const PLAN_MAP_TTL_MS = 5 * 60 * 1000;
let planMapCache: { at: number; map: Record<string, number> } | null = null;

export async function GET(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const ctx = await getOrgContext(user.id);

  // 공통화 이전에 발급된 현장 계정은 근로자 구분·업종·공종이 비어 교육시간 목표가
  // 기본값(비사무직 12시간)으로 어긋난다. 세션마다 오는 이 판정 요청에서 비어 있는 키만
  // 감독자 값으로 채워 초기값을 맞춘다 — 비어 있을 때만 채우므로, 현장 계정이 자기
  // 근로자 구분을 직접 고친 뒤에는 다시 덮이지 않는다.
  if (ctx.kind === "member" && ctx.org?.ownerUserId) {
    try {
      const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
      const missing = ["worker_type", "industry", "work_category"].filter((k) => !meta[k]);
      if (missing.length) {
        const admin = getAdminClient();
        const { data: o } = await admin.auth.admin.getUserById(ctx.org.ownerUserId);
        const om = (o?.user?.user_metadata ?? {}) as Record<string, unknown>;
        const fill: Record<string, unknown> = {};
        for (const k of missing) if (om[k]) fill[k] = om[k];
        if (Object.keys(fill).length) {
          // admin update는 metadata 전체 치환 — 최신 값을 다시 읽어 병합 (다른 키 유실 방지)
          const { data: me } = await admin.auth.admin.getUserById(user.id);
          const mine = (me?.user?.user_metadata ?? {}) as Record<string, unknown>;
          await admin.auth.admin.updateUserById(user.id, { user_metadata: { ...mine, ...fill } });
        }
      }
    } catch { /* 비치명 — 다음 세션이나 owner 저장 전파가 채운다 */ }
  }

  // 소속 현장 계정(member)은 결제 주체가 아니다 — 정원 정보를 계산할 이유가 없다.
  if (ctx.kind === "member") return NextResponse.json(ctx);

  const seats = await resolveSeatState(user.id);
  return NextResponse.json({ ...ctx, ...seats });
}

/**
 * 앱 스테퍼가 필요한 판정 일체. 실패는 전부 '모름'으로 떨어지되 **기존 기능을 막지 않는다** —
 * 앱은 이 값이 없으면 정원 카드만 숨기고 목록·발급 위저드는 그대로 둔다. 발급의 최종 판정은 서버다.
 */
async function resolveSeatState(userId: string) {
  // '모름·해당 없음'의 기본값. canIssueSeats·canAdjustSeats가 전부 false이므로 소비자는
  // 이 두 값만 보고 정원 UI를 숨기면 된다. ⚠️ seatsUsed(1)는 이 경우 **실제 계정 수가 아니다** —
  // 정원 UI 밖에서 계정 수를 표시하는 데 쓰면 안 된다(그 숫자는 /api/org/members가 준다).
  const off = {
    seatCapacity: null as number | null,
    pendingSeatCapacity: null as number | null,
    seatsUsed: 1,
    canIssueSeats: false,
    canAdjustSeats: false,
    /** 발급을 막았을 때 스테퍼 자리에 남길 사실 한 줄. null이면 막은 것이 없다. */
    seatBlockNotice: null as string | null,
    seatPlanMap: {} as Record<string, number>,
  };
  try {
    const admin = getAdminClient();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("plan, status, source, current_period_end, billing_key, store_seat_capacity, store_pending_seat_capacity")
      .eq("user_id", userId)
      .maybeSingle();
    if (!sub) return off;

    const s = sub as {
      plan: string | null;
      status: string;
      source: string | null;
      store_seat_capacity: number | null;
      store_pending_seat_capacity: number | null;
    };

    // 스토어 구독자가 아니면 정원이라는 개념 자체가 없다 — 웹 카드 감독자·grandfather·솔로는
    // 아래 질의(조직·멤버 수·요금제 표)를 한 건도 타지 않고 즉시 빠진다. 이 라우트는 세션마다
    // 여러 번 불리는 상시 경로라, 정원과 무관한 사용자에게 붙은 왕복이 그대로 체감된다.
    // (판정 기준은 lib/billing.ts getStoreSeatCapacity와 같다 — 출처가 스토어일 때만 정원이 있다)
    if (!isStoreSource(s.source)) return off;

    // 실제 계정 수 = 감독자 본인(1) + 활성 소속 현장. organizations.seat_count는 청구 성공 때
    // 갱신되는 스냅샷이라 여기서 쓰지 않는다(표시가 하루 늦게 따라오는 자리가 된다).
    let seatsUsed = 1;
    const { data: org } = await admin
      .from("organizations")
      .select("id")
      .eq("owner_user_id", userId)
      .maybeSingle();
    if (org) {
      const { count } = await admin
        .from("org_members")
        .select("member_user_id", { count: "exact", head: true })
        .eq("org_id", (org as { id: string }).id)
        .eq("status", "active");
      seatsUsed = 1 + (count ?? 0);
    }

    // 정원은 **스토어 출처일 때만** 존재한다 — 스토어를 떠나 웹 카드로 돌아온 계정에 남은
    // 죽은 정원을 그대로 내려주면 앱이 없는 정원으로 발급을 열거나(무과금) 막는다.
    // (lib/billing.ts getStoreSeatCapacity와 같은 기준 — 판정을 한 곳에 모은다)
    const capacity = s.store_seat_capacity != null ? Number(s.store_seat_capacity) : null;
    const allows = subscriptionAllows(s);
    const billable = isBillablePlan(s.plan);

    // 스테퍼를 띄워도 되는가. grandfather(영구 무료)는 billable=false라 여기서 걸린다 —
    // 앱 결제 요소 0 규율. 무료체험 중에도 막는다: 스토어에서 체험 중 요금제를 갈아타면
    // 체험이 끝나고 즉시 결제가 시작될 수 있다.
    // grace(past_due)에서는 **열어둔다** — 요금제를 다시 사는 행위가 곧 결제 회복이라 막을 이유가 없다.
    const canAdjustSeats =
      s.source === "google_play" && billable && allows && s.status !== "trialing";

    // 정원 안의 발급은 무과금 = 앱 안 결제 접점 0 → 정책상 정상이고 이 설계의 핵심 가치다.
    // 정원제가 아니면(카드 경로) 앱에서는 계속 막는다.
    // grace(past_due) 차단은 **lib/billing.ts capacityIssueBlocked 한 곳**에서 판정한다 —
    // resolveSeatCharge의 정원 분기가 같은 함수를 부르므로, 앱이 "N개 더 만들 수 있어요"를
    // 띄운 뒤 서버가 402를 주는 어긋남이 구조적으로 불가능해진다(2026-08-10 검수).
    const graceBlocked = capacity != null && capacityIssueBlocked(s.status);
    const canIssueSeats =
      capacity != null && billable && allows && !graceBlocked && seatsUsed < capacity;
    // 막을 때 화면이 침묵하지 않게 사실 한 줄을 같이 내린다 — 스테퍼가 그냥 사라지면
    // 사용자는 왜 못 만드는지 알 단서가 없다(앱은 이 문구를 카드에 그대로 렌더한다).
    const seatBlockNotice = graceBlocked ? STORE_GRACE_MESSAGE : null;

    // 앱은 'seats-'를 파싱하지 않는다 — 스토어가 실제로 내려준 오퍼와 이 표를 교집합한다.
    // 콘솔에 요금제가 아직 없으면 교집합이 비어 스테퍼가 조용히 숨는다(오류 화면 없음).
    // 표는 요청마다 바뀌지 않으므로 TTL 캐시로 접는다(상시 경로에 붙은 30행 조회).
    let seatPlanMap = planMapCache && Date.now() - planMapCache.at < PLAN_MAP_TTL_MS
      ? planMapCache.map
      : null;
    if (!seatPlanMap) {
      const built: Record<string, number> = {};
      const { data: plans, error: planErr } = await admin
        .from("store_products")
        .select("base_plan_id, seat_capacity")
        .eq("platform", "google_play")
        .eq("active", true)
        .not("seat_capacity", "is", null)
        .order("sort_order", { ascending: true });
      for (const p of ((plans ?? []) as { base_plan_id: string; seat_capacity: number }[])) {
        built[p.base_plan_id] = Number(p.seat_capacity);
      }
      // 조회 실패를 '요금제 없음'으로 5분간 캐시하면 DB가 한 번 흔들렸을 뿐인데 스테퍼가
      // 그 시간 내내 숨는다 — 실패는 캐시하지 않고 다음 요청이 다시 시도하게 둔다.
      if (!planErr) planMapCache = { at: Date.now(), map: built };
      seatPlanMap = built;
    }

    return {
      seatCapacity: capacity,
      pendingSeatCapacity:
        s.store_pending_seat_capacity == null ? null : Number(s.store_pending_seat_capacity),
      seatsUsed,
      canIssueSeats,
      canAdjustSeats,
      seatBlockNotice,
      seatPlanMap,
    };
  } catch (e) {
    console.error("org context: seat state failed", e);
    return off;
  }
}
