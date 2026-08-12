// lib/orgSeats.ts — 좌석 회계(청구·정원·미러)의 **유일한 TS 접점**.
//
// 판정식은 여기에 없다. DB의 public.is_self_paid(uuid) 하나가 규칙이고,
// public.org_seat_states 뷰가 그 규칙을 적용한 결과를 준다. 이 파일은 뷰를 **읽기만** 한다.
//
// 왜 규칙을 TS로 옮겨 적지 않는가: 같은 규칙을 claim_org_seat(SQL, advisory lock 안)과
// 청구·미러(TS)가 함께 봐야 하는데, 양쪽에 쓰면 반드시 어긋난다. 실제로 어긋났었다 —
// 정원은 org_members active로 세고, 무과금 경보는 살아 있는 미러로 세서, 정원이 가득 찼는데
// 경보는 침묵하는 상태가 만들어졌다(2026-08-10 검수).
//
// 별도 파일인 이유: lib/org.ts ↔ lib/billing.ts 순환 import를 만들지 않기 위해서다.
// 이 파일은 어떤 로컬 모듈도 import 하지 않는다.
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 좌석 회계 상태. 뷰의 CASE 세 갈래를 그대로 옮긴 것이고, **여기서 다시 계산하지 않는다.**
 * - seat        : 감독자가 좌석을 제공하고 요금을 받는다(미러 발급 대상)
 * - self_store  : 본인이 직접 결제 중(스토어 **또는 본인 카드**) → 청구·정원·미러 전부에서
 *                 제외(조직 연결은 유지). 값 이름은 스토어만 인정하던 시절의 잔재이며,
 *                 앱이 이 문자열을 그대로 쓰고 있어 바꾸지 않는다.
 * - grandfather : 영구 무료 → 미러도 안 주고 요금도 안 받는다
 */
export type SeatState = "seat" | "self_store" | "grandfather";

export interface OrgSeatRow {
  userId: string;
  seatState: SeatState;
  /** 미러 구독(plan='org_seat', status='active')이 실제로 살아 있는가 */
  mirrorAlive: boolean;
  joinedAt: string | null;
}

export interface OrgSeatAccounting {
  /** joined_at 오름차순 — 정원 초과분을 '최근 합류 순'으로 접는 규칙이 이 순서에 기댄다 */
  rows: OrgSeatRow[];
  /** seatState==='seat' — 청구·정원·미러 복원의 **유일한** 단위 */
  seatIds: string[];
  selfPaidIds: string[];
  grandfatherIds: string[];
  /** = seatIds.length. 감독자 청구액 = (1 + billableSeats) × SEAT_PRICE */
  billableSeats: number;
  /** seat && mirrorAlive — 무과금 누수 경보(STORE_CAPACITY_OVER) 전용.
   *  '자격 상한'과 다른 질문이며, 그 차이는 뷰의 mirror_alive 한 컬럼으로만 갈린다.
   *  (감액 예약으로 의도적으로 접힌 좌석이 상시 경보를 울리지 않게 하려는 기존 의도 유지) */
  aliveSeats: number;
}

interface SeatStateRow {
  member_user_id: string;
  seat_state: string;
  mirror_alive: boolean | null;
  joined_at: string | null;
}

function toSeatState(raw: string): SeatState {
  return raw === "self_store" || raw === "grandfather" ? raw : "seat";
}

/**
 * 조직 하나의 좌석 회계. 왕복 1회(뷰 조회).
 *
 * **조회 실패는 던진다.** 빈 회계로 폴백하면 청구액이 조용히 (1 + 0) × 3,900으로 떨어지고
 * 미러 복원 대상이 통째로 사라진다 — DB가 한 번 흔들린 것이 무과금·잠김으로 굳는다.
 * 호출부(크론 루프·결제 라우트)는 이 예외를 '이번 회차 스킵'으로 처리한다. 다음 실행이 다시 한다.
 */
export async function resolveOrgSeatAccounting(
  admin: SupabaseClient,
  orgId: string
): Promise<OrgSeatAccounting> {
  const { data, error } = await admin
    .from("org_seat_states")
    .select("member_user_id, seat_state, mirror_alive, joined_at")
    .eq("org_id", orgId)
    .order("joined_at", { ascending: true });
  if (error) {
    throw new Error(`org_seat_states 조회 실패(org=${orgId}): ${error.message}`);
  }
  const rows: OrgSeatRow[] = ((data ?? []) as SeatStateRow[]).map((r) => ({
    userId: r.member_user_id,
    seatState: toSeatState(String(r.seat_state)),
    mirrorAlive: r.mirror_alive === true,
    joinedAt: r.joined_at,
  }));
  const seatIds = rows.filter((r) => r.seatState === "seat").map((r) => r.userId);
  return {
    rows,
    seatIds,
    selfPaidIds: rows.filter((r) => r.seatState === "self_store").map((r) => r.userId),
    grandfatherIds: rows.filter((r) => r.seatState === "grandfather").map((r) => r.userId),
    billableSeats: seatIds.length,
    aliveSeats: rows.filter((r) => r.seatState === "seat" && r.mirrorAlive).length,
  };
}

/** 감독자(소유주) 기준 좌석 회계. 회사가 없으면 null. organizations 1회 + 뷰 1회. */
export async function resolveOrgSeatAccountingByOwner(
  admin: SupabaseClient,
  ownerUserId: string
): Promise<(OrgSeatAccounting & { orgId: string }) | null> {
  const { data, error } = await admin
    .from("organizations")
    .select("id")
    .eq("owner_user_id", ownerUserId)
    .maybeSingle();
  if (error) {
    throw new Error(`organizations 조회 실패(owner=${ownerUserId}): ${error.message}`);
  }
  if (!data) return null;
  const orgId = (data as { id: string }).id;
  return { ...(await resolveOrgSeatAccounting(admin, orgId)), orgId };
}

/**
 * "서버가 해지할 수 없는 결제가 살아 있는가" — **스토어(구글·애플) 구독만** 센다.
 *
 * 쓰는 자리는 하나뿐이다: 편입(attach)이 기존 개인 구독을 정산할지 판단할 때.
 * 스토어 구독은 우리가 해지·환불할 권한이 없어 정산 자체가 불가능하므로 그대로 두고,
 * 본인 카드(PortOne) 구독은 정산(해지·환불) 후 회사 좌석으로 넘긴다 — 그것이 편입의 뜻이다.
 *
 * ⚠️ **회계(청구·정원·미러)에는 이 함수를 쓰지 말 것.** 그쪽은 isSelfPaid다.
 */
export async function isStoreSelfPaid(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await admin.rpc("is_store_self_paid", { p_user: userId });
  if (error) {
    throw new Error(`is_store_self_paid 호출 실패(user=${userId}): ${error.message}`);
  }
  return data === true;
}

/**
 * "본인 돈으로 사고 있는가" — 스토어 + 본인 카드(PortOne). 회계가 보는 판정이며
 * org_seat_states 뷰·claim_org_seat이 부르는 것과 **같은 SQL 함수**다(규칙 사본 금지).
 *
 * 뷰를 쓸 수 있는 자리(조직 소속 멤버)에서는 seatState를 읽으면 되고, 이 함수는 뷰 밖의
 * 단건 판정(결제수단 등록 게이트·자발적 연결 해제)에서만 쓴다.
 */
export async function isSelfPaid(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await admin.rpc("is_self_paid", { p_user: userId });
  if (error) {
    throw new Error(`is_self_paid 호출 실패(user=${userId}): ${error.message}`);
  }
  return data === true;
}
