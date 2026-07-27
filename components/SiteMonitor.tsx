"use client"

/* Hallmark · component: panel (홈 관제 섹션) · genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * states: loading · all(전체 합산 + 7일 차트) · site(현장 1곳) · empty-risk(예시) · attention · error
 * tokens only — hairline depth, card radius 12px, 칩 rounded-full, cur-primary 절제
 */

// 감독자 홈 관제 섹션 — 구 '현장관리' 탭의 대시보드를 홈으로 흡수한 것 (탭 제거 라운드).
// 칩(전체/현장별)이 활동 카드를 지배한다. 위험요인·주의 현장은 '전체'에서만 보인다
// (서버 집계가 전체 기준이라 특정 현장 선택 중에 보이면 범위를 오해한다).
// 교육 진행도·작성 버튼은 본인 지표라 이 섹션 밖(홈 개인 영역)에 고정.

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { fetchSubscription, isProActive, type SubscriptionRow } from "@/lib/useSubscription"
import { Loader2, ChevronRight, CheckCircle2, Plus } from "lucide-react"

interface SiteRow {
    userId: string
    siteName: string
    managerName: string
    status: "active" | "detached"
    isOwner: boolean
    isSelf: boolean
    todayDone: boolean
    todayMinutes: number
    todayLogs: number
    monthMinutes: number
    monthLogs: number
    lastActivity: string | null
}

interface Overview {
    kind: "owner" | "member" | "solo"
    canManage: boolean
    orgName: string
    accountCount: number
    memberCount: number
    todayDoneCount: number
    today: string
    sites: SiteRow[]
    daily?: { date: string; minutes: number; logs: number }[]
    risk?: { levels: { high: number; mid: number; low: number }; keywords: { word: string; count: number }[] }
}

// 홈 복귀 때마다 풀 로딩이 돌지 않도록 마지막 응답을 모듈에 캐시(SWR) — 구 CompanyPanel과 동일 패턴
let monitorCache: { userId: string; data: Overview; sub: SubscriptionRow | null } | null = null

const chipCls = (on: boolean) =>
    [
        "shrink-0 h-8 px-3 rounded-full text-[13px] font-semibold whitespace-nowrap transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary",
        on ? "bg-cur-ink text-white" : "bg-cur-card border border-cur-hairline text-cur-body hover:border-cur-primary/40",
    ].join(" ")

export function SiteMonitor() {
    const router = useRouter()
    const [data, setData] = useState<Overview | null>(monitorCache?.data ?? null)
    const [sub, setSub] = useState<SubscriptionRow | null>(monitorCache?.sub ?? null)
    const [loading, setLoading] = useState(!monitorCache)
    // "all" 또는 현장 userId — 칩 선택이 아래 활동 카드를 지배한다
    const [sel, setSel] = useState<string>("all")
    // 온보딩에서 '여러 현장'을 고른 사람에게만 추가 칩을 강조
    const [hintAddSite, setHintAddSite] = useState(false)

    useEffect(() => {
        try { setHintAddSite(window.localStorage.getItem("antok_hint_add_site") === "1") } catch { /* 무시 */ }
    }, [])

    const load = useCallback(async () => {
        try {
            const { data: s } = await supabase.auth.getSession()
            const uid = s?.session?.user?.id
            if (!uid) return
            if (monitorCache && monitorCache.userId !== uid) {
                monitorCache = null
                setData(null); setSub(null); setLoading(true)
            }
            const [res, subRow] = await Promise.all([
                fetch("/api/org/overview", { headers: { Authorization: `Bearer ${s?.session?.access_token}` } }),
                fetchSubscription(),
            ])
            if (res.ok) {
                const j = (await res.json()) as Overview
                setData(j)
                setSub(subRow)
                monitorCache = { userId: uid, data: j, sub: subRow }
            } else {
                setSub(subRow)
            }
        } catch {
            /* 네트워크 실패 — 아래 에러 카드가 재시도를 제공 (조용히 사라지면 기능이 없어진 걸로 보인다) */
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    if (loading) {
        return (
            <div className="bg-cur-card rounded-[12px] border border-cur-hairline py-12 flex justify-center">
                <Loader2 className="w-5 h-5 animate-spin text-cur-muted" />
            </div>
        )
    }
    if (!data) {
        return (
            <div className="bg-cur-card rounded-[12px] border border-cur-hairline px-4 py-3.5 flex items-center justify-between gap-3">
                <p className="text-[13px] text-cur-muted">현장 현황을 불러오지 못했어요.</p>
                <button
                    type="button"
                    onClick={() => { setLoading(true); load() }}
                    className="shrink-0 h-8 px-3 rounded-[8px] border border-cur-hairline bg-cur-elevated text-[12px] font-semibold text-cur-ink hover:border-cur-primary/40 transition-colors"
                >
                    다시 시도
                </button>
            </div>
        )
    }

    const activeSites = data.sites
        .filter((s) => s.status === "active")
        .sort((a, b) => Number(a.todayDone) - Number(b.todayDone) || (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""))
    const canAddSites = isProActive(sub)
    const clearHint = () => {
        setHintAddSite(false)
        try { window.localStorage.removeItem("antok_hint_add_site") } catch { /* 무시 */ }
    }
    // 선택 현장이 해제 등으로 사라졌으면 전체로 폴백
    const selected = sel === "all" ? null : activeSites.find((s) => s.userId === sel) ?? null
    const isAll = !selected

    const dow = ["일", "월", "화", "수", "목", "금", "토"]
    const daily = data.daily ?? []
    const maxDay = Math.max(1, ...daily.map((d) => d.minutes + d.logs))
    const mMinutes = activeSites.reduce((a, x) => a + x.monthMinutes, 0)
    const mLogs = activeSites.reduce((a, x) => a + x.monthLogs, 0)

    return (
        <div className="space-y-3">
            <h3 className="text-[15px] font-semibold text-cur-ink tracking-[-0.11px] px-1">현장 활동</h3>

            {/* 현장 필터 칩 — 전체 / 현장별 / 추가 */}
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1" role="tablist" aria-label="현장 선택">
                <button type="button" role="tab" aria-selected={isAll} onClick={() => setSel("all")} className={chipCls(isAll)}>
                    전체
                </button>
                {activeSites.map((s) => (
                    <button
                        key={s.userId}
                        type="button"
                        role="tab"
                        aria-selected={sel === s.userId}
                        onClick={() => setSel(s.userId)}
                        className={chipCls(sel === s.userId)}
                    >
                        {s.siteName}
                        {s.isSelf && <span className={sel === s.userId ? " text-white/60" : " text-cur-muted-soft"}> · 내 현장</span>}
                    </button>
                ))}
                {canAddSites && (
                    <button
                        type="button"
                        onClick={() => { clearHint(); router.push("/org/members?new=1") }}
                        className="relative shrink-0 h-8 px-3 rounded-full text-[13px] font-semibold whitespace-nowrap border border-dashed border-cur-hairline-strong text-cur-muted hover:text-cur-ink hover:border-cur-primary/40 transition-colors flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                    >
                        {hintAddSite && data.memberCount === 0 && (
                            <span aria-hidden className="absolute -inset-0.5 rounded-full border-2 border-cur-primary pointer-events-none animate-pulse" />
                        )}
                        <Plus className="w-3.5 h-3.5" /> 현장 추가
                    </button>
                )}
            </div>

            {/* 활동 카드 — 칩 선택에 따라 전체 합산 또는 현장 1곳 */}
            <section className="bg-cur-card rounded-[12px] border border-cur-hairline p-5 space-y-4">
                <div className="flex items-center justify-between">
                    <h2 className="text-[14px] font-bold text-cur-ink truncate">
                        {isAll ? "활동 기록" : selected!.siteName}
                    </h2>
                    <span className="text-[12px] text-cur-muted-soft shrink-0">
                        {isAll ? "이번 달 · 차트는 최근 7일" : "이번 달"}
                    </span>
                </div>
                {isAll ? (
                    <>
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
                        {daily.length > 0 && (
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
                        )}
                    </>
                ) : (
                    <>
                        <div className="grid grid-cols-3 gap-px bg-cur-hairline border border-cur-hairline rounded-[12px] overflow-hidden text-center">
                            <div className="bg-cur-card py-3.5">
                                <p className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1">오늘</p>
                                <p className={`text-[24px] leading-none font-bold font-mono ${selected!.todayDone ? "text-cur-success" : "text-cur-primary"}`}>
                                    {selected!.todayDone ? selected!.todayMinutes + selected!.todayLogs : 0}
                                    <span className="text-[13px] text-cur-muted font-sans font-medium ml-0.5">건</span>
                                </p>
                            </div>
                            <div className="bg-cur-card py-3.5">
                                <p className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1">TBM 회의록</p>
                                <p className="text-[24px] leading-none font-bold text-cur-ink font-mono">{selected!.monthMinutes}</p>
                            </div>
                            <div className="bg-cur-card py-3.5">
                                <p className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1">교육일지</p>
                                <p className="text-[24px] leading-none font-bold text-cur-ink font-mono">{selected!.monthLogs}</p>
                            </div>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <p className="text-[12px] text-cur-muted min-w-0 truncate">
                                {selected!.todayDone
                                    ? `오늘 회의록 ${selected!.todayMinutes} · 일지 ${selected!.todayLogs}`
                                    : selected!.lastActivity
                                      ? `마지막 활동 ${selected!.lastActivity}`
                                      : "이번 달 기록 없음"}
                            </p>
                            <button
                                type="button"
                                onClick={() => router.push(`/org/sites/${selected!.userId}`)}
                                className="shrink-0 h-9 px-3 rounded-[8px] border border-cur-hairline bg-cur-elevated text-[13px] font-semibold text-cur-ink hover:border-cur-primary/40 transition-colors flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                            >
                                현장 기록 보기 <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft" />
                            </button>
                        </div>
                    </>
                )}
            </section>

            {/* 이번 달 위험요인 + 주의 현장 — 전체 기준 집계라 '전체' 선택에서만 */}
            {isAll && (() => {
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
                            /* 예시 스켈레톤 — 데이터가 쌓이면 이 자리가 무엇으로 채워지는지 미리 보여준다 */
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
                                <button
                                    onClick={() => router.push("/risk-assessment")}
                                    className="w-full h-10 rounded-[8px] border border-cur-hairline bg-cur-elevated text-[13px] font-semibold text-cur-ink hover:border-cur-primary/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                                >
                                    현장별 AI 분석 보고서 만들기
                                </button>
                            </>
                        )}
                    </section>
                )
            })()}

            {isAll && activeSites.length > 1 && (() => {
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
                                    onClick={() => setSel(x.userId)}
                                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-cur-elevated/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-inset"
                                >
                                    <span className="flex-1 min-w-0 text-[14px] font-semibold text-cur-ink truncate">{x.siteName}</span>
                                    <span className="shrink-0 text-[12px] font-semibold text-cur-error">
                                        {x.gap === Infinity ? "기록 없음" : `${x.gap}일째 기록 없음`}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </section>
                )
            })()}
        </div>
    )
}
