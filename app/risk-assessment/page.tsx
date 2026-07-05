"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { formatRangeLabelKo } from "@/lib/utils"
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
    // 이메일 형식 미리보기(회의록 종합분석 / 안전보건교육일지 종합분석) HTML
    const [minutesHtml, setMinutesHtml] = useState("")
    const [eduHtml, setEduHtml] = useState("")
    const [loadingPreviews, setLoadingPreviews] = useState(false)


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
        const label = formatRangeLabelKo(fromS, toS)
        setAnalyzing(true)
        try {
            // 베이직: 체험(더미 결과). Pro: 실제 AI 분석
            if (!isPro) {
                await new Promise((r) => setTimeout(r, 1200))
                setItems(SAMPLE_ITEMS)
                setPeriodLabel(label)
                setSendMsg(null)
                await loadPreviews(fromS, toS, SAMPLE_ITEMS)
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
            await loadPreviews(fromS, toS, json.items as RiskItem[])
            setStep(2)
        } catch {
            setMsg({ type: "err", text: "AI 분석 중 오류가 발생했습니다." })
        } finally {
            setAnalyzing(false)
        }
    }

    // 회의록·교육 이메일 형식 미리보기 HTML 로드 (분석 후)
    const loadPreviews = async (fromS: string, toS: string, riskItems: RiskItem[]) => {
        setLoadingPreviews(true)
        setMinutesHtml(""); setEduHtml("")
        try {
            const { data: s } = await supabase.auth.getSession()
            const headers = { "Content-Type": "application/json", Authorization: `Bearer ${s?.session?.access_token}` }
            const [mRes, eRes] = await Promise.all([
                fetch("/api/reports/minutes/render", { method: "POST", headers, body: JSON.stringify({ from: fromS, to: toS, items: riskItems }) }),
                fetch("/api/reports/education/render", { method: "POST", headers, body: JSON.stringify({ from: fromS, to: toS }) }),
            ])
            const mj = await mRes.json().catch(() => ({}))
            const ej = await eRes.json().catch(() => ({}))
            setMinutesHtml(mRes.ok ? (mj.html || "") : "")
            setEduHtml(eRes.ok ? (ej.html || "") : "")
        } finally {
            setLoadingPreviews(false)
        }
    }

    const sendReport = async () => {
        const recipients = reportEmail.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
        if (recipients.length === 0) { setSendMsg({ type: "err", text: "받는 사람 이메일을 입력해주세요." }); return }
        if (recipients.length > 5) { setSendMsg({ type: "err", text: "최대 5명까지 보낼 수 있어요." }); return }
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
            if (ok1) parts.push("회의록 AI 분석 보고서")
            if (eduSent) parts.push("안전보건교육일지 종합")
            setSendMsg({
                type: "ok",
                text: `${recipients.length}곳으로 ${parts.join(" + ")} 메일${parts.length > 1 ? " 2개" : ""}를 발송했습니다.${hasEdu && !eduSent ? " (교육 메일은 실패)" : ""}`,
            })
        } finally { setSending(false) }
    }

    const restart = () => { setStep(1); setItems([]); setMsg(null); setSendMsg(null) }

    if (checking) return <div className="min-h-screen flex items-center justify-center bg-cur-canvas"><Loader2 className="w-10 h-10 text-cur-primary animate-spin" /></div>

    // 이메일 형식 보고서 미리보기(회의록 종합분석 / 안전보건교육일지 종합분석) — 실제 발송 형식과 동일. step 2·3 공용
    const reportPreviews = (
        <div className="space-y-4">
            <div className="space-y-2">
                <h3 className="font-bold text-[15px] text-cur-ink">TBM 회의록 종합분석 <span className="text-[11px] font-medium text-cur-muted-soft">· 위험성평가표 포함</span></h3>
                <div className="relative h-[440px] border border-cur-hairline rounded-xl overflow-hidden bg-white">
                    {minutesHtml
                        ? <iframe title="회의록 종합분석" srcDoc={minutesHtml} className="w-full h-full" />
                        : <div className="absolute inset-0 flex items-center justify-center text-[13px] text-cur-muted-soft">{loadingPreviews ? <Loader2 className="w-6 h-6 animate-spin text-cur-muted" /> : "이 기간에 회의록이 없습니다."}</div>}
                </div>
            </div>
            {(loadingPreviews || eduHtml) && (
                <div className="space-y-2">
                    <h3 className="font-bold text-[15px] text-cur-ink">안전보건교육일지 종합분석</h3>
                    <div className="relative h-[440px] border border-cur-hairline rounded-xl overflow-hidden bg-white">
                        {eduHtml
                            ? <iframe title="안전보건교육일지 종합분석" srcDoc={eduHtml} className="w-full h-full" />
                            : <div className="absolute inset-0 flex items-center justify-center text-[13px] text-cur-muted-soft">{loadingPreviews ? <Loader2 className="w-6 h-6 animate-spin text-cur-muted" /> : "이 기간에 교육일지가 없습니다."}</div>}
                    </div>
                </div>
            )}
        </div>
    )

    return (
        <div className="min-h-screen bg-cur-canvas pb-24 font-sans text-cur-ink">
            <div className="max-w-md mx-auto min-h-screen bg-cur-card shadow-sm border-x border-cur-hairline overflow-hidden flex flex-col">
                <div className="p-4 border-b border-cur-hairline bg-cur-card sticky top-0 z-10 print:hidden">
                    <TBMHeader
                        title="AI 분석 보고서"
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
                                <h2 className="text-[22px] font-bold">TBM 종합 AI 분석 보고서</h2>
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
                                <p className="text-[12px] text-cur-muted-soft text-center">Pro 4,900원/월 · 첫 달 무료 · AI 분석 보고서 + 월간 보고서</p>
                            </div>
                        </div>
                    )}

                    {/* 분석 중 */}
                    {analyzing && (
                        <div className="bg-cur-card rounded-2xl p-10 border border-cur-hairline text-center space-y-4">
                            <Loader2 className="w-12 h-12 text-cur-primary animate-spin mx-auto" />
                            <div>
                                <p className="text-[17px] font-bold text-cur-ink">분석 중입니다…</p>
                                <p className="text-[14px] text-cur-muted mt-1">TBM 내용을 분석해 AI 분석 보고서를 만들고 있어요.<br />잠시 기다려 주세요. (10~20초)</p>
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

                    {/* STEP 2: 결과 확인 (실제 발송될 이메일 형식 미리보기) */}
                    {!analyzing && step === 2 && (
                        <div className="space-y-4">
                            <div className="flex items-center justify-between gap-2">
                                <Button variant="ghost" onClick={restart} className="text-cur-muted hover:text-cur-ink h-9 px-2">← 기간 다시</Button>
                                <span className="text-[13px] text-cur-muted">발송될 보고서를 확인하세요</span>
                            </div>

                            {reportPreviews}

                            <Button onClick={() => setStep(3)} className="w-full h-12 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90">
                                다음 — 내보내기 / 전송
                            </Button>
                        </div>
                    )}

                    {/* STEP 3: 내보내기 */}
                    {!analyzing && step === 3 && (
                        <div className="space-y-4">
                            <div className="flex items-center justify-between gap-2">
                                <Button variant="ghost" onClick={() => setStep(2)} className="text-cur-muted hover:text-cur-ink h-9 px-2">← 미리보기</Button>
                            </div>

                            {reportPreviews}

                            {/* 이메일로 보고서 전송 (회의록 종합 + 안전보건교육일지 종합, 메일 2개) */}
                            <div className="bg-cur-card rounded-2xl p-5 border border-cur-hairline space-y-2 print:hidden">
                                <h3 className="font-bold text-[15px]">이메일로 보고서 전송</h3>
                                <p className="text-[12px] text-cur-muted-soft">여러 명은 쉼표(,)로 구분해 최대 5명까지 보낼 수 있어요.</p>
                                <div className="flex gap-2">
                                    <Input type="email" value={reportEmail} onChange={(e) => setReportEmail(e.target.value)} placeholder="1safetalk@safe.com, 2safetalk@safe.com" className="h-11" />
                                    <Button onClick={sendReport} disabled={sending} className="h-11 px-4 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90 shrink-0">
                                        {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : "보내기"}
                                    </Button>
                                </div>
                                {sendMsg && <p className={`text-[13px] ${sendMsg.type === "ok" ? "text-cur-primary" : "text-cur-error"}`}>{sendMsg.text}</p>}
                            </div>
                        </div>
                    )}
                </div>
            </div>

        </div>
    )
}
