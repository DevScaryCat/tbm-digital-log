// lib/portone.ts — PortOne V2 서버 측 헬퍼
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const PORTONE_API_BASE = "https://api.portone.io";

export type PlanId = "monthly_basic" | "monthly_pro" | "org" | "org_seat";

export interface PlanDef {
  id: PlanId;
  name: string;
  amount: number;
  currency: "KRW";
  /** 유료 단일 티어의 기능(AI 분석 보고서·월간 보고서) 사용 가능 여부.
   *  legacy(monthly_basic)만 false — DB 트리거 enforce_tbm_monthly_limit의
   *  200/30/20 대 80/10/0 분기와 반드시 같은 집합이어야 한다.
   *  (grandfather는 PLANS에 없는 가상 플랜이고 isProPlan에서 true로 처리한다) */
  pro: boolean;
  /** 사용자가 결제 UI에서 직접 선택할 수 있는 플랜인지.
   *  org_seat는 조직 플로우 전용 — body의 plan을 그대로 받는 라우트에서
   *  selectable=false를 거부하지 않으면 0원 org_seat를 아무나 예약할 수 있다. */
  selectable: boolean;
}

/** 계정 1개당 월 요금. 감독자는 본인을 포함한 계정 수만큼 낸다 (본인 1 + 소속 현장 N). */
export const SEAT_PRICE = 3900;

/** @deprecated 구 이름 — SEAT_PRICE를 쓸 것 */
export const ORG_SEAT_PRICE = SEAT_PRICE;

export const PLANS: Record<PlanId, PlanDef> = {
  // 유료 단일 티어. 감독자든 혼자 쓰는 사람이든 전부 이 플랜이고,
  // 실제 청구액만 "계정 수 × SEAT_PRICE"로 청구 시점에 재계산된다(billing.ts resolveBillableAmount).
  monthly_pro: {
    id: "monthly_pro",
    name: "안톡 월간구독",
    amount: SEAT_PRICE,
    currency: "KRW",
    pro: true,
    selectable: true,
  },
  // legacy — 구 베이직(1,900원). 신규 가입 불가, 기존 가입자만 기존 가격·기존 한도로 유지.
  monthly_basic: {
    id: "monthly_basic",
    name: "안톡 월간구독 (구 베이직)",
    amount: 1900,
    currency: "KRW",
    pro: false,
    selectable: false,
  },
  // legacy — 구 회사 플랜. 단일 티어 통합으로 신규 발급되지 않지만,
  // 남아있는 행이 getPlan() 폴백으로 1,900원 베이직이 되어버리지 않도록 정의는 유지한다.
  org: {
    id: "org",
    name: "안톡 월간구독",
    amount: SEAT_PRICE,
    currency: "KRW",
    pro: true,
    selectable: false,
  },
  org_seat: {
    id: "org_seat",
    // 소속 현장 미러 구독 — 감독자가 대신 내므로 본인 청구 없음(0원), 자격은 유료 티어와 동일
    name: "안톡 소속 현장",
    amount: 0,
    currency: "KRW",
    pro: true,
    selectable: false,
  },
};

/** 플랜 식별자로 정의를 조회. 모르는 값이면 유료 단일 티어로 폴백.
 *  (구 구현은 베이직으로 폴백해서, 모르는 값이 조용히 1,900원·기능 축소로 강등됐다) */
export function getPlan(planId?: string | null): PlanDef {
  if (planId && planId in PLANS) return PLANS[planId as PlanId];
  return PLANS.monthly_pro;
}

/**
 * 해당 플랜이 유료 티어 **기능**을 허용하는지.
 *
 * 2026-08-10 Chris 결정: grandfather(영구 무료, 실계정 8개)는 "결제 시스템만 빠진 유료 계정"이다.
 * 기능·한도를 유료와 완전히 동일하게 준다(교육일지 200·회의록 30·AI 분석 20) — 종전에는
 * false라 AI 분석이 0회로 잠겨 실고객이 핵심 기능을 아예 못 썼다.
 * 이 집합은 DB 트리거 enforce_tbm_monthly_limit / lib/useSubscription.ts LIMITS /
 * 앱 src/lib/subscription.ts LIMITS와 반드시 같아야 한다.
 *
 * ⚠️ 이 함수는 **기능 자격**만 뜻한다. "돈을 받을 수 있는 구독인가"는 isBillablePlan을 쓸 것 —
 *    grandfather에게 좌석·조직을 열면 무과금 좌석이 생긴다(아래 주석 참조).
 */
export function isProPlan(planId?: string | null): boolean {
  if (planId === "grandfather") return true;
  return getPlan(planId).pro;
}

/**
 * **실제로 청구가 가능한** 유료 구독인가 — 좌석·조직 게이트 전용 판정.
 *
 * isProPlan과 분리한 이유(2026-08-10): grandfather는 기능은 유료와 같지만 결제 수단을
 * 등록할 수 없는(카드 등록 UI 자체가 없는) 계정이다. 좌석 발급·초대·조직 생성을 isProPlan으로
 * 게이트하면 grandfather가 통과해 **감독자가 되고, 소속 현장 좌석이 무기한 무과금으로 늘어난다**
 * (좌석 청구 크론은 billing_key NOT NULL 행만 긁는데 grandfather는 billing_key=null이다).
 * 그래서 조직·좌석 경로만 이 판정을 쓴다.
 *
 * (구 reportEligiblePlan은 삭제했다 — grandfather가 isProPlan=true가 되면서 완전히 같은 식이 됐다.
 *  주간·월간 보고서 크론은 이제 isProPlan을 직접 쓴다.)
 */
export function isBillablePlan(planId?: string | null): boolean {
  if (planId === "grandfather") return false;
  return isProPlan(planId);
}

/** 기본 플랜(하위 호환용 별칭) */
export const PLAN = PLANS.monthly_pro;

/** 서비스 롤 Supabase 클라이언트 (RLS 우회, 서버 전용) */
export function getAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error("Supabase 서버 설정 누락");
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Authorization: Bearer <supabase access token> 헤더로 로그인 사용자 식별 */
export async function getUserFromRequest(request: Request) {
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

/**
 * 상태 갱신이 멈춘 행을 걸러내는 유예 폭. 이 기간을 넘도록 만료가 방치된 행은
 * "권한이 있는 상태"가 아니라 "갱신이 고장난 상태"로 본다.
 * 2주로 잡은 이유: 정상 경로는 하루 단위로 갱신되므로 여유가 크고, 반대로 우리 크론·자격증명이
 * 망가져 fail-closed로 정상 결제자를 잠그기 전까지 알아채고 고칠 시간이 충분하다.
 */
const STALE_PERIOD_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

/** 구독 상태가 앱/유료기능 사용을 허용하는지 (서버 측 판정) */
export function subscriptionAllows(
  sub: { status?: string; current_period_end?: string | null; billing_key?: string | null } | null,
): boolean {
  if (!sub) return false;
  // 카드 없는 무료체험(휴대폰인증 가입): 체험 기간이 끝나면 결제 등록 전까지 불허.
  // billing_key가 있는 trialing(기존 카드등록 체험)은 cron이 과금하므로 기존과 동일하게 허용.
  if (
    sub.status === "trialing" &&
    !sub.billing_key &&
    sub.current_period_end &&
    new Date(sub.current_period_end) <= new Date()
  ) {
    return false;
  }
  // 백스톱: 만료가 STALE_PERIOD_GRACE_MS 넘게 지났는데 상태가 아직 살아 있는 행은 갱신이
  // 유실된 것이다(스토어 알림 유실 + 재조회 크론 정지, 또는 청구 크론 정지). 정상 운영이면
  // 카드 구독은 하루 안에 갱신·강등되고 스토어 구독은 재조회 크론이 하루 안에 확정하므로,
  // 2주가 지나도록 만료 상태로 남아 있는 정상 이용자는 존재하지 않는다.
  // current_period_end가 null인 행(org_seat 미러·grandfather 영구무료)은 애초에 만료 개념이
  // 없으므로 여기 걸리지 않는다.
  if (
    sub.current_period_end &&
    Date.now() - new Date(sub.current_period_end).getTime() > STALE_PERIOD_GRACE_MS
  ) {
    return false;
  }
  if (sub.status === "active" || sub.status === "trialing" || sub.status === "past_due") return true;
  if (
    sub.status === "canceled" &&
    sub.current_period_end &&
    new Date(sub.current_period_end) > new Date()
  ) {
    return true;
  }
  return false;
}

/** 요청의 로그인 사용자 + 구독 허용 여부를 함께 반환 (유료 API 보호용) */
export async function getUserAndSubscription(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return { user: null, allowed: false, isPro: false, sub: null as any };
  const admin = getAdminClient();
  const { data } = await admin
    .from("subscriptions")
    .select("status, plan, current_period_end, billing_key")
    .eq("user_id", user.id)
    .maybeSingle();
  const allowed = subscriptionAllows(data);
  // Pro 기능은 (구독이 유효하면서) 플랜이 Pro일 때만 허용
  const isPro = allowed && isProPlan(data?.plan);
  return { user, allowed, isPro, sub: data };
}

function apiSecret(): string {
  const secret = process.env.PORTONE_API_SECRET;
  if (!secret) throw new Error("PORTONE_API_SECRET 누락");
  return secret;
}

async function portoneFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${PORTONE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `PortOne ${apiSecret()}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, body: json };
}

/** 빌링키 발급 검증 + 카드정보 조회 */
export async function getBillingKeyInfo(billingKey: string) {
  return portoneFetch(`/billing-keys/${encodeURIComponent(billingKey)}`, {
    method: "GET",
  });
}

/** 빌링키 폐기 — 구독 해지 시 PG에 남은 결제수단 위임을 회수한다(실패해도 해지는 진행, 로그만) */
export async function deleteBillingKey(billingKey: string) {
  return portoneFetch(`/billing-keys/${encodeURIComponent(billingKey)}`, {
    method: "DELETE",
  });
}

/** 결제 단건 조회 (paymentId로 실제 결제 상태 확인 — 이미 결제됨 재조정용) */
export async function getPayment(paymentId: string) {
  return portoneFetch(`/payments/${encodeURIComponent(paymentId)}`, {
    method: "GET",
  });
}

/** 빌링키로 즉시 결제 */
export async function chargeWithBillingKey(params: {
  paymentId: string;
  billingKey: string;
  orderName: string;
  amount: number;
  customer?: { id?: string; email?: string; name?: string };
}) {
  const body: Record<string, any> = {
    billingKey: params.billingKey,
    orderName: params.orderName,
    amount: { total: params.amount },
    currency: PLAN.currency,
  };
  if (params.customer) {
    body.customer = {
      id: params.customer.id,
      email: params.customer.email,
      name: params.customer.name ? { full: params.customer.name } : undefined,
    };
  }
  return portoneFetch(
    `/payments/${encodeURIComponent(params.paymentId)}/billing-key`,
    { method: "POST", body: JSON.stringify(body) }
  );
}

/** 결제 취소/환불 (amount 미지정 시 전액, 지정 시 부분 환불) */
export async function cancelPayment(params: {
  paymentId: string;
  amount?: number;
  reason: string;
}) {
  const body: Record<string, any> = { reason: params.reason };
  if (params.amount && params.amount > 0) body.amount = params.amount;
  return portoneFetch(`/payments/${encodeURIComponent(params.paymentId)}/cancel`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** 빌링키 응답에서 표시용 카드정보 추출 (마스킹) */
export function extractCardInfo(billingKeyBody: any) {
  try {
    const methods = billingKeyBody?.methods || billingKeyBody?.billingKeyPaymentMethods;
    const card = Array.isArray(methods)
      ? methods.find((m: any) => m?.card)?.card
      : billingKeyBody?.card;
    if (!card) return null;
    return {
      issuer: card.issuer ?? card.name ?? null,
      brand: card.brand ?? null,
      last4: card.number ? String(card.number).slice(-4) : null,
    };
  } catch {
    return null;
  }
}

/** YYYYMMDD-HHmmss 형태 없이, 결제 고유 ID 생성 (paymentId) */
export function newPaymentId(prefix = "sub") {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
}

/** 다음 결제일 = 기준일 + 1개월 */
export function addOneMonth(from: Date = new Date()): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + 1);
  return d;
}
