"use client"

/* Hallmark · component: pricing panel · genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * 단일 요금제 — 고를 티어가 하나뿐이라 비교표·플랜 타일·업/다운그레이드 UI를 전부 걷어냈다.
 * 남는 결정은 "결제수단을 등록할지"뿐이다.
 */

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Check, ArrowLeft, Loader2, LogOut, Sparkles } from "lucide-react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { SubscribeButtons } from "@/components/SubscribeButtons"
import { BillingRedirectHandler } from "@/components/BillingRedirectHandler"
import { fetchSubscription, isAllowed, isWhitelist, SubscriptionRow } from "@/lib/useSubscription"
import { GrandfatherNotice } from "@/components/GrandfatherNotice"
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
    const isGrandfather = isWhitelist(sub)
    const nextDate = sub?.current_period_end
        ? new Date(sub.current_period_end).toLocaleDateString("ko-KR")
        : null
    // 카드 없는 무료체험(휴대폰인증 가입): 결제가 아니라 '결제수단 등록'으로 유도해야 한다.
    const cardlessTrial = sub?.status === "trialing" && !sub?.card_info
    // 만료된 카드 없는 체험 — 홈·위저드가 이리로 축출하는 착지점이라, "무료체험 중"이라는
    // 현재형은 거짓이 된다(qa 실측: 이틀 지난 종료일을 '체험 중'으로 표기). 문구만 분기.
    const cardlessTrialExpired =
        cardlessTrial && !!sub?.current_period_end && new Date(sub.current_period_end).getTime() < Date.now()
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

        // 영구 무료(grandfather)는 이 함수에 오지 않는다 — 아래 렌더에서 renderAction 자체를
        // 부르지 않고 GrandfatherNotice 한 장만 띄운다(구매 버튼·요금·결제수단 전부 없음).
        // 2026-08-10 Chris: 이 계정들은 "결제 시스템만 빠진 유료 계정"이라 팔 것이 없다.

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
                            <Sparkles className="w-4 h-4 text-cur-primary" />{" "}
                            {cardlessTrialExpired ? "무료체험 종료" : "무료체험 중"}
                            {nextDate ? ` · ${cardlessTrialExpired ? "종료일" : "체험 종료일"} ${nextDate}` : ""}
                        </p>
                        <p className="mt-1 text-cur-muted">
                            {/* 금액은 계정 수 반영 — 고정 3,900원 표기는 다계정 감독자에게 거짓말이 된다 */}
                            {cardlessTrialExpired ? "결제수단을 등록하면 바로 이어서 쓸 수 있어요 — 등록 시 " : "계속 쓰려면 결제수단을 등록하세요 — 체험 종료일부터 "}
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

                {/* 부제를 없앴다(Chris) — "플랜은 하나뿐이에요. 쓰는 계정 수만큼만 냅니다"는
                    설명하려다 오히려 "왜 계정이 여러 개인데?"를 만들었다. 계정 단위 과금은
                    금액 바로 아래 한 줄이면 충분하고, 계정이 여럿인 사람에겐 실계산이 대신 말한다. */}
                {/* 영구 무료 계정에게 '요금제'는 살 것이 있다는 뜻이 된다 — 제목부터 바꾼다 */}
                <h1 className="text-[26px] font-bold text-cur-ink tracking-[-0.02em] text-center">
                    {isGrandfather ? "이용 정보" : "요금제"}
                </h1>

                {/* 로딩 중엔 sub이 null이라 isGrandfather=false다. 금액을 먼저 그렸다가 무료 안내로
                    바뀌면 영구 무료 사용자에게 요금이 한 번 번쩍인다 — 로딩 동안은 금액을 숨긴다. */}
                {isGrandfather && <GrandfatherNotice />}

                <section className="bg-cur-card rounded-[12px] border border-cur-hairline overflow-hidden">
                    {!isGrandfather && !loading && (
                        <div className="text-center px-6 pt-7 pb-6 border-b border-cur-hairline">
                            <p className="text-[40px] font-bold text-cur-ink leading-none tracking-[-0.03em]">
                                {(accountCount * SEAT_PRICE).toLocaleString()}
                                <span className="text-[15px] font-semibold text-cur-muted ml-1.5">원</span>
                            </p>
                            <p className="text-[13px] text-cur-muted mt-2.5">
                                {accountCount > 1
                                    ? `계정 ${accountCount}개 × ${SEAT_PRICE.toLocaleString()}원 · 매달 · VAT 포함`
                                    : `계정 1개당 · 매달 · VAT 포함`}
                            </p>
                            <p className="text-[12px] text-cur-muted-soft mt-1">첫 달 무료 · 언제든 해지</p>
                        </div>
                    )}

                    {/* 영구 무료도 한도까지 유료와 같으므로 이 목록은 그대로가 진실이다(200/30/20) */}
                    <ul className="px-6 py-5 space-y-3">
                        {FEATURES.map((f) => (
                            <li key={f} className="flex items-start gap-2.5 text-[14px] text-cur-body">
                                <Check className="w-4 h-4 mt-[3px] shrink-0 text-cur-muted-soft" strokeWidth={2.5} />
                                <span className="leading-snug">{f}</span>
                            </li>
                        ))}
                    </ul>
                </section>

                {!isGrandfather && renderAction()}

                {!isGrandfather && (
                    <p className="text-[12px] text-cur-muted-soft text-center leading-relaxed">
                        해지해도 남은 기간까지는 그대로 쓸 수 있어요.
                    </p>
                )}
            </div>
        </div>
    )
}
