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
 */
export async function resolveBillableAmount(
  admin: SupabaseClient,
  sub: SubscriptionRow
): Promise<{ amount: number; orderName: string; org: BillableOrg | null }> {
  // 인앱 구독 소유주(구글/애플): 본인 몫(4,900)은 스토어가 이미 받는다.
  // 등록 카드(PortOne 빌링키)로는 좌석(활성 소속 현장) 몫만 청구한다 — 본인까지 세면 이중청구.
  const googleOwner = isStoreSource(sub.source);

  const { data: orgRow } = await admin
    .from("organizations")
    .select("id")
    .eq("owner_user_id", sub.user_id)
    .maybeSingle();

  if (orgRow) {
    const { count } = await admin
      .from("org_members")
      .select("member_user_id", { count: "exact", head: true })
      .eq("org_id", (orgRow as any).id)
      .eq("status", "active");
    const seatCount = count ?? 0;
    const accountCount = 1 + seatCount; // 감독자 본인도 한 계정(=현장 하나)으로 센다 (표시용 seat_count 기준)
    if (googleOwner) {
      return {
        amount: seatCount * SEAT_PRICE, // 좌석 0이면 0 — 청구할 것이 없다
        orderName: `안톡 현장 계정 ${seatCount}개 (감독자 앱 구독 별도)`,
        org: { id: (orgRow as any).id, accountCount },
      };
    }
    return {
      amount: accountCount * SEAT_PRICE,
      orderName: `안톡 월간구독 (계정 ${accountCount}개)`,
      org: { id: (orgRow as any).id, accountCount },
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
 * plan/subscription은 **자격** 문제라 초대·편입 라우트(app/api/org/invites)도 같은 판정으로
 * 막는다. method/period는 **즉시 청구 실행** 조건이라 즉시 청구가 없는 초대·편입은 지나간다.
 */
export type SeatBlockReason = "plan" | "subscription" | "method" | "period";

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
        const { data: orgRow } = await admin
          .from("organizations")
          .select("id")
          .eq("owner_user_id", sub.user_id)
          .maybeSingle();
        if (orgRow) {
          const { count: activeSeats } = await admin
            .from("org_members")
            .select("member_user_id", { count: "exact", head: true })
            .eq("org_id", (orgRow as any).id)
            .eq("status", "active");
          // 실제 청구 시점에는 발급분(count)이 좌석 점유(claim)를 먼저 끝내 active에 이미 포함돼
          // 있으므로 빼고 센다. 미리보기(seatsClaimed=false)는 아직 안 만들었으니 그대로 센다.
          const already = opts.seatsClaimed ? count : 0;
          periodBase = Math.max(0, (activeSeats ?? 0) - already) * SEAT_PRICE;
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
      const { data: members } = await admin
        .from("org_members")
        .select("member_user_id")
        .eq("org_id", orgRow.id)
        .eq("status", "active");
      await cancelOrgSeatMirrors(
        (members ?? []).map((m: any) => m.member_user_id as string),
        admin
      );
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
        const { data: mm } = await admin
          .from("org_members")
          .select("member_user_id")
          .eq("org_id", org.id)
          .eq("status", "active");
        await cancelOrgSeatMirrors(
          ((mm ?? []) as any[]).map((m) => m.member_user_id as string),
          admin
        );
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

  // 좌석 강등/복원 대상 = 활성 소속 현장 (소유주 본인 제외)
  const { data: members } = await admin
    .from("org_members")
    .select("member_user_id")
    .eq("org_id", org.id)
    .eq("status", "active");
  const memberIds = ((members ?? []) as any[]).map((m) => m.member_user_id as string);

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
    // 이전 실패(3회 강등)로 접힌 미러가 있으면 되살린다 — 청구액과 사용 가능 계정 수 일치
    if (memberIds.length > 0) {
      const { data: folded } = await admin
        .from("subscriptions")
        .select("user_id")
        .in("user_id", memberIds)
        .eq("plan", "org_seat")
        .neq("status", "active");
      const foldedIds = ((folded ?? []) as any[]).map((f) => f.user_id as string);
      if (foldedIds.length > 0) await restoreOrgSeatMirrors(foldedIds, admin);
    }
  } else {
    const attempts = (sub.failed_attempts ?? 0) + 1;
    // 소유주 status는 절대 건드리지 않는다 — 좌석 카드 실패가 구글 구독(본인 몫)을 끊으면 안 된다
    await admin
      .from("subscriptions")
      .update({ failed_attempts: attempts, updated_at: now.toISOString() })
      .eq("id", sub.id);
    if (attempts >= MAX_FAILED_ATTEMPTS && memberIds.length > 0) {
      // 강등은 좌석 미러(org_seat)에만. 멤버십은 남겨 카드 재등록 시 복구 가능하게 한다
      await cancelOrgSeatMirrors(memberIds, admin);
    }
  }

  return { ok: paid, paymentId, status: paid ? "paid" : "failed", detail: body };
}
