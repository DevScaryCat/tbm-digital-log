// app/analytics/page.tsx
"use client"

import { useState, useEffect, useMemo, useRef, useCallback } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { fetchAllRows } from "@/lib/fetchAllRows"
import { useRequireSubscription, fetchSubscription, isProActive } from "@/lib/useSubscription"
import { TBMHeader } from "@/components/TBMHeader"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, Hash, Activity, Loader2, Sparkles, ChevronRight } from "lucide-react"

interface Keyword { word: string; count: number; trend?: string }
interface RiskCard { id: number; minuteId?: string; level: string; category: string; subCategory: string; workName: string; date: string }

// 위험 등급 → 상/중/하 (회의록 hazards.level은 이미 상/중/하)
function gradeOf(level: unknown): string {
    const s = String(level ?? "").trim()
    if (s === "상" || s === "매우높음" || s === "높음") return "상"
    if (s === "중" || s === "보통") return "중"
    if (s === "하" || s === "낮음") return "하"
    const n = Number(s)
    if (!isNaN(n)) { if (n >= 9) return "상"; if (n >= 4) return "중"; return "하" }
    return "중"
}
function gradeRank(level: unknown): number { const g = gradeOf(level); return g === "상" ? 3 : g === "중" ? 2 : 1 }

// 한 달치 회의록 → 통계/키워드/카드
function computeMonth(minutes: any[], monthKey: string) {
    const monthMins = minutes.filter((m) => String(m.date || "").startsWith(monthKey))
    const items: { factor: string; level: unknown; minuteId: string; date: string; workName: string; process: string }[] = []
    for (const m of monthMins) for (const h of (Array.isArray(m.hazards) ? m.hazards : [])) {
        if (!h?.factor) continue
        items.push({ factor: String(h.factor), level: h.level, minuteId: m.id, date: m.date || "", workName: m.work_name || "TBM 회의록", process: m.process_name || "" })
    }
    const freq = new Map<string, number>()
    for (const it of items) { const n = it.factor.trim(); if (n) freq.set(n, (freq.get(n) || 0) + 1) }
    const keywords: Keyword[] = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([word, count]) => ({ word, count }))
    const high = items.filter((it) => gradeOf(it.level) === "상").length
    const mid = items.filter((it) => gradeOf(it.level) === "중").length
    const cards: RiskCard[] = items.slice().sort((a, b) => gradeRank(b.level) - gradeRank(a.level)).slice(0, 10)
        .map((it, idx) => ({ id: idx, minuteId: it.minuteId, level: gradeOf(it.level), category: it.process || "TBM 회의록", subCategory: it.factor, workName: it.workName, date: it.date }))
    return { stats: { total: monthMins.length, high, mid }, keywords, cards }
}

// ── 베이직(예시) 데모 ──
const SAMPLE = {
    stats: { total: 42, high: 5, mid: 9 },
    keywords: [
        { word: "추락방지", count: 24, trend: "up" }, { word: "안전대", count: 18 }, { word: "개구부", count: 15, trend: "up" },
        { word: "크레인", count: 12 }, { word: "협착", count: 9 }, { word: "안전모", count: 8 },
    ] as Keyword[],
    cards: [
        { id: 1, level: "상", category: "철근콘크리트", subCategory: "개구부 덮개 미설치", workName: "A동 2층 슬라브 배근", date: "2026-05-04" },
        { id: 2, level: "중", category: "비계", subCategory: "상부 자재 낙하 위험", workName: "B동 외부 비계 설치", date: "2026-05-03" },
        { id: 3, level: "상", category: "전기", subCategory: "가설 분전반 접지 불량", workName: "C동 지하 전기 배관", date: "2026-05-02" },
    ] as RiskCard[],
    summary: "이번 달은 총 16건의 TBM 회의록이 작성되어 현장 소통이 꾸준히 이행되었습니다. 고소작업 추락 위험이 반복적으로 지적되어 안전대 체결과 작업발판 점검 강화가 필요합니다. 다음 달에는 중량물 취급 시 신호수 배치를 정착시킬 것을 권고합니다.",
}

const monthLabel = (m: string) => `${m.slice(0, 4)}년 ${parseInt(m.slice(5, 7), 10)}월`

export default function AnalyticsDashboardPage() {
    const router = useRouter()
    useRequireSubscription()

    const [checking, setChecking] = useState(true)
    const [pro, setPro] = useState(false)
    const [uid, setUid] = useState<string | null>(null)
    // 월 옵션용 전체 날짜(경량) + 선택 월 상세(hazards 포함)만 별도 보관 —
    // 전체 이력을 hazards째 내려받으면 장기 사용자에서 수 MB + PostgREST 1000행 캡 절단 위험.
    const [minuteDates, setMinuteDates] = useState<string[]>([])
    const [monthRows, setMonthRows] = useState<any[]>([])
    const monthCacheRef = useRef<Map<string, any[]>>(new Map())
    const [selectedKey, setSelectedKey] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` })
    const [aiSummary, setAiSummary] = useState("")
    const [loadingAI, setLoadingAI] = useState(false)

    const loadMonth = useCallback(async (userId: string, key: string) => {
        const cached = monthCacheRef.current.get(key)
        if (cached) { setMonthRows(cached); return }
        const [y, m] = key.split("-").map(Number)
        const nextMonth = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`
        const { data } = await supabase
            .from("tbm_minutes")
            .select("id, date, hazards, work_name, process_name")
            .eq("user_id", userId)
            .gte("date", `${key}-01`)
            .lt("date", nextMonth)
        const rows = data || []
        monthCacheRef.current.set(key, rows)
        setMonthRows(rows)
    }, [])

    useEffect(() => {
        ;(async () => {
            const { data: { user } } = await supabase.auth.getUser()
            const p = isProActive(await fetchSubscription())
            setPro(p)
            if (p && user) {
                setUid(user.id)
                // fetchAllRows = PostgREST 1000행 침묵 절단 방지 (월 옵션이 오래된 달을 잃지 않게)
                const rows = await fetchAllRows<{ date: string | null }>((f, t) =>
                    supabase.from("tbm_minutes").select("date").eq("user_id", user.id).order("id").range(f, t)
                )
                setMinuteDates(rows.map(r => r.date || "").filter(Boolean))
            }
            setChecking(false)
        })()
    }, [])

    // 선택 월 변경 시 그 달 상세만 조회(월별 캐시)
    useEffect(() => {
        if (pro && uid) loadMonth(uid, selectedKey)
    }, [pro, uid, selectedKey, loadMonth])

    // 선택 월 집계 (Pro=실데이터 / 베이직=샘플)
    const computed = useMemo(() => (pro ? computeMonth(monthRows, selectedKey) : SAMPLE), [pro, monthRows, selectedKey])
    const { stats, keywords, cards } = computed

    // AI 총평 — 집계 시그니처가 캐시와 다를 때만 재호출
    useEffect(() => {
        if (checking) return
        if (!pro) { setAiSummary(SAMPLE.summary); return }
        const facts = { total: stats.total, high: stats.high, mid: stats.mid, topHazards: keywords }
        if (facts.total === 0) { setAiSummary(""); return }
        const signature = JSON.stringify(facts)
        let cancelled = false
        ;(async () => {
            setLoadingAI(true)
            try {
                const { data: s } = await supabase.auth.getSession()
                const [year, month] = selectedKey.split("-").map(Number)
                const res = await fetch("/api/analytics/minutes-insight", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s?.session?.access_token}` },
                    body: JSON.stringify({ year, month, signature, facts }),
                })
                const j = await res.json()
                if (!cancelled) setAiSummary(res.ok ? (j.summary || "") : "")
            } finally {
                if (!cancelled) setLoadingAI(false)
            }
        })()
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [checking, pro, selectedKey, monthRows])

    // 월 옵션 (데이터가 있는 달 + 이번 달, 최신순)
    const monthOptions = (() => {
        const cur = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` })()
        const set = new Set<string>([cur])
        for (const d of minuteDates) { const k = d.slice(0, 7); if (k) set.add(k) }
        return [...set].sort().reverse()
    })()

    const getLevelStyle = (level: string) => {
        switch (level) {
            case "상": return "bg-cur-error/15 text-cur-error border-cur-error/30"
            case "중": return "bg-cur-primary/15 text-cur-primary border-cur-primary/30"
            case "하": return "bg-cur-success/15 text-cur-success border-cur-success/30"
            default: return "bg-cur-elevated text-cur-muted"
        }
    }
    const topWords = keywords.slice(0, 2).map((k) => k.word)

    if (checking) return <div className="min-h-screen flex items-center justify-center bg-cur-canvas"><Loader2 className="w-10 h-10 text-cur-primary animate-spin" /></div>

    return (
        <div className="bg-cur-canvas min-h-screen sm:py-8 flex sm:block items-center justify-center font-sans text-cur-body pb-20">
            <div className="max-w-lg w-full mx-auto bg-cur-card sm:rounded-[12px] relative flex flex-col min-h-[100dvh] sm:min-h-[85vh] border-x sm:border border-cur-hairline mb-[env(safe-area-inset-bottom)] overflow-hidden">

                <div className="p-4 bg-cur-card border-b border-cur-hairline sticky top-0 z-50">
                    <TBMHeader title="TBM 회의록 종합분석" pageBadge={pro ? undefined : "예시"} />
                </div>

                <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">

                    {!pro && (
                        <div className="rounded-[12px] bg-cur-primary/[0.06] border border-cur-primary/30 p-4 space-y-2">
                            <p className="text-[13px] text-cur-primary font-semibold flex items-center gap-1.5"><Sparkles className="w-4 h-4" /> 예시 화면입니다</p>
                            <p className="text-[12px] text-cur-muted leading-relaxed">아래 수치는 샘플이에요. Pro 구독 시 내가 작성한 TBM 회의록을 월별로 분석해 핵심 위험 키워드와 AI 총평을 보여드립니다.</p>
                            <Button onClick={() => router.push("/pricing")} className="w-full h-10 rounded-[8px] bg-cur-primary text-white text-[14px] font-bold hover:opacity-90">Pro 플랜 보기</Button>
                        </div>
                    )}

                    {/* 월 선택 */}
                    <div className="flex items-center justify-between">
                        <h2 className="text-[15px] font-bold text-cur-ink">월간 회의록 분석</h2>
                        {pro ? (
                            <Select value={selectedKey} onValueChange={setSelectedKey}>
                                <SelectTrigger className="h-9 w-auto gap-1 text-[13px] border-cur-hairline rounded-[8px] bg-cur-card text-cur-ink px-3 focus:ring-1 focus:ring-cur-primary"><SelectValue /></SelectTrigger>
                                <SelectContent className="bg-cur-card border-cur-hairline text-cur-body max-h-64">
                                    {monthOptions.map((m) => <SelectItem key={m} value={m}>{monthLabel(m)}</SelectItem>)}
                                </SelectContent>
                            </Select>
                        ) : (
                            <span className="text-[13px] text-cur-muted font-medium px-3 py-1.5 rounded-[8px] bg-cur-elevated">{monthLabel(selectedKey)}</span>
                        )}
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                        <div className="bg-cur-card p-4 rounded-[8px] border border-cur-hairline text-center">
                            <div className="text-[12px] text-cur-muted font-medium mb-1">총 회의록</div>
                            <div className="text-[24px] font-bold text-cur-ink font-mono">{stats.total}<span className="text-[14px] font-medium text-cur-muted ml-1">건</span></div>
                        </div>
                        <div className="bg-cur-error/10 p-4 rounded-[8px] border border-cur-error/20 text-center">
                            <div className="text-[12px] text-cur-error font-medium mb-1">위험성 (상)</div>
                            <div className="text-[24px] font-bold text-cur-error font-mono">{stats.high}<span className="text-[14px] font-medium text-cur-error/70 ml-1">건</span></div>
                        </div>
                        <div className="bg-cur-primary/10 p-4 rounded-[8px] border border-cur-primary/20 text-center">
                            <div className="text-[12px] text-cur-primary font-medium mb-1">위험성 (중)</div>
                            <div className="text-[24px] font-bold text-cur-primary font-mono">{stats.mid}<span className="text-[14px] font-medium text-cur-primary/70 ml-1">건</span></div>
                        </div>
                    </div>

                    {/* AI 총평 */}
                    <div className="bg-cur-card p-5 rounded-[12px] border border-cur-hairline">
                        <h2 className="text-[15px] font-bold text-cur-ink flex items-center gap-1.5 mb-2"><Sparkles className="w-4 h-4 text-cur-primary" /> AI 안전 총평</h2>
                        {loadingAI ? (
                            <div className="flex items-center gap-2 text-cur-muted text-[13px] py-2"><Loader2 className="w-4 h-4 animate-spin" /> 분석 중…</div>
                        ) : aiSummary ? (
                            <p className="text-[14px] text-cur-body leading-[1.7] whitespace-pre-line">{aiSummary}</p>
                        ) : (
                            <p className="text-[13px] text-cur-muted-soft">이 달에는 분석할 회의록이 없습니다.</p>
                        )}
                    </div>

                    <div className="space-y-4">
                        <h2 className="text-[18px] font-bold text-cur-ink flex items-center gap-2"><Hash className="w-5 h-5 text-cur-primary" /> 핵심 위험 키워드</h2>
                        <div className="bg-cur-card p-5 rounded-[12px] border border-cur-hairline">
                            {keywords.length === 0 ? (
                                <p className="text-[13px] text-cur-muted-soft">집계된 위험 키워드가 없습니다. TBM 회의록을 작성하면 표시됩니다.</p>
                            ) : (
                                <>
                                    <div className="flex flex-wrap gap-2">
                                        {keywords.map((kw, idx) => (
                                            <div key={idx} className="flex items-center gap-1.5 bg-cur-elevated px-3 py-1.5 rounded-full border border-cur-hairline">
                                                <span className="text-[14px] font-semibold text-cur-ink">#{kw.word}</span>
                                                <span className="text-[12px] text-cur-muted font-medium">({kw.count})</span>
                                                {kw.trend === "up" && <TrendingUp className="w-3.5 h-3.5 text-cur-error ml-0.5" />}
                                            </div>
                                        ))}
                                    </div>
                                    {topWords.length > 0 && (
                                        <p className="text-[13px] text-cur-muted mt-4 leading-relaxed">
                                            <span className="font-semibold text-cur-error">{topWords[0]}</span>{topWords[1] && <> 및 <span className="font-semibold text-cur-error">{topWords[1]}</span></>} 관련 위험요인의 언급 빈도가 가장 높습니다. 해당 작업 전 집중 안전점검이 필요합니다.
                                        </p>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                    <div className="space-y-4">
                        <h2 className="text-[18px] font-bold text-cur-ink flex items-center gap-2"><Activity className="w-5 h-5 text-cur-primary" /> 주요 위험요인</h2>
                        {cards.length === 0 ? (
                            <div className="bg-cur-card p-8 rounded-[12px] border border-cur-hairline text-center text-[13px] text-cur-muted-soft">이 달에 작성된 회의록 위험요인이 없습니다.</div>
                        ) : (
                            <div className="space-y-3">
                                {cards.map((risk) => (
                                    <div
                                        key={risk.id}
                                        onClick={() => risk.minuteId && router.push(`/report/minutes/${risk.minuteId}`)}
                                        className={`bg-cur-card p-4 rounded-[12px] border border-cur-hairline ${risk.minuteId ? "cursor-pointer hover:border-cur-primary/40 active:scale-[0.99] transition-all" : ""}`}
                                    >
                                        <div className="flex justify-between items-start mb-3">
                                            <div className="flex items-center gap-2">
                                                <Badge variant="outline" className={getLevelStyle(risk.level)}>위험 {risk.level}</Badge>
                                                <span className="text-[13px] font-semibold text-cur-muted">{risk.category}</span>
                                            </div>
                                            <div className="text-[12px] text-cur-muted">{risk.date}</div>
                                        </div>
                                        <div className="flex items-end justify-between gap-2">
                                            <div className="min-w-0">
                                                <h3 className="text-[16px] font-bold text-cur-ink mb-1">{risk.subCategory}</h3>
                                                <p className="text-[14px] text-cur-muted-soft truncate">{risk.workName}</p>
                                            </div>
                                            {risk.minuteId && (
                                                <span className="flex items-center text-[12px] text-cur-primary font-semibold shrink-0">보고서 <ChevronRight className="w-4 h-4" /></span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                </div>
            </div>
        </div>
    )
}
