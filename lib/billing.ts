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
import { cancelOrgSeatMirrors } from "@/lib/org";

export const MAX_FAILED_ATTEMPTS = 3;

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
    const accountCount = 1 + (count ?? 0); // 감독자 본인도 한 계정(=현장 하나)으로 센다
    return {
      amount: accountCount * SEAT_PRICE,
      orderName: `안톡 월간구독 (계정 ${accountCount}개)`,
      org: { id: (orgRow as any).id, accountCount },
    };
  }

  // legacy 요금 유지: 구 베이직(1,900)은 카드사 정기결제 동의 금액이 그때 값이라 올리지 않는다.
  if (sub.plan === "monthly_basic" || sub.plan === "grandfather") {
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
 * 현장 계정을 하나 추가할 때의 잔여기간 일할 청구.
 * 좌석 선구매를 없앤 뒤로 "계정 발급 = 즉시 일할 청구"가 되었고,
 * 다음 주기부터는 resolveBillableAmount가 알아서 늘어난 계정 수로 청구한다.
 */
export async function chargeProratedAccount(
  admin: SupabaseClient,
  sub: {
    id: string;
    user_id: string;
    status?: string;
    billing_key: string | null;
    current_period_end: string | null;
  },
  opts: { count?: number; customerEmail?: string } = {}
): Promise<{ ok: boolean; charged: number; error?: string }> {
  const count = opts.count ?? 1;
  const now = new Date();
  const end = sub.current_period_end ? new Date(sub.current_period_end) : null;

  // 무료체험 중에는 일할 청구를 하지 않는다.
  // '첫 달 무료'라고 안내해 놓고 현장을 추가했다는 이유로 당일 3,900원을 긁으면 약속 위반이고,
  // 카드 없는 휴대폰 인증 체험 계정은 아예 결제수단이 없어 여기서 막히면 현장을 하나도
  // 못 만든다(가입 직후 안내되는 첫 화면이 바로 '현장 계정 만들기'다).
  // 체험이 끝나는 날 cron이 늘어난 계정 수로 온전히 청구한다.
  if (sub.status === "trialing") return { ok: true, charged: 0 };

  if (!sub.billing_key) return { ok: false, charged: 0, error: "등록된 결제수단이 없습니다." };

  // 주기가 이미 지났다 = 정기 결제가 아직 안 붙었거나 실패한 상태.
  // 여기서 '나중에 받으면 된다'고 통과시키면, past_due로 실패를 반복하는 감독자가
  // 계정을 무제한으로 무료 발급할 수 있다(3회 실패 후 해지되면 그대로 끝).
  if (!end || end.getTime() <= now.getTime()) {
    return {
      ok: false,
      charged: 0,
      error: "결제가 확인되지 않았습니다. 구독 및 결제에서 결제수단을 확인한 뒤 다시 시도해주세요.",
    };
  }

  const periodStart = new Date(end);
  periodStart.setMonth(periodStart.getMonth() - 1);
  const total = Math.max(DAY_MS, end.getTime() - periodStart.getTime());
  const remaining = Math.min(total, Math.max(0, end.getTime() - now.getTime()));
  const prorated = Math.max(100, Math.floor((SEAT_PRICE * count * remaining) / total)); // PG 최소금액 100원

  const paymentId = newPaymentId("seat");
  const res = await chargeWithBillingKey({
    paymentId,
    billingKey: sub.billing_key,
    orderName: `안톡 현장 계정 추가 ${count}개 (잔여기간 일할)`,
    amount: prorated,
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
      amount: prorated,
      status: paid ? "paid" : "failed",
      pg_raw: body,
      paid_at: paid ? now.toISOString() : null,
    },
    { onConflict: "payment_id" }
  );

  return paid
    ? { ok: true, charged: prorated }
    : { ok: false, charged: 0, error: "현장 계정 추가 결제에 실패했습니다. 카드를 확인해주세요." };
}

/** 결제 대상 기간을 식별하는 결정적 키 (같은 기간 재시도 시 동일 paymentId → 중복결제 방지) */
function periodPaymentId(sub: SubscriptionRow): string {
  const base = sub.current_period_end ? new Date(sub.current_period_end) : new Date(0);
  const key = `${base.getUTCFullYear()}${String(base.getUTCMonth() + 1).padStart(2, "0")}${String(
    base.getUTCDate()
  ).padStart(2, "0")}`;
  return `sub_${sub.id}_${key}`;
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
