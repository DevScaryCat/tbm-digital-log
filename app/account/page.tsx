"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { SubscribeButtons } from "@/components/SubscribeButtons"
import { fetchSubscription, isAllowed, SubscriptionRow } from "@/lib/useSubscription"
import { Button } from "@/components/ui/button"
import { Loader2, CreditCard, CheckCircle2, XCircle, Receipt } from "lucide-react"

interface Payment {
    payment_id: string
    amount: number
    status: string
    paid_at: string | null
    created_at: string
}

const STATUS_LABEL: Record<string, string> = {
    trialing: "무료체험 중",
    active: "구독 중",
    past_due: "결제 실패",
    canceled: "해지됨",
}

const PAY_STATUS_LABEL: Record<string, string> = {
    paid: "결제완료",
    failed: "실패",
    canceled: "취소",
}

export default function AccountPage() {
    const router = useRouter()
    const [loading, setLoading] = useState(true)
    const [sub, setSub] = useState<SubscriptionRow | null>(null)
    const [payments, setPayments] = useState<Payment[]>([])
    const [busy, setBusy] = useState(false)
    const [changingMethod, setChangingMethod] = useState(false)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)

    const load = async () => {
        const {
            data: { user },
        } = await supabase.auth.getUser()
        if (!user) {
            router.replace("/login")
            return
        }
        setSub(await fetchSubscription())
        const { data } = await supabase
            .from("payments")
            .select("payment_id, amount, status, paid_at, created_at")
            .order("created_at", { ascending: false })
        setPayments((data as Payment[]) || [])
        setLoading(false)
    }

    useEffect(() => {
        load()
    }, [])

    const handleCancel = async () => {
        if (!confirm("정말 구독을 해지하시겠어요? 남은 기간까지는 계속 이용할 수 있습니다.")) return
        setBusy(true)
        setMsg(null)
        try {
            const { data: sessionData } = await supabase.auth.getSession()
            const res = await fetch("/api/payments/cancel", {
                method: "POST",
                headers: { Authorization: `Bearer ${sessionData?.session?.access_token}` },
            })
            const json = await res.json()
            if (!res.ok) {
                setMsg({ type: "err", text: json.error || "해지 실패" })
                return
            }
            setMsg({ type: "ok", text: "구독이 해지되었습니다. 남은 기간까지 이용 가능합니다." })
            await load()
        } finally {
            setBusy(false)
        }
    }

    const isGrandfather = sub?.plan === "grandfather"
    const active = isAllowed(sub)
    const nextDate = sub?.current_period_end
        ? new Date(sub.current_period_end).toLocaleDateString("ko-KR")
        : null
    const methodLabel = sub?.card_info?.last4
        ? `${sub.card_info.issuer ?? "카드"} ****${sub.card_info.last4}`
        : sub?.card_info?.provider ?? null

    return (
        <div className="min-h-screen bg-cur-canvas flex flex-col font-sans text-cur-body">
            <div className="w-full max-w-2xl mx-auto px-4 pt-4">
                <TBMHeader title="구독 및 결제" />
            </div>

            <div className="flex-1 w-full max-w-2xl mx-auto px-4 py-6 space-y-5">
                {loading ? (
                    <div className="flex justify-center py-20">
                        <Loader2 className="w-6 h-6 animate-spin text-cur-muted" />
                    </div>
                ) : (
                    <>
                        {msg && (
                            <div
                                className={`text-[14px] rounded-xl p-4 ${
                                    msg.type === "ok"
                                        ? "bg-cur-primary/10 text-cur-primary"
                                        : "bg-cur-error/10 text-cur-error"
                                }`}
                            >
                                {msg.text}
                            </div>
                        )}

                        {/* 현재 상태 */}
                        <div className="bg-cur-card rounded-2xl p-6 border border-cur-hairline">
                            <div className="flex items-center gap-2 mb-4">
                                {active ? (
                                    <CheckCircle2 className="w-5 h-5 text-cur-primary" />
                                ) : (
                                    <XCircle className="w-5 h-5 text-cur-muted" />
                                )}
                                <h2 className="text-[18px] font-bold text-cur-ink">
                                    {isGrandfather ? "평생 무료 이용 중" : STATUS_LABEL[sub?.status ?? ""] ?? "구독 없음"}
                                </h2>
                            </div>

                            {isGrandfather ? (
                                <p className="text-[14px] text-cur-muted">
                                    기존 사용자 혜택으로 모든 기능을 무료로 이용하고 계십니다. 별도 결제가 필요 없습니다.
                                </p>
                            ) : (
                                <div className="space-y-2 text-[14px]">
                                    <div className="flex justify-between">
                                        <span className="text-cur-muted">플랜</span>
                                        <span className="text-cur-ink font-medium">월간 구독 (1,900원/월)</span>
                                    </div>
                                    {methodLabel && (
                                        <div className="flex justify-between">
                                            <span className="text-cur-muted">결제수단</span>
                                            <span className="text-cur-ink font-medium flex items-center gap-1">
                                                <CreditCard className="w-4 h-4" /> {methodLabel}
                                            </span>
                                        </div>
                                    )}
                                    {nextDate && (
                                        <div className="flex justify-between">
                                            <span className="text-cur-muted">
                                                {sub?.status === "canceled" ? "이용 종료일" : "다음 결제일"}
                                            </span>
                                            <span className="text-cur-ink font-medium">{nextDate}</span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* 액션: 평생무료가 아니면 결제수단 변경/해지/재구독 */}
                        {!isGrandfather && (
                            <div className="bg-cur-card rounded-2xl p-6 border border-cur-hairline space-y-4">
                                {active && sub?.status !== "canceled" ? (
                                    <>
                                        {changingMethod ? (
                                            <SubscribeButtons
                                                mode="update"
                                                onSuccess={async () => {
                                                    setChangingMethod(false)
                                                    await load()
                                                }}
                                                ctaSuffix="로 변경"
                                                successText="결제수단이 변경되었습니다."
                                            />
                                        ) : (
                                            <Button
                                                onClick={() => setChangingMethod(true)}
                                                className="w-full h-11 rounded-xl bg-cur-elevated text-cur-ink border border-cur-hairline hover:bg-cur-hairline font-bold"
                                            >
                                                결제수단 변경
                                            </Button>
                                        )}
                                        <Button
                                            onClick={handleCancel}
                                            disabled={busy}
                                            className="w-full h-11 rounded-xl bg-transparent text-cur-error border border-cur-error/30 hover:bg-cur-error/10 font-bold"
                                        >
                                            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "구독 해지"}
                                        </Button>
                                    </>
                                ) : (
                                    // 미구독 / 해지(기간만료) / 결제실패 → 재구독
                                    <>
                                        <p className="text-[14px] text-cur-muted text-center">
                                            {sub?.status === "canceled"
                                                ? "다시 구독하면 모든 기능을 계속 이용할 수 있습니다."
                                                : "구독하고 모든 기능을 이용하세요."}
                                        </p>
                                        <SubscribeButtons onSuccess={load} />
                                    </>
                                )}
                            </div>
                        )}

                        {/* 결제 내역 */}
                        <div className="bg-cur-card rounded-2xl p-6 border border-cur-hairline">
                            <div className="flex items-center gap-2 mb-4">
                                <Receipt className="w-5 h-5 text-cur-muted" />
                                <h2 className="text-[16px] font-bold text-cur-ink">결제 내역</h2>
                            </div>
                            {payments.length === 0 ? (
                                <p className="text-[14px] text-cur-muted-soft py-4 text-center">결제 내역이 없습니다.</p>
                            ) : (
                                <div className="divide-y divide-cur-hairline">
                                    {payments.map((p) => (
                                        <div key={p.payment_id} className="flex items-center justify-between py-3 text-[14px]">
                                            <div>
                                                <p className="text-cur-ink font-medium">
                                                    {new Date(p.paid_at ?? p.created_at).toLocaleDateString("ko-KR")}
                                                </p>
                                                <p
                                                    className={`text-[12px] ${
                                                        p.status === "paid" ? "text-cur-primary" : "text-cur-error"
                                                    }`}
                                                >
                                                    {PAY_STATUS_LABEL[p.status] ?? p.status}
                                                </p>
                                            </div>
                                            <span className="text-cur-ink font-bold">{p.amount.toLocaleString()}원</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    )
}
