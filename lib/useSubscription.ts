"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { startOfMonth, addMonths, format } from "date-fns"

export interface SubscriptionRow {
    status: string
    plan?: string | null
    pending_plan?: string | null
    card_info?: { issuer?: string | null; last4?: string | null; provider?: string | null } | null
    current_period_end?: string | null
    trial_end?: string | null
    trial_used?: boolean | null
    /** 마지막으로 확정된 청구 금액 스냅샷 (감독자는 계정 수만큼 곱해진 값) */
    amount?: number | null
}

/** Pro 상당 플랜 여부 — 조직 플랜(org=안전관리자, org_seat=하위 현장) 포함 */
function isProPlanId(plan?: string | null): boolean {
    return plan === "monthly_pro" || plan === "org" || plan === "org_seat"
}

/** 화면에 띄울 플랜 이름 — 단일 요금제라 티어 이름이 없다 */
function planLabel(plan?: string | null): string {
    if (plan === "grandfather") return "무료"
    if (plan === "monthly_basic") return "베이직"
    if (plan === "org_seat") return "소속 현장"
    return "안톡"
}

/** 현재 구독이 Pro 기능을 쓸 수 있는 상태인지 (grandfather는 영구 무료 베이직이라 Pro 아님) */
export function isProActive(sub: SubscriptionRow | null): boolean {
    return isAllowed(sub) && isProPlanId(sub?.plan)
}

/**
 * 만료 판정(단일 진실) — 구독 행은 있는데 isAllowed=false(체험 종료·해지 만료)면 true.
 * legacy 비구독(isAllowed && !Pro, grandfather·monthly_basic 등)과 반드시 구분할 것 —
 * 그쪽은 기존 '예시' 화면이 맞고, 만료자만 결제 유도(/pricing)로 보낸다.
 * 행 없음(null)은 만료가 아니라 미가입(/start-trial 대상)이다. 앱 expiredStatus()와 동일 판정.
 * 이 식을 페이지에 인라인으로 다시 쓰지 말 것 — 판정식이 갈라지면 grandfather·org_seat·past_due가 오차단된다.
 */
export function isExpired(sub: SubscriptionRow | null): boolean {
    return !!sub && !isAllowed(sub)
}

/** 화이트리스트(영구 무료 베이직) 여부 */
export function isWhitelist(sub: SubscriptionRow | null): boolean {
    return sub?.plan === "grandfather"
}

/** 메인/헤더에 표시할 플랜 배지. 사용 가능한 구독이 없으면 null */
export function planBadge(sub: SubscriptionRow | null): { label: string; isPro: boolean; trial: boolean } | null {
    if (!isAllowed(sub)) return null
    const isPro = isProPlanId(sub?.plan)
    const base = planLabel(sub?.plan)
    // '체험'은 아직 확정되지 않은 상태에만 표기: 카드 없는 무료체험, 또는 해지(남은 기간 소진 중).
    // 카드가 붙은 체험은 결제일에 자동 청구되는 확정 구독이므로 '체험'을 떼고 Pro/베이직으로 표기.
    const trial = sub?.status === "trialing" ? !sub?.card_info : sub?.status === "canceled"
    return { label: trial ? `${base} 체험` : base, isPro, trial }
}

/** 구독이 앱 사용을 허용하는 상태인지 */
export function isAllowed(sub: SubscriptionRow | null): boolean {
    if (!sub) return false
    // 카드 없는 무료체험(휴대폰인증 가입, card_info 없음): 기간 만료 시 결제 등록 전까지 불허
    if (
        sub.status === "trialing" &&
        !sub.card_info &&
        sub.current_period_end &&
        new Date(sub.current_period_end) <= new Date()
    ) {
        return false
    }
    // past_due(결제 재시도 중)는 서버 판정(subscriptionAllows)과 동일하게 허용 —
    // 재시도 기간에 UI만 먼저 잠기는 서버/클라 불일치 방지
    if (sub.status === "active" || sub.status === "trialing" || sub.status === "past_due") return true
    // 해지했지만 남은 기간이 있으면 그 기간까지는 허용
    if (
        sub.status === "canceled" &&
        sub.current_period_end &&
        new Date(sub.current_period_end) > new Date()
    ) {
        return true
    }
    return false
}

/**
 * 사용량 한도 창(count 기준 시작 + 리셋 표시). DB 트리거 enforce_tbm_monthly_limit와 동일 규칙:
 * - current_period_end(결제/체험 경계)가 있으면 그 날짜 앵커의 현재 이용기간 [start, reset)
 * - 없으면(영구무료 등) 달력 월(매월 1일)
 */
export function usageWindow(sub: SubscriptionRow | null): { startISO: string; resetLabel: string } {
    const cpe = sub?.current_period_end
    if (!cpe) {
        return { startISO: startOfMonth(new Date()).toISOString(), resetLabel: "매월 1일 초기화" }
    }
    const now = new Date()
    let pend = new Date(cpe)
    while (pend <= now) pend = addMonths(pend, 1) // 과거로 밀려있으면 현재 이용기간까지 굴림
    const pstart = addMonths(pend, -1)
    return { startISO: pstart.toISOString(), resetLabel: `${format(pend, "M월 d일")} 초기화` }
}

export async function fetchSubscription(): Promise<SubscriptionRow | null> {
    const { data } = await supabase
        .from("subscriptions")
        .select("status, plan, pending_plan, card_info, current_period_end, trial_end, trial_used, amount")
        .maybeSingle()
    return (data as SubscriptionRow) || null
}

// ── 짧은 캐시 — 페이지 이동/뒤로가기마다 구독을 다시 조회해 스피너가 뜨는 것 방지.
// 결제·해지 직후 화면(/account, /pricing)은 신선도가 중요하니 원본 fetchSubscription을 쓴다.
let subCache: { row: SubscriptionRow | null; ts: number } | null = null
// 마지막 통과 결과 — 같은 세션에서 페이지를 오갈 때마다 게이트 스피너를 다시 띄우지 않는다.
// (구독 캐시보다 먼저 선언해 아래 리스너에서 안전하게 참조한다)
let allowedCache: { userId: string; ts: number } | null = null
if (typeof window !== "undefined") {
    supabase.auth.onAuthStateChange((event) => {
        // 계정이 바뀌면 통과 이력도 남의 것이 된다 — 구독 캐시와 반드시 같이 버린다
        if (event === "SIGNED_OUT" || event === "SIGNED_IN" || event === "USER_UPDATED") {
            subCache = null
            allowedCache = null
        }
    })
}

export async function fetchSubscriptionCached(ttlMs = 60_000): Promise<SubscriptionRow | null> {
    if (subCache && Date.now() - subCache.ts < ttlMs) return subCache.row
    const row = await fetchSubscription()
    subCache = { row, ts: Date.now() }
    return row
}

/**
 * 보호된 페이지 상단에서 호출. 로그인했지만 구독(또는 체험/평생무료)이 없으면
 * /pricing 으로 보낸다. 로그인 안 한 경우엔 각 페이지의 기존 로직에 맡긴다.
 *
 * allowExpired(열람 등급 A 화면 — 문서 목록·열람·출력·달력·제안함·교육 진행도):
 * 만료자(구독 행은 있는데 isAllowed=false — 체험 종료·해지 만료)도 축출하지 않고 연다.
 * 대신 expired=true를 돌려주니, 화면 안의 "새로 만들기"류 CTA는 /pricing으로 돌릴 것.
 * 구독 게이트만 완화하는 것이다 — 비로그인 처리는 기존과 동일하게 각 페이지 로직에 맡긴다.
 * 구독 행 자체가 없는 계정은 만료가 아니라 미가입이므로 여전히 /start-trial로 보낸다.
 */
export function useRequireSubscription(opts?: { allowExpired?: boolean }) {
    const allowExpired = opts?.allowExpired === true
    const router = useRouter()
    // 만료자에게 열어준 경우 true — A 화면이 CTA를 결제 유도로 바꾸는 근거
    const [expired, setExpired] = useState(false)
    // 5분 내 통과 이력이 있으면 즉시 열고, 아래 effect가 백그라운드로 재검증한다
    const [checking, setChecking] = useState(() => {
        if (typeof window === "undefined") return true
        return !(allowedCache && Date.now() - allowedCache.ts < 300_000)
    })

    useEffect(() => {
        let active = true
        ;(async () => {
            const {
                data: { user },
            } = await supabase.auth.getUser()
            if (!active) return
            if (!user) {
                // 로그인 미들웨어/페이지 로직에 위임
                setChecking(false)
                return
            }
            // 초기 상태 계산 시점엔 user.id를 모른다 — 남의 통과 기록으로 낙관적으로 열렸다면
            // 여기서 되돌려야 로그아웃 직후 다른 계정이 홈을 먼저 보고 튕기는 일이 없다
            if (allowedCache && allowedCache.userId !== user.id) {
                allowedCache = null
                setChecking(true)
            }
            const { data, error } = await supabase
                .from("subscriptions")
                .select("status, plan, pending_plan, card_info, current_period_end, trial_end")
                .maybeSingle()
            if (!active) return
            // 일시적 조회 오류(네트워크/RLS)면 잠그지 않음 — 결제 고객 오잠금 방지
            if (error) {
                setChecking(false)
                return
            }
            if (!isAllowed(data as SubscriptionRow)) {
                allowedCache = null
                // 만료자(행 있음)에게 열람을 허용하는 화면 — 축출 대신 expired만 표시하고 연다.
                // allowedCache는 굽지 않는다: 이 통과는 '구독 통과'가 아니라서, B 화면(분석 등)이
                // 5분 낙관 오픈으로 만료자에게 먼저 열리는 일이 없어야 한다.
                if (allowExpired && isExpired(data as SubscriptionRow)) {
                    setExpired(true)
                    setChecking(false)
                    return
                }
                // 구독 행 자체가 없는 계정(카카오 OAuth·구 무인증 가입)은 요금제가 아니라
                // 무료체험 온보딩으로 — "가입 = 첫 달 무료" 약속을 전 가입 경로에서 지킨다.
                // 행이 있는데 막힌 것(체험 만료·해지)만 결제 유도(/pricing).
                router.replace(data ? "/pricing" : "/start-trial")
                return
            }
            setExpired(false)
            allowedCache = { userId: user.id, ts: Date.now() }
            setChecking(false)
        })()
        return () => {
            active = false
        }
    }, [router, allowExpired])

    return { checking, expired }
}
