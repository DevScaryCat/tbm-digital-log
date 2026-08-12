// app/api/org/context/route.ts — 클라이언트 컴포넌트용 역할 판정 엔드포인트.
// 홈 스왑(owner=관제 대시보드), 헤더 메뉴 분기, attach 수락 모달이 이걸 소비한다.
// 앱(안드로이드)의 '현장 계정 정원' 스테퍼도 여기서 판정값을 받는다 — 앱은 규칙을 손으로
// 베끼지 않고 서버가 내려준 값을 그대로 쓴다(베끼면 반드시 어긋난다는 기존 규율).
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest, subscriptionAllows, isBillablePlan } from "@/lib/portone";
import { cancelOrgSeatMirrors, getOrgContext } from "@/lib/org";
import { resolveOrgSeatAccountingByOwner, type SeatState } from "@/lib/orgSeats";
import { OWNER_SEAT_SUB_COLUMNS, restoreOrgSeats, type OwnerSeatSub } from "@/lib/seatRestore";
import { isStoreSource, capacityIssueBlocked, resolveSeatCharge, STORE_GRACE_MESSAGE } from "@/lib/billing";

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
  if (ctx.kind === "member") {
    // 좌석 회계 상태. self_store(본인이 스토어에 직접 결제 중)면 /account를 열어주고
    // '회사 연결 끊기'를 허용한다 — 그 판정을 앱·웹이 각자 계산하지 않게 여기서 내린다.
    let seatState: SeatState | null = null;
    let seatLocked = false;
    // 다만 여기가 '잠김'을 가장 빨리 푸는 자리다. ctx.kind==='member'라는 것은 소속 조직 구독이
    // 유효하다는 뜻인데(getOrgContext가 이미 판정했다), 본인 행이 무효면 기능 게이트가 잠긴다 —
    // 본인 스토어 구독이 끝났고 미러가 아직 안 씌워진 창(크론 스윕까지 최대 24h)이 정확히 그 상태다.
    // 소속 계정은 카드 교체가 403이라 스스로 풀 방법이 없으므로, 앱을 켜는 순간 서버가 1회 시도한다.
    // 정상 케이스(미러 살아 있음)는 쓰기가 없다 — restoreOrgSeatMirrors가 뷰로 후보를 거른다.
    try {
      const admin = getAdminClient();
      const { data: mine } = await admin
        .from("subscriptions")
        .select("status, current_period_end, billing_key")
        .eq("user_id", user.id)
        .maybeSingle();
      if (ctx.org?.id) {
        const { data: seatRow } = await admin
          .from("org_seat_states")
          .select("seat_state")
          .eq("org_id", ctx.org.id)
          .eq("member_user_id", user.id)
          .maybeSingle();
        const raw = String((seatRow as { seat_state?: string } | null)?.seat_state ?? "");
        seatState = raw === "self_store" || raw === "grandfather" ? (raw as SeatState) : raw ? "seat" : null;
      }
      if (!subscriptionAllows(mine) && ctx.org?.id && ctx.org.ownerUserId) {
        // ⚠️ 자가복구는 크론과 **같은 잠금**을 지켜야 한다. 종전의 restoreOrgSeatMirrors 직접
        // 호출에는 좌석 카드 3회 소진(SEAT_CHARGE_EXHAUSTED)도 정원 부족 보류도 없어서,
        // 크론이 "돈을 못 받는 좌석은 열지 않는다"며 건너뛴 멤버가 **앱을 켜는 것만으로**
        // 좌석을 되살렸다 — 청구 쿼리는 그 감독자를 영구 제외하므로 무기한 무과금 좌석이었다
        // (2026-08-13 검수). 판정은 lib/seatRestore.ts 한 곳에 있고 여기는 부르기만 한다.
        const { data: ownerSub } = await admin
          .from("subscriptions")
          .select(OWNER_SEAT_SUB_COLUMNS)
          .eq("user_id", ctx.org.ownerUserId)
          .maybeSingle();
        const r = await restoreOrgSeats(
          admin,
          { id: ctx.org.id, ownerUserId: ctx.org.ownerUserId },
          (ownerSub as OwnerSeatSub | null) ?? null,
          { only: [user.id] }
        );
        if (r.restored > 0) console.warn("SEAT_MIRROR_SELF_HEAL", { orgId: ctx.org.id, userId: user.id });
        else if (seatState !== "self_store" && seatState !== "grandfather") {
          // 자가복구를 시도했는데도 본인 행이 무효다 = **좌석만 잠긴** 상태다(좌석 카드 3회 실패·
          // 정원 부족 복원 보류). 회사 구독은 유효하므로 "회사 결제가 끝났어요"는 거짓이고,
          // 종전에는 이 사실을 로그로만 남겨(SEAT_MIRROR_SELF_HEAL) 멤버가 아무 진단도 못 받았다.
          seatLocked = true;
          console.warn("SEAT_LOCKED", { orgId: ctx.org.id, userId: user.id, blocked: r.blocked });
        }
      }
    } catch (e) {
      // 비치명 — 다음 크론 스윕이 같은 일을 한다
      console.error("org context: 미러 자가복구 실패", e);
    }
    return NextResponse.json({ ...ctx, seatState, seatLocked });
  }

  // 회사 구독이 무효인데 **내 미러가 아직 살아 있으면** 그 자리에서 접는다.
  // 위 member 분기의 자가복구와 대칭인 자리다: 종전에는 '조직 유효 + 본인 무효 → 복구'만 있고
  // '조직 무효 + 본인 미러 alive → 강등'이 없어서, 스토어 회수·STALE 백스톱처럼 즉시 접히지
  // 않는 경로에서 하루 1회 크론까지 최대 24시간이 통째로 무과금이었다(2026-08-13 검수).
  // cancelOrgSeatMirrors의 UPDATE는 plan='org_seat'로 좁혀져 있어 자가 결제자·영구무료의
  // 행에는 닿지 않는다(그런 멤버는 애초에 orgLapse를 받지 않는다).
  if (ctx.orgLapse) {
    try {
      const admin = getAdminClient();
      const { data: mine } = await admin
        .from("subscriptions")
        .select("plan, status")
        .eq("user_id", user.id)
        .maybeSingle();
      const m = mine as { plan?: string | null; status?: string | null } | null;
      if (m?.plan === "org_seat" && m.status === "active") {
        await cancelOrgSeatMirrors([user.id], admin);
        console.warn("ORG_LAPSE_SELF_DEMOTE", { orgId: ctx.orgLapse.orgId, userId: user.id });
      }
    } catch (e) {
      // 비치명 — 다음 크론 스윕이 같은 일을 한다
      console.error("org context: 유예 강등 실패", e);
    }
  }

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
    /**
     * **"지금 이 사람이 0원으로 현장 계정을 만들 수 있는가"** — canIssueSeats와 다른 질문이다.
     *
     * canIssueSeats는 "스토어에서 정원(seats-NN)을 산 사람인가"만 답한다. 그래서 카드 없는
     * 휴대폰 무료체험 감독자는 여기서 false로 떨어졌는데, 정작 서버의 진짜 발급 판정
     * (lib/billing.ts resolveSeatCharge)은 그 사람을 **0원으로 통과**시킨다("카드 없는 휴대폰
     * 인증 체험 계정은 아예 결제수단이 없어 여기서 막히면 현장을 하나도 못 만든다" — 그 함수
     * 주석). 웹은 그 판정을 따라 위저드를 열어주는데 앱만 canIssueSeats를 보고 막아서,
     * 체험자 전원이 '사용 형태를 바꿔도 아무 일도 안 일어나는' 막다른 길에 있었다
     * (2026-08-11 Chris 지적, DB 확인: 카드 없는 체험자 5명 전원 / 스토어 체험자 0명).
     *
     * 'capacity'   = 스토어 정원 안의 무과금 발급 (종전 canIssueSeats와 같은 상태)
     * 'free_trial' = 무료체험 중이라 지금 만들면 0원 (체험 종료일에 늘어난 수만큼 청구)
     * 'none'       = 발급 불가. 이유는 seatIssueNotice에 있다.
     *
     * ⚠️ 0원일 때만 연다. 발급이 성공하더라도 **카드가 긁히는** 경우(웹 카드 정기결제 감독자가
     *    현장을 추가하는 일할 청구)는 'none'이다 — 앱 안 결제 접점 0 규율은 그대로다.
     */
    seatIssueMode: "none" as "capacity" | "free_trial" | "none",
    /** seatIssueMode='none'일 때 화면이 침묵하지 않도록 서버가 주는 사유 한 줄 */
    seatIssueNotice: null as string | null,
    seatPlanMap: {} as Record<string, number>,
  };
  try {
    const admin = getAdminClient();
    const { data: sub } = await admin
      .from("subscriptions")
      // id는 resolveSeatCharge의 시그니처가 요구한다(그 안에서 source 재조회를 건너뛰게 하려면
      // source까지 넘겨야 하고, 넘기지 않으면 id로 다시 읽는다). 상시 경로라 왕복을 아낀다.
      .select("id, plan, status, source, current_period_end, billing_key, store_seat_capacity, store_pending_seat_capacity")
      .eq("user_id", userId)
      .maybeSingle();
    if (!sub) return off;

    const s = sub as {
      id: string;
      plan: string | null;
      status: string;
      source: string | null;
      current_period_end: string | null;
      billing_key: string | null;
      store_seat_capacity: number | null;
      store_pending_seat_capacity: number | null;
    };

    // 스토어 구독자가 아니면 정원이라는 개념 자체가 없다 — 웹 카드 감독자·grandfather·솔로는
    // 아래 질의(조직·멤버 수·요금제 표)를 한 건도 타지 않고 즉시 빠진다. 이 라우트는 세션마다
    // 여러 번 불리는 상시 경로라, 정원과 무관한 사용자에게 붙은 왕복이 그대로 체감된다.
    // (판정 기준은 lib/billing.ts getStoreSeatCapacity와 같다 — 출처가 스토어일 때만 정원이 있다)
    if (!isStoreSource(s.source)) {
      // 정원 개념은 없지만 **발급 자격은 있을 수 있다.** 그 판정은 여기서 다시 만들지 않고
      // 발급·초대·편입이 전부 쓰는 함수 하나에 그대로 묻는다 — 규칙을 베끼면 "만들 수 있다더니
      // 402"가 되고, 실제로 그 어긋남 때문에 체험자가 앱에서 통째로 막혀 있었다.
      //
      // 비용: 비스토어 출처에서는 왕복이 0회다. source를 명시해 넘기므로 resolveSeatCharge의
      // source 재조회(billing.ts:385)가 건너뛰어지고, getStoreSeatCapacity도 285행에서 즉시
      // null을 돌려준다. trialing이면 그대로 ok:true·0원으로 반환된다(billing.ts:429).
      const dry = await resolveSeatCharge(
        admin,
        {
          id: s.id,
          user_id: userId,
          status: s.status,
          billing_key: s.billing_key,
          current_period_end: s.current_period_end,
          source: s.source,
          store_seat_capacity: s.store_seat_capacity,
        },
        { count: 1, seatsClaimed: false }
      );
      // 0원일 때만 연다. 발급 자체는 되더라도 카드가 긁히는 경우(웹 카드 정기결제 감독자의
      // 일할 청구)는 앱에서 열지 않는다 — 앱 안 결제 접점 0.
      if (dry.ok && dry.amount === 0) {
        return { ...off, seatIssueMode: "free_trial" as const, seatIssueNotice: null };
      }
      // ⚠️ 여기서 "웹에서 하세요"라고 쓰지 않는다 — 구글 플레이 외부 결제 유도 규정에 걸릴
      //    수 있고, Chris가 고른 안(2026-08-11)도 '앱에서 체험자에게 열어준다'이지 '앱 밖으로
      //    보낸다'가 아니다. 막힌 사실과 이유만 말한다.
      return {
        ...off,
        seatIssueMode: "none" as const,
        seatIssueNotice: dry.ok
          ? "현장 계정을 추가하면 계정당 요금이 함께 청구돼요. 지금은 앱에서 추가할 수 없어요."
          : dry.error ?? null,
      };
    }

    // 실제 계정 수 = 감독자 본인(1) + **정원을 먹는 좌석**. organizations.seat_count는 청구 성공 때
    // 갱신되는 스냅샷이라 여기서 쓰지 않는다(표시가 하루 늦게 따라오는 자리가 된다).
    // 좌석 수는 좌석 회계(lib/orgSeats.ts)에서만 나온다 — 앱 스테퍼가 서버의 정원 판정
    // (claim_org_seat·checkSeatCapacity)과 다른 수를 세면 "만들 수 있다더니 402"가 된다.
    const acc = await resolveOrgSeatAccountingByOwner(admin, userId);
    const seatsUsed = 1 + (acc?.billableSeats ?? 0);

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
      // 스토어 정원제에서는 발급 자격이 곧 canIssueSeats다 — 여기서 resolveSeatCharge를 또 부르면
      // checkSeatCapacity 왕복이 하나 더 붙는데, 두 판정은 이미 capacityIssueBlocked를 공유해
      // 갈라질 수 없다. 사유 문구도 seatBlockNotice와 같은 것을 쓴다(두 자리에 다른 말 금지).
      seatIssueMode: (canIssueSeats ? "capacity" : "none") as "capacity" | "free_trial" | "none",
      seatIssueNotice: canIssueSeats ? null : seatBlockNotice,
      seatPlanMap,
    };
  } catch (e) {
    console.error("org context: seat state failed", e);
    return off;
  }
}
