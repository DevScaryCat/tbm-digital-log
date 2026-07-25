// lib/billing.ts — 빌링키 과금 + 구독/결제 상태 갱신 (수동 charge & cron 공용)
import { SupabaseClient } from "@supabase/supabase-js";
import {
  chargeWithBillingKey,
  getBillingKeyInfo,
  getPayment,
  addOneMonth,
  PLAN,
  getPlan,
  ORG_SEAT_PRICE,
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
  // 회사 플랜(org): 스냅샷(sub.amount)이 아니라 청구 시점 좌석 수 × 단가로 재계산.
  // 감축 예약(pending_seat_count)은 이번 청구부터 적용. pending_plan 경로보다 먼저 판정해야
  // (org에는 pending_plan을 허용하지 않지만) 잔존 값이 재계산을 가로채지 못한다.
  let orgRow: { id: string; seat_count: number; pending_seat_count: number | null } | null = null;
  let orgSeats: number | null = null;
  if (sub.plan === "org") {
    const { data } = await admin
      .from("organizations")
      .select("id, seat_count, pending_seat_count")
      .eq("owner_user_id", sub.user_id)
      .maybeSingle();
    orgRow = data as any;
    if (!orgRow) {
      return { ok: false, paymentId: periodPaymentId(sub), status: "failed", detail: "조직 정보 없음" };
    }
    orgSeats = orgRow.pending_seat_count ?? orgRow.seat_count;
  }

  // 예약된 플랜 변경(pending_plan)이 있으면 이번 결제부터 새 플랜 금액으로 청구하고 전환
  const amount =
    opts.amount ??
    (orgSeats != null
      ? orgSeats * ORG_SEAT_PRICE
      : sub.pending_plan
        ? getPlan(sub.pending_plan).amount
        : sub.amount ?? PLAN.amount);
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
    orderName:
      orgSeats != null
        ? `안톡 회사 플랜 (관리감독자 ${orgSeats}명)`
        : getPlan(sub.pending_plan ?? sub.plan).name,
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
    // 예약 변경이 있으면 이번 결제에서 플랜 전환 (없으면 plan/amount 건드리지 않음)
    // org는 청구액 재계산 결과를 amount 스냅샷에도 반영(표시용)
    const planChange =
      sub.plan === "org"
        ? { amount }
        : sub.pending_plan
          ? { plan: getPlan(sub.pending_plan).id, amount, pending_plan: null }
          : {};
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

    // org 감축 예약 반영 — 이번 청구를 감축된 좌석 수로 했으므로 확정한다.
    // (seat_count = pending 값 세팅은 멱등이라 동시 실행에도 안전)
    if (orgRow && orgRow.pending_seat_count != null) {
      await admin
        .from("organizations")
        .update({ seat_count: orgRow.pending_seat_count, pending_seat_count: null })
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
