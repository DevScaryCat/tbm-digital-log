"use client"

// 현장 분석 (안전관리자 전용) — 대상 현장 1곳의 이번 달 통계 + 최근 문서.
// 데이터는 전부 서버 경유(/api/org/site-stats) — RLS는 열지 않는다.
import { useEffect, useState, use as usePromise } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { Loader2, FileText, BookOpen, Sparkles } from "lucide-react"
import { useOrgContext } from "@/lib/useOrgContext"

interface SiteStats {
    siteName: string
    managerName: string
    month: string
    monthMinutes: number
    monthLogs: number
    recentMinutes: { id: string; date: string; work_name?: string | null; process_name?: string | null }[]
    recentLogs: { id: string; date: string; education_type?: string | null }[]
}

export default function OrgSitePage({ params }: { params: Promise<{ userId: string }> }) {
    const { userId } = usePromise(params)
    const router = useRouter()
    const { ctx, loading: ctxLoading } = useOrgContext()
    const [data, setData] = useState<SiteStats | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        if (ctxLoading) return
        if (!ctx || ctx.kind !== "owner") { router.replace("/"); return }
        ;(async () => {
            try {
                const { data: s } = await supabase.auth.getSession()
                const res = await fetch(`/api/org/site-stats?userId=${encodeURIComponent(userId)}`, {
                    headers: { Authorization: `Bearer ${s?.session?.access_token}` },
                })
                if (res.ok) setData(await res.json())
            } finally {
                setLoading(false)
            }
        })()
    }, [ctx, ctxLoading, router, userId])

    return (
        <div className="min-h-screen bg-cur-canvas font-sans">
            <TBMHeader title="현장 분석" backHref="/" />
            <main className="max-w-2xl mx-auto px-5 py-6 space-y-5 pb-16">
                {loading || ctxLoading ? (
                    <div className="py-24 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-cur-muted" /></div>
                ) : !data ? (
                    <p className="text-[14px] text-cur-muted text-center py-16">현장 정보를 불러오지 못했습니다.</p>
                ) : (
                    <>
                        <section className="bg-cur-card rounded-2xl border border-cur-hairline p-5">
                            <h1 className="text-[18px] font-bold text-cur-ink">{data.siteName}</h1>
                            {data.managerName && <p className="text-[13px] text-cur-muted mt-0.5">담당 {data.managerName}</p>}
                            <div className="grid grid-cols-2 gap-2 mt-4">
                                <div className="rounded-xl bg-cur-elevated p-3 text-center">
                                    <p className="text-[12px] text-cur-muted">이번 달 회의록</p>
                                    <p className="text-[20px] font-bold text-cur-ink">{data.monthMinutes}<span className="text-[13px] text-cur-muted ml-0.5">건</span></p>
                                </div>
                                <div className="rounded-xl bg-cur-elevated p-3 text-center">
                                    <p className="text-[12px] text-cur-muted">이번 달 교육일지</p>
                                    <p className="text-[20px] font-bold text-cur-ink">{data.monthLogs}<span className="text-[13px] text-cur-muted ml-0.5">건</span></p>
                                </div>
                            </div>
                            <button
                                onClick={() => { sessionStorage.setItem("ra_target", JSON.stringify({ userId, siteName: data.siteName })); router.push("/risk-assessment") }}
                                className="mt-3 w-full h-11 rounded-xl bg-cur-primary text-white text-[14px] font-bold flex items-center justify-center gap-1.5 hover:opacity-90"
                            >
                                <Sparkles className="w-4 h-4" /> 이 현장 AI 분석 보고서
                            </button>
                        </section>

                        <section className="space-y-2">
                            <h2 className="text-[14px] font-bold text-cur-ink px-1 flex items-center gap-1.5"><FileText className="w-4 h-4 text-cur-muted" /> 최근 TBM 회의록</h2>
                            {data.recentMinutes.length === 0 ? (
                                <p className="text-[13px] text-cur-muted-soft px-1 py-3">기록이 없습니다.</p>
                            ) : (
                                <div className="bg-cur-card rounded-2xl border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                                    {data.recentMinutes.map((m) => (
                                        <div key={m.id} className="p-3.5">
                                            <p className="text-[14px] font-medium text-cur-ink truncate">{m.work_name || m.process_name || "TBM 회의록"}</p>
                                            <p className="text-[12px] text-cur-muted mt-0.5">{m.date}</p>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>

                        <section className="space-y-2">
                            <h2 className="text-[14px] font-bold text-cur-ink px-1 flex items-center gap-1.5"><BookOpen className="w-4 h-4 text-cur-muted" /> 최근 안전보건교육일지</h2>
                            {data.recentLogs.length === 0 ? (
                                <p className="text-[13px] text-cur-muted-soft px-1 py-3">기록이 없습니다.</p>
                            ) : (
                                <div className="bg-cur-card rounded-2xl border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                                    {data.recentLogs.map((l) => (
                                        <div key={l.id} className="p-3.5 flex items-center justify-between">
                                            <p className="text-[14px] font-medium text-cur-ink">{l.education_type || "안전보건교육"}</p>
                                            <p className="text-[12px] text-cur-muted">{l.date}</p>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>
                    </>
                )}
            </main>
        </div>
    )
}
