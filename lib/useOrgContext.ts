"use client"

// 클라이언트 역할 판정 훅 — /api/org/context를 세션당 1회 캐시.
// 홈 스왑(owner), 헤더 메뉴 분기(member), attach 수락 모달이 소비한다.
import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabaseClient"

/** 서버 lib/org.ts OrgLapseInfo와 1:1. **판정·계산은 전부 서버가 한다** — 여기서 날짜를 다시 세지 말 것. */
export interface ClientOrgLapse {
    orgId: string
    orgName: string
    ownerUserId: string
    lapsedAt: string | null
    graceEndsAt: string | null
    /**
     * 'grace' = 감독자가 결제를 되살릴 수 있는 기간 / 'ended' = 그 기간이 지났다.
     * ⚠️ **둘의 차이는 문구뿐이다.** 개인 결제 전환은 어느 쪽에서도 없다(Chris 2026-08-11 2차 정정).
     * 이 값으로 결제 CTA를 열지 말 것 — 유일한 출구는 '감독자에게 알리기'다(lib/orgGrace.ts 상단).
     */
    phase: "grace" | "ended"
    daysLeft: number | null
    lastPingAt: string | null
    canPingNow: boolean
}

export interface ClientOrgContext {
    kind: "owner" | "member" | "solo"
    org?: { id: string; name: string; seatCount: number; pendingSeatCount: number | null }
    /** owner일 때: 활성 소속 현장 user id — 청구 계정 수(본인 1 + 이 수) 계산에 쓴다 */
    memberIds?: string[]
    orgLapsed?: boolean
    /** orgLapsed=true일 때만. "유예 중 / 유예 후"는 두 번째 불리언이 아니라 phase가 가른다. */
    orgLapse?: ClientOrgLapse
    /** kind==='member'인데 본인 좌석만 죽어 있다 — 회사 구독은 유효하므로 '회사 결제 종료'는 거짓 */
    seatLocked?: boolean
    /** kind==='member'일 때의 좌석 회계 상태. self_store면 본인이 직접 결제 중이다. */
    seatState?: "seat" | "self_store" | "grandfather" | null
    pendingAttach?: { inviteId: string; token: string; orgId: string; orgName: string } | null
}

let cache: ClientOrgContext | null = null
let cacheUserId: string | null = null
let inflight: Promise<ClientOrgContext | null> | null = null

// 로그아웃·계정 전환 시 이전 계정의 역할이 남지 않도록 캐시·진행 중 요청 무효화
if (typeof window !== "undefined") {
    supabase.auth.onAuthStateChange((event) => {
        if (event === "SIGNED_OUT" || event === "SIGNED_IN" || event === "USER_UPDATED") {
            cache = null
            cacheUserId = null
            inflight = null
        }
    })
}

export async function fetchOrgContext(force = false): Promise<ClientOrgContext | null> {
    // 캐시는 요청 시점의 user id에 귀속 — 계정 전환 레이스에서 이전 계정 역할 오염 방지
    const { data: sess } = await supabase.auth.getSession()
    const userId = sess?.session?.user?.id ?? null
    const token = sess?.session?.access_token
    if (!userId || !token) return null
    if (cache && cacheUserId === userId && !force) return cache
    if (inflight && !force) return inflight
    const req = (async () => {
        try {
            const res = await fetch("/api/org/context", { headers: { Authorization: `Bearer ${token}` } })
            if (!res.ok) return null
            const ctx = (await res.json()) as ClientOrgContext
            // 응답 도착 시점에도 같은 계정일 때만 캐시에 기록
            const { data: nowSess } = await supabase.auth.getSession()
            if (nowSess?.session?.user?.id === userId) {
                cache = ctx
                cacheUserId = userId
            }
            return ctx
        } catch {
            // 네트워크 단절 시 fetch가 reject — 여기서 삼키지 않으면 useOrgContext 훅의
            // setLoading(false)가 영영 안 불려 소비 화면(프로필 등)이 잠긴 채 멈춘다
            return null
        }
    })()
    inflight = req
    try {
        return await req
    } finally {
        if (inflight === req) inflight = null
    }
}

export function clearOrgContextCache() {
    cache = null
    cacheUserId = null
    inflight = null
}

// useBlockOwner는 제거됨 — 단일 역할 통합으로 감독자도 TBM·일지·교육·제안함을 쓴다.
// (구조상 남겨두면 회사를 만든 순간 본인 작성 화면이 잠기는 버그가 된다)

export function useOrgContext(): { ctx: ClientOrgContext | null; loading: boolean } {
    const [ctx, setCtx] = useState<ClientOrgContext | null>(cache)
    const [loading, setLoading] = useState(!cache)
    useEffect(() => {
        let active = true
        fetchOrgContext().then((c) => {
            if (!active) return
            setCtx(c)
            setLoading(false)
        })
        return () => {
            active = false
        }
    }, [])
    return { ctx, loading }
}
