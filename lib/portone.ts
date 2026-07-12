// lib/portone.ts — PortOne V2 서버 측 헬퍼
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const PORTONE_API_BASE = "https://api.portone.io";

export type PlanId = "monthly_basic" | "monthly_pro";

export interface PlanDef {
  id: PlanId;
  name: string;
  amount: number;
  currency: "KRW";
  /** Pro 전용 기능(위험성평가 자동생성·월간 보고서) 사용 가능 여부 */
  pro: boolean;
}

export const PLANS: Record<PlanId, PlanDef> = {
  monthly_basic: {
    id: "monthly_basic",
    name: "안전톡톡e 월간구독",
    amount: 1900,
    currency: "KRW",
    pro: false,
  },
  monthly_pro: {
    id: "monthly_pro",
    name: "안전톡톡e Pro 월간구독",
    amount: 4900,
    currency: "KRW",
    pro: true,
  },
};

/** 플랜 식별자로 정의를 조회. 모르는 값이면 베이직으로 폴백. */
export function getPlan(planId?: string | null): PlanDef {
  if (planId && planId in PLANS) return PLANS[planId as PlanId];
  return PLANS.monthly_basic;
}

/** 해당 플랜이 Pro 기능을 허용하는지 (grandfather=영구 무료 '베이직'이므로 Pro 아님) */
export function isProPlan(planId?: string | null): boolean {
  return getPlan(planId).pro;
}

/** 기본 플랜(하위 호환용 별칭) */
export const PLAN = PLANS.monthly_basic;

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

/** 구독 상태가 앱/유료기능 사용을 허용하는지 (서버 측 판정) */
export function subscriptionAllows(sub: { status?: string; current_period_end?: string | null } | null): boolean {
  if (!sub) return false;
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
    .select("status, plan, current_period_end")
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
