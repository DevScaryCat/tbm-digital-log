"use client"

// 월간 보고서 (안전관리자 전용) — 전 현장 병합 월간 보고서 열람.
// 병합본은 매월 1일 cron이 owner 소유(monthly_reports)로 저장한다 (§7-1).
// RLS(user_id=본인)로 owner 행만 보이므로 클라이언트 직조회로 충분.
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { Loader2, FileBarChart2, ChevronRight } from "lucide-react"
import { useOrgContext } from "@/lib/useOrgContext"

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

    useEffect(() => {
        if (ctxLoading) return
        if (!ctx || ctx.kind !== "owner") { router.replace("/"); return }
        ;(async () => {
            try {
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
                <TBMHeader title="월간 보고서" backHref="/" />
            </div>
            <main className="max-w-lg mx-auto px-5 py-6 space-y-4 pb-16">
                {loading || ctxLoading ? (
                    <div className="py-24 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-cur-muted" /></div>
                ) : rows.length === 0 ? (
                    <div className="bg-cur-card rounded-2xl border border-cur-hairline p-8 text-center space-y-2">
                        <FileBarChart2 className="w-8 h-8 text-cur-muted-soft mx-auto" />
                        <p className="text-[14px] font-semibold text-cur-ink">아직 병합 보고서가 없어요</p>
                        <p className="text-[13px] text-cur-muted leading-relaxed">
                            매월 1일, 지난달 전 현장의 TBM 기록을 병합한<br />월간 보고서가 여기에 쌓입니다.
                        </p>
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
                )}
            </main>
        </div>
    )
}
