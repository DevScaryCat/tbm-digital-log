"use client"

/* Hallmark · component: panel (홈 활동 현황) · genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * states: loading · default(개인 4타일·클릭) · owner(+통계 보기 버튼)
 * tokens only — hairline depth, card radius 12px
 */

// 홈 활동 현황 — 홈에는 토글·셀렉트를 두지 않는다 (Chris: 홈은 개인 화면).
// 감독자에게는 헤더 오른쪽 '통계 보기' 버튼 하나만 — 전체·현장별 통계는 /org/stats 전용 페이지에서.

import { type KeyboardEvent } from "react"
import { useRouter } from "next/navigation"
import { Loader2, ChevronRight, CalendarDays, BarChart3 } from "lucide-react"

interface Props {
    isOwner: boolean
    statsLoading: boolean
    myMinutes: number
    myLogs: number
    mySuggestions: number
    myUnread: number
}

export function HomeActivity({ isOwner, statsLoading, myMinutes, myLogs, mySuggestions, myUnread }: Props) {
    const router = useRouter()

    // 카드 키보드 접근성: Enter/Space가 onClick과 동일하게 동작
    const cardKeyDown = (go: () => void) => (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go() }
    }

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 px-1">
                <h3 className="text-[15px] font-semibold text-cur-ink tracking-[-0.11px]">활동 현황</h3>
                {isOwner && (
                    <button
                        type="button"
                        onClick={() => router.push("/org/stats")}
                        className="h-9 px-3 rounded-[8px] border border-cur-hairline bg-cur-card text-[13px] font-semibold text-cur-ink hover:border-cur-primary/40 transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                    >
                        <BarChart3 className="w-4 h-4 text-cur-muted" /> 통계 보기
                    </button>
                )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-cur-hairline border border-cur-hairline rounded-[12px] overflow-hidden text-center">
                <div onClick={() => router.push('/analytics')} role="button" tabIndex={0} aria-label="TBM 회의록 목록 보기" onKeyDown={cardKeyDown(() => router.push('/analytics'))} className="relative py-6 px-2 cursor-pointer bg-cur-card hover:bg-cur-elevated active:bg-cur-elevated transition-colors">
                    <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft absolute bottom-2 right-2" />
                    <div className="text-[12px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1.5">TBM 회의록</div>
                    <div className="text-[32px] leading-none font-bold text-cur-ink font-mono">
                        {statsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-cur-muted" /> : myMinutes}
                    </div>
                </div>
                <div onClick={() => router.push('/analytics/education')} role="button" tabIndex={0} aria-label="안전보건교육일지 목록 보기" onKeyDown={cardKeyDown(() => router.push('/analytics/education'))} className="relative py-6 px-2 cursor-pointer bg-cur-card hover:bg-cur-elevated active:bg-cur-elevated transition-colors">
                    <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft absolute bottom-2 right-2" />
                    <div className="text-[12px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1.5">안전보건교육일지</div>
                    <div className="text-[32px] leading-none font-bold text-cur-ink font-mono">
                        {statsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-cur-muted" /> : myLogs}
                    </div>
                </div>
                <div onClick={() => router.push('/suggestions')} role="button" tabIndex={0} aria-label="근로자 제안함 보기" onKeyDown={cardKeyDown(() => router.push('/suggestions'))} className="relative py-6 px-2 cursor-pointer bg-cur-card hover:bg-cur-elevated active:bg-cur-elevated transition-colors">
                    {!statsLoading && myUnread > 0 && (
                        <span className="absolute top-2 right-2 bg-cur-primary text-cur-on-primary text-[10px] font-bold px-1.5 py-0.5 rounded-full">{myUnread}</span>
                    )}
                    <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft absolute bottom-2 right-2" />
                    <div className="text-[12px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1.5">근로자 제안함</div>
                    <div className="text-[32px] leading-none font-bold text-cur-ink font-mono">
                        {statsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-cur-muted" /> : mySuggestions}
                    </div>
                </div>
                <div onClick={() => router.push('/dashboard')} role="button" tabIndex={0} aria-label="안전문서 달력 보기" onKeyDown={cardKeyDown(() => router.push('/dashboard'))} className="relative py-6 px-2 cursor-pointer bg-cur-card hover:bg-cur-elevated active:bg-cur-elevated transition-colors flex flex-col items-center justify-center">
                    <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft absolute bottom-2 right-2" />
                    <div className="text-[12px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1.5">안전문서 달력</div>
                    <div className="bg-cur-elevated w-10 h-10 rounded-[8px] flex items-center justify-center text-cur-ink mx-auto">
                        <CalendarDays className="w-5 h-5" />
                    </div>
                </div>
            </div>
        </div>
    )
}
