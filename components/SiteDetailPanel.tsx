"use client"

/* Hallmark · component: panel (홈 현장 상세) · genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * states: loading · loaded · empty(기록 없음) · error(재시도)
 * tokens only — hairline depth, card radius 12px, CTA radius 8px
 */

// 현장 통계(/org/stats)에서 소속 현장을 선택했을 때 보이는 그 현장 대시보드.
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

    // 이메일 발송본·문서 목록과 같은 mm.dd 표기 — 행마다 연도까지 반복하면 소음이다
    const dayLabel = (d: string) => d?.slice(5).replace("-", ".")

    const docRow = (title: string, date: string) => (
        <>
            <span className="shrink-0 text-[11px] font-mono font-semibold text-cur-muted bg-cur-elevated border border-cur-hairline rounded-[6px] px-1.5 py-1">
                {dayLabel(date)}
            </span>
            <span className="flex-1 min-w-0 text-[14px] font-medium text-cur-ink truncate">{title}</span>
        </>
    )

    const emptyDocs = (label: string) => (
        <p className="text-[12px] text-cur-muted-soft text-center rounded-[8px] border border-dashed border-cur-hairline-strong py-4 mx-4 mb-4">
            아직 {label}이 없어요 — 현장에서 기록하면 여기에 쌓입니다
        </p>
    )

    return (
        <div className="space-y-4">
            {/* 현장 헤더 — 이니셜 아바타 + 오늘 상태 칩으로 '누구 화면인지'가 한눈에 */}
            <section className="bg-cur-card rounded-[12px] border border-cur-hairline p-5 space-y-4">
                <div className="flex items-center gap-3">
                    <span aria-hidden className="w-11 h-11 rounded-[10px] bg-cur-primary/10 text-cur-primary flex items-center justify-center shrink-0 text-[17px] font-bold">
                        {(data.siteName || "현").slice(0, 1)}
                    </span>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-[17px] font-bold text-cur-ink truncate tracking-[-0.2px]">{data.siteName}</h3>
                        <p className="text-[12px] text-cur-muted mt-0.5 truncate">
                            {data.managerName ? `담당 ${data.managerName} · ` : ""}{data.month.replace("-", "년 ")}월
                        </p>
                    </div>
                    {data.recentMinutes[0]?.date || data.recentLogs[0]?.date ? (
                        <span className="shrink-0 text-[11px] font-semibold text-cur-body bg-cur-elevated border border-cur-hairline rounded-full px-2.5 py-1">
                            최근 {dayLabel((data.recentMinutes[0]?.date ?? "") > (data.recentLogs[0]?.date ?? "") ? data.recentMinutes[0]!.date : data.recentLogs[0]!.date)}
                        </span>
                    ) : null}
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
                    className="w-full h-11 rounded-[8px] bg-cur-primary text-cur-on-primary text-[14px] font-bold flex items-center justify-center gap-1.5 hover:bg-cur-primary-active transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                >
                    <Sparkles className="w-4 h-4" /> 이 현장 AI 분석 보고서
                </button>
            </section>

            {/* 최근 문서 — 제목을 카드 안으로 넣어 섹션이 흩어져 보이지 않게 */}
            <section className="bg-cur-card rounded-[12px] border border-cur-hairline overflow-hidden">
                <h3 className="px-4 pt-4 pb-2 text-[14px] font-bold text-cur-ink flex items-center gap-1.5">
                    <FileText className="w-4 h-4 text-cur-muted" /> 최근 TBM 회의록
                </h3>
                {data.recentMinutes.length === 0 ? (
                    emptyDocs("회의록")
                ) : (
                    <div className="divide-y divide-cur-hairline border-t border-cur-hairline">
                        {data.recentMinutes.slice(0, 5).map((m) => (
                            <div key={m.id} className="px-4 py-3 flex items-center gap-2.5">
                                {docRow(m.work_name || m.process_name || "TBM 회의록", m.date)}
                            </div>
                        ))}
                    </div>
                )}
            </section>

            <section className="bg-cur-card rounded-[12px] border border-cur-hairline overflow-hidden">
                <h3 className="px-4 pt-4 pb-2 text-[14px] font-bold text-cur-ink flex items-center gap-1.5">
                    <BookOpen className="w-4 h-4 text-cur-muted" /> 최근 안전보건교육일지
                </h3>
                {data.recentLogs.length === 0 ? (
                    emptyDocs("교육일지")
                ) : (
                    <div className="divide-y divide-cur-hairline border-t border-cur-hairline">
                        {data.recentLogs.slice(0, 5).map((l) => (
                            <div key={l.id} className="px-4 py-3 flex items-center gap-2.5">
                                {docRow(l.education_type || "안전보건교육", l.date)}
                            </div>
                        ))}
                    </div>
                )}
            </section>

            <button
                type="button"
                onClick={() => router.push(`/org/sites/${userId}`)}
                className="w-full flex items-center justify-center gap-1 h-11 rounded-[8px] border border-cur-hairline bg-cur-card text-[13px] font-semibold text-cur-body hover:border-cur-primary/40 hover:text-cur-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
            >
                이 현장 기록 전체 보기 <ChevronRight className="w-3.5 h-3.5" />
            </button>
        </div>
    )
}
