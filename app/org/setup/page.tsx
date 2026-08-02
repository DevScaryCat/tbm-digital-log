"use client"

/* Hallmark · component: onboarding page (다현장 셋업) · genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * 온보딩에서 '여러 현장을 관리해요'를 고른 직후 한 번 지나가는 전용 화면.
 * 현장관리 탭 안에 인라인으로 두면 현장 목록·추가 버튼과 역할이 겹쳐 난잡해진다 — 그래서 분리.
 * 스테퍼는 '추가할 현장 수'만 센다 — "내 현장 포함 N개"는 머리로 한 번 더 계산하게 만든다.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { fetchSubscription, isProActive, type SubscriptionRow } from "@/lib/useSubscription"
import { fetchOrgContext } from "@/lib/useOrgContext"
import { Logo } from "@/components/Logo"
import { Loader2, Minus, Plus, KeyRound, Link2, ChevronRight } from "lucide-react"

const SEAT_PRICE = 3900

export default function OrgSetupPage() {
    const router = useRouter()
    const [checking, setChecking] = useState(true)
    const [sub, setSub] = useState<SubscriptionRow | null>(null)
    // 추가할 현장 수 (내 현장 제외)
    const [addCount, setAddCount] = useState(1)

    useEffect(() => {
        ;(async () => {
            const { data } = await supabase.auth.getUser()
            if (!data?.user) { router.replace("/login"); return }
            const ctx = await fetchOrgContext()
            if (ctx?.kind === "member") { router.replace("/"); return }
            const s = await fetchSubscription()
            // legacy(구 베이직·영구무료)는 현장 추가가 요금제에 없다 — 요금제 안내로
            if (!isProActive(s)) { router.replace("/pricing"); return }
            setSub(s)
            setChecking(false)
        })()
    }, [router])

    if (checking) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-cur-canvas">
                <Loader2 className="w-8 h-8 text-cur-muted animate-spin" />
            </div>
        )
    }

    const total = (1 + addCount) * SEAT_PRICE
    const nextChargeDate = sub?.current_period_end
        ? new Date(sub.current_period_end).toLocaleDateString("ko-KR")
        : null
    const isTrial = sub?.status === "trialing"

    return (
        <div className="min-h-screen flex items-center justify-center bg-cur-canvas p-4 font-sans text-cur-ink">
            <div className="w-full max-w-md bg-cur-card border border-cur-hairline rounded-[24px] shadow-[0_1px_3px_rgba(0,0,0,0.04)] px-6 py-9 sm:px-8 space-y-7">
                <div className="text-center space-y-3">
                    <div className="mx-auto w-fit"><Logo size="md" /></div>
                    <h1 className="text-[24px] font-bold tracking-[-0.02em]">몇 곳을 더 관리하세요?</h1>
                    <p className="text-[14px] text-cur-body leading-relaxed">
                        내 현장은 이미 준비돼 있어요.<br />
                        <b className="text-cur-ink">추가할 다른 현장 수</b>만 고르면 됩니다.
                    </p>
                </div>

                {/* 추가 현장 수 — 포함 계산을 시키지 않는다 */}
                <div className="flex items-center justify-center gap-6">
                    <button
                        onClick={() => setAddCount((c) => Math.max(1, c - 1))}
                        disabled={addCount <= 1}
                        aria-label="추가 현장 줄이기"
                        className="w-12 h-12 rounded-[8px] border border-cur-hairline bg-cur-elevated text-cur-ink flex items-center justify-center hover:bg-cur-hairline transition-colors disabled:opacity-40"
                    >
                        <Minus className="w-4 h-4" />
                    </button>
                    <div className="text-center w-28">
                        <p className="text-[40px] font-bold leading-none tabular-nums">{addCount}</p>
                        <p className="text-[13px] text-cur-muted mt-1.5">추가할 현장</p>
                    </div>
                    <button
                        onClick={() => setAddCount((c) => Math.min(49, c + 1))}
                        aria-label="추가 현장 늘리기"
                        className="w-12 h-12 rounded-[8px] border border-cur-hairline bg-cur-elevated text-cur-ink flex items-center justify-center hover:bg-cur-hairline transition-colors"
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                </div>

                {/* 청구 미리보기 — 언제, 얼마가 나가는지 숫자로 */}
                <div className="rounded-[12px] bg-cur-elevated p-4 space-y-1.5">
                    <div className="flex items-baseline justify-between">
                        <span className="text-[13px] text-cur-body">내 현장 1 + 추가 {addCount} = 계정 {1 + addCount}개</span>
                        <span className="text-[17px] font-bold text-cur-ink">월 {total.toLocaleString()}원</span>
                    </div>
                    <p className="text-[12px] text-cur-muted leading-relaxed">
                        {isTrial
                            ? `무료체험 중엔 청구되지 않아요. 체험이 끝나는 ${nextChargeDate ?? "종료일"}부터 월 ${total.toLocaleString()}원이 결제됩니다.`
                            : `현장을 추가하면 이번 달 남은 기간 요금이 먼저 결제되고, ${nextChargeDate ? `${nextChargeDate}부터` : "다음 결제일부터"} 월 ${total.toLocaleString()}원이 결제됩니다.`}
                    </p>
                </div>

                {/* 다음 행동 — 두 방식 중 하나로 현장 계정을 만든다 */}
                <div className="space-y-2.5">
                    <button
                        onClick={() => router.push(`/org/members?new=1&count=${addCount}&method=direct`)}
                        className="w-full flex items-center gap-3.5 p-4 rounded-[12px] border border-cur-hairline bg-cur-elevated hover:border-cur-primary/40 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                    >
                        <span className="w-10 h-10 shrink-0 rounded-[8px] bg-cur-primary/10 text-cur-primary flex items-center justify-center"><KeyRound className="w-5 h-5" /></span>
                        <span className="flex-1 min-w-0">
                            <span className="block text-[14px] font-bold text-cur-ink">내가 만들어서 현장담당자에게 줄래요</span>
                            <span className="block text-[12px] text-cur-body mt-0.5 leading-snug">아이디·초기 비밀번호를 한 번에 만들어 드려요</span>
                        </span>
                        <ChevronRight className="w-4 h-4 shrink-0 text-cur-muted-soft" />
                    </button>
                    <button
                        onClick={() => router.push(`/org/members?new=1&count=${addCount}&method=link`)}
                        className="w-full flex items-center gap-3.5 p-4 rounded-[12px] border border-cur-hairline bg-cur-elevated hover:border-cur-primary/40 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                    >
                        <span className="w-10 h-10 shrink-0 rounded-[8px] bg-cur-ink/8 text-cur-ink flex items-center justify-center"><Link2 className="w-5 h-5" /></span>
                        <span className="flex-1 min-w-0">
                            <span className="block text-[14px] font-bold text-cur-ink">현장담당자가 직접 만들게 할래요</span>
                            <span className="block text-[12px] text-cur-body mt-0.5 leading-snug">초대 링크를 보내면 현장담당자가 스스로 가입해요 · 기존 계정 편입도 여기서</span>
                        </span>
                        <ChevronRight className="w-4 h-4 shrink-0 text-cur-muted-soft" />
                    </button>
                </div>

                <p className="text-center">
                    <button
                        onClick={() => router.push("/")}
                        className="text-[13px] font-medium text-cur-muted hover:text-cur-ink underline underline-offset-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary rounded-[4px]"
                    >
                        나중에 할게요
                    </button>
                </p>
            </div>
        </div>
    )
}
