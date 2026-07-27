"use client"

// 월간 보고서 (안전관리자 전용) — 전 현장 병합 월간 보고서 열람.
// 병합본은 매월 1일 cron이 owner 소유(monthly_reports)로 저장한다 (§7-1).
// RLS(user_id=본인)로 owner 행만 보이므로 클라이언트 직조회로 충분.
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { Loader2, FileBarChart2, ChevronRight, ExternalLink } from "lucide-react"
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

    useEffect(() => {
        if (ctxLoading) return
        if (!ctx || ctx.kind === "member") { router.replace("/"); return }
        ;(async () => {
            try {
                setPro(isProActive(await fetchSubscription()))
                const { data } = await supabase
                    .from("monthly_reports")
                    .select("period_year, period_month, token, sent_at")
                    .order("period_year", { ascending: false })
                    .order("period_month", { ascending: false })
                    .limit(24)
                setRows((data as ReportRow[]) || [])
            } finally {
                setLoading(false)
            }
        })()
    }, [ctx, ctxLoading, router])

    return (
        <div className="min-h-screen bg-cur-canvas font-sans">
            <div className="max-w-lg mx-auto px-4 pt-4">
                <TBMHeader title="보고서" backHref="/" />
            </div>
            <main className="max-w-lg mx-auto px-5 py-6 space-y-4 pb-16">
                {/* 받은 보고서(열람)와 발송 설정(수신자·예시)을 탭으로 분리 — 한 화면 세로 나열은 스캔이 안 된다 */}
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
                    loading || ctxLoading ? (
                        <div className="py-24 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-cur-muted" /></div>
                    ) : rows.length === 0 ? (
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

                {/* 패널은 항상 마운트(hidden 토글) — 탭을 오가도 입력 중이던 수신자 이메일·목록이 유지되고 재조회도 없다.
                    구독 판정 전에는 감춘다: pro 기본값 false로 그리면 유료 사용자에게 업그레이드 배너가 깜빡인다 */}
                <div className={tab === "settings" && !loading && !ctxLoading ? "space-y-4" : "hidden"}>
                    {/* 문서 형식은 문서·보고서 계열 설정이라 여기(발송 설정)에 둔다 — 현장 계정 관리에서 이동 */}
                    <CompanyDocFormatCard />
                    <ReportSettingsPanel pro={pro} />
                </div>
                {tab === "settings" && (loading || ctxLoading) && (
                    <div className="py-24 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-cur-muted" /></div>
                )}
            </main>
        </div>
    )
}
