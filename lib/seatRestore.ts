// lib/seatRestore.ts — "좌석 미러를 지금 열어도 되는가"의 **유일한 판정**.
//
// 왜 별도 파일인가: 좌석을 되살리는 자리가 둘이고, 둘의 규칙이 달라서 사고가 났다.
//   · 크론(/api/cron/charge-subscriptions)은 두 개의 잠금을 건다 —
//     ① SEAT_CHARGE_EXHAUSTED(스토어 감독자의 좌석 카드 3회 소진) ② 정원 부족 복원 보류.
//   · 자가복구(GET /api/org/context)는 그 둘을 몰랐다. 크론이 "돈을 못 받는 좌석은 열지
//     않는다"며 건너뛴 멤버가 **앱을 켜는 것만으로** 좌석을 되살렸고, 청구 쿼리는
//     .lt(failed_attempts, MAX)로 그 감독자를 영구 제외하므로 결과는 무기한 무과금 좌석이었다
//     (2026-08-13 검수). 크론이 봉합한 구멍을 같은 diff의 다른 파일이 다시 뚫은 것이다.
//
// 그래서 판정을 여기 한 번만 적고 두 호출부가 이 함수를 부른다. 규칙을 늘릴 일이 생기면
// 이 파일만 고치면 되고, 호출부가 규칙을 다시 적을 자리는 없다.
//
// import 방향: billing → org 이므로 org에서 billing을 부를 수 없다(순환). 이 파일은 셋
// (billing·org·orgSeats) 모두를 부르는 **가장 바깥 층**이고, 아무도 이 파일을 import 하지 않는다.
import type { SupabaseClient } from "@supabase/supabase-js";
import { subscriptionAllows } from "./portone";
import { getStoreSeatCapacity, isStoreSource, MAX_FAILED_ATTEMPTS } from "./billing";
import { restoreOrgSeatMirrors } from "./org";
import { resolveOrgSeatAccounting, type OrgSeatAccounting } from "./orgSeats";

/** 좌석 판정에 필요한 감독자 구독 컬럼. select 문자열을 두 곳에 손으로 적지 않는다 —
 *  하나라도 빠지면 subscriptionAllows가 조용히 false를 반환해 정상 조직의 복원이 통째로 멈춘다. */
export const OWNER_SEAT_SUB_COLUMNS =
  "user_id, status, current_period_end, billing_key, canceled_at, failed_attempts, source, store_seat_capacity";

export interface OwnerSeatSub {
  user_id?: string;
  status?: string | null;
  current_period_end?: string | null;
  billing_key?: string | null;
  canceled_at?: string | null;
  failed_attempts?: number | null;
  source?: string | null;
  store_seat_capacity?: number | null;
}

/** 좌석이 열리지 않은 이유. null이면 막은 것이 없다. */
export type SeatRestoreBlock = "owner_lapsed" | "seat_charge_exhausted" | "over_capacity";

export interface SeatRestoreResult {
  restored: number;
  failed: number;
  /** 정원이 모자라 이번 회차에 보류한 좌석 수 */
  deferred: number;
  blocked: SeatRestoreBlock | null;
  capacity: number | null;
  /** 이번 호출이 읽은 좌석 회계(호출부가 재사용해 왕복을 줄인다). 회계 전에 막혔으면 null */
  accounting: OrgSeatAccounting | null;
}

/**
 * 스토어 감독자의 **좌석 카드**가 3회 실패해 청구가 멈춘 상태인가.
 *
 * 본인 스토어 구독은 멀쩡하므로 subscriptionAllows는 true다 — 그 상태로 좌석을 되살리면
 * 청구 쿼리(.lt(failed_attempts, MAX))가 그 감독자를 영구 제외하는 것과 맞물려
 * **무기한 무과금 좌석**이 된다. 정원제(store_seat_capacity NOT NULL)는 좌석 값을 스토어가
 * 이미 받으므로 해당 없다.
 */
export function seatChargeExhausted(ownerSub: OwnerSeatSub | null | undefined): boolean {
  if (!ownerSub) return false;
  return (
    isStoreSource(ownerSub.source) &&
    ownerSub.store_seat_capacity == null &&
    (ownerSub.failed_attempts ?? 0) >= MAX_FAILED_ATTEMPTS
  );
}

/**
 * 조직의 좌석 미러를 **규칙을 지켜** 되살린다. 크론 스윕과 자가복구가 같은 함수를 쓴다.
 *
 * @param opts.only    이 id들로만 좁힌다(자가복구는 본인 하나). 정원 여유(room)는 좁히기 전
 *                     조직 전체 기준으로 계산하므로, 한 명만 복구해도 정원을 넘지 않는다.
 * @param opts.accounting 이미 읽어둔 회계가 있으면 재사용(크론이 같은 org를 두 번 읽지 않게).
 */
export async function restoreOrgSeats(
  admin: SupabaseClient,
  org: { id: string; ownerUserId: string },
  ownerSub: OwnerSeatSub | null | undefined,
  opts: { only?: string[]; accounting?: OrgSeatAccounting } = {}
): Promise<SeatRestoreResult> {
  const base: SeatRestoreResult = {
    restored: 0,
    failed: 0,
    deferred: 0,
    blocked: null,
    capacity: null,
    accounting: opts.accounting ?? null,
  };

  // ① 상위 구독이 무효면 좌석을 되살릴 근거가 없다 — 강등의 관할이다
  const ownerAllows = subscriptionAllows(
    ownerSub
      ? {
          status: ownerSub.status ?? undefined,
          current_period_end: ownerSub.current_period_end,
          billing_key: ownerSub.billing_key,
        }
      : null
  );
  if (!ownerAllows) return { ...base, blocked: "owner_lapsed" };

  // ② 좌석 카드 3회 소진 — 돈을 못 받는 좌석을 열지 않는다
  if (seatChargeExhausted(ownerSub)) return { ...base, blocked: "seat_charge_exhausted" };

  const acc = opts.accounting ?? (await resolveOrgSeatAccounting(admin, org.id));
  const allTargets = acc.rows.filter((r) => r.seatState === "seat" && !r.mirrorAlive).map((r) => r.userId);
  const onlySet = opts.only ? new Set(opts.only) : null;
  const targets = onlySet ? allTargets.filter((id) => onlySet.has(id)) : allTargets;
  if (targets.length === 0) return { ...base, accounting: acc };

  // ③ 정원제 감독자는 정원을 넘겨 복원하지 않는다. 자가 결제자가 좌석으로 돌아오면서 넘칠 수 있다.
  //    room은 **조직 전체** 기준이다 — only로 한 명만 열 때도 같은 상한을 쓴다.
  const capacity = await getStoreSeatCapacity(admin, {
    user_id: org.ownerUserId,
    source: ownerSub?.source ?? null,
    store_seat_capacity: ownerSub?.store_seat_capacity ?? null,
  });
  const room = capacity == null ? targets.length : Math.max(0, capacity - 1 - acc.aliveSeats);
  const take = targets.slice(0, room);
  const deferred = targets.length - take.length;

  let restored = 0;
  let failed = 0;
  if (take.length > 0) {
    const r = await restoreOrgSeatMirrors(org.id, admin, { only: take });
    restored = r.restored;
    failed = r.failed;
  }

  return {
    restored,
    failed,
    deferred,
    blocked: deferred > 0 ? "over_capacity" : null,
    capacity,
    accounting: acc,
  };
}
