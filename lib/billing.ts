// lib/billing.ts — 빌링키 과금 + 구독/결제 상태 갱신 (수동 charge & cron 공용)
import { SupabaseClient } from "@supabase/supabase-js";
import {
  chargeWithBillingKey,
  getBillingKeyInfo,
  getPayment,
  addOneMonth,
  getPlan,
  newPaymentId,
  SEAT_PRICE,
} from "@/lib/portone";
import { cancelOrgSeatMirrors, restoreOrgSeatMirrors } from "@/lib/org";
import { resolveOrgSeatAccounting, resolveOrgSeatAccountingByOwner } from "@/lib/orgSeats";

export const MAX_FAILED_ATTEMPTS = 3;

/** 스토어 인앱결제 출처 — 본인 몫(4,900)은 스토어가 청구·갱신한다 */
export const STORE_SOURCES = ["google_play", "app_store"] as const;

/**
 * 인앱결제(구글/애플) 구독인가.
 * 애플도 구글과 청구 구조가 같다(본인 몫은 스토어, 좌석 몫은 우리 카드) — 두 값을 한 곳에서
 * 판정해, iOS를 추가하며 `source === "google_play"` 비교가 남아 무과금·이중청구가 나는 것을 막는다.
 */
export function isStoreSource(source?: string | null): boolean {
  return source === "google_play" || source === "app_store";
}

/**
 * 회사(조직) 소유 여부 — verify 라우트 공용.
 *
 * 한때 여기서 감독자(조직 소유주)의 스토어 결제를 409로 막았다(고정가 단일 상품이라 좌석 몫
 * N×3,900이 무과금이 될까 봐). 2026-08-09 번복(Chris 결정): 감독자도 **본인 몫(4,900)은 스토어**로
 * 내고 **좌석 몫은 기존 카드(PortOne)**로 내는 공존이 가능해졌으므로 차단을 제거했다 —
 *   (a) verify가 좌석 보유 계정의 billing_key/card_info를 보존하고(아래 반환값이 그 판정),
 *   (b) 좌석 크론(chargeGoogleOwnerSeats)이 source in ('google_play','app_store') 소유주를 매일 훑어
 *       활성 좌석 × 3,900을 계속 청구한다.
 * 반환값은 verify의 "좌석 보유 계정 카드 보존" 판정에 쓴다.
 */
export async function ownsOrganization(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { count } = await admin
    .from("organizations")
    .select("id", { count: "exact", head: true })
    .eq("owner_user_id", userId);
  return (count ?? 0) > 0;
}

export interface SubscriptionRow {
  id: string;
  user_id: string;
  plan?: string | null;
  pending_plan?: string | null;
  billing_key: string | null;
  // 발급 직후 UNAUTHORIZED(전파지연)로 소유권을 확인하지 못한 채 낙관수용한 키는 false.
  // 첫 과금 직전 여기서 재검증한다. (미지정/true면 이미 검증된 것으로 간주)
  billing_key_verified?: boolean | null;
  amount: number;
  status: string;
  current_period_end: string | null;
  failed_attempts?: number;
  /** 청구 주체: 'portone'(웹 카드 정기결제) | 'google_play'·'app_store'(앱 인앱결제).
   *  스토어면 본인 몫(4,900)은 스토어가 받으므로 우리 카드 청구는 좌석 몫만이어야 한다. */
  source?: string | null;
  /** 스토어 요금제가 보장하는 총 계정 수(감독자 본인 포함). NOT NULL이면 좌석 청구는 스토어 단독 —
   *  이 카드로는 좌석 몫을 청구하지 않는다(이중청구 방지). NULL이면 기존 카드 경로 그대로. */
  store_seat_capacity?: number | null;
}

/**
 * 낙관수용(billing_key_verified=false)한 빌링키를 과금 직전에 재검증한다.
 * - 조회 성공 + 소유권 일치 → verified 처리(true)하고 과금 진행
 * - 조회 성공 + 소유권 불일치 → 남의 키 → 빌링키 제거, 과금 중단(보안)
 * - 조회 실패(아직 전파중/NOT_FOUND) → 이번 회차 과금 스킵(다음 실행 재시도)
 * 반환: 과금을 계속해도 되면 null, 중단해야 하면 ChargeResult
 */
async function ensureBillingKeyVerified(
  admin: SupabaseClient,
  sub: SubscriptionRow,
  paymentId: string
): Promise<ChargeResult | null> {
  if (sub.billing_key_verified !== false || !sub.billing_key) return null;
  const info = await getBillingKeyInfo(sub.billing_key);
  if (info.ok) {
    const customerId = (info.body as { customer?: { id?: string } })?.customer?.id;
    if (customerId && customerId !== sub.user_id) {
      // 소유권 불일치 → 타인 카드 과금 방지: 키를 제거하고 재등록을 유도
      console.error("cron re-verify: billing-key ownership mismatch — clearing key", {
        subId: sub.id,
        keyCustomerId: customerId,
        userId: sub.user_id,
      });
      await admin
        .from("subscriptions")
        .update({
          billing_key: null,
          card_info: null,
          billing_key_verified: true,
          status: "past_due",
          updated_at: new Date().toISOString(),
        })
        .eq("id", sub.id);
      return { ok: false, paymentId, status: "failed", detail: "ownership mismatch — key cleared" };
    }
    // 검증 통과 → 플래그 정리 후 과금 진행
    await admin.from("subscriptions").update({ billing_key_verified: true }).eq("id", sub.id);
    return null;
  }
  // 아직 조회 불가(전파 지연/NOT_FOUND) → 검증 못 함 → 이번 회차는 과금하지 않고 넘어간다
  console.warn("cron re-verify: billing-key still not readable — skipping charge this run", {
    subId: sub.id,
    status: info.status,
  });
  return { ok: false, paymentId, status: "skipped", detail: "awaiting billing-key verification" };
}

export interface ChargeResult {
  ok: boolean;
  paymentId: string;
  status: "paid" | "failed" | "skipped";
  detail?: any;
}

/** 과금 대상 조직 — 이 사용자가 소유한 회사(있으면) */
export interface BillableOrg {
  id: string;
  /** 본인 포함 과금 계정 수 = 1(감독자 본인) + 활성 소속 현장 수 */
  accountCount: number;
}

/**
 * 이번 회차에 청구할 금액을 결정한다.
 *
 * 단일 요금제 이후 금액의 근거는 plan 문자열이 아니라 **실제 계정 수**다:
 *   - 회사를 소유하면  (1 + 활성 소속 현장 수) × SEAT_PRICE
 *   - 혼자 쓰면        SEAT_PRICE
 *   - legacy(구 베이직/영구무료)는 기존 스냅샷 금액을 그대로 유지 — 재동의 없이 인상하지 않는다.
 *
 * plan 문자열로 금액을 판정하던 구 구현은, 플랜 값이 바뀌는 순간 좌석 재계산이 통째로
 * 빠지면서 감독자가 자식 수와 무관하게 1계정 요금만 내게 되는 구멍이 있었다.
 *
 * ⚠️ 좌석 수는 org_members active **개수**가 아니라 좌석 회계(lib/orgSeats.ts)의 billableSeats다.
 * 본인 스토어 구독으로 사는 멤버·영구 무료 멤버는 좌석을 제공받지 않으므로 청구에서도 빠진다 —
 * 제공하지 않는 좌석에 요금을 받으면 그게 정확히 이중청구다. 정원 판정(claim_org_seat)과
 * 미러 복원이 **같은 뷰**를 보므로 세 숫자가 갈라질 수 없다.
 */
export async function resolveBillableAmount(
  admin: SupabaseClient,
  sub: SubscriptionRow
): Promise<{ amount: number; orderName: string; org: BillableOrg | null }> {
  // 인앱 구독 소유주(구글/애플): 본인 몫(4,900)은 스토어가 이미 받는다.
  // 등록 카드(PortOne 빌링키)로는 좌석(활성 소속 현장) 몫만 청구한다 — 본인까지 세면 이중청구.
  const googleOwner = isStoreSource(sub.source);

  const acc = await resolveOrgSeatAccountingByOwner(admin, sub.user_id);

  if (acc) {
    const seatCount = acc.billableSeats;
    const accountCount = 1 + seatCount; // 감독자 본인도 한 계정(=현장 하나)으로 센다 (표시용 seat_count 기준)
    // 스토어 정원제(seats-NN): 좌석 값까지 스토어가 이미 받았다 → 우리 카드 청구액은 0.
    // 이 분기가 없으면 카드가 남아 있는 정원제 감독자에게 스토어+카드 이중청구가 된다.
    // (크론 쿼리에서도 제외하지만, 금액 계산 자체를 0으로 못박아 그 필터에 의존하지 않게 한다)
    if (googleOwner && sub.store_seat_capacity != null) {
      return {
        amount: 0,
        orderName: "안톡 현장 계정 (앱 구독 정원제 — 스토어 청구)",
        org: { id: acc.orgId, accountCount },
      };
    }
    if (googleOwner) {
      return {
        amount: seatCount * SEAT_PRICE, // 좌석 0이면 0 — 청구할 것이 없다
        orderName: `안톡 현장 계정 ${seatCount}개 (감독자 앱 구독 별도)`,
        org: { id: acc.orgId, accountCount },
      };
    }
    return {
      amount: accountCount * SEAT_PRICE,
      orderName: `안톡 월간구독 (계정 ${accountCount}개)`,
      org: { id: acc.orgId, accountCount },
    };
  }

  if (googleOwner) {
    // 회사가 없으면 좌석도 없다 — 본인 몫은 구글 것이므로 우리 쪽 청구액은 0.
    return { amount: 0, orderName: "안톡 현장 계정 0개 (감독자 앱 구독 별도)", org: null };
  }

  // 영구 무료(grandfather)는 **무조건 0원**이다. sub.amount에 기대면 안 된다 —
  // getPlan('grandfather')는 PLANS에 없어 monthly_pro(3,900)로 폴백하므로, amount가 어쩌다
  // NULL이 되는 순간 청구액이 3,900으로 계산된다("영원히 0원" 약속이 깨진다).
  // 지금은 chargeSubscription의 billing_key 가드가 PG 호출을 막아 도달 불가지만,
  // 금액 계산 자체를 0으로 못박아 그 가드에 의존하지 않게 한다(2026-08-10 검수 지적).
  if (sub.plan === "grandfather") {
    return { amount: 0, orderName: "안톡 영구 무료", org: null };
  }

  // legacy 요금 유지: 구 베이직(1,900)은 카드사 정기결제 동의 금액이 그때 값이라 올리지 않는다.
  if (sub.plan === "monthly_basic") {
    return {
      amount: sub.amount ?? getPlan(sub.plan).amount,
      orderName: getPlan(sub.plan).name,
      org: null,
    };
  }

  const planId = sub.pending_plan ?? sub.plan;
  return { amount: SEAT_PRICE, orderName: getPlan(planId).name, org: null };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 좌석 발급을 막은 **기계가 읽는** 사유. 화면이 한국어 문장을 되짚어 사유를 추측하면
 * (검수 2026-08-10) legacy 요금제 거절이 "결제수단 문제"로 오독돼 결제수단만 바꿀 수 있는
 * /account로 안내되는 새 막다른 길이 생긴다. 문장은 사람용, 이 코드가 분기용이다.
 *
 * - "plan"         요금제 자체가 좌석을 살 수 없다(grandfather 영구무료, legacy monthly_basic).
 *                  결제수단을 바꿔도 풀리지 않는다 → **결제 화면으로 보내면 안 된다.**
 * - "subscription" 구독이 없거나 만료·정지됐다(카드 없는 체험 종료 포함) → 구독 및 결제.
 * - "method"       등록된 결제수단이 없다 → 구독 및 결제(카드 등록).
 * - "period"       주기가 지났는데 정기 결제가 아직 안 붙었다(past_due) → 구독 및 결제.
 *
 * - "capacity"     스토어 요금제로 산 **정원**이 가득 찼다. 결제수단 문제가 아니다 →
 *                  화면은 결제수단이 아니라 **정원 스테퍼(+)**로 보내야 한다.
 *
 * plan/subscription/**capacity**는 **자격** 문제라 초대·편입 라우트(app/api/org/invites,
 * app/api/org/attach, app/api/signup 초대 링크)도 같은 판정으로 막는다 — 안 그러면 초대 링크와
 * 편입이 정원을 무제한 우회한다. method/period는 **즉시 청구 실행** 조건이라 즉시 청구가 없는
 * 초대·편입은 지나간다.
 */
export type SeatBlockReason = "plan" | "subscription" | "method" | "period" | "capacity";

/**
 * 정원이 가득 찼을 때 사용자에게 보여줄 문구 — 세 라우트가 같은 말을 하게 한다.
 *
 * **플랫폼을 말하지 않는다**(2026-08-10 검수). 종전 문구는 "앱에서 정원을 늘린 뒤"였는데,
 * 안드로이드로 결제한 감독자가 아이폰·아이패드로 로그인해 이 402를 만나면(다른 기기에서
 * 좌석이 채워진 레이스) iOS에 **존재하지 않는 화면**을 가리킨다. 정원을 어디서 늘리는지는
 * 화면이 플랫폼을 보고 붙인다 — 웹(app/org/members/page.tsx)은 "앱(안드로이드)의 현장 계정
 * 정원", 앱(org-members.tsx)은 Platform.OS로 갈라 쓴다.
 */
export const CAPACITY_FULL_MESSAGE =
  "현장 계정 정원이 가득 찼어요. 정원을 늘린 뒤 다시 시도해주세요.";

/**
 * 스토어 결제가 확인되지 않은 정원제 감독자에게 보여줄 문구 (grace = past_due).
 * 서버의 두 판정(resolveSeatCharge 정원 분기 · /api/org/context canIssueSeats)이 **같은 문장**을
 * 쓰게 해서, 앱이 "만들 수 있다"고 말한 뒤 서버가 402로 되돌려보내는 일이 없게 한다.
 */
export const STORE_GRACE_MESSAGE =
  "스토어 결제가 확인되지 않았어요. 결제가 정상 처리된 뒤 다시 시도해주세요.";

/**
 * 정원제(스토어 seats-NN) 감독자의 **좌석 발급**을 막아야 하는 결제 상태인가.
 *
 * 판정을 여기 한 곳에서 만든다(2026-08-10 검수). 종전에는 resolveSeatCharge의 정원 분기만
 * past_due를 막고 /api/org/context의 canIssueSeats에는 status 검사가 없어, grace 중인 감독자에게
 * 앱이 "현장 계정 N개 더 만들 수 있어요"를 띄운 뒤 누르면 서버가 402를 주는 **서버가 스스로
 * 두 말을 하는** 상태였다. 규칙을 손으로 베끼지 않고 이 함수를 양쪽이 부른다.
 *
 * 조절(canAdjustSeats)은 grace에서도 열어둔다 — 스토어 요금제를 다시 사는 행위라 막을 이유가 없다.
 */
export function capacityIssueBlocked(status?: string | null): boolean {
  return status === "past_due";
}

/**
 * 이 구독의 확정 정원(감독자 본인 포함 총 계정 수). 정원제가 아니면 null.
 *
 * **출처(source)가 스토어일 때만 정원이 존재한다.** store_seat_capacity 값 하나만 보면 안 되는
 * 이유(2026-08-10 검수): 스토어 구독이 만료된 계정이 웹 카드로 재구독하면 source는 portone으로
 * 돌아가는데 store_* 컬럼은 남을 수 있다(재구독 upsert가 지우게 고쳤지만, 그 이전에 저장된 행과
 * 수작업 데이터가 남는다). 그러면 카드 감독자의 좌석 발급이 전부 무과금이 되면서 동시에 죽은
 * 정원이 상한으로 남아 정당한 발급이 막힌다. resolveBillableAmount가 정원 분기에 googleOwner를
 * 요구하는 것과 **같은 기준**을 여기 한 곳에 모아 두 함수가 어긋나지 않게 한다.
 *
 * 호출부가 source·store_seat_capacity를 셀렉트하지 않았으면(구 셀렉트) 직접 조회한다.
 * 셀렉트 누락으로 정원 검사가 **조용히 빠지면** 초대·편입으로 산 것보다 많은 계정을 만들 수 있다.
 */
export async function getStoreSeatCapacity(
  admin: SupabaseClient,
  sub: { id?: string; user_id?: string; source?: string | null; store_seat_capacity?: number | null }
): Promise<number | null> {
  // 출처를 아는데 스토어가 아니면 정원 자체가 없다 — 컬럼에 값이 남아 있어도 무시한다
  if (sub.source !== undefined && !isStoreSource(sub.source)) return null;
  if (sub.source !== undefined && sub.store_seat_capacity !== undefined) {
    return sub.store_seat_capacity ?? null;
  }
  // 식별자가 없으면 조회 자체가 불가능하다 — 빈 문자열을 uuid 컬럼에 넣으면 에러가 나고,
  // 그 에러를 null로 삼키면 "정원 없음"과 구분되지 않는다. 애초에 부르지 않는다.
  if (!sub.id && !sub.user_id) return null;
  let q = admin.from("subscriptions").select("source, store_seat_capacity");
  q = sub.id ? q.eq("id", sub.id) : q.eq("user_id", sub.user_id as string);
  const { data } = await q.maybeSingle();
  const row = data as { source?: string | null; store_seat_capacity?: number | null } | null;
  if (!row || !isStoreSource(row.source)) return null;
  const v = row.store_seat_capacity;
  return v == null ? null : Number(v);
}

/**
 * 정원 검사 — **자격** 판정이라 즉시 청구가 없는 초대·편입도 이걸 부른다.
 *
 * resolveSeatCharge의 capacity 분기와 규칙을 공유한다(손으로 베끼지 않는다).
 * 정원제가 아니면(capacity=null) 항상 통과 — 웹 카드 경로는 상한이 없다.
 *
 * @param seatsClaimed 좌석 점유가 이미 끝났으면(실청구 시점) 추가분이 활성 좌석에 포함돼 있다.
 */
export async function checkSeatCapacity(
  admin: SupabaseClient,
  args: {
    userId: string;
    capacity: number | null;
    count?: number;
    seatsClaimed?: boolean;
  }
): Promise<{ ok: boolean; used: number; error?: string }> {
  const { userId, capacity } = args;
  const count = args.count ?? 1;
  if (capacity == null) return { ok: true, used: 0 };

  // 정원 점유는 claim_org_seat(SQL)과 **같은 정의**로 센다 — 자가 스토어 결제자는 감독자가 산
  // 정원을 먹지 않는다. 종전에는 여기와 RPC가 서로 다른 수를 세서 '미리보기는 OK인데 만들면
  // CAPACITY_FULL'이 났다(2026-08-10 검수 지적 4).
  const acc = await resolveOrgSeatAccountingByOwner(admin, userId);
  const active = acc?.billableSeats ?? 0;
  // 본인(1) + 청구 대상 좌석 + (아직 안 만들었으면) 이번 요청분
  const used = 1 + active + (args.seatsClaimed ? 0 : count);
  if (used > capacity) {
    return { ok: false, used, error: CAPACITY_FULL_MESSAGE };
  }
  return { ok: true, used };
}

/** 현장 계정 추가 1건의 청구 계획 — 실제 청구와 화면 미리보기가 **같은 식**을 쓰게 하는 반환값 */
export interface SeatChargePlan {
  /** 청구를 진행해도 되는가. false면 error가 그대로 사용자에게 보여줄 문구다. */
  ok: boolean;
  error?: string;
  /** ok=false일 때의 사유 코드 — 화면은 문장이 아니라 이걸로 분기한다 */
  reason?: SeatBlockReason;
  /** 추가분(count개)의 잔여기간 일할분 */
  prorated: number;
  /** 기존 활성 좌석의 이번 주기 소급분 — 스토어 소유주가 주기 키를 선점할 때만 > 0 */
  periodBase: number;
  /** 이번에 즉시 승인될 총액. 체험 중이면 0(받지 않는다). */
  amount: number;
  /** 실제 청구에 쓸 결제 키 (미리보기에서는 쓰지 않는다) */
  paymentId: string;
}

/**
 * 좌석 추가 청구액을 계산한다. **돈은 여기서 움직이지 않는다** — 실제 청구(chargeProratedAccount)와
 * 발급 화면의 미리보기(/api/org/seat-preview)가 이 함수 하나를 공유한다.
 *
 * 분리한 이유(2026-08-10 검수): 미리보기가 화면 쪽 자체 계산식("남은 기간 요금이 먼저 결제")을
 * 들고 있어 periodBase(기존 좌석 이번 주기 소급분)가 빠졌고, 좌석을 가진 스토어 감독자가 한 개를
 * 더 추가하면 예고보다 훨씬 큰 금액이 즉시 승인됐다(결제 분쟁 소지). 두 곳이 같은 함수를 쓰면
 * 한쪽만 바뀌어 어긋나는 일이 구조적으로 불가능해진다.
 *
 * @param opts.seatsClaimed 실제 청구 시점에는 좌석 점유(claim_org_seat)가 이미 끝나 추가분이
 *   활성 좌석 수에 포함돼 있다(true). 미리보기는 아직 만들기 전이라 포함돼 있지 않다(false).
 */
export async function resolveSeatCharge(
  admin: SupabaseClient,
  sub: {
    id: string;
    user_id: string;
    status?: string;
    billing_key: string | null;
    current_period_end: string | null;
    source?: string | null;
    store_seat_capacity?: number | null;
  },
  opts: { count?: number; seatsClaimed?: boolean } = {}
): Promise<SeatChargePlan> {
  const count = opts.count ?? 1;
  const zero = { prorated: 0, periodBase: 0, amount: 0, paymentId: "" };
  const now = new Date();
  const end = sub.current_period_end ? new Date(sub.current_period_end) : null;

  // 호출부가 source를 안 넘겼으면(구 셀렉트) 직접 조회 — 구글 소유주 분기가 조용히 빠지면
  // 아래 gseat 멱등 키 선점이 안 돼 cron 월청구와 같은 주기 이중청구가 된다.
  let source = sub.source;
  if (source === undefined) {
    const { data: srcRow } = await admin
      .from("subscriptions")
      .select("source")
      .eq("id", sub.id)
      .maybeSingle();
    source = ((srcRow as any)?.source as string | null) ?? null;
  }

  // ── 스토어 정원제(seats-NN) — 카드 청구 경로를 통째로 대체한다 ──────────────
  // 순서가 중요하다: 아래 trialing·billing_key·period 검사보다 **먼저** 판정해야 한다.
  // 정원제 감독자는 카드가 아예 없을 수 있고(스토어가 전액을 받는다), 카드가 없다고 막으면
  // 돈을 내고 산 정원을 한 자리도 못 쓴다.
  //
  // 단 **스토어 출처일 때만**이다(2026-08-10 검수). 방금 확정한 source를 그대로 넘겨
  // resolveBillableAmount(googleOwner 요구)와 판정 기준을 일치시킨다 — 어긋나면 웹 카드
  // 감독자가 무과금 발급 + 죽은 정원 상한이라는 최악의 조합을 맞는다.
  const capacity = await getStoreSeatCapacity(admin, { ...sub, source });
  if (capacity != null) {
    // 구글 grace(IN_GRACE_PERIOD → past_due) 중에는 정원을 **더** 쓰게 하지 않는다.
    // 카드 경로에서 같은 상태를 'period'로 막던 자리이고, 스토어가 돈을 못 받고 있는 동안
    // 계정이 늘어나는 것을 허용할 이유가 없다. 이미 쓰던 좌석은 건드리지 않는다(발급만 차단).
    // 판정은 capacityIssueBlocked 한 곳에서만 만든다 — /api/org/context의 canIssueSeats가
    // 같은 함수를 부르므로 앱 안내와 서버 응답이 갈라질 수 없다.
    if (capacityIssueBlocked(sub.status)) {
      return { ok: false, ...zero, reason: "period", error: STORE_GRACE_MESSAGE };
    }
    const cap = await checkSeatCapacity(admin, {
      userId: sub.user_id,
      capacity,
      count,
      seatsClaimed: opts.seatsClaimed,
    });
    if (!cap.ok) {
      return { ok: false, ...zero, reason: "capacity", error: cap.error };
    }
    return { ok: true, ...zero }; // 정원 안 = 무과금. PG를 부르지 않는다.
  }

  // 무료체험 중에는 일할 청구를 하지 않는다.
  // '첫 달 무료'라고 안내해 놓고 현장을 추가했다는 이유로 당일 3,900원을 긁으면 약속 위반이고,
  // 카드 없는 휴대폰 인증 체험 계정은 아예 결제수단이 없어 여기서 막히면 현장을 하나도
  // 못 만든다(가입 직후 안내되는 첫 화면이 바로 '현장 계정 만들기'다).
  // 체험이 끝나는 날 cron이 늘어난 계정 수로 온전히 청구한다.
  if (sub.status === "trialing") {
    // 단, 인앱 체험 소유주(구글/애플)는 카드부터 받는다 — 포트원 체험은 기간이 끝나면 구독 자체가
    // 잠겨 무과금 좌석도 같이 잠기지만, 스토어 소유주는 본인 몫을 스토어가 계속 받아 구독이
    // 살아 있으므로 카드 없이 만든 좌석이 영원히 무과금으로 남는다. 청구는 체험 종료 후
    // 첫 정규 주기부터 cron이 한다(체험 중 좌석 무료 관례는 유지).
    if (isStoreSource(source) && !sub.billing_key) {
      return { ok: false, ...zero, reason: "method", error: "등록된 결제수단이 없습니다." };
    }
    return { ok: true, ...zero };
  }

  if (!sub.billing_key) {
    return { ok: false, ...zero, reason: "method", error: "등록된 결제수단이 없습니다." };
  }

  // 주기가 이미 지났다 = 정기 결제가 아직 안 붙었거나 실패한 상태.
  // 여기서 '나중에 받으면 된다'고 통과시키면, past_due로 실패를 반복하는 감독자가
  // 계정을 무제한으로 무료 발급할 수 있다(3회 실패 후 해지되면 그대로 끝).
  if (!end || end.getTime() <= now.getTime()) {
    return {
      ok: false,
      ...zero,
      reason: "period",
      error: "결제가 확인되지 않았습니다. 구독 및 결제에서 결제수단을 확인한 뒤 다시 시도해주세요.",
    };
  }

  const periodStart = new Date(end);
  periodStart.setMonth(periodStart.getMonth() - 1);
  const total = Math.max(DAY_MS, end.getTime() - periodStart.getTime());
  const remaining = Math.min(total, Math.max(0, end.getTime() - now.getTime()));
  const prorated = Math.max(100, Math.floor((SEAT_PRICE * count * remaining) / total)); // PG 최소금액 100원

  // 구글 소유주의 좌석 일할결제는 이번 구글 주기의 정기 좌석청구 키(gseat_…)를 선점한다.
  // cron(chargeGoogleOwnerSeats)은 이 키가 paid면 그 주기를 건너뛰므로,
  // "발급 당일 일할 + 같은 주기 월청구 전액"이라는 이중청구가 멱등 키 하나로 막힌다.
  // 키가 이미 paid면(이번 주기 두 번째 증설 등) 일회성 id로 청구한다.
  let paymentId = newPaymentId("seat");
  // 키를 선점할 때 함께 청구할 '기존 활성 좌석'의 이번 주기 몫 (구글 소유주 전용).
  // 추가분 일할만으로 키를 paid로 만들면 cron이 이 주기를 통째로 건너뛰어, 갱신 직후~그날
  // cron 사이에 증설한 경우 **기존 좌석의 한 달치가 무과금**이 된다(검수 발견). 기존 좌석은
  // 지난 주기까지만 결제된 상태이므로 이번 주기 전액을 여기서 같이 받는다.
  // 단 grace(past_due) 중에는 받지 않는다 — 회복 시 만료일이 전진해 새 키로 전액이 다시
  // 청구되므로, grace 창에서 전액을 선청구하면 그게 이중청구가 된다.
  let periodBase = 0;
  if (isStoreSource(source)) {
    const gseatId = seatPeriodPaymentId(sub);
    const { data: taken } = await admin
      .from("payments")
      .select("payment_id, status")
      .eq("payment_id", gseatId)
      .maybeSingle();
    if (!taken || taken.status !== "paid") {
      paymentId = gseatId; // failed 잔재는 재사용(포트원 재시도 관례)
      if (sub.status === "active") {
        // 소급 대상은 '청구 대상 좌석'이다 — org_members active 전체를 세면 본인 스토어 구독으로
        // 사는 현장 몫까지 감독자에게 소급 청구된다(정기 청구에서는 빠지는데 여기서만 받는 어긋남).
        const acc = await resolveOrgSeatAccountingByOwner(admin, sub.user_id);
        if (acc) {
          // 실제 청구 시점에는 발급분(count)이 좌석 점유(claim)를 먼저 끝내 회계에 이미 포함돼
          // 있으므로 빼고 센다. 미리보기(seatsClaimed=false)는 아직 안 만들었으니 그대로 센다.
          const already = opts.seatsClaimed ? count : 0;
          periodBase = Math.max(0, acc.billableSeats - already) * SEAT_PRICE;
        }
      }
    }
  }
  return { ok: true, prorated, periodBase, amount: prorated + periodBase, paymentId };
}

/**
 * 현장 계정을 하나 추가할 때의 잔여기간 일할 청구.
 * 좌석 선구매를 없앤 뒤로 "계정 발급 = 즉시 일할 청구"가 되었고,
 * 다음 주기부터는 resolveBillableAmount가 알아서 늘어난 계정 수로 청구한다.
 * 금액·결제 키 계산은 resolveSeatCharge가 전담한다(발급 화면 미리보기와 공유).
 */
export async function chargeProratedAccount(
  admin: SupabaseClient,
  sub: {
    id: string;
    user_id: string;
    status?: string;
    billing_key: string | null;
    current_period_end: string | null;
    source?: string | null;
    store_seat_capacity?: number | null;
  },
  opts: { count?: number; customerEmail?: string } = {}
): Promise<{ ok: boolean; charged: number; error?: string }> {
  const count = opts.count ?? 1;
  const now = new Date();

  const plan = await resolveSeatCharge(admin, sub, { count, seatsClaimed: true });
  if (!plan.ok) return { ok: false, charged: 0, error: plan.error };
  // 체험 중(amount 0) — 받을 것이 없으니 PG를 부르지 않는다. 일할 청구는 체험이 끝난 뒤부터.
  if (plan.amount <= 0) return { ok: true, charged: 0 };
  // 빌링키 재확인 — resolveSeatCharge가 이미 걸렀지만(ok=false) 타입을 좁히려면 여기서도 필요하다
  if (!sub.billing_key) return { ok: false, charged: 0, error: "등록된 결제수단이 없습니다." };
  const { paymentId, periodBase, amount } = plan;

  const res = await chargeWithBillingKey({
    paymentId,
    billingKey: sub.billing_key,
    orderName:
      periodBase > 0
        ? `안톡 현장 계정 추가 ${count}개 일할 + 기존 좌석 이번 주기분`
        : `안톡 현장 계정 추가 ${count}개 (잔여기간 일할)`,
    amount,
    customer: { id: sub.user_id, email: opts.customerEmail },
  });
  const body: any = res.body || {};
  const pgStatus = String(body?.payment?.status ?? body?.status ?? "").toUpperCase();
  const paid = res.ok && (pgStatus === "" || pgStatus === "PAID");

  await admin.from("payments").upsert(
    {
      subscription_id: sub.id,
      user_id: sub.user_id,
      payment_id: paymentId,
      amount,
      status: paid ? "paid" : "failed",
      pg_raw: body,
      paid_at: paid ? now.toISOString() : null,
    },
    { onConflict: "payment_id" }
  );

  return paid
    ? { ok: true, charged: amount }
    : { ok: false, charged: 0, error: "현장 계정 추가 결제에 실패했습니다. 카드를 확인해주세요." };
}

/** 결제 대상 기간의 결정적 날짜 키 (YYYYMMDD, current_period_end 기준) */
function periodKey(currentPeriodEnd: string | null): string {
  const base = currentPeriodEnd ? new Date(currentPeriodEnd) : new Date(0);
  return `${base.getUTCFullYear()}${String(base.getUTCMonth() + 1).padStart(2, "0")}${String(
    base.getUTCDate()
  ).padStart(2, "0")}`;
}

/** 결제 대상 기간을 식별하는 결정적 키 (같은 기간 재시도 시 동일 paymentId → 중복결제 방지) */
function periodPaymentId(sub: SubscriptionRow): string {
  return `sub_${sub.id}_${periodKey(sub.current_period_end)}`;
}

/** 구글 소유주 좌석 몫의 주기 결제 키 — 구글 주기(현재 만료일)당 1회 청구를 보장한다.
 *  구글이 갱신하면 current_period_end가 전진해 키가 바뀌고, 새 주기의 청구가 열린다. */
function seatPeriodPaymentId(sub: { id: string; current_period_end: string | null }): string {
  return `gseat_${sub.id}_${periodKey(sub.current_period_end)}`;
}

/**
 * 한 구독을 빌링키로 과금하고 결과를 DB에 기록한다. (멱등)
 * - 동일 기간 paymentId가 이미 paid면 스킵 (중복결제 방지)
 * - 성공 시 active + 다음 결제일(+1개월), 낙관적 잠금으로 이중 진행 방지
 * - 실패 시 failed_attempts 증가, 한도 초과 시 canceled, 아니면 past_due
 */
export async function chargeSubscription(
  admin: SupabaseClient,
  sub: SubscriptionRow,
  opts: { amount?: number; customerEmail?: string; paymentIdOverride?: string } = {}
): Promise<ChargeResult> {
  // 청구액은 스냅샷(sub.amount)이 아니라 청구 시점의 실제 계정 수로 재계산한다.
  // 감축(현장 제거)은 자연히 다음 주기부터 반영되고, 증설은 즉시 일할 청구된다.
  const billable = await resolveBillableAmount(admin, sub);
  const orgRow = billable.org;
  const amount = opts.amount ?? billable.amount;
  // 초회 결제(checkout 등)는 1회성 id를 주입할 수 있다 — 같은 날 해지→재구독 시
  // 날짜 키 paymentId가 재사용되어 환불 기록을 덮거나 결제가 거절되는 문제 방지 (리뷰 B/하)
  const paymentId = opts.paymentIdOverride ?? periodPaymentId(sub);
  const now = new Date();

  if (!sub.billing_key) {
    return { ok: false, paymentId, status: "failed", detail: "빌링키 없음" };
  }

  // 멱등성: 이 기간에 대해 이미 성공한 결제가 있으면 재청구하지 않음
  const { data: existing } = await admin
    .from("payments")
    .select("status")
    .eq("payment_id", paymentId)
    .maybeSingle();
  if (existing?.status === "paid") {
    return { ok: true, paymentId, status: "skipped", detail: "이미 결제됨" };
  }

  // 낙관수용한 미검증 키는 과금 전에 소유권을 재검증 (통과 못 하면 여기서 중단)
  const gate = await ensureBillingKeyVerified(admin, sub, paymentId);
  if (gate) return gate;

  const res = await chargeWithBillingKey({
    paymentId,
    billingKey: sub.billing_key,
    orderName: billable.orderName,
    amount,
    customer: { id: sub.user_id, email: opts.customerEmail },
  });

  // 성공 판정: HTTP 2xx 뿐 아니라 PG 상태가 PAID인지까지 확인 (거절이 2xx로 오는 경우 방지)
  const body: any = res.body || {};
  const pgStatus = String(body?.payment?.status ?? body?.status ?? "").toUpperCase();
  let paid = res.ok && (pgStatus === "" || pgStatus === "PAID");
  let recordBody: any = body;

  // 재조정: 직전 실행에서 결제는 성공했으나 payments 기록이 실패해 재청구를 시도하면,
  // PortOne이 동일 paymentId를 "이미 결제됨"(ALREADY_PAID/409)으로 거절한다. 이때 실제 상태를
  // 조회해 PAID면 성공으로 간주한다. (그렇지 않으면 실제로 청구된 고객이 실패로 기록→3회 후 강제 해지됨)
  if (!paid) {
    const errCode = String(body?.type ?? body?.code ?? body?.pgCode ?? "").toUpperCase();
    if (res.status === 409 || errCode.includes("ALREADY_PAID")) {
      const chk = await getPayment(paymentId);
      const chkStatus = String(chk.body?.status ?? chk.body?.payment?.status ?? "").toUpperCase();
      if (chk.ok && chkStatus === "PAID") {
        paid = true;
        recordBody = chk.body;
      }
    }
  }

  // 결제 내역 기록 (paymentId 충돌 시 갱신)
  const { error: payErr } = await admin.from("payments").upsert(
    {
      subscription_id: sub.id,
      user_id: sub.user_id,
      payment_id: paymentId,
      amount,
      status: paid ? "paid" : "failed",
      pg_raw: recordBody,
      paid_at: paid ? now.toISOString() : null,
    },
    { onConflict: "payment_id" }
  );
  if (payErr) {
    // 기록 실패 시 기간을 진행시키지 않음 (결제는 됐는데 기록 없음 방지 → 다음 재시도가 멱등 처리)
    console.error("payment insert error:", payErr);
    return { ok: false, paymentId, status: "failed", detail: payErr };
  }

  if (paid) {
    const base =
      sub.current_period_end && new Date(sub.current_period_end) > now
        ? new Date(sub.current_period_end)
        : now;
    // 재계산한 청구액을 amount 스냅샷에도 반영한다(표시·이력용).
    // 예약 변경(pending_plan)이 남아 있으면 이번 결제에서 함께 전환한다.
    const planChange = sub.pending_plan
      ? { plan: getPlan(sub.pending_plan).id, amount, pending_plan: null }
      : { amount };
    // 낙관적 잠금: 우리가 본 current_period_end 그대로일 때만 진행 (동시 실행 이중 진행 방지)
    let q = admin
      .from("subscriptions")
      .update({
        status: "active",
        current_period_end: addOneMonth(base).toISOString(),
        failed_attempts: 0,
        updated_at: now.toISOString(),
        ...planChange,
      })
      .eq("id", sub.id);
    q = sub.current_period_end
      ? q.eq("current_period_end", sub.current_period_end)
      : q.is("current_period_end", null);
    await q;

    // 좌석 선구매가 사라져 감축 예약(pending_seat_count)이 필요 없다 —
    // 청구액을 매번 실제 계정 수로 재계산하므로 현장을 빼면 다음 주기에 자동 반영된다.
    // 표시용 seat_count만 실제 값과 맞춰둔다.
    if (orgRow) {
      await admin
        .from("organizations")
        .update({ seat_count: orgRow.accountCount, pending_seat_count: null })
        .eq("id", orgRow.id);
    }
  } else {
    const attempts = (sub.failed_attempts ?? 0) + 1;
    const nowCanceled = attempts >= MAX_FAILED_ATTEMPTS;
    await admin
      .from("subscriptions")
      .update({
        status: nowCanceled ? "canceled" : "past_due",
        failed_attempts: attempts,
        ...(nowCanceled ? { canceled_at: now.toISOString() } : {}),
        updated_at: now.toISOString(),
      })
      .eq("id", sub.id);

    // 회사 플랜이 3회 실패로 해지되면 하위 미러 구독을 즉시 강등 (결정 8: 유예 없음).
    // 멤버십(org_members)은 남겨 재결제 시 복구 가능하게 한다. cron 말미 reconciliation이 2차 안전망.
    if (nowCanceled && orgRow) {
      // 접는 대상도 좌석 회계와 같은 단위다 — 자가 스토어 결제자는 애초에 미러가 없고,
      // 그 사람의 구독 행을 이 경로가 건드리면 본인 결제까지 끊어버린다.
      const acc = await resolveOrgSeatAccounting(admin, orgRow.id);
      await cancelOrgSeatMirrors(acc.seatIds, admin);
    }
  }

  return { ok: paid, paymentId, status: paid ? "paid" : "failed", detail: body };
}

/**
 * 인앱 구독 소유주(구글 Play·애플 App Store)의 좌석 몫 월 청구. (cron 전용)
 * 함수명은 구글만 있던 시절의 잔재 — 애플(source='app_store') 소유주도 같은 구조로 처리한다.
 *
 * 본인 몫(4,900)은 스토어가 받고, 등록 카드(PortOne 빌링키)로는 활성 좌석 × 3,900만 받는다.
 * chargeSubscription을 재사용하지 않는 이유: 그 함수는 성공 시 current_period_end를 전진시키고
 * 실패 시 status를 past_due/canceled로 바꾸는데, 스토어 소유주의 그 두 필드는 **스토어 구독 상태의
 * 미러**(verify/RTDN·애플 알림이 관리)라서 좌석 카드 문제로 건드리면 본인 구독까지 망가진다.
 *
 * - 멱등: 주기 키 gseat_{subId}_{만료일}. 같은 스토어 주기에 1회만 청구.
 *   (좌석 증설 일할결제 chargeProratedAccount가 이 키를 먼저 선점했으면 그 주기는 스킵)
 * - 실패: failed_attempts만 증가. MAX_FAILED_ATTEMPTS 도달 시 좌석 미러(org_seat)만 강등 —
 *   소유주 status/기간은 불변. 복구는 카드 재등록(/api/billing/card, 카운터 리셋) 후 다음 cron.
 * - 성공: 카운터 리셋 + 접혀 있던 미러 복원(돈은 받는데 현장이 잠긴 상태 방지).
 */
export async function chargeGoogleOwnerSeats(
  admin: SupabaseClient,
  sub: SubscriptionRow,
  opts: { customerEmail?: string } = {}
): Promise<ChargeResult> {
  const paymentId = seatPeriodPaymentId(sub);
  const now = new Date();

  if (!sub.billing_key) {
    return { ok: false, paymentId, status: "failed", detail: "빌링키 없음" };
  }

  // 멱등성: 이 구글 주기의 좌석 몫이 이미 결제됐으면(월청구 또는 일할 선점) 재청구하지 않음
  const { data: existing } = await admin
    .from("payments")
    .select("status")
    .eq("payment_id", paymentId)
    .maybeSingle();
  if (existing?.status === "paid") {
    return { ok: true, paymentId, status: "skipped", detail: "이미 결제됨" };
  }

  const billable = await resolveBillableAmount(admin, sub);
  if (!billable.org || billable.amount <= 0) {
    return { ok: true, paymentId, status: "skipped", detail: "청구할 좌석 없음" };
  }
  const org = billable.org;

  // 낙관수용(미검증) 키 재검증 — ensureBillingKeyVerified는 소유권 불일치 시 status를 past_due로
  // 바꾸므로 여기서는 못 쓴다(구글 소유주의 status는 구글 것). 구글-안전 버전으로 직접 처리.
  if (sub.billing_key_verified === false) {
    const info = await getBillingKeyInfo(sub.billing_key);
    if (info.ok) {
      const customerId = (info.body as { customer?: { id?: string } })?.customer?.id;
      if (customerId && customerId !== sub.user_id) {
        console.error("google-seat re-verify: billing-key ownership mismatch — clearing key", {
          subId: sub.id,
          keyCustomerId: customerId,
          userId: sub.user_id,
        });
        await admin
          .from("subscriptions")
          .update({
            billing_key: null,
            card_info: null,
            billing_key_verified: true,
            updated_at: now.toISOString(),
          })
          .eq("id", sub.id);
        // 키가 비면 이 구독은 cron 대상(billing_key not null)에서 빠진다 — 여기서 미러를
        // 접지 않으면 남의 키로 만든 좌석이 무기한 무과금으로 산다(검수 발견). 멤버십은
        // 남겨두므로, 정상 카드 재등록(카운터 리셋) 후 첫 청구 성공 시 자동 복원된다.
        const acc = await resolveOrgSeatAccounting(admin, org.id);
        await cancelOrgSeatMirrors(acc.seatIds, admin);
        return { ok: false, paymentId, status: "failed", detail: "ownership mismatch — key cleared" };
      }
      await admin.from("subscriptions").update({ billing_key_verified: true }).eq("id", sub.id);
    } else {
      // 아직 조회 불가(전파 지연) → 이번 회차 스킵, 실패 카운트도 올리지 않는다
      console.warn("google-seat re-verify: billing-key still not readable — skipping this run", {
        subId: sub.id,
        status: info.status,
      });
      return { ok: false, paymentId, status: "skipped", detail: "awaiting billing-key verification" };
    }
  }

  const res = await chargeWithBillingKey({
    paymentId,
    billingKey: sub.billing_key,
    orderName: billable.orderName,
    amount: billable.amount,
    customer: { id: sub.user_id, email: opts.customerEmail },
  });

  const body: any = res.body || {};
  const pgStatus = String(body?.payment?.status ?? body?.status ?? "").toUpperCase();
  let paid = res.ok && (pgStatus === "" || pgStatus === "PAID");
  let recordBody: any = body;

  // 재조정: 결제는 됐는데 기록이 실패했던 재시도가 ALREADY_PAID로 거절되는 경우 (portone 경로와 동일)
  if (!paid) {
    const errCode = String(body?.type ?? body?.code ?? body?.pgCode ?? "").toUpperCase();
    if (res.status === 409 || errCode.includes("ALREADY_PAID")) {
      const chk = await getPayment(paymentId);
      const chkStatus = String(chk.body?.status ?? chk.body?.payment?.status ?? "").toUpperCase();
      if (chk.ok && chkStatus === "PAID") {
        paid = true;
        recordBody = chk.body;
      }
    }
  }

  const { error: payErr } = await admin.from("payments").upsert(
    {
      subscription_id: sub.id,
      user_id: sub.user_id,
      payment_id: paymentId,
      amount: billable.amount,
      status: paid ? "paid" : "failed",
      pg_raw: recordBody,
      paid_at: paid ? now.toISOString() : null,
    },
    { onConflict: "payment_id" }
  );
  if (payErr) {
    // 기록 실패 시 상태를 진행시키지 않음 — 다음 실행의 멱등 체크(ALREADY_PAID 재조정)가 수습한다
    console.error("google-seat payment insert error:", payErr);
    return { ok: false, paymentId, status: "failed", detail: payErr };
  }

  if (paid) {
    // 구글 소유 필드(status/current_period_end/amount)는 불변 — 좌석 관련 필드만 만진다
    await admin
      .from("subscriptions")
      .update({ failed_attempts: 0, updated_at: now.toISOString() })
      .eq("id", sub.id);
    await admin
      .from("organizations")
      .update({ seat_count: org.accountCount, pending_seat_count: null })
      .eq("id", org.id);
    // 이전 실패(3회 강등)로 접힌 미러가 있으면 되살린다 — 청구액과 사용 가능 계정 수 일치.
    // 후보 선정은 restoreOrgSeatMirrors 안에서 뷰가 한다(`plan='org_seat'` 필터가 아니라
    // mirror_alive=false). 그래서 자가 결제 기간 동안 plan이 monthly_pro로 남았던 행과
    // 구독 행이 아예 없는 계정도 여기서 함께 복원된다.
    await restoreOrgSeatMirrors(org.id, admin);
  } else {
    const attempts = (sub.failed_attempts ?? 0) + 1;
    // 소유주 status는 절대 건드리지 않는다 — 좌석 카드 실패가 구글 구독(본인 몫)을 끊으면 안 된다
    await admin
      .from("subscriptions")
      .update({ failed_attempts: attempts, updated_at: now.toISOString() })
      .eq("id", sub.id);
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      // 강등은 좌석 미러(org_seat)에만. 멤버십은 남겨 카드 재등록 시 복구 가능하게 한다.
      // 대상은 **청구 대상 좌석**뿐이다 — 자가 스토어 결제자는 감독자 카드 실패와 무관하게
      // 자기 구독으로 계속 산다(정확히 이 시나리오의 원래 의도).
      const seatIds = (await resolveOrgSeatAccounting(admin, org.id)).seatIds;
      if (seatIds.length > 0) await cancelOrgSeatMirrors(seatIds, admin);
    }
  }

  return { ok: paid, paymentId, status: paid ? "paid" : "failed", detail: body };
}
