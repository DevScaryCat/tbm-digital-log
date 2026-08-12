"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { fetchOrgContext } from "@/lib/useOrgContext"
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

/** Pro 상당 플랜 여부 — 조직 플랜(org=안전관리자, org_seat=하위 현장) 포함.
 *
 * 2026-08-10 Chris 결정: grandfather(영구 무료)는 "결제 시스템만 빠진 유료 계정"이다 → 여기 포함.
 * 서버 lib/portone.ts isProPlan()과 반드시 같은 집합이어야 한다. 빠져 있으면 화면(AI 분석·
 * 월간 보고서 설정·통계)이 잠긴 채로 남아, DB 한도만 20회로 열려 있고 정작 들어갈 문이 없다.
 * ⚠️ "돈을 받을 수 있는 구독인가"는 이 판정이 아니다 — 좌석·조직 게이트는 서버 isBillablePlan. */
function isProPlanId(plan?: string | null): boolean {
    return plan === "monthly_pro" || plan === "org" || plan === "org_seat" || plan === "grandfather"
}

/** 화면에 띄울 플랜 이름 — 단일 요금제라 티어 이름이 없다 */
function planLabel(plan?: string | null): string {
    if (plan === "grandfather") return "무료"
    if (plan === "monthly_basic") return "베이직"
    if (plan === "org_seat") return "소속 현장"
    return "안톡"
}

/** 현재 구독이 Pro 기능을 쓸 수 있는 상태인지 (grandfather 포함 — 위 isProPlanId 주석 참조) */
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

/** 영구 무료(grandfather) 여부 — 기능은 유료와 같고 결제 UI만 없는 계정 */
export function isWhitelist(sub: SubscriptionRow | null): boolean {
    return sub?.plan === "grandfather"
}

// 월 한도 — DB 트리거 enforce_tbm_monthly_limit와 반드시 같은 집합/같은 숫자여야 한다.
// 유료 단일 티어(monthly_pro·org_seat·구 org·grandfather) = 200/30/20, legacy(구 베이직) = 80/10/0.
// (TBMHeader의 사용량 바에서 옮겨왔다 — 결제 화면의 영구무료 고지도 같은 표를 읽어야
//  숫자가 갈라지지 않는다. 앱 src/lib/subscription.ts의 LIMITS와도 동일.)
//
// 2026-08-10 Chris 결정: grandfather(영구 무료)는 "결제만 없는 유료 계정"이다 → PAID로 옮겼다.
// 종전 LEGACY(80/10/0)에서는 AI 분석이 0회라 실고객 8계정이 핵심 기능을 못 썼다.
// ⚠️ 세 곳(DB 트리거·이 표·앱 LIMITS)이 어긋나면 화면은 여유인데 저장이 거부된다.
const PAID = { log: 200, minutes: 30, ra: 20 }
const LEGACY = { log: 80, minutes: 10, ra: 0 }
const LIMITS: Record<string, { log: number; minutes: number; ra: number }> = {
    monthly_pro: PAID,
    org_seat: PAID,
    org: PAID,
    grandfather: PAID,
    monthly_basic: LEGACY,
}

export function limitFor(plan: string | null, kind: "log" | "minutes" | "ra"): number {
    return (LIMITS[plan ?? "monthly_pro"] ?? PAID)[kind]
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
 *
 * ⚠️ **유예 중인 소속 계정은 /pricing으로 보내지 않는다**(Chris 규정 2: 회사가 낼 수도 있는
 * 동안 개인에게 카드를 들이밀지 않는다). 홈의 작성 카드만 유예 안내로 바꿔놓고 이 훅은
 * 그대로 두면, 헤더 메뉴에서 '출력/발송 설정'을 누르는 것만으로 개인 결제 화면에 떨어졌다
 * (/analytics·/report-settings·/tbm-minutes·/safety-log 전부 같은 목적지였다 — 2026-08-13 검수).
 * 좌석만 잠긴 멤버(seatLocked)도 마찬가지다: 그는 애초에 결제 주체가 아니라 /pricing에서
 * 할 수 있는 일이 없다. 둘 다 홈으로 보내 OrgLapseNotice가 사실을 말하게 한다.
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
                // 개인 결제 문을 열기 전에 "이 사람이 결제 주체인가"를 먼저 본다.
                // 판정은 서버가 이미 내렸다(GET /api/org/context) — 여기서 다시 계산하지 않는다.
                const octx = await fetchOrgContext().catch(() => null)
                if (!active) return
                // ⚠️ phase를 보지 않는다(2026-08-11 정정). 종전에는 'grace'일 때만 되돌려서
                //    유예 7일이 지난 멤버는 이 훅을 통과해 /pricing에 떨어졌다 — 그 문은 폐지됐다.
                //    소속 멤버는 유예 전/중/후 어느 시점에도 결제 주체가 아니다.
                if (octx?.orgLapse || octx?.seatLocked) {
                    router.replace("/")
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
