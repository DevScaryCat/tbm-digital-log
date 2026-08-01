"use client"

/* Hallmark · component: pricing panel · genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * 단일 요금제 — 고를 티어가 하나뿐이라 비교표·플랜 타일·업/다운그레이드 UI를 전부 걷어냈다.
 * 남는 결정은 "결제수단을 등록할지"뿐이다.
 */

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { CheckCircle2, ArrowLeft, Loader2, LogOut, Sparkles } from "lucide-react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { SubscribeButtons } from "@/components/SubscribeButtons"
import { BillingRedirectHandler } from "@/components/BillingRedirectHandler"
import { fetchSubscription, isAllowed, SubscriptionRow } from "@/lib/useSubscription"
import { fetchOrgContext } from "@/lib/useOrgContext"
import { paymentsEnabled } from "@/lib/utils"

const SEAT_PRICE = 3900

const STATUS_LABEL: Record<string, string> = {
    trialing: "무료체험 중",
    active: "이용 중",
    past_due: "결제 실패",
    canceled: "해지됨",
}

const FEATURES = [
    "AI가 정리하는 TBM 회의록 (월 30회)",
    "안전보건교육일지 (월 200회)",
    "AI 분석 보고서 (현장당 월 20회)",
    "월간 안전 보고서 자동 발송",
    "사장·안전관리자 메일 자동 전달 (받는 분은 가입 불필요)",
    "참석자 전자 서명",
    "hwpx·docx·xlsx·pdf 출력",
    "클라우드 보안 저장 (1년 보관)",
]

export default function PricingPage() {
    const router = useRouter()

    const [loading, setLoading] = useState(true)
    const [hasUser, setHasUser] = useState(false)
    const [sub, setSub] = useState<SubscriptionRow | null>(null)
    // 감독자는 본인 + 소속 현장 수만큼 낸다 — 큰 숫자 하나만 던지면 "3,900이라며?"가 된다
    const [accountCount, setAccountCount] = useState(1)

    const loadSubscription = async () => {
        const s = await fetchSubscription()
        setSub(s)
        return s
    }

    const handleLogout = async () => {
        await supabase.auth.signOut()
        router.push("/login")
    }

    useEffect(() => {
        ;(async () => {
            const { data } = await supabase.auth.getUser()
            setHasUser(!!data?.user)
            // 소속 현장은 결제 주체가 아니다 — 감독자가 대신 낸다.
            const orgCtx = await fetchOrgContext()
            if (orgCtx?.kind === "member") {
                router.replace("/")
                return
            }
            if (orgCtx?.kind === "owner") setAccountCount(1 + (orgCtx.memberIds?.length ?? 0))
            await loadSubscription()
            setLoading(false)
        })()
    }, [router])

    const subscribed = isAllowed(sub)
    const isGrandfather = sub?.plan === "grandfather"
    const nextDate = sub?.current_period_end
        ? new Date(sub.current_period_end).toLocaleDateString("ko-KR")
        : null
    // 카드 없는 무료체험(휴대폰인증 가입): 결제가 아니라 '결제수단 등록'으로 유도해야 한다.
    const cardlessTrial = sub?.status === "trialing" && !sub?.card_info
    const committedTrial = sub?.status === "trialing" && !!sub?.card_info
    const statusLabel = committedTrial ? "이용 중" : STATUS_LABEL[sub?.status ?? ""] ?? "이용 중"

    const renderAction = () => {
        if (loading) {
            return (
                <Button disabled className="w-full h-12 rounded-[8px]">
                    <Loader2 className="w-4 h-4 animate-spin" />
                </Button>
            )
        }
        if (!hasUser) {
            return (
                <Button
                    onClick={() => router.push("/login")}
                    className="w-full h-12 rounded-[8px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[15px] font-bold"
                >
                    첫 달 무료로 시작하기
                </Button>
            )
        }

        // 영구 무료(기존 가입자 혜택) — 유료로 올릴 이유가 없으면 그대로 두는 게 맞다
        if (isGrandfather) {
            return (
                <div className="rounded-[12px] bg-cur-elevated border border-cur-hairline p-5 text-center space-y-1">
                    <p className="font-bold text-cur-ink">영구 무료로 이용 중</p>
                    <p className="text-cur-muted text-[13px] leading-relaxed">
                        기존 가입자 혜택입니다. AI 분석 보고서·월간 보고서를 쓰려면 아래에서 결제수단을 등록하세요.
                    </p>
                    {paymentsEnabled() && (
                        <div className="pt-3">
                            <SubscribeButtons onSuccess={loadSubscription} ctaSuffix="로 시작" />
                        </div>
                    )}
                </div>
            )
        }

        if (!paymentsEnabled()) {
            return (
                <div className="rounded-[12px] bg-cur-elevated border border-cur-hairline p-4 text-center">
                    <p className="text-[14px] font-medium text-cur-ink">결제 준비 중입니다</p>
                    <p className="text-[13px] text-cur-muted mt-1">실제 결제 연동 작업 중이에요. 곧 오픈됩니다.</p>
                </div>
            )
        }

        if (cardlessTrial) {
            return (
                <div className="space-y-3">
                    <div className="rounded-[12px] bg-cur-primary/[0.06] border border-cur-primary/30 p-4 text-[13px] leading-relaxed">
                        <p className="font-bold text-cur-ink flex items-center gap-1.5">
                            <Sparkles className="w-4 h-4 text-cur-primary" /> 무료체험 중{nextDate ? ` · 체험 종료일 ${nextDate}` : ""}
                        </p>
                        <p className="mt-1 text-cur-muted">
                            {/* 금액은 계정 수 반영 — 고정 3,900원 표기는 다계정 감독자에게 거짓말이 된다 */}
                            계속 쓰려면 결제수단을 등록하세요 — 체험 종료일부터{" "}
                            <b className="text-cur-ink">월 {(accountCount * SEAT_PRICE).toLocaleString()}원 자동 결제</b>, 등록 전에는 결제되지 않아요.
                        </p>
                    </div>
                    <SubscribeButtons
                        onSuccess={loadSubscription}
                        ctaSuffix="로 등록"
                        successText="결제수단이 등록되었습니다. 체험 종료 후 자동으로 결제됩니다."
                    />
                </div>
            )
        }

        if (subscribed) {
            return (
                <div className="space-y-2">
                    <div className="rounded-[12px] bg-cur-elevated border border-cur-hairline p-4 text-center space-y-1">
                        <p className="font-bold text-cur-ink">
                            월 {(sub?.amount ?? SEAT_PRICE).toLocaleString()}원 · {statusLabel}
                        </p>
                        {accountCount > 1 && (
                            <p className="text-cur-body text-[13px]">
                                계정 {accountCount}개 × {SEAT_PRICE.toLocaleString()}원
                                <span className="text-cur-muted"> (내 현장 1 + 소속 현장 {accountCount - 1})</span>
                            </p>
                        )}
                        {nextDate && <p className="text-cur-muted text-[14px]">다음 결제일: {nextDate}</p>}
                    </div>
                    <Button
                        variant="ghost"
                        onClick={() => router.push("/account")}
                        className="w-full h-10 text-cur-muted hover:text-cur-ink text-[13px]"
                    >
                        구독 및 결제 관리
                    </Button>
                </div>
            )
        }

        return <SubscribeButtons onSuccess={loadSubscription} />
    }

    return (
        <div className="min-h-screen bg-cur-canvas font-sans">
            <BillingRedirectHandler />
            <div className="max-w-lg mx-auto px-5 py-6 space-y-6 pb-20">
                <div className="flex items-center justify-between">
                    {/* 뒤로가기 아이콘이 특정 페이지로 점프하면 의미가 어긋난다.
                        다만 외부 링크로 바로 들어온 경우 back()은 갈 곳이 없으므로 홈으로 떨군다. */}
                    <Button
                        variant="outline"
                        size="icon"
                        onClick={() => (window.history.length > 1 ? router.back() : router.push("/"))}
                        className="h-10 w-10 border border-cur-hairline bg-cur-card hover:bg-cur-elevated text-cur-ink rounded-[8px]"
                    >
                        <ArrowLeft className="w-5 h-5" />
                    </Button>
                    {hasUser && (
                        <Button
                            variant="ghost"
                            onClick={handleLogout}
                            className="h-10 px-3 text-[13px] text-cur-muted hover:text-cur-ink"
                        >
                            <LogOut className="w-4 h-4 mr-1.5" /> 로그아웃
                        </Button>
                    )}
                </div>

                <header className="text-center space-y-2">
                    <h1 className="text-[26px] font-bold text-cur-ink tracking-[-0.02em]">요금제</h1>
                    <p className="text-[14px] text-cur-muted leading-relaxed">
                        플랜은 하나뿐이에요. 쓰는 계정 수만큼만 냅니다.
                    </p>
                </header>

                <section className="bg-cur-card rounded-[12px] border border-cur-hairline p-6 space-y-5">
                    <div className="text-center">
                        <p className="text-[36px] font-bold text-cur-ink leading-none tracking-[-0.02em]">
                            {(accountCount * SEAT_PRICE).toLocaleString()}
                            <span className="text-[16px] font-semibold text-cur-muted ml-1">원 / 월</span>
                        </p>
                        <p className="text-[13px] text-cur-muted mt-2">
                            {accountCount > 1
                                ? `내 현장 1 + 소속 현장 ${accountCount - 1} = 계정 ${accountCount}개 × ${SEAT_PRICE.toLocaleString()}원 · VAT 포함`
                                : `계정 1개 기준 · VAT 포함`}
                        </p>
                    </div>

                    {/* 계정이 여럿이면 위 실계산 문구가 이미 설명한다 — 예시 박스는 1계정일 때만 */}
                    {accountCount === 1 && (
                        <div className="rounded-[8px] bg-cur-elevated p-3.5 text-[13px] text-cur-body leading-relaxed">
                            현장이 여러 곳이면 <b className="text-cur-ink">현장 계정을 추가한 만큼만</b> 더 냅니다.
                        </div>
                    )}

                    <ul className="space-y-2.5">
                        {FEATURES.map((f) => (
                            <li key={f} className="flex items-start gap-2.5 text-[14px] text-cur-body">
                                <CheckCircle2 className="w-[18px] h-[18px] mt-px shrink-0 text-cur-primary" />
                                <span className="leading-snug">{f}</span>
                            </li>
                        ))}
                    </ul>
                </section>

                {renderAction()}

                <p className="text-[12px] text-cur-muted-soft text-center leading-relaxed">
                    첫 달 무료 체험 · 언제든 해지할 수 있어요.<br />
                    해지하면 남은 기간까지 이용할 수 있습니다.
                </p>
            </div>
        </div>
    )
}
