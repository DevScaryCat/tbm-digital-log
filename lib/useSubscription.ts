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
}

/** 현재 구독이 Pro 기능을 쓸 수 있는 상태인지 (grandfather는 영구 무료 베이직이라 Pro 아님) */
export function isProActive(sub: SubscriptionRow | null): boolean {
    return isAllowed(sub) && sub?.plan === "monthly_pro"
}

/** 화이트리스트(영구 무료 베이직) 여부 */
export function isWhitelist(sub: SubscriptionRow | null): boolean {
    return sub?.plan === "grandfather"
}

/** 메인/헤더에 표시할 플랜 배지. 사용 가능한 구독이 없으면 null */
export function planBadge(sub: SubscriptionRow | null): { label: string; isPro: boolean; trial: boolean } | null {
    if (!isAllowed(sub)) return null
    const isPro = sub?.plan === "monthly_pro"
    const base = isPro ? "Pro" : "베이직"
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
    if (sub.status === "active" || sub.status === "trialing") return true
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
        .select("status, plan, pending_plan, card_info, current_period_end, trial_end, trial_used")
        .maybeSingle()
    return (data as SubscriptionRow) || null
}

/**
 * 보호된 페이지 상단에서 호출. 로그인했지만 구독(또는 체험/평생무료)이 없으면
 * /pricing 으로 보낸다. 로그인 안 한 경우엔 각 페이지의 기존 로직에 맡긴다.
 */
export function useRequireSubscription() {
    const router = useRouter()
    const [checking, setChecking] = useState(true)

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
                router.replace("/pricing")
                return
            }
            setChecking(false)
        })()
        return () => {
            active = false
        }
    }, [router])

    return { checking }
}
