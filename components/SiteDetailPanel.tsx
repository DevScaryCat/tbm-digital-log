"use client"

/* Hallmark · component: panel (홈 현장 상세) · genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * states: loading · loaded · empty(기록 없음) · error(재시도)
 * tokens only — hairline depth, card radius 12px, CTA radius 8px
 */

// 홈에서 다른 현장을 선택했을 때 보이는 그 현장 대시보드.
// 이 자리에 원래 있던 '내 회의록 작성' 카드들은 남의 현장을 보는 중엔 말이 안 돼서 숨긴다(page.tsx).
// 데이터는 전부 서버 경유(/api/org/site-stats) — 소유 검증(assertOwnerOfMember)이 라우트에 있다.

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Loader2, FileText, BookOpen, Sparkles, ChevronRight } from "lucide-react"

interface SiteStats {
    siteName: string
    managerName: string
    month: string
    monthMinutes: number
    monthLogs: number
    recentMinutes: { id: string; date: string; work_name?: string | null; process_name?: string | null }[]
    recentLogs: { id: string; date: string; education_type?: string | null }[]
}

export function SiteDetailPanel({ userId, siteName }: { userId: string; siteName: string }) {
    const router = useRouter()
    const [data, setData] = useState<SiteStats | null>(null)
    const [loading, setLoading] = useState(true)
    const [failed, setFailed] = useState(false)

    // 현장을 빠르게 바꾸면 이전 현장의 응답이 나중에 도착해 다른 현장 데이터가 남을 수 있다 —
    // 요청 세대를 세어 최신 요청의 응답만 반영한다.
    const reqSeq = useRef(0)

    const load = useCallback(async () => {
        const seq = ++reqSeq.current
        setFailed(false)
        try {
            const { data: s } = await supabase.auth.getSession()
            const res = await fetch(`/api/org/site-stats?userId=${encodeURIComponent(userId)}`, {
                headers: { Authorization: `Bearer ${s?.session?.access_token}` },
            })
            if (seq !== reqSeq.current) return // 더 최신 요청이 있다 — 이 응답은 버린다
            if (!res.ok) { setFailed(true); return }
            const j = await res.json()
            if (seq !== reqSeq.current) return
            setData(j)
        } catch {
            if (seq === reqSeq.current) setFailed(true)
        } finally {
            if (seq === reqSeq.current) setLoading(false)
        }
    }, [userId])

    useEffect(() => {
        setLoading(true)
        setData(null)
        load()
    }, [load])

    if (loading) {
        return (
            <div className="bg-cur-card rounded-[12px] border border-cur-hairline py-12 flex justify-center">
                <Loader2 className="w-5 h-5 animate-spin text-cur-muted" />
            </div>
        )
    }
    if (failed || !data) {
        return (
            <div className="bg-cur-card rounded-[12px] border border-cur-hairline px-4 py-3.5 flex items-center justify-between gap-3">
                <p className="text-[13px] text-cur-muted">현장 정보를 불러오지 못했어요.</p>
                <button
                    type="button"
                    onClick={() => { setLoading(true); load() }}
                    className="shrink-0 h-8 px-3 rounded-[8px] border border-cur-hairline bg-cur-elevated text-[12px] font-semibold text-cur-ink hover:border-cur-primary/40 transition-colors"
                >
                    다시 시도
                </button>
            </div>
        )
    }

    const goRiskAssessment = () => {
        // 위험성평가 화면이 이 현장을 대상으로 열리도록 — 현장 상세 페이지와 같은 규약.
        // 이름은 응답(data)이 아니라 선택된 현장 prop에서 — 둘이 어긋나면 보고서에 다른 현장명이 찍힌다.
        try { sessionStorage.setItem("ra_target", JSON.stringify({ userId, siteName })) } catch { /* 무시 */ }
        router.push("/risk-assessment")
    }

    return (
        <div className="space-y-4">
            <section className="bg-cur-card rounded-[12px] border border-cur-hairline p-5 space-y-4">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h3 className="text-[15px] font-bold text-cur-ink truncate">{data.siteName}</h3>
                        {data.managerName && <p className="text-[12px] text-cur-muted mt-0.5 truncate">담당 {data.managerName}</p>}
                    </div>
                    <span className="shrink-0 text-[12px] text-cur-muted-soft">{data.month.replace("-", "년 ")}월</span>
                </div>
                <div className="grid grid-cols-2 gap-px bg-cur-hairline border border-cur-hairline rounded-[12px] overflow-hidden text-center">
                    <div className="bg-cur-card py-3.5">
                        <p className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1">이번 달 회의록</p>
                        <p className="text-[24px] leading-none font-bold text-cur-ink font-mono">{data.monthMinutes}</p>
                    </div>
                    <div className="bg-cur-card py-3.5">
                        <p className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1">이번 달 교육일지</p>
                        <p className="text-[24px] leading-none font-bold text-cur-ink font-mono">{data.monthLogs}</p>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={goRiskAssessment}
                    className="w-full h-11 rounded-[8px] bg-cur-primary text-white text-[14px] font-bold flex items-center justify-center gap-1.5 hover:bg-cur-primary-active transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                >
                    <Sparkles className="w-4 h-4" /> 이 현장 AI 분석 보고서
                </button>
            </section>

            <section className="space-y-2">
                <h3 className="text-[14px] font-bold text-cur-ink px-1 flex items-center gap-1.5">
                    <FileText className="w-4 h-4 text-cur-muted" /> 최근 TBM 회의록
                </h3>
                {data.recentMinutes.length === 0 ? (
                    <p className="text-[13px] text-cur-muted-soft px-1 py-3">기록이 없습니다.</p>
                ) : (
                    <div className="bg-cur-card rounded-[12px] border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                        {data.recentMinutes.slice(0, 5).map((m) => (
                            <div key={m.id} className="p-3.5">
                                <p className="text-[14px] font-medium text-cur-ink truncate">{m.work_name || m.process_name || "TBM 회의록"}</p>
                                <p className="text-[12px] text-cur-muted mt-0.5">{m.date}</p>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            <section className="space-y-2">
                <h3 className="text-[14px] font-bold text-cur-ink px-1 flex items-center gap-1.5">
                    <BookOpen className="w-4 h-4 text-cur-muted" /> 최근 안전보건교육일지
                </h3>
                {data.recentLogs.length === 0 ? (
                    <p className="text-[13px] text-cur-muted-soft px-1 py-3">기록이 없습니다.</p>
                ) : (
                    <div className="bg-cur-card rounded-[12px] border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                        {data.recentLogs.slice(0, 5).map((l) => (
                            <div key={l.id} className="p-3.5 flex items-center justify-between gap-3">
                                <p className="text-[14px] font-medium text-cur-ink truncate">{l.education_type || "안전보건교육"}</p>
                                <p className="text-[12px] text-cur-muted shrink-0">{l.date}</p>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            <button
                type="button"
                onClick={() => router.push(`/org/sites/${userId}`)}
                className="w-full flex items-center justify-center gap-1 h-10 rounded-[8px] border border-cur-hairline bg-cur-card text-[13px] font-semibold text-cur-body hover:border-cur-primary/40 hover:text-cur-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
            >
                이 현장 기록 전체 보기 <ChevronRight className="w-3.5 h-3.5" />
            </button>
        </div>
    )
}
