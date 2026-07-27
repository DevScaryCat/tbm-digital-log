"use client"

/* Hallmark · component: panel (홈 활동 현황) · genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * states: loading · self(개인 4타일·클릭) · all(전체 합산 3타일) · site(현장 3타일 → 상세) · error(재시도)
 * tokens only — hairline depth, card radius 12px
 */

// 홈 활동 현황 — 대시보드 카드(활동 기록·7일 차트·위험요인·주의 현장)는 뺐다 (Chris: "없으면 밋밋해도 없애").
// 감독자에게는 셀렉트 하나(디폴트 전체)만 남고, 선택이 아래 그리드를 지배한다.
// 숫자는 전 선택에서 '전체 기간' 기준 — 선택을 바꿔도 기간 의미가 같아야 비교된다.
// 내 현장 선택 = 기존 개인 그리드(클릭 이동·달력·안읽음 배지), 다른 현장 = 그 현장 건수 + 상세 진입.

import { useCallback, useEffect, useState, type KeyboardEvent } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, ChevronRight, CalendarDays } from "lucide-react"
import { SiteDetailPanel } from "@/components/SiteDetailPanel"

interface SiteRow {
    userId: string
    siteName: string
    status: "active" | "detached"
    isSelf: boolean
    totalMinutes: number
    totalLogs: number
    suggestions: number
}

interface Overview {
    kind: "owner" | "member" | "solo"
    sites: SiteRow[]
}

// 홈 복귀 때마다 풀 로딩이 돌지 않도록 마지막 응답을 모듈에 캐시(SWR)
let overviewCache: { userId: string; data: Overview } | null = null
// 계정 전환 시 이전 계정의 현장 이름·건수가 한 프레임이라도 비치지 않게 캐시 무효화
if (typeof window !== "undefined") {
    supabase.auth.onAuthStateChange((event) => {
        if (event === "SIGNED_OUT" || event === "SIGNED_IN") overviewCache = null
    })
}

interface Props {
    isOwner: boolean
    statsLoading: boolean
    myMinutes: number
    myLogs: number
    mySuggestions: number
    myUnread: number
    /** 다른 현장을 보는 중인지 — 홈의 개인 섹션(교육 진행도·작성 카드)을 숨기는 신호 */
    onViewingOtherSite?: (viewing: boolean) => void
}

export function HomeActivity({ isOwner, statsLoading, myMinutes, myLogs, mySuggestions, myUnread, onViewingOtherSite }: Props) {
    const router = useRouter()
    const [data, setData] = useState<Overview | null>(overviewCache?.data ?? null)
    const [loading, setLoading] = useState(isOwner && !overviewCache)
    const [failed, setFailed] = useState(false)
    // "all" 또는 현장 userId — 디폴트는 전체
    const [sel, setSel] = useState<string>("all")

    const load = useCallback(async () => {
        try {
            setFailed(false)
            const { data: s } = await supabase.auth.getSession()
            const uid = s?.session?.user?.id
            if (!uid) { setFailed(true); return } // 세션 부재 — 0건짜리 가짜 전체 그리드 방지
            if (overviewCache && overviewCache.userId !== uid) {
                overviewCache = null
                setData(null)
                setLoading(true)
            }
            const res = await fetch("/api/org/overview", { headers: { Authorization: `Bearer ${s?.session?.access_token}` } })
            if (!res.ok) { setFailed(true); return }
            const j = (await res.json()) as Overview
            setData(j)
            overviewCache = { userId: uid, data: j }
        } catch {
            setFailed(true)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        if (isOwner) load()
    }, [isOwner, load])

    // 선택해 둔 현장이 새 데이터에서 사라지면(해제 등) 셀렉트가 빈 값을 보이지 않게 전체로 복귀
    useEffect(() => {
        if (sel !== "all" && data && !data.sites.some((s) => s.status === "active" && s.userId === sel)) setSel("all")
    }, [data, sel])

    // 카드 키보드 접근성: Enter/Space가 onClick과 동일하게 동작
    const cardKeyDown = (go: () => void) => (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go() }
    }

    const activeSites = (data?.sites ?? []).filter((s) => s.status === "active")
    const selected = sel === "all" ? null : activeSites.find((s) => s.userId === sel) ?? null
    // 조회 실패로 현장 데이터가 없으면 개인 그리드로 강등 — 0건짜리 가짜 전체 그리드를 보여주지 않는다
    const degraded = isOwner && failed && !data
    // 선택 현장이 사라졌으면(해제) 전체로 폴백
    const view: "self" | "all" | "site" = !isOwner || degraded || selected?.isSelf ? "self" : selected ? "site" : "all"

    // 다른 현장을 보는 중이면 홈의 개인 섹션을 숨기라고 알린다 (내 회의록 작성 버튼 등)
    useEffect(() => {
        onViewingOtherSite?.(view === "site")
    }, [view, onViewingOtherSite])

    // 개인 그리드 (본인 전체 기간·클릭 이동·달력·안읽음 배지) — 비감독자와 '내 현장' 선택이 공유
    const selfGrid = (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-cur-hairline border border-cur-hairline rounded-[12px] overflow-hidden text-center">
            <div onClick={() => router.push('/analytics')} role="button" tabIndex={0} aria-label="TBM 회의록 목록 보기" onKeyDown={cardKeyDown(() => router.push('/analytics'))} className="relative py-6 px-2 cursor-pointer bg-cur-card hover:bg-cur-elevated active:bg-cur-elevated transition-colors">
                <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft absolute bottom-2 right-2" />
                <div className="text-[12px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1.5">TBM 회의록</div>
                <div className="text-[32px] leading-none font-bold text-cur-ink font-mono">
                    {statsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-cur-muted" /> : myMinutes}
                </div>
            </div>
            <div onClick={() => router.push('/analytics/education')} role="button" tabIndex={0} aria-label="안전보건교육일지 목록 보기" onKeyDown={cardKeyDown(() => router.push('/analytics/education'))} className="relative py-6 px-2 cursor-pointer bg-cur-card hover:bg-cur-elevated active:bg-cur-elevated transition-colors">
                <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft absolute bottom-2 right-2" />
                <div className="text-[12px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1.5">안전보건교육일지</div>
                <div className="text-[32px] leading-none font-bold text-cur-ink font-mono">
                    {statsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-cur-muted" /> : myLogs}
                </div>
            </div>
            <div onClick={() => router.push('/suggestions')} role="button" tabIndex={0} aria-label="근로자 제안함 보기" onKeyDown={cardKeyDown(() => router.push('/suggestions'))} className="relative py-6 px-2 cursor-pointer bg-cur-card hover:bg-cur-elevated active:bg-cur-elevated transition-colors">
                {!statsLoading && myUnread > 0 && (
                    <span className="absolute top-2 right-2 bg-cur-primary text-cur-on-primary text-[10px] font-bold px-1.5 py-0.5 rounded-full">{myUnread}</span>
                )}
                <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft absolute bottom-2 right-2" />
                <div className="text-[12px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1.5">근로자 제안함</div>
                <div className="text-[32px] leading-none font-bold text-cur-ink font-mono">
                    {statsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-cur-muted" /> : mySuggestions}
                </div>
            </div>
            <div onClick={() => router.push('/dashboard')} role="button" tabIndex={0} aria-label="안전문서 달력 보기" onKeyDown={cardKeyDown(() => router.push('/dashboard'))} className="relative py-6 px-2 cursor-pointer bg-cur-card hover:bg-cur-elevated active:bg-cur-elevated transition-colors flex flex-col items-center justify-center">
                <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft absolute bottom-2 right-2" />
                <div className="text-[12px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1.5">안전문서 달력</div>
                <div className="bg-cur-elevated w-10 h-10 rounded-[8px] flex items-center justify-center text-cur-ink mx-auto">
                    <CalendarDays className="w-5 h-5" />
                </div>
            </div>
        </div>
    )

    // 전체/특정 현장 누적 그리드 — 3타일(표시 전용).
    // 현장 선택 시엔 아래 SiteDetailPanel이 진입 동선을 맡으므로 타일은 링크가 아니다.
    const orgGrid = (minutes: number, logs: number, suggestions: number) => {
        const tile = (label: string, value: number) => (
            <div className="relative py-6 px-2 bg-cur-card text-center">
                <div className="text-[12px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1.5">{label}</div>
                <div className="text-[32px] leading-none font-bold text-cur-ink font-mono">
                    {loading ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-cur-muted" /> : value}
                </div>
            </div>
        )
        return (
            <div className="grid grid-cols-3 gap-px bg-cur-hairline border border-cur-hairline rounded-[12px] overflow-hidden">
                {tile("TBM 회의록", minutes)}
                {tile("안전보건교육일지", logs)}
                {tile("근로자 제안함", suggestions)}
            </div>
        )
    }

    const allMinutes = activeSites.reduce((a, x) => a + x.totalMinutes, 0)
    const allLogs = activeSites.reduce((a, x) => a + x.totalLogs, 0)
    const allSuggestions = activeSites.reduce((a, x) => a + x.suggestions, 0)

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 px-1">
                <h3 className="text-[15px] font-semibold text-cur-ink tracking-[-0.11px]">활동 현황</h3>
                {isOwner && !degraded && (
                    <Select value={sel} onValueChange={setSel}>
                        <SelectTrigger className="w-auto min-w-[112px] h-9 text-[13px] font-semibold border-cur-hairline rounded-[8px] bg-cur-card text-cur-ink">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                            <SelectItem value="all">전체</SelectItem>
                            {activeSites.map((s) => (
                                <SelectItem key={s.userId} value={s.userId}>
                                    {s.siteName}{s.isSelf ? " (내 현장)" : ""}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
            </div>

            {isOwner && failed && (
                <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-[12px] border border-cur-hairline bg-cur-card">
                    <p className="text-[13px] text-cur-muted">현장 현황을 불러오지 못했어요.</p>
                    <button
                        type="button"
                        onClick={() => { setLoading(true); load() }}
                        className="shrink-0 h-8 px-3 rounded-[8px] border border-cur-hairline bg-cur-elevated text-[12px] font-semibold text-cur-ink hover:border-cur-primary/40 transition-colors"
                    >
                        다시 시도
                    </button>
                </div>
            )}

            {view === "self"
                ? selfGrid
                : view === "site"
                  ? orgGrid(selected!.totalMinutes, selected!.totalLogs, selected!.suggestions)
                  : orgGrid(allMinutes, allLogs, allSuggestions)}

            {/* 현장 선택 시 그 현장 대시보드 — 홈의 개인용 작성 카드 자리를 대신한다 */}
            {view === "site" && (
                <div className="pt-3">
                    <SiteDetailPanel userId={selected!.userId} siteName={selected!.siteName} />
                </div>
            )}
        </div>
    )
}
