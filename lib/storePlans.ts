// lib/storePlans.ts — 스토어 요금제(base plan) ↔ 좌석 정원 매핑의 단일 소스.
//
// 앱(안드로이드) 감독자가 스테퍼로 현장 계정 수를 조절하면 스토어 구독 하나의 **요금제**가 바뀐다.
// 그 요금제가 몇 계정을 파는지는 서버가 store_products 표를 **조인**해서 안다 —
// productId/basePlanId 문자열을 파싱하지 않는다. 파싱은 콘솔에서 ID를 한 글자 잘못 만드는 순간
// 정원이 엉뚱한 숫자로 해석되는데, 표 조인은 같은 실수가 'unmapped'라는 안전한 미아 상태가 된다.
//
// verify(앱이 결제 직후 호출)와 RTDN(구글이 밀어주는 알림)이 **이 파일 하나**를 공유한다.
// 두 곳에 규칙을 손으로 베끼면 반드시 어긋난다 — 이 저장소가 resolveSeatCharge를
// 미리보기/실청구가 공유하게 만든 것과 같은 규율이다.

import type { SupabaseClient } from "@supabase/supabase-js"
import { subscriptionAllows } from "@/lib/portone"
import { cancelOrgSeatMirrors, restoreOrgSeatMirrors } from "@/lib/org"
import { resolveOrgSeatAccountingByOwner } from "@/lib/orgSeats"

export type StorePlatform = "google_play" | "app_store"

/**
 * 매핑 조회 결과. **네 상태를 구분하는 것 자체가 안전장치**다:
 * - ok            : 표에 있다. seatCapacity가 NULL이면 정원제가 아닌 legacy 요금제.
 * - unmapped      : 표에 없다(콘솔에 새 요금제가 생겼는데 seed를 안 했다 등).
 * - lookup_failed : DB 장애. unmapped와 처리는 같지만 로그로 구분해야 원인을 찾는다.
 * - unknown       : 스토어가 productId/basePlanId를 안 줬다.
 *
 * ok가 아닌 셋은 전부 **현상 유지**다. 정원을 0이나 NULL로 덮으면 매핑 누락 하나가
 * 정상 고객의 현장 계정을 통째로 잠근다 — 그게 이 폴백이 존재하는 이유다.
 */
export type StorePlanLookup =
  | { kind: "ok"; seatCapacity: number | null; priceKrw: number }
  | { kind: "unmapped" }
  | { kind: "lookup_failed" }
  | { kind: "unknown" }

export async function resolveStorePlan(
  admin: SupabaseClient,
  platform: StorePlatform,
  productId: string | null | undefined,
  basePlanId: string | null | undefined
): Promise<StorePlanLookup> {
  if (!productId || !basePlanId) return { kind: "unknown" }
  const { data, error } = await admin
    .from("store_products")
    .select("seat_capacity, price_krw")
    .eq("platform", platform)
    .eq("product_id", productId)
    .eq("base_plan_id", basePlanId)
    .eq("active", true)
    .maybeSingle()
  if (error) return { kind: "lookup_failed" }
  if (!data) return { kind: "unmapped" }
  const cap = (data as { seat_capacity: number | null }).seat_capacity
  return {
    kind: "ok",
    seatCapacity: cap == null ? null : Number(cap),
    priceKrw: Number((data as { price_krw: number }).price_krw),
  }
}

/**
 * 조회 결과를 subscriptions 패치 조각으로 옮긴다. verify와 RTDN이 같은 필드를 같은 규칙으로 쓴다.
 *
 * ok가 아니면 **빈 객체**를 돌려준다 — store_seat_capacity·amount에 손대지 않는다(현상 유지).
 * 호출부는 로그를 남긴다.
 */
export function storePlanPatch(
  lookup: StorePlanLookup,
  basePlanId: string | null | undefined
): Record<string, unknown> {
  if (lookup.kind !== "ok") return {}
  return {
    store_base_plan_id: basePlanId ?? null,
    store_seat_capacity: lookup.seatCapacity,
    // 하드코딩 4,900은 요금제가 30개인 지금 계정 화면에 거짓말을 표시한다. 표의 값이 진실이다.
    amount: lookup.priceKrw,
    // 실제 정원이 확정됐으므로 '변경 예약됨' 표시는 소임을 다했다.
    store_pending_seat_capacity: null,
  }
}

/**
 * reconcileCapacitySeats에 넘길 '실효 정원'.
 *
 * 스테퍼의 '−' 최하단은 정원제 요금제가 아니라 legacy `monthly`(감독자 혼자)로의 강등이다.
 * 그런데 store_products의 monthly 행은 seat_capacity가 NULL(정원제 아님)이라, 갱신일에 그대로
 * reconcile에 넘기면 첫 줄에서 return none — **초과 좌석이 한 자리도 접히지 않는다.**
 * 정원제 감독자는 카드가 없는 것이 정상이라 좌석 청구 크론(billing_key NOT NULL 필터)에서도
 * 빠지므로, 4,900원만 내면서 현장 계정 N개를 영구히 쓰는 무과금 상태가 만들어진다(검수 2026-08-10).
 *
 * → 직전에 정원제였다면 monthly 강등을 **정원 1로 접는다**. 컬럼에는 계속 NULL을 쓴다
 *   (카드 청구 경로 복귀는 그대로). 애초에 정원제가 아니었던 legacy 카드-좌석 이용자는
 *   prevCapacity가 NULL이라 영향받지 않는다.
 */
export function effectiveCapacityForReconcile(
  lookup: StorePlanLookup,
  prevCapacity: number | null | undefined
): number | null {
  if (lookup.kind !== "ok") return null
  if (lookup.seatCapacity != null) return lookup.seatCapacity
  return prevCapacity != null ? 1 : null
}

/**
 * 스토어 감독자의 구독이 회수·만료됐으면 **그 조직의 활성 좌석 미러를 전부 접는다.**
 *
 * 고치는 무과금 구간(2026-08-13 검수): 카드 경로는 lib/billing.ts chargeSubscription이 3회
 * 실패 시 그 자리에서 cancelOrgSeatMirrors를 부르는데, 스토어 경로에는 대응물이 없었다.
 *   · RTDN·reconcile 크론은 reconcileCapacitySeats(allowActive=false)만 불렀고 그 함수는
 *     **정원 초과분**만 접는다 — 정원에 여유가 있으면 한 명도 안 접히고, 정원제가 아니면
 *     capacity==null로 즉시 return이다.
 *   · 애플 알림은 좌석을 아예 건드리지 않았다.
 * 미러가 살아 있는 동안 멤버 행은 plan='org_seat'/status='active'/기간 null이라 서버 게이트를
 * 전부 통과한다. 실제 차단은 하루 1회 크론 스윕뿐이라 최대 ~24시간이 통째로 무과금이었고,
 * 크론이 멈추면 무기한이었다(fail-open).
 *
 * 판정은 여기서 다시 적지 않는다 — 방금 우리가 쓴 행을 되읽어 subscriptionAllows에 묻는다.
 * '회수(revoked)'의 정의가 구글·애플에서 다르고 앞으로 더 늘어날 수 있으므로, 각 호출부의
 * revoked 플래그가 아니라 **저장된 상태**를 진실로 삼는다(해지 예약처럼 잔여 기간이 남은
 * 경우에는 자동으로 아무 일도 일어나지 않는다).
 */
export async function foldSeatsIfOwnerLapsed(
  admin: SupabaseClient,
  ownerUserId: string
): Promise<number> {
  const { data: sub } = await admin
    .from("subscriptions")
    .select("status, current_period_end, billing_key")
    .eq("user_id", ownerUserId)
    .maybeSingle()
  if (subscriptionAllows(sub as { status?: string; current_period_end?: string | null; billing_key?: string | null } | null)) {
    return 0
  }
  const acc = await resolveOrgSeatAccountingByOwner(admin, ownerUserId)
  if (!acc || acc.seatIds.length === 0) return 0
  await cancelOrgSeatMirrors(acc.seatIds, admin)
  console.warn("STORE_LAPSE_SEATS_FOLDED", { ownerUserId, orgId: acc.orgId, seats: acc.seatIds.length })
  return acc.seatIds.length
}

/**
 * 정원이 확정된 뒤 실제 좌석 수를 정원에 맞춘다. (RTDN·verify 공용)
 *
 * - 정원보다 많으면: **최근 합류 순(joined_at DESC)**으로 초과분 미러만 접는다.
 *   멤버십(org_members)은 남긴다 — 정원을 다시 올리면 자동 복원되게 하려는 기존 관례
 *   (미납 강등·chargeGoogleOwnerSeats와 동일). 계정·데이터는 지우지 않는다.
 * - 정원 안인데 접혀 있으면: 되살린다. 단 `allowActive=false`(구독이 회수 상태)면 손대지 않는다 —
 *   돈이 끊긴 구독의 현장을 정원 계산만으로 되살리면 무과금 이용이 열린다.
 *
 * capacity가 null이면(정원제가 아니다) 아무것도 하지 않는다 — 기존 카드 청구 경로의 관할이다.
 */
export async function reconcileCapacitySeats(
  admin: SupabaseClient,
  ownerUserId: string,
  capacity: number | null | undefined,
  allowActive: boolean
): Promise<{ folded: number; restored: number }> {
  const none = { folded: 0, restored: 0 }
  if (capacity == null) return none

  // 정원을 먹는 좌석 = 좌석 회계의 billableSeats(자가 스토어 결제자·영구무료는 제외).
  // claim_org_seat·checkSeatCapacity와 **같은 뷰**를 본다 — 여기만 org_members active로 세면
  // 감독자가 산 정원을 남이 축내는 상태로 되돌아간다.
  const acc = await resolveOrgSeatAccountingByOwner(admin, ownerUserId)
  if (!acc) return none
  // rows는 joined_at 오름차순 — 아래 '최근 합류 순으로 접는다'가 이 순서에 기댄다
  const members = acc.rows.filter((r) => r.seatState === "seat").map((r) => r.userId)

  // 정원은 감독자 본인을 포함한 총 계정 수 — 소속 현장에 허용되는 수는 그보다 하나 적다.
  const allowed = Math.max(0, capacity - 1)
  const keep = new Set(members.slice(0, allowed))
  const excess = members.slice(allowed)

  let folded = 0
  if (excess.length > 0) {
    // joined_at DESC = 가장 최근에 합류한 현장부터 접는다(임의성 없는 고정 규칙)
    await cancelOrgSeatMirrors([...excess].reverse(), admin)
    folded = excess.length
  }

  let restored = 0
  if (allowActive && keep.size > 0) {
    // 후보 선정은 restoreOrgSeatMirrors 안의 뷰가 한다 — `plan='org_seat'` 필터가 아니라
    // mirror_alive=false라, 자가 결제가 끝나 좌석으로 돌아온 계정(plan이 monthly_pro로 남은 행)도
    // 여기서 함께 복원된다. restored는 후보 수가 아니라 **실제 복원 성공 수**다.
    const r = await restoreOrgSeatMirrors(acc.orgId, admin, { only: [...keep] })
    restored = r.restored
    if (r.failed > 0) console.error("reconcileCapacitySeats: 미러 복원 일부 실패", { ownerUserId, ...r })
  }

  return { folded, restored }
}
