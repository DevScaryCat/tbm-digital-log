"use client"

/* Hallmark · component: panel (현장관리 tab) · genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * states: loading · solo(자기 현장 1) · owner(다현장) · setup(현장 추가 + 청구 미리보기) · read-only(member) · error
 * tokens only — hairline depth, card radius 12px, CTA radius 8px, cur-primary used scarcely
 *
 * 현장관리 탭. 누구에게나 같은 골격:
 *   - 혼자 쓰는 사람: 현장 목록에 본인 현장 하나. 그대로 쓰면 된다.
 *   - 감독자: 본인 현장 + 소속 현장. 계정·결제·보고서 관리.
 *   - 소속 현장: 같은 화면을 보되 조작 불가 + "감독자가 관리 중" 안내.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { fetchSubscription, isProActive, type SubscriptionRow } from "@/lib/useSubscription"
import {
    Loader2, ChevronRight, FileBarChart2, Settings2, Users, Sparkles,
    CheckCircle2, CircleDashed, Lock, CreditCard, Plus,
} from "lucide-react"

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

const SEAT_PRICE = 3900

// 탭 전환·페이지 복귀 때마다 재마운트되며 풀 로딩이 돌던 문제 —
// 마지막 응답을 모듈에 캐시해 두고 즉시 그린 뒤 뒤에서 조용히 갱신한다(SWR).
let panelCache: { userId: string; data: Overview; sub: SubscriptionRow | null } | null = null

export function CompanyPanel() {
    const router = useRouter()
    const [data, setData] = useState<Overview | null>(panelCache?.data ?? null)
    const [sub, setSub] = useState<SubscriptionRow | null>(panelCache?.sub ?? null)
    const [loading, setLoading] = useState(!panelCache)
    // 온보딩에서 '여러 현장을 관리해요'를 고른 사람에게만 '현장 추가하기'를 강조한다.
    // 혼자 쓰는 사람에게는 광고성 소음이라 띄우지 않는다.
    const [hintAddSite, setHintAddSite] = useState(false)
    const [showAllSites, setShowAllSites] = useState(false)
    useEffect(() => {
        try { setHintAddSite(window.localStorage.getItem("antok_hint_add_site") === "1") } catch { /* 무시 */ }
    }, [])
    const clearHint = () => {
        setHintAddSite(false)
        try { window.localStorage.removeItem("antok_hint_add_site") } catch { /* 무시 */ }
    }

    useEffect(() => {
        ;(async () => {
            try {
                const { data: s } = await supabase.auth.getSession()
                const uid = s?.session?.user?.id
                if (!uid) return
                // 다른 계정의 캐시는 버린다
                if (panelCache && panelCache.userId !== uid) {
                    panelCache = null
                    setData(null); setSub(null); setLoading(true)
                }
                const [res, subRow] = await Promise.all([
                    fetch("/api/org/overview", {
                        headers: { Authorization: `Bearer ${s?.session?.access_token}` },
                    }),
                    fetchSubscription(),
                ])
                if (res.ok) {
                    const j = (await res.json()) as Overview
                    setData(j)
                    setSub(subRow)
                    panelCache = { userId: uid, data: j, sub: subRow }
                } else {
                    setSub(subRow)
                }
            } finally {
                setLoading(false)
            }
        })()
    }, [])

    if (loading) {
        return (
            <div className="py-24 flex justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-cur-muted" />
            </div>
        )
    }
    if (!data) {
        return <p className="text-[14px] text-cur-muted text-center py-16">현황을 불러오지 못했습니다.</p>
    }

    const managed = data.canManage
    // legacy(구 베이직 1,900·영구무료)는 현장 추가가 요금제에 없다 — 서버가 402로 막으므로
    // 여기서 추가 UI 대신 안내를 보여준다 (가격까지 보여주고 마지막에 거절하면 그게 더 나쁘다)
    const canAddSites = managed && isProActive(sub)
    // 현장이 수십 곳이어도 문제 현장부터 보이게: 오늘 미실시 우선, 그다음 최근 활동순.
    // 기본 5곳만 보여주고 나머지는 접는다.
    const activeSites = data.sites
        .filter((s) => s.status === "active")
        .sort((a, b) => Number(a.todayDone) - Number(b.todayDone) || (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""))


    return (
        <div className="space-y-5">
            {/* 소속 현장 안내 — 왜 아무것도 못 누르는지 먼저 설명한다 */}
            {!managed && (
                <div className="flex items-start gap-3 p-3.5 rounded-[12px] bg-cur-elevated border border-cur-hairline">
                    <Lock className="w-4 h-4 mt-0.5 shrink-0 text-cur-muted" />
                    <p className="text-[13px] text-cur-body leading-relaxed">
                        <span className="font-semibold text-cur-ink">{data.orgName || "회사"}</span> 소속 현장이에요.
                        계정·결제·보고서 설정은 <span className="font-semibold text-cur-ink">감독자가 관리 중</span>입니다.
                    </p>
                </div>
            )}




            {/* 이번 달 활동 대시보드 — 설정은 온보딩·계정 관리에서 끝내므로, 들어왔을 때
                눈에 들어와야 하는 건 메뉴가 아니라 데이터다 (Chris 의견). */}
            {(() => {
                const mMinutes = activeSites.reduce((a, x) => a + x.monthMinutes, 0)
                const mLogs = activeSites.reduce((a, x) => a + x.monthLogs, 0)
                const daily = data.daily ?? []
                const maxDay = Math.max(1, ...daily.map((d) => d.minutes + d.logs))
                const dow = ["일", "월", "화", "수", "목", "금", "토"]
                return (
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
                    </section>
                )
            })()}

            {/* 이번 달 위험요인 — 등급 분포 + 자주 나온 키워드. 감독자의 실질 관심사. */}
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
                                {/* 등급 분포 — 누적 막대 + 수치 */}
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
                                {/* 자주 나온 위험 키워드 */}
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
                                {/* 더 깊은 분석은 AI 보고서로 */}
                                {managed && (
                                    <button
                                        onClick={() => router.push("/risk-assessment")}
                                        className="w-full h-10 rounded-[8px] border border-cur-hairline bg-cur-elevated text-[13px] font-semibold text-cur-ink hover:border-cur-primary/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                                    >
                                        현장별 AI 분석 보고서 만들기
                                    </button>
                                )}
                            </>
                        )}
                    </section>
                )
            })()}

            {/* 확인이 필요한 현장 — 3일 이상 기록이 없거나 이번 달 0건. 현장이 많을수록
                감독자가 찾는 건 '빠진 곳'이다. 현장 2곳 이상일 때만 의미가 있다. */}
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
                                    disabled={!managed || data.memberCount === 0}
                                    onClick={() => managed && data.memberCount > 0 && router.push(`/org/sites/${x.userId}`)}
                                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-cur-elevated/50 transition-colors disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-inset"
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

            {/* 현장 목록 — 혼자 쓰면 본인 현장 하나, 감독자면 본인이 맨 위 */}
            <section className="space-y-2">
                <h2 className="text-[14px] font-bold text-cur-ink px-1">현장 목록</h2>
                <div className="bg-cur-card rounded-[12px] border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                    {(showAllSites ? activeSites : activeSites.slice(0, 5)).map((s) => {
                        const openable = managed && data.memberCount > 0
                        const Row = openable ? "button" : "div"
                        return (
                            <Row
                                key={s.userId}
                                {...(openable
                                    ? {
                                          onClick: () => router.push(`/org/sites/${s.userId}`),
                                          className:
                                              "w-full flex items-center gap-3 p-4 text-left hover:bg-cur-elevated/50 active:bg-cur-elevated transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-inset",
                                      }
                                    : { className: "w-full flex items-center gap-3 p-4 text-left" })}
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
                                        <span className="text-[15px] font-semibold text-cur-ink truncate">{s.siteName}</span>
                                        {s.isSelf && (
                                            <span className="shrink-0 text-[10px] font-bold text-cur-primary bg-cur-primary/10 px-1.5 py-0.5 rounded-[4px]">
                                                내 현장
                                            </span>
                                        )}
                                    </span>
                                    <span className="block text-[12px] text-cur-muted mt-0.5">
                                        {s.todayDone
                                            ? `오늘 회의록 ${s.todayMinutes} · 일지 ${s.todayLogs}`
                                            : s.lastActivity
                                              ? `마지막 활동 ${s.lastActivity}`
                                              : "이번 달 기록 없음"}
                                        {" · "}이번 달 {s.monthMinutes + s.monthLogs}건
                                    </span>
                                </span>
                                {openable && <ChevronRight className="w-4 h-4 text-cur-muted-soft shrink-0" />}
                            </Row>
                        )
                    })}

                    {activeSites.length > 5 && (
                        <button
                            onClick={() => setShowAllSites((v) => !v)}
                            className="w-full h-11 text-[13px] font-semibold text-cur-muted hover:text-cur-ink hover:bg-cur-elevated/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-inset"
                        >
                            {showAllSites ? "접기" : `현장 ${activeSites.length}곳 모두 보기`}
                        </button>
                    )}

                    {/* 현장 추가 — 목록의 마지막 행. 처음이면 청구 미리보기 셋업을 펼친다 */}
                    {managed && !canAddSites && (
                        <button
                            onClick={() => router.push("/pricing")}
                            className="w-full flex items-center gap-3 p-4 text-left hover:bg-cur-elevated/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-inset"
                        >
                            <span className="w-9 h-9 rounded-full border border-dashed border-cur-hairline-strong text-cur-muted flex items-center justify-center shrink-0">
                                <Plus className="w-4 h-4" />
                            </span>
                            <span className="flex-1 min-w-0">
                                <span className="block text-[14px] font-semibold text-cur-body">현장 추가는 유료 요금제에서</span>
                                <span className="block text-[12px] text-cur-muted-soft mt-0.5">
                                    계정 1개당 월 {SEAT_PRICE.toLocaleString()}원 — 요금제 보기
                                </span>
                            </span>
                            <ChevronRight className="w-4 h-4 text-cur-muted-soft shrink-0" />
                        </button>
                    )}
                    {canAddSites && (
                        <button
                            onClick={() => { clearHint(); router.push("/org/members?new=1") }}
                            className="relative w-full flex items-center gap-3 p-4 text-left hover:bg-cur-elevated/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-inset"
                        >
                            {hintAddSite && data.memberCount === 0 && (
                                <>
                                    <span aria-hidden className="absolute inset-1 rounded-[10px] border-2 border-cur-primary pointer-events-none animate-pulse" />
                                    <span aria-hidden className="absolute -top-2.5 right-3 z-10 flex items-center gap-1 rounded-full bg-cur-primary text-cur-on-primary text-[10px] font-bold px-2 py-[3px] shadow-[0_4px_12px_rgba(245,78,0,0.35)] animate-bounce pointer-events-none">
                                        여기서 현장을 추가해요
                                    </span>
                                </>
                            )}
                            <span className="w-9 h-9 rounded-full border border-dashed border-cur-hairline-strong text-cur-muted flex items-center justify-center shrink-0">
                                <Plus className="w-4 h-4" />
                            </span>
                            <span className="flex-1 min-w-0">
                                <span className="block text-[14px] font-semibold text-cur-body">현장 추가하기</span>
                                <span className="block text-[12px] text-cur-muted-soft mt-0.5">
                                    다른 현장 담당자에게 계정을 만들어 줄 수 있어요
                                </span>
                            </span>
                            <ChevronRight className="w-4 h-4 text-cur-muted-soft shrink-0" />
                        </button>
                    )}
                </div>
            </section>

            {/* 관리 메뉴 — 내 안톡 탭의 카드 문법(아이콘 좌·라벨·셰브론)과 동일한 리스트 한 장.
                소속 현장에게는 같은 자리·잠긴 모습으로 보인다. */}
            <section className="bg-cur-card rounded-[12px] border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                {[
                    { href: "/org/reports", label: "월간 보고서", icon: <FileBarChart2 className="w-5 h-5" /> },
                    { href: "/risk-assessment", label: "AI 분석 보고서", icon: <Sparkles className="w-5 h-5" /> },
                    { href: "/report-settings", label: "보고서 설정", icon: <Settings2 className="w-5 h-5" /> },
                    { href: "/org/members", label: "현장 계정 관리", icon: <Users className="w-5 h-5" /> },
                    { href: "/account", label: "구독 및 결제", icon: <CreditCard className="w-5 h-5" /> },
                ].map((q) => (
                    <button
                        key={q.href}
                        type="button"
                        disabled={!managed}
                        aria-disabled={!managed}
                        onClick={() => managed && router.push(q.href)}
                        className={[
                            "w-full flex items-center gap-3.5 p-4 text-left transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-inset",
                            managed ? "hover:bg-cur-elevated/50 active:bg-cur-elevated cursor-pointer" : "opacity-55 cursor-not-allowed",
                        ].join(" ")}
                    >
                        <span
                            className={`w-10 h-10 shrink-0 rounded-[8px] flex items-center justify-center ${
                                managed ? "bg-cur-elevated text-cur-ink" : "bg-cur-elevated text-cur-muted-soft"
                            }`}
                        >
                            {managed ? q.icon : <Lock className="w-4 h-4" />}
                        </span>
                        <span className="flex-1 text-[15px] font-semibold text-cur-ink">{q.label}</span>
                        {managed ? (
                            <ChevronRight className="w-4 h-4 text-cur-muted-soft shrink-0" />
                        ) : (
                            <span className="text-[11px] text-cur-muted-soft shrink-0">감독자 관리</span>
                        )}
                    </button>
                ))}
            </section>
        </div>
    )
}
