"use client"

// 보고서 설정 (안전관리자 전용) — 설정 미완료면 위저드(① 문서 형식 → ② 받는 사람),
// 완료하면 기존 2탭(발송 설정/받은 보고서) 화면. AI 분석 보고서는 이 설정을 끝내야 열린다.
// 병합 보고서는 매월 1일 cron이 owner 소유(monthly_reports)로 저장한다 (§7-1).
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { Loader2, FileBarChart2, ChevronRight, ExternalLink, CheckCircle2 } from "lucide-react"
import { useOrgContext } from "@/lib/useOrgContext"
import { ReportSettingsPanel } from "@/components/ReportSettingsPanel"
import { CompanyDocFormatCard } from "@/components/CompanyDocFormatCard"
import { fetchSubscription, isProActive } from "@/lib/useSubscription"

interface ReportRow {
    period_year: number
    period_month: number
    token: string
    sent_at: string | null
}

export default function OrgReportsPage() {
    const router = useRouter()
    const { ctx, loading: ctxLoading } = useOrgContext()
    const [rows, setRows] = useState<ReportRow[]>([])
    const [loading, setLoading] = useState(true)
    const [pro, setPro] = useState(false)
    // 발송 설정을 먼저 — 보고서는 매월 1일에만 쌓이는데, 들어와서 할 일은 대개 수신자·형식 설정이다
    const [tab, setTab] = useState<"settings" | "inbox">("settings")

    // 위저드 판정 재료 — 문서 형식(회사 공통)과 수신자 수
    const [docFormat, setDocFormat] = useState<string>("")
    const [recipientCount, setRecipientCount] = useState(0)
    const [wizStep, setWizStep] = useState<1 | 2>(1)
    // 화면 모드는 진입 시점에 고정 — 위저드 도중 조건이 충족돼도(수신자 추가 순간)
    // '설정 완료'를 누르기 전에 화면이 멋대로 탭으로 바뀌면 안 된다
    const [mode, setMode] = useState<"wizard" | "tabs">("tabs")
    const [doneJustNow, setDoneJustNow] = useState(false)

    useEffect(() => {
        if (ctxLoading) return
        if (!ctx || ctx.kind === "member") { router.replace("/"); return }
        ;(async () => {
            try {
                const [{ data: u }, sub, { data: sess }] = await Promise.all([
                    supabase.auth.getUser(), // 회사 형식은 admin API로도 바뀌므로 서버 기준으로 읽는다
                    fetchSubscription(),
                    supabase.auth.getSession(),
                ])
                setPro(isProActive(sub))
                const fmt = String(u?.user?.user_metadata?.preferred_export_format ?? "")
                setDocFormat(fmt)
                setWizStep(fmt ? 2 : 1)
                const [reportsRes, recipientsRes] = await Promise.all([
                    supabase
                        .from("monthly_reports")
                        .select("period_year, period_month, token, sent_at")
                        .order("period_year", { ascending: false })
                        .order("period_month", { ascending: false })
                        .limit(24),
                    fetch("/api/reports/recipients", { headers: { Authorization: `Bearer ${sess?.session?.access_token}` } })
                        .then((r) => (r.ok ? r.json() : { recipients: [] }))
                        .catch(() => ({ recipients: [] })),
                ])
                setRows((reportsRes.data as ReportRow[]) || [])
                const count = ((recipientsRes.recipients ?? []) as unknown[]).length
                setRecipientCount(count)
                // 완료 기준: 형식 설정 + (Pro면) 수신자 1명 이상 — 비Pro는 수신자를 등록할 수 없으니 형식만
                setMode(fmt && (!isProActive(sub) || count > 0) ? "tabs" : "wizard")
            } finally {
                setLoading(false)
            }
        })()
    }, [ctx, ctxLoading, router])

    const setupDone = !!docFormat && (!pro || recipientCount > 0)

    const stepChip = (n: 1 | 2, label: string) => {
        const active = wizStep === n
        const done = n === 1 ? !!docFormat : setupDone
        return (
            <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[12px] font-semibold ${active ? "bg-cur-primary text-cur-on-primary" : done ? "bg-cur-primary/15 text-cur-primary" : "bg-cur-elevated text-cur-muted"}`}>
                <span className={`w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] ${active ? "bg-white/25" : done ? "bg-cur-primary/20" : "bg-cur-hairline"}`}>{n}</span>
                {label}
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-cur-canvas font-sans">
            <div className="max-w-lg mx-auto px-4 pt-4">
                <TBMHeader title="보고서 설정" backHref="/" />
            </div>
            <main className="max-w-lg mx-auto px-5 py-6 space-y-4 pb-16">
                {loading || ctxLoading ? (
                    <div className="py-24 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-cur-muted" /></div>
                ) : doneJustNow ? (
                    /* 방금 위저드 완료 — 다음 행동 두 가지만 제안 */
                    <div className="bg-cur-card rounded-[12px] border border-cur-hairline p-8 text-center space-y-4">
                        <CheckCircle2 className="w-10 h-10 text-cur-success mx-auto" />
                        <div className="space-y-1.5">
                            <p className="text-[16px] font-bold text-cur-ink">보고서 설정 완료!</p>
                            <p className="text-[13px] text-cur-muted leading-relaxed">
                                {pro
                                    ? "매월 1일, 지난달 안전활동 보고서가 승인한 수신자에게 자동 발송돼요."
                                    : "문서 출력 형식 설정이 끝났어요. 수신자 자동 발송은 Pro에서 열려요."}
                            </p>
                        </div>
                        <div className="space-y-2">
                            <button
                                onClick={() => router.push("/")}
                                className="w-full h-11 rounded-[8px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[14px] font-bold transition-colors"
                            >
                                홈으로 가기
                            </button>
                            <button
                                onClick={() => router.push("/org/members?new=1")}
                                className="w-full h-11 rounded-[8px] border border-cur-hairline bg-cur-elevated text-[13px] font-semibold text-cur-ink hover:border-cur-primary/40 transition-colors"
                            >
                                현장이 여러 곳이에요 — 현장 계정 추가하기
                            </button>
                            <button
                                onClick={() => setDoneJustNow(false)}
                                className="w-full h-9 text-[13px] font-medium text-cur-muted hover:text-cur-ink transition-colors"
                            >
                                설정 화면 보기
                            </button>
                        </div>
                    </div>
                ) : mode === "wizard" ? (
                    /* ── 설정 위저드 — 다 보여주지 않고 한 걸음씩 ── */
                    <>
                        <div className="flex items-center gap-1.5">
                            {stepChip(1, "문서 형식")}
                            <span className="text-cur-muted-soft text-[12px]">›</span>
                            {stepChip(2, "받는 사람")}
                        </div>

                        {wizStep === 1 ? (
                            <>
                                <p className="text-[13px] text-cur-muted leading-relaxed px-1">
                                    회의록·교육일지를 어떤 형식으로 저장할지 정해주세요. 모든 현장 계정에 함께 적용돼요.
                                </p>
                                <CompanyDocFormatCard onSaved={(f) => setDocFormat(f)} />
                                <button
                                    disabled={!docFormat}
                                    onClick={() => setWizStep(2)}
                                    className="w-full h-11 rounded-[8px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[14px] font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    다음 — 받는 사람 설정
                                </button>
                            </>
                        ) : (
                            <>
                                <ReportSettingsPanel pro={pro} onRecipientsChange={setRecipientCount} />
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => setWizStep(1)}
                                        className="flex-1 h-11 rounded-[8px] border border-cur-hairline bg-cur-card text-[13px] font-semibold text-cur-muted hover:text-cur-ink transition-colors"
                                    >
                                        이전
                                    </button>
                                    <button
                                        disabled={pro && recipientCount === 0}
                                        onClick={() => { setDoneJustNow(true); setMode("tabs") }}
                                        className="flex-[2] h-11 rounded-[8px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[14px] font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        설정 완료
                                    </button>
                                </div>
                                {pro && recipientCount === 0 && (
                                    <button
                                        onClick={() => setMode("tabs")}
                                        className="w-full h-9 text-[13px] font-medium text-cur-muted hover:text-cur-ink transition-colors"
                                    >
                                        나중에 등록할게요 (AI 분석 보고서는 설정 완료 후 열려요)
                                    </button>
                                )}
                            </>
                        )}
                    </>
                ) : (
                    /* ── 설정 완료(또는 건너뜀) — 2탭 화면 ── */
                    <>
                        <div className="flex gap-1 p-1 bg-cur-elevated rounded-lg">
                            {([["settings", "발송 설정"], ["inbox", "받은 보고서"]] as const).map(([key, label]) => (
                                <button
                                    key={key}
                                    onClick={() => setTab(key)}
                                    className={`flex-1 h-9 rounded-md text-[13px] font-semibold transition-colors ${tab === key ? "bg-cur-card text-cur-ink shadow-sm" : "text-cur-muted hover:text-cur-ink"}`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        {tab === "inbox" && (
                            rows.length === 0 ? (
                                <div className="bg-cur-card rounded-2xl border border-cur-hairline p-8 text-center space-y-2">
                                    <FileBarChart2 className="w-8 h-8 text-cur-muted-soft mx-auto" />
                                    <p className="text-[14px] font-semibold text-cur-ink">아직 병합 보고서가 없어요</p>
                                    <p className="text-[13px] text-cur-muted leading-relaxed">
                                        매월 1일, 지난달 전 현장의 TBM 기록을 병합한<br />월간 보고서가 여기에 쌓입니다.
                                    </p>
                                    <a
                                        href="/report/sample/minutes"
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 pt-1 text-[13px] text-cur-primary font-semibold hover:opacity-70 transition-opacity"
                                    >
                                        발송될 보고서 예시 보기 <ExternalLink className="w-3.5 h-3.5" />
                                    </a>
                                </div>
                            ) : (
                                <div className="bg-cur-card rounded-2xl border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                                    {rows.map((r) => (
                                        <a
                                            key={`${r.period_year}-${r.period_month}`}
                                            href={`/report/monthly/${r.token}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="flex items-center gap-3 p-4 hover:bg-cur-elevated/50 transition-colors"
                                        >
                                            <span className="w-10 h-10 rounded-xl bg-cur-primary/10 text-cur-primary flex items-center justify-center shrink-0">
                                                <FileBarChart2 className="w-5 h-5" />
                                            </span>
                                            <span className="flex-1 min-w-0">
                                                <span className="block text-[15px] font-semibold text-cur-ink">{r.period_year}년 {r.period_month}월 종합</span>
                                                <span className="block text-[12px] text-cur-muted mt-0.5">{r.sent_at ? `발행 ${r.sent_at.slice(0, 10)}` : "발행됨"}</span>
                                            </span>
                                            <ChevronRight className="w-4 h-4 text-cur-muted-soft shrink-0" />
                                        </a>
                                    ))}
                                </div>
                            )
                        )}

                        {/* 패널은 항상 마운트(hidden 토글) — 탭을 오가도 입력 중이던 수신자 이메일·목록이 유지되고 재조회도 없다 */}
                        <div className={tab === "settings" ? "space-y-4" : "hidden"}>
                            <CompanyDocFormatCard onSaved={(f) => setDocFormat(f)} />
                            <ReportSettingsPanel pro={pro} onRecipientsChange={setRecipientCount} />
                        </div>
                    </>
                )}
            </main>
        </div>
    )
}
