"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { fetchSubscription, isProActive } from "@/lib/useSubscription"
import { TBMHeader } from "@/components/TBMHeader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DateRange } from "react-day-picker"
import { Loader2 } from "lucide-react"
import { format, parseISO, isWithinInterval, startOfDay, endOfDay, startOfMonth, startOfWeek, endOfMonth, subMonths } from "date-fns"

interface RiskItem {
    hazard: string
    cause: string
    frequency: number
    severity: number
    risk: number
    level: string
    measures: string
    recurring?: boolean
}

const LEVEL_STYLE: Record<string, string> = {
    "매우높음": "bg-red-100 text-red-700",
    "높음": "bg-orange-100 text-orange-700",
    "보통": "bg-yellow-100 text-yellow-700",
    "낮음": "bg-green-100 text-green-700",
}

function levelFromRisk(risk: number): string {
    if (risk >= 15) return "매우높음"
    if (risk >= 9) return "높음"
    if (risk >= 4) return "보통"
    return "낮음"
}

// 기간 프리셋 (달력 대신 버튼 선택) — 위험성평가는 최대 1개월까지만
const PRESETS: { key: string; label: string; range: () => DateRange }[] = [
    { key: "week", label: "이번 주", range: () => ({ from: startOfWeek(new Date(), { weekStartsOn: 1 }), to: new Date() }) },
    { key: "month", label: "이번 달", range: () => ({ from: startOfMonth(new Date()), to: new Date() }) },
    { key: "lastmonth", label: "지난 달", range: () => ({ from: startOfMonth(subMonths(new Date(), 1)), to: endOfMonth(subMonths(new Date(), 1)) }) },
]

const SAMPLE_ITEMS: RiskItem[] = [
    { hazard: "고소작업 중 추락", cause: "여러 날 반복된 비계·고소 작업, 안전대 미체결", frequency: 4, severity: 5, risk: 20, level: "매우높음", measures: "안전대 100% 체결, 작업발판·안전난간 점검, 추락방지망 설치", recurring: true },
    { hazard: "중량물 취급 중 협착·끼임", cause: "자재 인양·운반 작업 반복", frequency: 3, severity: 4, risk: 12, level: "높음", measures: "신호수 배치, 인양구 결속 확인, 하부 출입통제", recurring: true },
    { hazard: "전동공구 사용 중 감전", cause: "누전·피복 손상, 우천 시 작업", frequency: 2, severity: 4, risk: 8, level: "보통", measures: "누전차단기 설치, 공구 절연 점검, 젖은 손 사용 금지", recurring: false },
    { hazard: "정리정돈 미흡으로 전도", cause: "자재·공구 적치, 통로 미확보", frequency: 3, severity: 2, risk: 6, level: "보통", measures: "통로 확보, 적치장 분리, 작업 후 정리정돈", recurring: false },
    { hazard: "분진·소음 노출", cause: "절단·천공 작업 반복", frequency: 3, severity: 2, risk: 6, level: "보통", measures: "방진마스크·귀마개 착용, 습식 작업, 작업시간 관리", recurring: false },
]

function exportCsv(items: RiskItem[], meta: { period: string; company: string; date: string }) {
    const header = ["No", "반복", "유해·위험요인", "발생 원인", "가능성", "중대성", "위험성", "등급", "감소대책"]
    const rows = items.map((it, i) => [i + 1, it.recurring ? "반복" : "", it.hazard, it.cause, it.frequency, it.severity, it.risk, it.level, it.measures])
    const top = [["위험성평가표"], ["현장/업체", meta.company || "-", "대상기간", meta.period, "작성일", meta.date], [], header, ...rows]
    const csv = top.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n")
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url; a.download = `위험성평가_${meta.date}.csv`; a.click()
    URL.revokeObjectURL(url)
}

function Steps({ step }: { step: number }) {
    const labels = ["기간 선택", "결과 확인", "내보내기"]
    return (
        <div className="flex items-center gap-1.5">
            {labels.map((l, i) => {
                const n = i + 1
                const active = step === n
                const done = step > n
                return (
                    <div key={l} className="flex items-center gap-1.5">
                        <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[12px] font-semibold ${active ? "bg-cur-primary text-white" : done ? "bg-cur-primary/15 text-cur-primary" : "bg-cur-elevated text-cur-muted"}`}>
                            <span className={`w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] ${active ? "bg-white/25" : done ? "bg-cur-primary/20" : "bg-cur-hairline"}`}>{n}</span>
                            {l}
                        </div>
                        {i < labels.length - 1 && <span className="text-cur-muted-soft text-[12px]">›</span>}
                    </div>
                )
            })}
        </div>
    )
}

export default function RiskAssessmentPage() {
    const router = useRouter()
    const [checking, setChecking] = useState(true)
    const [pro, setPro] = useState(false)
    const [companyName, setCompanyName] = useState("")
    const today = format(new Date(), "yyyy-MM-dd")

    const [step, setStep] = useState<0 | 1 | 2 | 3>(1)
    const [analyzing, setAnalyzing] = useState(false)
    const [range, setRange] = useState<DateRange | undefined>()
    const [preset, setPreset] = useState<string | null>(null)
    const [items, setItems] = useState<RiskItem[]>([])
    const [periodLabel, setPeriodLabel] = useState("")
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
    const [tbmDates, setTbmDates] = useState<string[]>([])

    // 보고서 보내기 (step 3)
    const [reportEmail, setReportEmail] = useState("")
    const [sending, setSending] = useState(false)
    const [sendMsg, setSendMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
    // 같은 기간 안전보건교육일지 통계 (회의록 위험성평가와 함께 메일 발송)
    const [eduStats, setEduStats] = useState<{ sessions: number; days: number; headcount: number; avg: string } | null>(null)


    useEffect(() => {
        ;(async () => {
            const { data: { user } } = await supabase.auth.getUser()
            if (!user) { router.replace("/login"); return }
            const s = await fetchSubscription()
            const p = isProActive(s)
            setPro(p)
            if (!p) setStep(0) // 베이직: 설명 화면 먼저
            setCompanyName(user.user_metadata?.company_name || "")
            await loadTbmDates() // 달력 점 표시는 모두에게
            setChecking(false)

            // 안전문서 달력에서 기간을 골라 넘어온 경우 → 재선택 없이 바로 분석
            try {
                const raRange = localStorage.getItem("ra_range")
                if (raRange) {
                    localStorage.removeItem("ra_range")
                    const { from, to } = JSON.parse(raRange)
                    if (from) {
                        const rng = { from: parseISO(from), to: to ? parseISO(to) : parseISO(from) }
                        setRange(rng)
                        setPreset(null)
                        analyze(rng, p)
                    }
                }
            } catch { /* 무시 */ }
        })()
    }, [router])

    const loadTbmDates = async () => {
        // 위험성평가는 TBM 회의록(minutes)만 분석 — 안전보건교육일지는 제외
        const { data: m } = await supabase.from("tbm_minutes").select("date").order("date", { ascending: false }).limit(300)
        const dates = new Set<string>()
        for (const r of (m as any[]) || []) if (r.date) dates.add(r.date)
        setTbmDates([...dates])
    }

    const countInRange = (): number => {
        if (!range?.from) return 0
        const from = startOfDay(range.from)
        const to = endOfDay(range.to ?? range.from)
        return tbmDates.filter((d) => isWithinInterval(parseISO(d), { start: from, end: to })).length
    }

    const buildRangeContext = async (fromS: string, toS: string): Promise<string> => {
        // 위험성평가는 TBM 회의록(minutes)만 분석 — 안전보건교육일지(tbm_logs) 제외
        const { data: minutes } = await supabase
            .from("tbm_minutes")
            .select("date, process_name, work_name, work_content, hazards, instructions, safety_phrase, ppe_check")
            .gte("date", fromS).lte("date", toS).order("date")
        const blocks: string[] = []
        for (const m of (minutes as any[]) || []) {
            const hz = Array.isArray(m.hazards) ? m.hazards : []
            const hzText = hz.map((h: any) => `- ${h?.factor ?? ""}${h?.level ? ` (위험도: ${h.level})` : ""}${h?.measure ? ` → 대책: ${h.measure}` : ""}`).filter((s: string) => s.trim() !== "-").join("\n")
            blocks.push(`=== TBM (${m.date}, 회의록) ===\n` + [
                m.process_name && `공정: ${m.process_name}`, m.work_name && `작업명: ${m.work_name}`,
                m.work_content && `작업내용: ${m.work_content}`, m.ppe_check && `보호구: ${m.ppe_check}`,
                hzText && `논의된 위험요인:\n${hzText}`, m.instructions && `지시사항: ${m.instructions}`,
            ].filter(Boolean).join("\n"))
        }
        let text = blocks.join("\n\n")
        if (text.length > 11000) text = text.slice(0, 11000)
        return text
    }

    // 같은 기간 안전보건교육일지(tbm_logs) 통계 — 미리보기 + 발송 여부 판단용 (RLS로 본인 데이터만)
    const loadEduStats = async (fromS: string, toS: string) => {
        const { data: rows } = await supabase.from("tbm_logs").select("id, date").gte("date", fromS).lte("date", toS)
        const logs = (rows as { id: string; date: string }[]) || []
        const sessions = logs.length
        const days = new Set(logs.map((l) => l.date)).size
        let headcount = 0
        if (sessions > 0) {
            const ids = logs.map((l) => l.id)
            const { count } = await supabase.from("tbm_participants").select("id", { count: "exact", head: true }).in("log_id", ids)
            headcount = count ?? 0
        }
        const avg = sessions ? (headcount / sessions).toFixed(1) : "0.0"
        setEduStats({ sessions, days, headcount, avg })
    }

    const analyze = async (rangeArg?: DateRange, proArg?: boolean) => {
        const r = rangeArg ?? range
        const isPro = proArg ?? pro
        if (!r?.from) { setMsg({ type: "err", text: "기간을 선택해주세요." }); return }
        setMsg(null)
        const fromS = format(r.from, "yyyy-MM-dd")
        const toS = format(r.to ?? r.from, "yyyy-MM-dd")
        const label = fromS === toS ? fromS : `${fromS} ~ ${toS}`
        setAnalyzing(true)
        try {
            // 베이직: 체험(더미 결과). Pro: 실제 AI 분석
            if (!isPro) {
                await new Promise((r) => setTimeout(r, 1500))
                setItems(SAMPLE_ITEMS)
                setPeriodLabel(label)
                setSendMsg(null)
                setStep(2)
                return
            }

            const content = await buildRangeContext(fromS, toS)
            if (!content.trim()) { setMsg({ type: "err", text: "선택한 기간에 작성된 TBM이 없습니다." }); return }
            const { data: sessionData } = await supabase.auth.getSession()
            const token = sessionData?.session?.access_token
            const res = await fetch("/api/ai/risk-assessment", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ workName: `${label} 종합`, workContent: content }),
            })
            const json = await res.json()
            if (!res.ok) { setMsg({ type: "err", text: json.error || "분석 실패" }); return }
            setItems(json.items as RiskItem[])
            setPeriodLabel(label)
            setSendMsg(null)
            await loadEduStats(fromS, toS)
            setStep(2)
        } catch {
            setMsg({ type: "err", text: "AI 분석 중 오류가 발생했습니다." })
        } finally {
            setAnalyzing(false)
        }
    }

    const updateItem = (idx: number, patch: Partial<RiskItem>) => {
        setItems((prev) => prev.map((it, i) => {
            if (i !== idx) return it
            const next = { ...it, ...patch }
            next.risk = next.frequency * next.severity
            next.level = levelFromRisk(next.risk)
            return next
        }))
    }
    const addRow = () => setItems((prev) => [...prev, { hazard: "", cause: "", frequency: 1, severity: 1, risk: 1, level: "낮음", measures: "", recurring: false }])

    const sendReport = async () => {
        const recipients = reportEmail.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
        if (recipients.length === 0) { setSendMsg({ type: "err", text: "받는 사람 이메일을 입력해주세요." }); return }
        setSending(true); setSendMsg(null)
        try {
            // 베이직 체험: 실제 발송하지 않음
            if (!pro) {
                await new Promise((r) => setTimeout(r, 800))
                setSendMsg({ type: "ok", text: `체험 모드 — Pro에서는 ${recipients.length}곳으로 엑셀 첨부 메일이 실제 발송됩니다.` })
                return
            }
            const { data: sessionData } = await supabase.auth.getSession()
            const headers = { "Content-Type": "application/json", Authorization: `Bearer ${sessionData?.session?.access_token}` }
            const fromS = range?.from ? format(range.from, "yyyy-MM-dd") : undefined
            const toS = range?.from ? format(range.to ?? range.from, "yyyy-MM-dd") : undefined
            const hasEdu = !!(eduStats && eduStats.sessions > 0) && !!fromS

            // 메일 2개 동시 발송: ① 회의록 분석·위험성평가  ② 안전보건교육일지 종합(교육일지가 있을 때만)
            const [r1, r2] = await Promise.all([
                fetch("/api/reports/risk-assessment/send", {
                    method: "POST", headers,
                    body: JSON.stringify({ items, period: `${periodLabel} 종합`, company: companyName, recipients, from: fromS, to: toS }),
                }),
                hasEdu
                    ? fetch("/api/reports/education/send", {
                        method: "POST", headers,
                        body: JSON.stringify({ company: companyName, recipients, from: fromS, to: toS }),
                    })
                    : Promise.resolve(null),
            ])

            const j1 = await r1.json().catch(() => ({}))
            const ok1 = r1.ok
            let ok2 = false, eduSent = false
            if (r2) { const j2 = await r2.json().catch(() => ({})); ok2 = r2.ok; eduSent = ok2 && (j2.sent ?? 0) > 0 }

            if (!ok1 && !eduSent) { setSendMsg({ type: "err", text: j1.error || "발송 실패" }); return }
            const parts: string[] = []
            if (ok1) parts.push("회의록 분석·위험성평가")
            if (eduSent) parts.push("안전보건교육일지 종합")
            setSendMsg({
                type: "ok",
                text: `${recipients.length}곳으로 ${parts.join(" + ")} 메일${parts.length > 1 ? " 2개" : ""}를 발송했습니다.${hasEdu && !eduSent ? " (교육 메일은 실패)" : ""}`,
            })
        } finally { setSending(false) }
    }

    const restart = () => { setStep(1); setItems([]); setMsg(null); setSendMsg(null) }

    if (checking) return <div className="min-h-screen flex items-center justify-center bg-cur-canvas"><Loader2 className="w-10 h-10 text-cur-primary animate-spin" /></div>

    const recurringCount = items.filter((it) => it.recurring).length

    // 같은 기간 교육일지 미리보기 (회의록 위험성평가와 함께 발송) — step 2·3 공용
    const eduPreview = eduStats && eduStats.sessions > 0 ? (
        <div className="bg-cur-card rounded-2xl p-5 border border-cur-hairline space-y-3">
            <div className="flex items-center justify-between">
                <h3 className="font-bold text-[16px]">안전보건교육일지 종합</h3>
                <span className="text-[11px] font-bold text-cur-primary bg-cur-primary/[0.08] px-2 py-1 rounded-full">메일 함께 발송</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
                {[
                    { label: "교육 횟수", value: eduStats.sessions, unit: "회" },
                    { label: "교육 일수", value: eduStats.days, unit: "일" },
                    { label: "연인원", value: eduStats.headcount, unit: "명" },
                    { label: "평균 인원", value: eduStats.avg, unit: "명/회" },
                ].map((st) => (
                    <div key={st.label} className="bg-cur-canvas-soft border border-cur-hairline rounded-[8px] p-3 text-center">
                        <div className="text-[11px] text-cur-muted mb-1">{st.label}</div>
                        <div className="text-[18px] font-bold text-cur-ink font-mono">{st.value}<span className="text-[11px] text-cur-muted font-medium ml-0.5">{st.unit}</span></div>
                    </div>
                ))}
            </div>
            <p className="text-[12px] text-cur-muted-soft">날짜별 AI 교육 요약·주제 키워드가 담긴 보고서가 메일로 함께 발송됩니다. (결재서류 PDF + 엑셀)</p>
        </div>
    ) : null

    return (
        <div className="min-h-screen bg-cur-canvas pb-24 font-sans text-cur-ink">
            <div className="max-w-md mx-auto min-h-screen bg-cur-card shadow-sm border-x border-cur-hairline overflow-hidden flex flex-col">
                <div className="p-4 border-b border-cur-hairline bg-cur-card sticky top-0 z-10 print:hidden">
                    <TBMHeader
                        title="위험성평가"
                        backHref="/dashboard"
                        pageBadge={pro ? undefined : "체험"}
                    />
                </div>

                <div className="p-5 space-y-5 flex-1 bg-cur-canvas-soft">
                    {step >= 1 && <div className="print:hidden"><Steps step={analyzing ? 2 : step} /></div>}

                    {msg && <div className={`text-[14px] rounded-xl p-4 ${msg.type === "ok" ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-error/10 text-cur-error"}`}>{msg.text}</div>}

                    {/* STEP 0: 베이직 설명/체험 안내 */}
                    {!analyzing && step === 0 && (
                        <div className="space-y-5">
                            <div className="text-center space-y-3 pt-6">
                                <h2 className="text-[22px] font-bold">TBM 종합 위험성평가</h2>
                                <p className="text-cur-muted text-[14px] leading-relaxed">
                                    기간만 선택하면 그 기간의 TBM을 AI가 분석해<br />
                                    위험성평가표를 자동으로 만들어줍니다.
                                </p>
                            </div>

                            <div className="bg-cur-card rounded-2xl border border-cur-hairline divide-y divide-cur-hairline">
                                {[
                                    { t: "기간만 선택", d: "이번 달·3개월·6개월 또는 직접 기간 지정" },
                                    { t: "AI가 종합 분석", d: "중복 위험은 통합, 반복 위험은 따로 표시" },
                                    { t: "엑셀·PDF·메일 발송", d: "사장·안전보건 담당자에게 바로 제출" },
                                ].map((f, i) => (
                                    <div key={i} className="flex items-start gap-3 p-4">
                                        <div className="w-6 h-6 rounded-full bg-cur-primary/15 text-cur-primary text-[12px] font-bold flex items-center justify-center shrink-0">{i + 1}</div>
                                        <div>
                                            <div className="font-semibold text-[14px] text-cur-ink">{f.t}</div>
                                            <div className="text-[13px] text-cur-muted-soft">{f.d}</div>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            <div className="space-y-2">
                                <Button onClick={() => setStep(1)} className="w-full h-12 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90">
                                    체험해보기
                                </Button>
                                <p className="text-[12px] text-cur-muted-soft text-center">Pro 4,900원/월 · 첫 달 무료 · 위험성평가 + 월간 보고서</p>
                            </div>
                        </div>
                    )}

                    {/* 분석 중 */}
                    {analyzing && (
                        <div className="bg-cur-card rounded-2xl p-10 border border-cur-hairline text-center space-y-4">
                            <Loader2 className="w-12 h-12 text-cur-primary animate-spin mx-auto" />
                            <div>
                                <p className="text-[17px] font-bold text-cur-ink">분석 중입니다…</p>
                                <p className="text-[14px] text-cur-muted mt-1">TBM 내용을 분석해 위험성평가를 만들고 있어요.<br />잠시 기다려 주세요. (10~20초)</p>
                            </div>
                        </div>
                    )}

                    {/* STEP 1: 기간 선택 (프리셋 버튼) */}
                    {!analyzing && step === 1 && (
                        <div className="space-y-4">
                            <p className="text-[15px] font-semibold text-cur-ink px-1">보고서를 생성할 기간을 선택하세요</p>

                            <div className="grid grid-cols-2 gap-2">
                                {PRESETS.map((p) => (
                                    <Button
                                        key={p.key}
                                        variant="outline"
                                        onClick={() => { setRange(p.range()); setPreset(p.key) }}
                                        className={`h-12 rounded-[8px] text-[14px] font-medium border ${preset === p.key ? "border-cur-primary bg-cur-primary/[0.06] text-cur-primary" : "border-cur-hairline text-cur-ink"}`}
                                    >
                                        {p.label}
                                    </Button>
                                ))}
                            </div>

                            {range?.from && (
                                <div className="bg-cur-card border border-cur-hairline rounded-[12px] p-4 space-y-3">
                                    <div className="flex justify-between items-center">
                                        <div className="font-semibold text-[15px] text-cur-ink">
                                            {format(range.from, "yyyy.MM.dd")} ~ {format(range.to ?? range.from, "yyyy.MM.dd")}
                                        </div>
                                        <span className="text-[13px] text-cur-muted">TBM {countInRange()}건</span>
                                    </div>
                                    <Button onClick={() => analyze()} className="w-full bg-cur-primary text-white hover:bg-cur-primary-active h-11 text-[14px] font-medium rounded-[8px]">
                                        다음: AI 분석
                                    </Button>
                                </div>
                            )}
                        </div>
                    )}

                    {/* STEP 2: 결과 확인·수정 (표만) */}
                    {!analyzing && step === 2 && (
                        <div className="space-y-4">
                            <div className="flex items-center justify-between gap-2">
                                <Button variant="ghost" onClick={restart} className="text-cur-muted hover:text-cur-ink h-9 px-2">← 기간 다시</Button>
                                <span className="text-[13px] text-cur-muted">내용을 확인·수정하세요</span>
                            </div>

                            <div className="bg-cur-card rounded-2xl p-5 border border-cur-hairline space-y-4">
                                <div>
                                    <h3 className="font-bold text-[16px]">{periodLabel} 종합 위험성평가 ({items.length}건)</h3>
                                    {recurringCount > 0 && (
                                        <div className="mt-2 text-[13px] text-cur-primary bg-cur-primary/[0.06] rounded-lg px-3 py-2">
                                            반복 위험요인 {recurringCount}건 — 여러 TBM에서 반복 등장, 우선 관리 대상
                                        </div>
                                    )}
                                </div>

                                <div className="overflow-x-auto rounded-xl border border-cur-hairline">
                                    <table className="border-collapse min-w-[680px] w-full text-[13px]">
                                        <thead>
                                            <tr className="bg-cur-elevated/60 text-cur-muted text-[12px]">
                                                <th className="border border-cur-hairline px-2 py-2 text-center w-8">No</th>
                                                <th className="border border-cur-hairline px-2 py-2 text-left">유해·위험요인 / 원인</th>
                                                <th className="border border-cur-hairline px-1 py-2 text-center w-12">가능성</th>
                                                <th className="border border-cur-hairline px-1 py-2 text-center w-12">중대성</th>
                                                <th className="border border-cur-hairline px-2 py-2 text-center w-20">위험성</th>
                                                <th className="border border-cur-hairline px-2 py-2 text-left">감소대책</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {items.map((it, idx) => (
                                                <tr key={idx} className="align-top">
                                                    <td className="border border-cur-hairline px-1 py-2 text-center text-cur-muted-soft">{idx + 1}</td>
                                                    <td className="border border-cur-hairline px-1 py-1">
                                                        {it.recurring && <span className="inline-block text-[10px] font-bold bg-cur-primary/15 text-cur-primary px-1.5 py-0.5 rounded-[4px] mb-1">반복</span>}
                                                        <input value={it.hazard} onChange={(e) => updateItem(idx, { hazard: e.target.value })} className="w-full bg-transparent font-medium text-cur-ink px-1 py-0.5 rounded focus:outline-none focus:bg-cur-primary/5" />
                                                        <textarea value={it.cause} onChange={(e) => updateItem(idx, { cause: e.target.value })} rows={2} className="w-full bg-transparent text-[12px] text-cur-muted-soft px-1 py-0.5 rounded resize-none focus:outline-none focus:bg-cur-primary/5" />
                                                    </td>
                                                    <td className="border border-cur-hairline px-0.5 py-1 text-center">
                                                        <input type="number" min={1} max={5} value={it.frequency} onChange={(e) => updateItem(idx, { frequency: Math.min(5, Math.max(1, Number(e.target.value) || 1)) })} className="w-10 bg-transparent text-center px-0.5 py-1 rounded focus:outline-none focus:bg-cur-primary/5" />
                                                    </td>
                                                    <td className="border border-cur-hairline px-0.5 py-1 text-center">
                                                        <input type="number" min={1} max={5} value={it.severity} onChange={(e) => updateItem(idx, { severity: Math.min(5, Math.max(1, Number(e.target.value) || 1)) })} className="w-10 bg-transparent text-center px-0.5 py-1 rounded focus:outline-none focus:bg-cur-primary/5" />
                                                    </td>
                                                    <td className="border border-cur-hairline px-1 py-2 text-center">
                                                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${LEVEL_STYLE[it.level] ?? "bg-gray-100 text-gray-600"}`}>{it.risk} · {it.level}</span>
                                                    </td>
                                                    <td className="border border-cur-hairline px-1 py-1">
                                                        <textarea value={it.measures} onChange={(e) => updateItem(idx, { measures: e.target.value })} rows={2} className="w-full bg-transparent text-cur-body px-1 py-0.5 rounded resize-none focus:outline-none focus:bg-cur-primary/5" />
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>

                                <Button variant="outline" onClick={addRow} className="w-full h-11 rounded-xl border-cur-hairline">항목 추가</Button>
                            </div>

                            {eduPreview}

                            <Button onClick={() => setStep(3)} className="w-full h-12 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90">
                                완료 — 내보내기
                            </Button>
                        </div>
                    )}

                    {/* STEP 3: 내보내기 */}
                    {!analyzing && step === 3 && (
                        <div className="space-y-4">
                            <div className="flex items-center justify-between gap-2 print:hidden">
                                <Button variant="ghost" onClick={() => setStep(2)} className="text-cur-muted hover:text-cur-ink h-9 px-2">← 결과 수정</Button>
                            </div>

                            {/* 확인용 읽기 전용 표 */}
                            <div className="bg-cur-card rounded-2xl p-5 border border-cur-hairline space-y-3">
                                <div>
                                    <h3 className="font-bold text-[16px]">{periodLabel} 종합 위험성평가</h3>
                                    <p className="text-[13px] text-cur-muted-soft mt-0.5">위험요인 {items.length}건{recurringCount > 0 ? ` · 반복 ${recurringCount}건` : ""}</p>
                                </div>
                                <div className="overflow-x-auto rounded-xl border border-cur-hairline">
                                    <table className="border-collapse min-w-[560px] w-full text-[13px]">
                                        <thead>
                                            <tr className="bg-cur-elevated/60 text-cur-muted text-[12px]">
                                                <th className="border border-cur-hairline px-2 py-2 text-left">유해·위험요인</th>
                                                <th className="border border-cur-hairline px-1 py-2 text-center w-20">위험성</th>
                                                <th className="border border-cur-hairline px-2 py-2 text-left">감소대책</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {items.map((it, idx) => (
                                                <tr key={idx} className="align-top">
                                                    <td className="border border-cur-hairline px-2 py-2 text-cur-ink font-medium">
                                                        {it.recurring && <span className="inline-block text-[10px] font-bold bg-cur-primary/15 text-cur-primary px-1.5 py-0.5 rounded-[4px] mr-1">반복</span>}
                                                        {it.hazard}
                                                        <div className="text-[11px] text-cur-muted-soft font-normal mt-0.5">{it.cause}</div>
                                                    </td>
                                                    <td className="border border-cur-hairline px-1 py-2 text-center">
                                                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${LEVEL_STYLE[it.level] ?? "bg-gray-100 text-gray-600"}`}>{it.risk} · {it.level}</span>
                                                    </td>
                                                    <td className="border border-cur-hairline px-2 py-2 text-cur-body">{it.measures}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            {eduPreview}

                            {/* 내보내기 액션 */}
                            <div className="bg-cur-card rounded-2xl p-5 border border-cur-hairline space-y-4 print:hidden">
                                <h3 className="font-bold text-[15px]">내보내기 / 제출</h3>
                                <div className="grid grid-cols-2 gap-2">
                                    <Button variant="outline" onClick={() => exportCsv(items, { period: periodLabel, company: companyName, date: today })} className="h-11 rounded-xl border-cur-hairline">엑셀로 내보내기</Button>
                                    <Button variant="outline" onClick={() => window.print()} className="h-11 rounded-xl border-cur-hairline">PDF로 내보내기</Button>
                                </div>

                                <div className="border-t border-cur-hairline pt-4 space-y-2">
                                    <h4 className="font-bold text-[14px]">이메일로 보고서 전송</h4>
                                    <div className="flex gap-2">
                                        <Input type="email" value={reportEmail} onChange={(e) => setReportEmail(e.target.value)} placeholder="이메일 (여러 명은 쉼표로 구분)" className="h-11" />
                                        <Button onClick={sendReport} disabled={sending} className="h-11 px-4 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90 shrink-0">
                                            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : "보내기"}
                                        </Button>
                                    </div>
                                    {sendMsg && <p className={`text-[13px] ${sendMsg.type === "ok" ? "text-cur-primary" : "text-cur-error"}`}>{sendMsg.text}</p>}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

        </div>
    )
}
