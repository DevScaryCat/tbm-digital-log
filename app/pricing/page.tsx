"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { CheckCircle2, Minus, ArrowLeft, Loader2, LogOut, Sparkles } from "lucide-react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { SubscribeButtons } from "@/components/SubscribeButtons"
import { fetchSubscription, isAllowed, SubscriptionRow } from "@/lib/useSubscription"
import { cn, paymentsEnabled } from "@/lib/utils"

type PlanId = "monthly_basic" | "monthly_pro"

const STATUS_LABEL: Record<string, string> = {
    trialing: "무료체험 중",
    active: "구독 중",
    past_due: "결제 실패",
    canceled: "해지됨",
}

const PLAN_LABEL: Record<PlanId, string> = {
    monthly_basic: "베이직",
    monthly_pro: "Pro",
}

// 기능 비교표 (text가 있으면 텍스트, 없으면 ✓/— 표시)
const FEATURES: { label: string; basic?: boolean; pro?: boolean; basicText?: string; proText?: string }[] = [
    { label: "TBM 회의록 작성", basicText: "월 10회", proText: "월 30회" },
    { label: "안전보건교육일지 작성", basicText: "월 80회", proText: "월 200회" },
    { label: "AI 분석 보고서 생성", basic: false, proText: "월 20회" },
    { label: "AI 일지·회의록 자동 생성 (녹음·음성)", basic: true, pro: true },
    { label: "무제한 프로젝트 및 인원 등록", basic: true, pro: true },
    { label: "클라우드 보안 저장 (1년 보관)", basic: true, pro: true },
    { label: "참석자 전자 서명", basic: true, pro: true },
    { label: "월간 안전 보고서 자동 발송", basic: false, pro: true },
    { label: "사장·안전관리자 메일 자동 전달 (가입 불필요)", basic: false, pro: true },
]

export default function PricingPage() {
    const router = useRouter()

    const [loading, setLoading] = useState(true)
    const [hasUser, setHasUser] = useState(false)
    const [sub, setSub] = useState<SubscriptionRow | null>(null)
    const [selected, setSelected] = useState<PlanId | null>(null)
    const [changing, setChanging] = useState(false)
    const [changeMsg, setChangeMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)

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
            const s = await loadSubscription()
            // 구독 중이면 현재 플랜을 기본 선택 (grandfather는 베이직으로 취급)
            if (isAllowed(s) && s?.plan) setSelected(s.plan === "grandfather" ? "monthly_basic" : (s.plan as PlanId))
            setLoading(false)
        })()
    }, [])

    const subscribed = isAllowed(sub)
    const isGrandfather = sub?.plan === "grandfather"
    const currentPlan = (sub?.plan as PlanId | undefined) ?? null
    const pending = (sub?.pending_plan as PlanId | null) ?? null
    const nextDate = sub?.current_period_end
        ? new Date(sub.current_period_end).toLocaleDateString("ko-KR")
        : null
    // 카드 없는 무료체험(휴대폰인증 가입): 결제/변경이 아니라 '결제수단 등록'으로 유도해야 한다.
    const cardlessTrial = sub?.status === "trialing" && !sub?.card_info
    // 카드가 붙은 체험 = 결제일 자동청구 확정 구독 → '무료체험 중'이 아니라 '이용 중'으로 표기
    const committedTrial = sub?.status === "trialing" && !!sub?.card_info
    const statusLabel = committedTrial ? "이용 중" : STATUS_LABEL[sub?.status ?? ""] ?? "이용 중"

    const changePlan = async (plan: PlanId) => {
        setChangeMsg(null)
        setChanging(true)
        try {
            const { data: sessionData } = await supabase.auth.getSession()
            const token = sessionData?.session?.access_token
            const res = await fetch("/api/payments/change-plan", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ plan }),
            })
            const json = await res.json()
            if (!res.ok) {
                setChangeMsg({ type: "err", text: json.error || "플랜 변경 실패" })
                return
            }
            const isCancel = plan === currentPlan
            setChangeMsg({
                type: "ok",
                text: isCancel
                    ? "플랜 변경 예약을 취소했습니다."
                    : plan === "monthly_pro"
                    ? "다음 결제일부터 Pro(4,900원)로 변경됩니다. 그때까지는 현재 플랜 그대로 이용됩니다."
                    : "다음 결제일부터 베이직(1,900원)으로 변경됩니다. 그때까지는 Pro를 계속 이용할 수 있어요.",
            })
            await loadSubscription()
        } finally {
            setChanging(false)
        }
    }

    // 선택된 플랜에 대한 하단 액션 영역
    const renderAction = () => {
        if (loading) {
            return (
                <Button disabled className="w-full h-12 rounded-xl">
                    <Loader2 className="w-4 h-4 animate-spin" />
                </Button>
            )
        }
        const payOff = !paymentsEnabled()

        // 화이트리스트(영구 무료 베이직)
        if (isGrandfather) {
            // Pro를 보려고 선택한 경우 → 카드 등록 필요
            if (selected === "monthly_pro") {
                return (
                    <div className="space-y-3">
                        <div className="rounded-xl bg-cur-primary/[0.06] border border-cur-primary/30 p-4 text-[13px] text-cur-ink text-center">
                            Pro 기능(AI 분석 보고서·월간 보고서)을 이용하려면 <b>카드 등록</b> 후 Pro 구독이 필요합니다.
                        </div>
                        {payOff ? (
                            <div className="rounded-xl bg-cur-elevated border border-cur-hairline p-4 text-center">
                                <p className="text-[14px] font-medium text-cur-ink">결제 준비 중입니다</p>
                                <p className="text-[13px] text-cur-muted mt-1">실제 결제 연동 작업 중이에요. 곧 오픈됩니다.</p>
                            </div>
                        ) : (
                            <SubscribeButtons onSuccess={loadSubscription} plan="monthly_pro" ctaSuffix="로 Pro 시작" />
                        )}
                    </div>
                )
            }
            return (
                <div className="rounded-xl bg-cur-elevated border border-cur-hairline p-5 text-center space-y-1">
                    <p className="font-bold text-cur-ink">베이직 · 영구 무료 이용 중</p>
                    <p className="text-cur-muted text-[13px]">기존 가입자 혜택입니다. Pro 기능이 필요하면 위에서 Pro를 선택하세요.</p>
                </div>
            )
        }

        // 결제 준비 중(실연동 전): 신규 결제·플랜 변경 차단
        if (payOff) {
            if (selected && subscribed && currentPlan === selected) {
                return (
                    <div className="rounded-xl bg-cur-elevated border border-cur-hairline p-4 text-center space-y-1">
                        <p className="font-bold text-cur-ink">{PLAN_LABEL[selected]} · {statusLabel}</p>
                        {nextDate && <p className="text-cur-muted text-[14px]">다음 결제일: {nextDate}</p>}
                    </div>
                )
            }
            return (
                <div className="rounded-xl bg-cur-elevated border border-cur-hairline p-4 text-center">
                    <p className="text-[14px] font-medium text-cur-ink">결제 준비 중입니다</p>
                    <p className="text-[13px] text-cur-muted mt-1">실제 결제 연동 작업 중이에요. 곧 오픈됩니다.</p>
                </div>
            )
        }

        if (!selected) {
            return (
                <p className="text-center text-[14px] text-cur-muted py-2">
                    위에서 플랜을 선택해주세요.
                </p>
            )
        }
        // 카드 없는 무료체험: '플랜 변경'/'다음 결제일'이 아니라 선택한 플랜으로 결제수단 등록을 유도.
        // 등록하면 체험 종료일부터 선택한 플랜으로 자동 결제가 시작된다(billing-key가 pending_plan 예약).
        if (cardlessTrial) {
            const sameAsCurrent = selected === currentPlan
            return (
                <div className="space-y-3">
                    <div className="rounded-xl bg-cur-primary/[0.06] border border-cur-primary/30 p-4 text-[13px] leading-relaxed">
                        <p className="font-bold text-cur-ink flex items-center gap-1.5">
                            <Sparkles className="w-4 h-4 text-cur-primary" /> 무료체험 중{nextDate ? ` · 체험 종료일 ${nextDate}` : ""}
                        </p>
                        <p className="mt-1 text-cur-muted">
                            지금은 무료로 이용 중입니다. 체험이 끝난 뒤에도 계속 이용하려면 결제수단을 등록해 주세요.
                            등록하면 <b className="text-cur-ink">체험 종료일부터 {PLAN_LABEL[selected]} 요금({selected === "monthly_pro" ? "4,900원" : "1,900원"}/월)이 자동으로 결제</b>됩니다. 등록 전에는 결제되지 않습니다.
                            {!sameAsCurrent && <span className="block mt-1">체험 기간에는 현재 Pro 혜택이 그대로 유지됩니다.</span>}
                        </p>
                    </div>
                    <SubscribeButtons
                        plan={selected}
                        onSuccess={loadSubscription}
                        ctaSuffix="로 등록"
                        successText="결제수단이 등록되었습니다. 체험 종료 후 자동으로 결제됩니다."
                    />
                </div>
            )
        }
        // 이미 이 플랜 구독 중
        if (subscribed && currentPlan === selected) {
            return (
                <div className="rounded-xl bg-cur-elevated border border-cur-hairline p-4 text-center space-y-2">
                    <p className="font-bold text-cur-ink">
                        {PLAN_LABEL[selected]} · {statusLabel}
                    </p>
                    {nextDate && <p className="text-cur-muted text-[14px]">다음 결제일: {nextDate}</p>}
                    {pending && pending !== currentPlan && (
                        <p className="text-[13px] text-cur-primary">
                            다음 결제일부터 {PLAN_LABEL[pending]}로 변경 예정
                        </p>
                    )}
                </div>
            )
        }
        // 다른 플랜 구독 중 → 이 플랜으로 변경(예약)
        if (subscribed && currentPlan !== selected) {
            const toPro = selected === "monthly_pro"
            // 이미 이 플랜으로 변경 예약된 상태 → 예약 취소 안내
            if (pending === selected) {
                return (
                    <div className="space-y-2">
                        <div className="rounded-xl bg-cur-primary/[0.06] border border-cur-primary/30 p-4 text-center text-[14px] text-cur-ink">
                            다음 결제일부터 <b>{PLAN_LABEL[selected]}</b>로 변경 예정입니다.
                        </div>
                        <Button onClick={() => changePlan(currentPlan!)} disabled={changing} variant="ghost" className="w-full h-10 text-cur-muted hover:text-cur-ink text-[13px]">
                            {changing ? <Loader2 className="w-4 h-4 animate-spin" /> : "변경 예약 취소"}
                        </Button>
                    </div>
                )
            }
            return (
                <div className="space-y-2">
                    <Button
                        onClick={() => changePlan(selected)}
                        disabled={changing}
                        className={cn("w-full font-bold h-12 rounded-xl text-white hover:opacity-90", toPro ? "bg-cur-primary" : "bg-cur-ink")}
                    >
                        {changing ? <Loader2 className="w-4 h-4 animate-spin" /> : toPro ? "Pro로 업그레이드" : "베이직으로 변경"}
                    </Button>
                    <p className="text-[12px] text-cur-muted-soft text-center">변경은 다음 결제일부터 적용됩니다.</p>
                </div>
            )
        }
        // 미구독 → 결제수단 선택
        return (
            <div className="space-y-3">
                <p className="text-center text-[14px] font-medium text-cur-ink">
                    {PLAN_LABEL[selected]} 플랜 · {selected === "monthly_pro" ? "4,900원" : "1,900원"}/월
                </p>
                <SubscribeButtons onSuccess={loadSubscription} plan={selected} />
            </div>
        )
    }

    // 플랜 선택 헤더 타일
    const PlanTile = ({ plan }: { plan: PlanId }) => {
        const isPro = plan === "monthly_pro"
        const active = selected === plan
        const mine = subscribed && (currentPlan === plan || (isGrandfather && plan === "monthly_basic"))
        return (
            <button
                type="button"
                onClick={() => setSelected(plan)}
                className={cn(
                    "relative flex-1 text-left rounded-2xl border-2 p-4 transition-all",
                    active ? "border-cur-primary bg-cur-primary/[0.04]" : "border-cur-hairline bg-cur-card hover:border-cur-primary/40"
                )}
            >
                {mine && (
                    <div className="absolute -top-2.5 left-3 bg-cur-ink text-white text-[11px] font-bold px-2.5 py-0.5 rounded-full flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> 내 플랜
                    </div>
                )}
                {isPro && (
                    <div className="absolute -top-2.5 right-3 bg-cur-primary text-white text-[11px] font-bold px-2.5 py-0.5 rounded-full flex items-center gap-1">
                        <Sparkles className="w-3 h-3" /> 추천
                    </div>
                )}
                <div className="flex items-center gap-2 mb-1">
                    <span
                        className={cn(
                            "w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0",
                            active ? "border-cur-primary" : "border-cur-muted-soft"
                        )}
                    >
                        {active && <span className="w-2 h-2 rounded-full bg-cur-primary" />}
                    </span>
                    <span className="font-bold text-cur-ink text-[16px]">{PLAN_LABEL[plan]}</span>
                </div>
                <div className="flex items-end gap-1 pl-6">
                    <span className="text-[24px] font-bold text-cur-ink tracking-tight">
                        {isPro ? "4,900" : "1,900"}
                    </span>
                    <span className="text-[13px] text-cur-muted mb-1">원/월</span>
                </div>
                {!sub?.trial_used && (
                    <div className="pl-6 mt-1">
                        <span className="inline-block bg-cur-primary/10 text-cur-primary text-[11px] font-bold px-2 py-0.5 rounded-full">
                            첫 달 무료
                        </span>
                    </div>
                )}
            </button>
        )
    }

    return (
        <div className="min-h-screen bg-cur-canvas flex flex-col font-sans text-cur-body">
            <div className="sticky top-0 z-10 bg-cur-canvas border-b border-cur-hairline p-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                    {subscribed && (
                        <Button variant="ghost" size="icon" onClick={() => router.back()}>
                            <ArrowLeft className="w-5 h-5" />
                        </Button>
                    )}
                    <h1 className="text-lg font-bold text-cur-ink">요금안내</h1>
                </div>
                {!loading && hasUser && !subscribed && (
                    <Button
                        variant="ghost"
                        onClick={handleLogout}
                        className="text-cur-muted hover:text-cur-error gap-1.5 text-[14px] font-medium"
                    >
                        <LogOut className="w-4 h-4" /> 로그아웃
                    </Button>
                )}
            </div>

            <div className="flex-1 max-w-md mx-auto w-full py-10 px-5">
                <div className="text-center mb-8">
                    <h2 className="text-[26px] font-bold text-cur-ink mb-3">현장의 안전을 위한 완벽한 선택</h2>
                    <p className="text-cur-muted text-[15px]">플랜을 선택하고 결제수단을 정하세요.</p>
                </div>

                {changeMsg && (
                    <div
                        className={cn(
                            "mb-6 text-[14px] rounded-xl p-4 text-center",
                            changeMsg.type === "ok" ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-error/10 text-cur-error"
                        )}
                    >
                        {changeMsg.text}
                    </div>
                )}

                {/* 1단계: 플랜 선택 */}
                <div className="flex gap-3 mb-6">
                    <PlanTile plan="monthly_basic" />
                    <PlanTile plan="monthly_pro" />
                </div>

                {/* 기능 비교표 */}
                <div className="bg-cur-card rounded-2xl border border-cur-hairline overflow-hidden mb-6">
                    <table className="w-full text-[14px] border-collapse">
                        <thead>
                            <tr className="border-b border-cur-hairline bg-cur-elevated/50">
                                <th className="text-left font-semibold text-cur-muted px-4 py-3 text-[13px]">기능</th>
                                <th className={cn("w-16 text-center font-bold py-3 text-[13px]", selected === "monthly_basic" ? "text-cur-primary" : "text-cur-ink")}>
                                    베이직
                                </th>
                                <th className={cn("w-16 text-center font-bold py-3 text-[13px]", selected === "monthly_pro" ? "text-cur-primary" : "text-cur-ink")}>
                                    Pro
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {FEATURES.map((f, idx) => (
                                <tr key={idx} className="border-b border-cur-hairline last:border-0">
                                    <td className="px-4 py-3 text-cur-ink leading-snug">{f.label}</td>
                                    <td className={cn("text-center py-3", selected === "monthly_basic" && "bg-cur-primary/[0.04]")}>
                                        {f.basicText ? (
                                            <span className="text-[13px] font-semibold text-cur-primary">{f.basicText}</span>
                                        ) : f.basic ? (
                                            <CheckCircle2 className="w-5 h-5 text-cur-primary inline-block" />
                                        ) : (
                                            <Minus className="w-4 h-4 text-cur-muted-soft inline-block" />
                                        )}
                                    </td>
                                    <td className={cn("text-center py-3", selected === "monthly_pro" && "bg-cur-primary/[0.04]")}>
                                        {f.proText ? (
                                            <span className="text-[13px] font-semibold text-cur-primary">{f.proText}</span>
                                        ) : f.pro ? (
                                            <CheckCircle2 className="w-5 h-5 text-cur-primary inline-block" />
                                        ) : (
                                            <Minus className="w-4 h-4 text-cur-muted-soft inline-block" />
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {/* 2단계: 결제 / 액션 */}
                <div className="bg-cur-card rounded-2xl p-6 border border-cur-hairline">
                    {renderAction()}
                </div>

                <div className="mt-8 text-center text-[13px] text-cur-muted-soft bg-cur-card p-6 rounded-xl border border-cur-hairline">
                    <p className="mb-2 font-medium">환불 규정 안내</p>
                    <p>구독 중도 해지 시, 이미 결제한 이용요금 중 이용하지 않은 잔여 기간을 일할 계산하여 환불해 드립니다.</p>
                    <p>결제일로부터 7일 이내이며 서비스 이용 이력이 전혀 없는 경우에는 전액 환불이 가능합니다.</p>
                </div>
            </div>
        </div>
    )
}
