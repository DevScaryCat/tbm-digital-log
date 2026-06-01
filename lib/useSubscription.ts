"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"

export interface SubscriptionRow {
    status: string
    plan?: string | null
    card_info?: { issuer?: string | null; last4?: string | null; provider?: string | null } | null
    current_period_end?: string | null
    trial_end?: string | null
}

/** 구독이 앱 사용을 허용하는 상태인지 */
export function isAllowed(sub: SubscriptionRow | null): boolean {
    if (!sub) return false
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

export async function fetchSubscription(): Promise<SubscriptionRow | null> {
    const { data } = await supabase
        .from("subscriptions")
        .select("status, plan, card_info, current_period_end, trial_end")
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
            const sub = await fetchSubscription()
            if (!active) return
            if (!isAllowed(sub)) {
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
