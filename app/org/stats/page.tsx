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
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useOrgContext } from "@/lib/useOrgContext"
import { Loader2, Building2 } from "lucide-react"

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
                        {/* 현장 선택 — 이 페이지의 조종간이라 크고 분명하게. 전체와 현장 목록은 구분선+라벨로 나눈다 */}
                        <Select value={sel} onValueChange={setSel}>
                            <SelectTrigger className="w-full h-14 px-4 text-[16px] font-bold border-cur-hairline rounded-[12px] bg-cur-card text-cur-ink shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                                <span className="flex items-center gap-2.5 min-w-0">
                                    <Building2 className="w-5 h-5 text-cur-muted shrink-0" />
                                    <SelectValue />
                                </span>
                            </SelectTrigger>
                            <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                                <SelectItem value="all" className="text-[15px] py-3 font-semibold">전체</SelectItem>
                                {memberSites.length > 0 && (
                                    <>
                                        <SelectSeparator className="bg-cur-hairline" />
                                        <SelectGroup>
                                            <SelectLabel className="text-[11px] font-semibold text-cur-muted-soft px-8 pt-1.5">소속 현장</SelectLabel>
                                            {memberSites.map((s) => (
                                                <SelectItem key={s.userId} value={s.userId} className="text-[15px] py-3">{s.siteName}</SelectItem>
                                            ))}
                                        </SelectGroup>
                                    </>
                                )}
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

                                {/* 이번 달 위험요인 — 등급 분포 + 키워드. 데이터가 없으면 예시 스켈레톤으로
                                    이 자리가 무엇으로 채워지는지 보여준다 (확인이 필요한 현장 카드는 Chris 지시로 제거) */}
                                {(() => {
                                    const r = data.risk
                                    const total = r ? r.levels.high + r.levels.mid + r.levels.low : 0
                                    return (
                                        <section className="bg-cur-card rounded-[12px] border border-cur-hairline p-5 space-y-4">
                                            <div className="flex items-center justify-between">
                                                <h2 className="text-[14px] font-bold text-cur-ink">이번 달 위험요인</h2>
                                                {total > 0 ? (
                                                    <span className="text-[12px] text-cur-muted-soft">{total}건 식별</span>
                                                ) : (
                                                    <span className="text-[10px] font-bold text-cur-muted bg-cur-elevated border border-cur-hairline rounded-full px-2 py-0.5">예시</span>
                                                )}
                                            </div>
                                            {total === 0 ? (
                                                <div className="relative">
                                                    <div aria-hidden className="space-y-4 opacity-40 grayscale-[0.3] select-none pointer-events-none">
                                                        <div className="space-y-2">
                                                            <div className="flex h-2.5 rounded-full overflow-hidden bg-cur-elevated">
                                                                <div className="bg-cur-error" style={{ width: "22%" }} />
                                                                <div className="bg-cur-primary" style={{ width: "50%" }} />
                                                                <div className="bg-cur-success" style={{ width: "28%" }} />
                                                            </div>
                                                            <div className="flex items-center gap-4 text-[12px]">
                                                                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-cur-error" /><span className="text-cur-body">상 <b className="text-cur-ink">2</b></span></span>
                                                                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-cur-primary" /><span className="text-cur-body">중 <b className="text-cur-ink">5</b></span></span>
                                                                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-cur-success" /><span className="text-cur-body">하 <b className="text-cur-ink">3</b></span></span>
                                                            </div>
                                                        </div>
                                                        <div className="space-y-1.5">
                                                            <p className="text-[12px] font-semibold text-cur-muted">자주 나온 위험 키워드</p>
                                                            <div className="flex flex-wrap gap-1.5">
                                                                {[["추락", 4], ["끼임", 3], ["지게차", 3], ["개구부", 2], ["감전", 1]].map(([w, c]) => (
                                                                    <span key={String(w)} className="text-[12px] font-medium text-cur-ink bg-cur-elevated border border-cur-hairline rounded-full px-2.5 py-1">
                                                                        {w} <span className="text-cur-muted-soft">{c}</span>
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <p className="text-[12px] text-cur-muted mt-3">TBM 회의록이 쌓이면 실제 데이터로 채워져요.</p>
                                                </div>
                                            ) : (
                                                <>
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
                                                </>
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
