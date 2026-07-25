"use client"

// 클라이언트 역할 판정 훅 — /api/org/context를 세션당 1회 캐시.
// 홈 스왑(owner), 헤더 메뉴 분기(member), attach 수락 모달이 소비한다.
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"

export interface ClientOrgContext {
    kind: "owner" | "member" | "solo"
    org?: { id: string; name: string; seatCount: number; pendingSeatCount: number | null }
    orgLapsed?: boolean
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

/** 작성계 화면(일지·회의록·교육진행도·제안함) 상단에서 호출 — 안전관리자(관리 전용)는 홈으로 (§4-B) */
export function useBlockOwner() {
    const router = useRouter()
    useEffect(() => {
        let active = true
        fetchOrgContext().then((c) => {
            if (active && c?.kind === "owner") router.replace("/")
        })
        return () => {
            active = false
        }
    }, [router])
}

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
