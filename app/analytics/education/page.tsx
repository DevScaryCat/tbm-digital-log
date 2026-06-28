// app/analytics/education/page.tsx
"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { useRequireSubscription, fetchSubscription, isProActive } from "@/lib/useSubscription"
import { TBMHeader } from "@/components/TBMHeader"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Hash, Loader2, Sparkles, ChevronRight, BookOpen } from "lucide-react"

interface LogRow { id: string; date: string; education_type: string }
interface DaySummary { date: string; summary: string }
interface TimelineDay { date: string; sessions: number; firstId: string; summary: string }

const monthLabel = (m: string) => `${m.slice(0, 4)}년 ${parseInt(m.slice(5, 7), 10)}월`
const curMonthKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` }

function fmtDay(dateStr: string): { md: string; w: string } {
    const [y, m, d] = dateStr.split("-").map(Number)
    const dt = new Date(y, (m || 1) - 1, d || 1)
    const w = ["일", "월", "화", "수", "목", "금", "토"][dt.getDay()]
    return { md: `${m}월 ${d}일`, w }
}

// 교육 유형 → 막대 색
const TYPE_COLORS = ["bg-cur-primary", "bg-[#ff9a5c]", "bg-amber-400", "bg-cur-success", "bg-cur-muted"]

// ── 베이직(예시) 데모 ──
const SAMPLE = {
    stats: { sessions: 38, days: 24, headcount: 152, avg: "4.0" },
    types: [{ type: "TBM", count: 35 }, { type: "정기 안전교육", count: 3 }],
    timeline: [
        { date: "2026-05-28", sessions: 2, firstId: "", summary: "지게차 안전수칙·안전모 착용 점검" },
        { date: "2026-05-27", sessions: 1, firstId: "", summary: "고소작업 추락 예방·안전대 결속" },
        { date: "2026-05-26", sessions: 3, firstId: "", summary: "밀폐공간 질식 예방·가스 농도 측정" },
        { date: "2026-05-25", sessions: 1, firstId: "", summary: "중량물 취급·협착 위험 주의" },
        { date: "2026-05-22", sessions: 2, firstId: "", summary: "작업 전 스트레칭·근골격계 예방" },
        { date: "2026-05-21", sessions: 1, firstId: "", summary: "개인보호구 착용·정리정돈 강조" },
    ] as TimelineDay[],
    keywords: ["안전모 착용", "스트레칭", "지게차 안전수칙", "개인보호구", "낙하물 주의", "추락 예방", "보고체계"],
}

export default function EducationAnalyticsPage() {
    const router = useRouter()
    useRequireSubscription()

    const [checking, setChecking] = useState(true)
    const [pro, setPro] = useState(false)
    const [logs, setLogs] = useState<LogRow[]>([])
    const [selectedKey, setSelectedKey] = useState(curMonthKey)
    const [headcount, setHeadcount] = useState(0)
    const [insight, setInsight] = useState<{ days: DaySummary[]; keywords: string[] }>({ days: [], keywords: [] })
    const [loadingAI, setLoadingAI] = useState(false)

    // 최초: 구독 + 전체 교육일지 메타 로드
    useEffect(() => {
        ;(async () => {
            const { data: { user } } = await supabase.auth.getUser()
            const p = isProActive(await fetchSubscription())
            setPro(p)
            if (p && user) {
                const { data } = await supabase
                    .from("tbm_logs")
                    .select("id, date, education_type")
                    .eq("user_id", user.id)
                    .order("date", { ascending: false })
                setLogs((data as LogRow[]) || [])
            }
            setChecking(false)
        })()
    }, [])

    // 선택 월 일지
    const monthLogs = logs.filter((l) => String(l.date).startsWith(selectedKey))

    // 월 옵션 (데이터 있는 달 + 이번 달, 최신순)
    const monthOptions = (() => {
        const set = new Set<string>([curMonthKey()])
        for (const l of logs) { const k = String(l.date).slice(0, 7); if (k) set.add(k) }
        return [...set].sort().reverse()
    })()

    // 선택 월: 연인원(참석 누계) + AI 날짜별 요약·키워드 — 한 번에
    useEffect(() => {
        if (checking || !pro) return
        const ids = monthLogs.map((l) => l.id)
        let cancelled = false

        if (ids.length === 0) { setHeadcount(0); setInsight({ days: [], keywords: [] }); return }

        ;(async () => {
            // 연인원(참석자 누계)
            const { count } = await supabase
                .from("tbm_participants")
                .select("id", { count: "exact", head: true })
                .in("log_id", ids)
            if (!cancelled) setHeadcount(count ?? 0)

            // AI 날짜별 1줄 요약 + 주제 키워드
            setLoadingAI(true)
            try {
                const { data: s } = await supabase.auth.getSession()
                const [year, month] = selectedKey.split("-").map(Number)
                const res = await fetch("/api/analytics/education-insight", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s?.session?.access_token}` },
                    body: JSON.stringify({ year, month }),
                })
                const j = await res.json()
                if (!cancelled) {
                    setInsight({
                        days: res.ok && Array.isArray(j.days) ? j.days : [],
                        keywords: res.ok && Array.isArray(j.keywords) ? j.keywords : [],
                    })
                }
            } finally {
                if (!cancelled) setLoadingAI(false)
            }
        })()

        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [checking, pro, selectedKey, logs])

    // ── 집계 (Pro=실데이터 / 베이직=샘플) ──
    let stats: { sessions: number; days: number; headcount: number; avg: string }
    let types: { type: string; count: number }[]
    let timeline: TimelineDay[]
    let keywords: string[]

    if (pro) {
        const sessions = monthLogs.length
        const dayCount = new Set(monthLogs.map((l) => l.date)).size
        const avg = sessions ? (headcount / sessions).toFixed(1) : "0.0"
        stats = { sessions, days: dayCount, headcount, avg }

        const typeMap = new Map<string, number>()
        for (const l of monthLogs) { const t = l.education_type || "기타"; typeMap.set(t, (typeMap.get(t) || 0) + 1) }
        types = [...typeMap.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }))

        const summaryMap = new Map(insight.days.map((d) => [d.date, d.summary]))
        const dayMap = new Map<string, { sessions: number; firstId: string }>()
        for (const l of monthLogs) {
            const cur = dayMap.get(l.date)
            if (cur) cur.sessions++
            else dayMap.set(l.date, { sessions: 1, firstId: l.id })
        }
        timeline = [...dayMap.entries()]
            .sort((a, b) => (a[0] < b[0] ? 1 : -1))
            .map(([date, v]) => ({ date, sessions: v.sessions, firstId: v.firstId, summary: summaryMap.get(date) || "" }))

        keywords = insight.keywords
    } else {
        stats = SAMPLE.stats
        types = SAMPLE.types
        timeline = SAMPLE.timeline
        keywords = SAMPLE.keywords
    }

    const totalTypes = types.reduce((s, t) => s + t.count, 0) || 1

    if (checking) return <div className="min-h-screen flex items-center justify-center bg-cur-canvas"><Loader2 className="w-10 h-10 text-cur-primary animate-spin" /></div>

    return (
        <div className="bg-cur-canvas min-h-screen sm:py-8 flex sm:block items-center justify-center font-sans text-cur-body pb-20">
            <div className="max-w-lg w-full mx-auto bg-cur-card sm:rounded-[12px] relative flex flex-col min-h-[100dvh] sm:min-h-[85vh] border-x sm:border border-cur-hairline mb-[env(safe-area-inset-bottom)] overflow-hidden">

                <div className="p-4 bg-cur-card border-b border-cur-hairline sticky top-0 z-50">
                    <TBMHeader title="안전교육일지 종합분석" backHref="/" pageBadge={pro ? undefined : "예시"} />
                </div>

                <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">

                    {!pro && (
                        <div className="rounded-[12px] bg-cur-primary/[0.06] border border-cur-primary/30 p-4 space-y-2">
                            <p className="text-[13px] text-cur-primary font-semibold flex items-center gap-1.5"><Sparkles className="w-4 h-4" /> 예시 화면입니다</p>
                            <p className="text-[12px] text-cur-muted leading-relaxed">아래 수치는 샘플이에요. Pro 구독 시 내가 작성한 안전교육일지를 월별로 분석해 교육 인원 통계와 날짜별 AI 교육 요약을 보여드립니다.</p>
                            <Button onClick={() => router.push("/pricing")} className="w-full h-10 rounded-[8px] bg-cur-primary text-white text-[14px] font-bold hover:opacity-90">Pro 플랜 보기</Button>
                        </div>
                    )}

                    {/* 월 선택 */}
                    <div className="flex items-center justify-between">
                        <h2 className="text-[15px] font-bold text-cur-ink">월간 교육 분석</h2>
                        {pro ? (
                            <Select value={selectedKey} onValueChange={setSelectedKey}>
                                <SelectTrigger className="h-9 w-auto gap-1 text-[13px] border-cur-hairline rounded-[8px] bg-cur-card text-cur-ink px-3 focus:ring-1 focus:ring-cur-primary"><SelectValue /></SelectTrigger>
                                <SelectContent className="bg-cur-card border-cur-hairline text-cur-body max-h-64">
                                    {monthOptions.map((m) => <SelectItem key={m} value={m}>{monthLabel(m)}</SelectItem>)}
                                </SelectContent>
                            </Select>
                        ) : (
                            <span className="text-[13px] text-cur-muted font-medium px-3 py-1.5 rounded-[8px] bg-cur-elevated">{monthLabel("2026-05")}</span>
                        )}
                    </div>

                    {/* 요약 카드 (회의록 분석 페이지와 동일 스타일) */}
                    <div className="grid grid-cols-2 gap-3">
                        <EduStat label="교육 횟수" value={stats.sessions} unit="회" />
                        <EduStat label="교육 일수" value={stats.days} unit="일" />
                        <EduStat label="연인원" value={stats.headcount} unit="명" />
                        <EduStat label="평균 인원" value={stats.avg} unit="명/회" />
                    </div>

                    {/* 교육 유형 분포 */}
                    {timeline.length > 0 && (
                        <div className="bg-cur-card p-4 rounded-[12px] border border-cur-hairline space-y-3">
                            <h3 className="text-[13px] font-bold text-cur-ink">교육 유형 분포</h3>
                            <div className="w-full h-2.5 rounded-full overflow-hidden flex bg-cur-elevated">
                                {types.map((t, i) => (
                                    <div key={t.type} className={`h-full ${TYPE_COLORS[i % TYPE_COLORS.length]}`} style={{ width: `${(t.count / totalTypes) * 100}%` }} />
                                ))}
                            </div>
                            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                                {types.map((t, i) => (
                                    <div key={t.type} className="flex items-center gap-1.5 text-[12px]">
                                        <span className={`w-2.5 h-2.5 rounded-[3px] ${TYPE_COLORS[i % TYPE_COLORS.length]}`} />
                                        <span className="text-cur-body font-medium">{t.type}</span>
                                        <span className="text-cur-muted">{t.count}회</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* 날짜별 AI 요약 타임라인 (히어로) */}
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <h2 className="text-[18px] font-bold text-cur-ink flex items-center gap-2"><BookOpen className="w-5 h-5 text-cur-primary" /> 날짜별 교육 요약</h2>
                            {pro && loadingAI && <span className="flex items-center gap-1.5 text-[12px] text-cur-muted"><Loader2 className="w-3.5 h-3.5 animate-spin" /> AI 분석 중</span>}
                        </div>

                        {timeline.length === 0 ? (
                            <div className="bg-cur-card p-8 rounded-[12px] border border-cur-hairline text-center text-[13px] text-cur-muted-soft">이 달에 작성된 교육일지가 없습니다.</div>
                        ) : (
                            <div className="relative pl-5">
                                {/* 세로 라인 */}
                                <div className="absolute left-[5px] top-2 bottom-2 w-px bg-cur-hairline" />
                                <div className="space-y-3">
                                    {timeline.map((d) => {
                                        const { md, w } = fmtDay(d.date)
                                        const clickable = pro && d.firstId
                                        return (
                                            <div key={d.date} className="relative">
                                                {/* 점 */}
                                                <div className="absolute -left-5 top-3.5 w-2.5 h-2.5 rounded-full bg-cur-primary ring-4 ring-cur-card" />
                                                <div
                                                    onClick={() => clickable && router.push(`/report/${d.firstId}`)}
                                                    className={`bg-cur-card p-3.5 rounded-[10px] border border-cur-hairline ${clickable ? "cursor-pointer hover:border-cur-primary/40 active:scale-[0.99] transition-all" : ""}`}
                                                >
                                                    <div className="flex items-center justify-between mb-1">
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-[13px] font-bold text-cur-ink">{md}</span>
                                                            <span className="text-[11px] text-cur-muted">({w})</span>
                                                            {d.sessions > 1 && (
                                                                <span className="text-[10px] font-bold text-cur-primary bg-cur-primary/10 px-1.5 py-0.5 rounded-full">{d.sessions}회</span>
                                                            )}
                                                        </div>
                                                        {clickable && <ChevronRight className="w-4 h-4 text-cur-muted shrink-0" />}
                                                    </div>
                                                    <p className="text-[14px] text-cur-body leading-snug">
                                                        {d.summary || (pro && loadingAI ? <span className="text-cur-muted-soft">요약 생성 중…</span> : <span className="text-cur-muted-soft">교육 {d.sessions}회 실시</span>)}
                                                    </p>
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* 자주 다룬 주제 */}
                    {keywords.length > 0 && (
                        <div className="space-y-3">
                            <h2 className="text-[18px] font-bold text-cur-ink flex items-center gap-2"><Hash className="w-5 h-5 text-cur-primary" /> 자주 다룬 교육 주제</h2>
                            <div className="bg-cur-card p-5 rounded-[12px] border border-cur-hairline">
                                <div className="flex flex-wrap gap-2">
                                    {keywords.map((kw, idx) => (
                                        <div key={idx} className="flex items-center gap-1.5 bg-cur-elevated px-3 py-1.5 rounded-full border border-cur-hairline">
                                            <span className="text-[14px] font-semibold text-cur-ink">#{kw}</span>
                                        </div>
                                    ))}
                                </div>
                                <p className="text-[13px] text-cur-muted mt-4 leading-relaxed">
                                    이 기간 <span className="font-semibold text-cur-primary">{keywords[0]}</span>{keywords[1] && <> · <span className="font-semibold text-cur-primary">{keywords[1]}</span></>} 관련 교육이 가장 자주 이뤄졌습니다.
                                </p>
                            </div>
                        </div>
                    )}

                </div>
            </div>
        </div>
    )
}

function EduStat({ label, value, unit }: { label: string; value: number | string; unit: string }) {
    return (
        <div className="bg-cur-card p-4 rounded-[8px] border border-cur-hairline text-center">
            <div className="text-[12px] text-cur-muted font-medium mb-1">{label}</div>
            <div className="text-[24px] font-bold text-cur-ink font-mono">{value}<span className="text-[14px] font-medium text-cur-muted ml-1">{unit}</span></div>
        </div>
    )
}
