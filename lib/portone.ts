// lib/portone.ts — PortOne V2 서버 측 헬퍼
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const PORTONE_API_BASE = "https://api.portone.io";

export const PLAN = {
  id: "monthly_basic",
  name: "안전톡톡e 월간구독",
  amount: 1900,
  currency: "KRW" as const,
};

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
  if (!user) return { user: null, allowed: false, sub: null as any };
  const admin = getAdminClient();
  const { data } = await admin
    .from("subscriptions")
    .select("status, plan, current_period_end")
    .eq("user_id", user.id)
    .maybeSingle();
  return { user, allowed: subscriptionAllows(data), sub: data };
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
