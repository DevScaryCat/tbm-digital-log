"use client"

/* Hallmark · component: page (현장 통계) · genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * states: loading · all(활동 기록+누적+현장별 현황+위험요인+주의 현장) · site(현장 대시보드) · error(재시도)
 * tokens only — hairline depth, card radius 12px
 */

// 현장 통계 (감독자 전용) — 홈의 '모든 현장 통계 보기' 버튼으로 진입하는 전용 대시보드.
// 홈에는 토글을 두지 않는다(Chris): 홈은 개인 화면, 관제·통계는 전부 여기서.
// 셀렉트에 '내 현장'은 없다 — 본인 기록은 홈이 이미 보여주므로, 여기 목록은 소속 현장만.
// '전체' 합산에는 감독자 본인 현장도 포함한다(월간 보고서·청구 계정 수와 같은 기준).
// 횅함 방지는 장식이 아니라 내용으로: 현장별 현황 로스터가 이 페이지의 본론이다.
import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { SiteDetailPanel } from "@/components/SiteDetailPanel"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useOrgContext } from "@/lib/useOrgContext"
import { Loader2, CheckCircle2, CircleDashed, ChevronRight, Building2 } from "lucide-react"

interface SiteRow {
    userId: string
    siteName: string
    status: "active" | "detached"
    isSelf: boolean
    todayDone: boolean
    monthMinutes: number
    monthLogs: number
    lastActivity: string | null
    totalMinutes: number
    totalLogs: number
    suggestions: number
}

interface Overview {
    kind: "owner" | "member" | "solo"
    todayDoneCount: number
    today: string
    sites: SiteRow[]
    daily?: { date: string; minutes: number; logs: number }[]
    risk?: { levels: { high: number; mid: number; low: number }; keywords: { word: string; count: number }[] }
}

export default function OrgStatsPage() {
    const router = useRouter()
    const { ctx, loading: ctxLoading } = useOrgContext()
    const [data, setData] = useState<Overview | null>(null)
    const [loading, setLoading] = useState(true)
    const [failed, setFailed] = useState(false)
    // "all" 또는 소속 현장 userId — 내 현장은 목록에 없다
    const [sel, setSel] = useState<string>("all")

    const load = useCallback(async () => {
        setFailed(false)
        try {
            const { data: s } = await supabase.auth.getSession()
            const res = await fetch("/api/org/overview", { headers: { Authorization: `Bearer ${s?.session?.access_token}` } })
            if (!res.ok) { setFailed(true); return }
            setData((await res.json()) as Overview)
        } catch {
            setFailed(true)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        if (ctxLoading) return
        if (!ctx || ctx.kind !== "owner") { router.replace("/"); return }
        load()
    }, [ctx, ctxLoading, router, load])

    const activeSites = (data?.sites ?? []).filter((s) => s.status === "active")
    const memberSites = activeSites.filter((s) => !s.isSelf)
    const selected = sel === "all" ? null : memberSites.find((s) => s.userId === sel) ?? null

    // 선택 현장이 해제 등으로 사라지면 전체로 복귀 (셀렉트 빈 값 방지)
    useEffect(() => {
        if (sel !== "all" && data && !memberSites.some((s) => s.userId === sel)) setSel("all")
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data, sel])

    const dow = ["일", "월", "화", "수", "목", "금", "토"]
    const daily = data?.daily ?? []
    const hasWeekData = daily.some((d) => d.minutes + d.logs > 0)
    const maxDay = Math.max(1, ...daily.map((d) => d.minutes + d.logs))
    const mMinutes = activeSites.reduce((a, x) => a + x.monthMinutes, 0)
    const mLogs = activeSites.reduce((a, x) => a + x.monthLogs, 0)
    const tMinutes = activeSites.reduce((a, x) => a + x.totalMinutes, 0)
    const tLogs = activeSites.reduce((a, x) => a + x.totalLogs, 0)
    const tSuggestions = activeSites.reduce((a, x) => a + x.suggestions, 0)

    return (
        <div className="min-h-screen bg-cur-canvas font-sans">
            <div className="max-w-lg mx-auto px-4 pt-4">
                <TBMHeader title="현장 통계" backHref="/" />
            </div>
            <main className="max-w-lg mx-auto px-5 py-6 space-y-4 pb-16">
                {loading || ctxLoading ? (
                    <div className="py-24 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-cur-muted" /></div>
                ) : failed || !data ? (
                    <div className="bg-cur-card rounded-[12px] border border-cur-hairline px-4 py-3.5 flex items-center justify-between gap-3">
                        <p className="text-[13px] text-cur-muted">통계를 불러오지 못했어요.</p>
                        <button
                            type="button"
                            onClick={() => { setLoading(true); load() }}
                            className="shrink-0 h-8 px-3 rounded-[8px] border border-cur-hairline bg-cur-elevated text-[12px] font-semibold text-cur-ink hover:border-cur-primary/40 transition-colors"
                        >
                            다시 시도
                        </button>
                    </div>
                ) : (
                    <>
                        {/* 현장 선택 — 이 페이지의 조종간이라 크고 분명하게 */}
                        <Select value={sel} onValueChange={setSel}>
                            <SelectTrigger className="w-full h-12 text-[15px] font-bold border-cur-hairline rounded-[12px] bg-cur-card text-cur-ink shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                                <span className="flex items-center gap-2.5 min-w-0">
                                    <span className="w-7 h-7 rounded-[8px] bg-cur-primary/10 text-cur-primary flex items-center justify-center shrink-0">
                                        <Building2 className="w-4 h-4" />
                                    </span>
                                    <SelectValue />
                                </span>
                            </SelectTrigger>
                            <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                                <SelectItem value="all" className="text-[15px] py-2.5">모든 현장</SelectItem>
                                {memberSites.map((s) => (
                                    <SelectItem key={s.userId} value={s.userId} className="text-[15px] py-2.5">{s.siteName}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>

                        {selected ? (
                            <SiteDetailPanel userId={selected.userId} siteName={selected.siteName} />
                        ) : (
                            <>
                                {/* 활동 기록 — 이번 달 3타일 + 7일 차트 + 누적 한 줄 (카드 하나로 응집) */}
                                <section className="bg-cur-card rounded-[12px] border border-cur-hairline p-5 space-y-4">
                                    <div className="flex items-center justify-between">
                                        <h2 className="text-[14px] font-bold text-cur-ink">활동 기록</h2>
                                        <span className="text-[12px] text-cur-muted-soft">이번 달 · 차트는 최근 7일</span>
                                    </div>
                                    <div className="grid grid-cols-3 gap-px bg-cur-hairline border border-cur-hairline rounded-[12px] overflow-hidden text-center">
                                        <div className="bg-cur-card py-3.5">
                                            <p className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1">오늘 실시</p>
                                            <p className="text-[24px] leading-none font-bold font-mono">
                                                <span className={data.todayDoneCount > 0 ? "text-cur-success" : "text-cur-primary"}>{data.todayDoneCount}</span>
                                                <span className="text-[15px] text-cur-muted">/{activeSites.length}</span>
                                            </p>
                                        </div>
                                        <div className="bg-cur-card py-3.5">
                                            <p className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1">TBM 회의록</p>
                                            <p className="text-[24px] leading-none font-bold text-cur-ink font-mono">{mMinutes}</p>
                                        </div>
                                        <div className="bg-cur-card py-3.5">
                                            <p className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1">교육일지</p>
                                            <p className="text-[24px] leading-none font-bold text-cur-ink font-mono">{mLogs}</p>
                                        </div>
                                    </div>
                                    {hasWeekData ? (
                                        <div className="flex items-end justify-between gap-1.5 h-20 pt-1" aria-label="최근 7일 기록 수">
                                            {daily.map((d) => {
                                                const v = d.minutes + d.logs
                                                const [dy, dm, dd] = d.date.split("-").map(Number)
                                                const kstDow = new Date(dy, dm - 1, dd).getDay()
                                                const isToday = d.date === data.today
                                                return (
                                                    <div key={d.date} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                                                        <span className={`text-[10px] leading-none font-mono ${v > 0 ? "text-cur-body font-semibold" : "text-cur-muted-soft"}`}>{v > 0 ? v : ""}</span>
                                                        <div className="w-full h-12 flex items-end">
                                                            <div
                                                                className={`w-full rounded-t-[4px] ${v > 0 ? "bg-cur-primary" : "bg-cur-elevated"}`}
                                                                style={{ height: v > 0 ? `${Math.max(14, Math.round((v / maxDay) * 100))}%` : "4px" }}
                                                            />
                                                        </div>
                                                        <span className={`text-[10px] leading-none ${isToday ? "font-bold text-cur-ink" : "text-cur-muted-soft"}`}>{isToday ? "오늘" : dow[kstDow]}</span>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    ) : (
                                        /* 빈 차트 영역을 그대로 두면 화면이 횅해진다 — 자리 대신 상태를 말한다 */
                                        <p className="text-[12px] text-cur-muted-soft text-center rounded-[8px] border border-dashed border-cur-hairline-strong py-4">
                                            최근 7일 기록이 없어요 — 기록이 쌓이면 요일별 차트가 채워집니다
                                        </p>
                                    )}
                                    <div className="pt-3 border-t border-cur-hairline flex items-center justify-between gap-3 text-[12px]">
                                        <span className="text-cur-muted font-semibold shrink-0">누적 · 전체 기간</span>
                                        <span className="text-cur-body text-right">
                                            회의록 <b className="text-cur-ink font-mono">{tMinutes}</b> · 일지 <b className="text-cur-ink font-mono">{tLogs}</b> · 제안 <b className="text-cur-ink font-mono">{tSuggestions}</b>
                                        </span>
                                    </div>
                                </section>

                                {/* 확인이 필요한 현장 — 3일 이상 기록 없음 (현장 2곳 이상일 때만 의미) */}
                                {activeSites.length > 1 && (() => {
                                    const dayDiff = (d: string | null) => {
                                        if (!d) return Infinity
                                        return Math.round((new Date(`${data.today}T00:00:00`).getTime() - new Date(`${d}T00:00:00`).getTime()) / 864e5)
                                    }
                                    const attention = activeSites
                                        .map((x) => ({ ...x, gap: dayDiff(x.lastActivity) }))
                                        .filter((x) => x.gap >= 3)
                                        .sort((a, b) => b.gap - a.gap)
                                    if (attention.length === 0) {
                                        return (
                                            <div className="flex items-center gap-2.5 px-4 py-3 rounded-[12px] bg-cur-success/5 border border-cur-success/20">
                                                <CheckCircle2 className="w-4 h-4 shrink-0 text-cur-success" />
                                                <p className="text-[13px] text-cur-body">모든 현장이 최근 3일 안에 기록했어요.</p>
                                            </div>
                                        )
                                    }
                                    return (
                                        <section className="bg-cur-card rounded-[12px] border border-cur-error/25 overflow-hidden">
                                            <p className="px-4 pt-3.5 pb-1 text-[14px] font-bold text-cur-ink">확인이 필요한 현장 <span className="text-cur-error">{attention.length}</span></p>
                                            <div className="divide-y divide-cur-hairline">
                                                {attention.slice(0, 3).map((x) => (
                                                    <button
                                                        key={x.userId}
                                                        disabled={x.isSelf}
                                                        onClick={() => setSel(x.userId)}
                                                        className="w-full flex items-center gap-3 px-4 py-3 text-left enabled:hover:bg-cur-elevated/50 transition-colors disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-inset"
                                                    >
                                                        <span className="flex-1 min-w-0 text-[14px] font-semibold text-cur-ink truncate">
                                                            {x.siteName}{x.isSelf && <span className="text-[11px] text-cur-muted font-medium ml-1">내 현장</span>}
                                                        </span>
                                                        <span className="shrink-0 text-[12px] font-semibold text-cur-error">
                                                            {/* lastActivity는 이번 달 범위 집계라 '기록 없음'이라고 단정하면 지난달 말 기록자를 억울하게 만든다 */}
                                                            {x.gap === Infinity ? "이번 달 기록 없음" : `${x.gap}일째 기록 없음`}
                                                        </span>
                                                    </button>
                                                ))}
                                            </div>
                                        </section>
                                    )
                                })()}

                                {/* 현장별 현황 — 이 페이지의 본론. 행을 누르면 그 현장 대시보드로 */}
                                <section className="bg-cur-card rounded-[12px] border border-cur-hairline overflow-hidden">
                                    <div className="px-5 pt-4 pb-2 flex items-center justify-between">
                                        <h2 className="text-[14px] font-bold text-cur-ink">현장별 현황</h2>
                                        <span className="text-[12px] text-cur-muted-soft">현장 {activeSites.length}곳</span>
                                    </div>
                                    <div className="divide-y divide-cur-hairline">
                                        {activeSites.map((s) => (
                                            <button
                                                key={s.userId}
                                                disabled={s.isSelf}
                                                onClick={() => setSel(s.userId)}
                                                className="w-full flex items-center gap-3 px-5 py-3.5 text-left enabled:hover:bg-cur-elevated/50 enabled:active:bg-cur-elevated transition-colors disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-inset"
                                            >
                                                {s.todayDone ? (
                                                    <span className="w-9 h-9 rounded-full bg-cur-success/10 text-cur-success flex items-center justify-center shrink-0">
                                                        <CheckCircle2 className="w-5 h-5" />
                                                    </span>
                                                ) : (
                                                    <span className="w-9 h-9 rounded-full bg-cur-elevated text-cur-muted-soft flex items-center justify-center shrink-0">
                                                        <CircleDashed className="w-5 h-5" />
                                                    </span>
                                                )}
                                                <span className="flex-1 min-w-0">
                                                    <span className="flex items-center gap-1.5">
                                                        <span className="text-[14px] font-semibold text-cur-ink truncate">{s.siteName}</span>
                                                        {s.isSelf && (
                                                            <span className="shrink-0 text-[10px] font-bold text-cur-primary bg-cur-primary/10 px-1.5 py-0.5 rounded-[4px]">내 현장</span>
                                                        )}
                                                    </span>
                                                    <span className="block text-[12px] text-cur-muted mt-0.5">
                                                        {s.todayDone ? "오늘 실시 완료" : "오늘 미실시"} · 이번 달 회의록 {s.monthMinutes} · 일지 {s.monthLogs}
                                                    </span>
                                                </span>
                                                {!s.isSelf && <ChevronRight className="w-4 h-4 text-cur-muted-soft shrink-0" />}
                                            </button>
                                        ))}
                                    </div>
                                </section>

                                {/* 이번 달 위험요인 — 등급 분포 + 키워드 + AI 분석 진입 */}
                                {(() => {
                                    const r = data.risk
                                    const total = r ? r.levels.high + r.levels.mid + r.levels.low : 0
                                    if (total === 0) return null
                                    return (
                                        <section className="bg-cur-card rounded-[12px] border border-cur-hairline p-5 space-y-4">
                                            <div className="flex items-center justify-between">
                                                <h2 className="text-[14px] font-bold text-cur-ink">이번 달 위험요인</h2>
                                                <span className="text-[12px] text-cur-muted-soft">{total}건 식별</span>
                                            </div>
                                            <div className="space-y-2">
                                                <div className="flex h-2.5 rounded-full overflow-hidden bg-cur-elevated">
                                                    {r!.levels.high > 0 && <div className="bg-cur-error" style={{ width: `${(r!.levels.high / total) * 100}%` }} />}
                                                    {r!.levels.mid > 0 && <div className="bg-cur-primary" style={{ width: `${(r!.levels.mid / total) * 100}%` }} />}
                                                    {r!.levels.low > 0 && <div className="bg-cur-success" style={{ width: `${(r!.levels.low / total) * 100}%` }} />}
                                                </div>
                                                <div className="flex items-center gap-4 text-[12px]">
                                                    <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-cur-error" /><span className="text-cur-body">상 <b className="text-cur-ink">{r!.levels.high}</b></span></span>
                                                    <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-cur-primary" /><span className="text-cur-body">중 <b className="text-cur-ink">{r!.levels.mid}</b></span></span>
                                                    <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-cur-success" /><span className="text-cur-body">하 <b className="text-cur-ink">{r!.levels.low}</b></span></span>
                                                </div>
                                            </div>
                                            {r!.keywords.length > 0 && (
                                                <div className="space-y-1.5">
                                                    <p className="text-[12px] font-semibold text-cur-muted">자주 나온 위험 키워드</p>
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {r!.keywords.map((k) => (
                                                            <span key={k.word} className="text-[12px] font-medium text-cur-ink bg-cur-elevated border border-cur-hairline rounded-full px-2.5 py-1">
                                                                {k.word} <span className="text-cur-muted-soft">{k.count}</span>
                                                            </span>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                            <button
                                                onClick={() => router.push("/risk-assessment")}
                                                className="w-full h-10 rounded-[8px] border border-cur-hairline bg-cur-elevated text-[13px] font-semibold text-cur-ink hover:border-cur-primary/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                                            >
                                                현장별 AI 분석 보고서 만들기
                                            </button>
                                        </section>
                                    )
                                })()}
                            </>
                        )}
                    </>
                )}
            </main>
        </div>
    )
}
