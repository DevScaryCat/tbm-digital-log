"use client"

// 안전관리자 홈 = 관제 대시보드 (§4-A). 현장(하위) 목록 + 오늘 TBM 실시 현황 + 관리 바로가기.
// TBM 작성 기능은 없다 — 이 계정은 관리 전용 (결정 2).
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { Loader2, ChevronRight, FileBarChart2, Settings2, Users, Sparkles, CheckCircle2, CircleDashed } from "lucide-react"

interface SiteRow {
    userId: string
    siteName: string
    managerName: string
    status: "active" | "detached"
    todayDone: boolean
    todayMinutes: number
    todayLogs: number
    monthMinutes: number
    monthLogs: number
    lastActivity: string | null
}

interface Overview {
    orgName: string
    seatCount: number
    pendingSeatCount: number | null
    activeCount: number
    todayDoneCount: number
    today: string
    sites: SiteRow[]
}

export function OwnerHome() {
    const router = useRouter()
    const [data, setData] = useState<Overview | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        ;(async () => {
            try {
                const { data: s } = await supabase.auth.getSession()
                const res = await fetch("/api/org/overview", { headers: { Authorization: `Bearer ${s?.session?.access_token}` } })
                if (res.ok) setData(await res.json())
            } finally {
                setLoading(false)
            }
        })()
    }, [])

    const quickLinks = [
        { href: "/org/reports", label: "월간 보고서", desc: "전 현장 병합 열람", icon: <FileBarChart2 className="w-5 h-5" /> },
        { href: "/risk-assessment", label: "AI 분석 보고서", desc: "현장별 위험요인 분석", icon: <Sparkles className="w-5 h-5" /> },
        { href: "/report-settings", label: "보고서 설정", desc: "외부 수신처 관리", icon: <Settings2 className="w-5 h-5" /> },
        { href: "/org/members", label: "좌석·계정 관리", desc: "현장 계정 발급·편입", icon: <Users className="w-5 h-5" /> },
    ]

    return (
        <div className="min-h-screen bg-cur-canvas font-sans">
            <TBMHeader />
            <main className="max-w-2xl mx-auto px-5 py-6 space-y-6 pb-16">
                {loading ? (
                    <div className="py-24 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-cur-muted" /></div>
                ) : !data ? (
                    <p className="text-[14px] text-cur-muted text-center py-16">현황을 불러오지 못했습니다.</p>
                ) : (
                    <>
                        {/* 오늘 요약 */}
                        <section className="bg-cur-card rounded-2xl border border-cur-hairline p-5">
                            <p className="text-[13px] text-cur-muted">{data.orgName}</p>
                            <h1 className="text-[20px] font-bold text-cur-ink mt-0.5">
                                오늘 TBM 실시 <span className="text-cur-primary">{data.todayDoneCount}</span>
                                <span className="text-cur-muted font-semibold text-[16px]"> / {data.activeCount}개 현장</span>
                            </h1>
                            <div className="mt-3 h-2 rounded-full bg-cur-elevated overflow-hidden">
                                <div
                                    className="h-full bg-cur-primary rounded-full transition-all duration-700"
                                    style={{ width: data.activeCount ? `${Math.round((data.todayDoneCount / data.activeCount) * 100)}%` : "0%" }}
                                />
                            </div>
                            <p className="text-[12px] text-cur-muted-soft mt-2">
                                좌석 {data.activeCount}/{data.seatCount} 사용
                                {data.pendingSeatCount != null && ` · 다음 결제일부터 ${data.pendingSeatCount}석으로 변경 예약됨`}
                            </p>
                        </section>

                        {/* 현장 목록 */}
                        <section className="space-y-2">
                            <h2 className="text-[14px] font-bold text-cur-ink px-1">현장 현황</h2>
                            {data.sites.filter((s) => s.status === "active").length === 0 ? (
                                <div className="bg-cur-card rounded-2xl border border-cur-hairline p-6 text-center space-y-3">
                                    <p className="text-[14px] text-cur-muted">아직 연결된 현장이 없어요.</p>
                                    <button onClick={() => router.push("/org/members")} className="text-[14px] font-bold text-cur-primary">
                                        현장 계정 만들기 →
                                    </button>
                                </div>
                            ) : (
                                <div className="bg-cur-card rounded-2xl border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                                    {data.sites.filter((s) => s.status === "active").map((s) => (
                                        <button
                                            key={s.userId}
                                            onClick={() => router.push(`/org/sites/${s.userId}`)}
                                            className="w-full flex items-center gap-3 p-4 text-left hover:bg-cur-elevated/50 transition-colors"
                                        >
                                            {s.todayDone ? (
                                                <span className="w-9 h-9 rounded-full bg-cur-success/10 text-cur-success flex items-center justify-center shrink-0"><CheckCircle2 className="w-5 h-5" /></span>
                                            ) : (
                                                <span className="w-9 h-9 rounded-full bg-cur-elevated text-cur-muted-soft flex items-center justify-center shrink-0"><CircleDashed className="w-5 h-5" /></span>
                                            )}
                                            <span className="flex-1 min-w-0">
                                                <span className="block text-[15px] font-semibold text-cur-ink truncate">{s.siteName}</span>
                                                <span className="block text-[12px] text-cur-muted mt-0.5">
                                                    {s.todayDone
                                                        ? `오늘 회의록 ${s.todayMinutes} · 일지 ${s.todayLogs}`
                                                        : s.lastActivity
                                                            ? `마지막 활동 ${s.lastActivity}`
                                                            : "이번 달 기록 없음"}
                                                    {" · "}이번 달 {s.monthMinutes + s.monthLogs}건
                                                </span>
                                            </span>
                                            <ChevronRight className="w-4 h-4 text-cur-muted-soft shrink-0" />
                                        </button>
                                    ))}
                                </div>
                            )}
                        </section>

                        {/* 관리 바로가기 */}
                        <section className="grid grid-cols-2 gap-2.5">
                            {quickLinks.map((q) => (
                                <button
                                    key={q.href}
                                    onClick={() => router.push(q.href)}
                                    className="bg-cur-card rounded-2xl border border-cur-hairline p-4 text-left hover:border-cur-primary/40 transition-all"
                                >
                                    <span className="w-9 h-9 rounded-xl bg-cur-primary/10 text-cur-primary flex items-center justify-center">{q.icon}</span>
                                    <span className="block text-[14px] font-bold text-cur-ink mt-2.5">{q.label}</span>
                                    <span className="block text-[12px] text-cur-muted mt-0.5">{q.desc}</span>
                                </button>
                            ))}
                        </section>
                    </>
                )}
            </main>
        </div>
    )
}
