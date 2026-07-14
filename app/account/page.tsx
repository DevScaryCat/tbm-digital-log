"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { SubscribeButtons } from "@/components/SubscribeButtons"
import { fetchSubscription, isAllowed, isProActive, SubscriptionRow } from "@/lib/useSubscription"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2, CheckCircle2, XCircle, Receipt, Mail, Send, Plus, Trash2, Sparkles } from "lucide-react"

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
    const [showRegister, setShowRegister] = useState(false)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)

    // Pro: 월간 보고서 수신처
    const [recipients, setRecipients] = useState<string[]>([])
    const [newEmail, setNewEmail] = useState("")
    const [savingRecipients, setSavingRecipients] = useState(false)
    const [sending, setSending] = useState(false)

    const load = async () => {
        const {
            data: { user },
        } = await supabase.auth.getUser()
        if (!user) {
            router.replace("/login")
            return
        }
        const s = await fetchSubscription()
        setSub(s)
        const { data } = await supabase
            .from("payments")
            .select("payment_id, amount, status, paid_at, created_at")
            .order("created_at", { ascending: false })
        setPayments((data as Payment[]) || [])
        if (isProActive(s)) {
            const { data: sessionData } = await supabase.auth.getSession()
            const res = await fetch("/api/reports/recipients", {
                headers: { Authorization: `Bearer ${sessionData?.session?.access_token}` },
            })
            if (res.ok) {
                const j = await res.json()
                setRecipients(j.recipients ?? [])
            }
        }
        setLoading(false)
    }

    useEffect(() => {
        load()
    }, [])

    const saveRecipients = async (next: string[]) => {
        setSavingRecipients(true)
        setMsg(null)
        try {
            const { data: sessionData } = await supabase.auth.getSession()
            const res = await fetch("/api/reports/recipients", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionData?.session?.access_token}` },
                body: JSON.stringify({ recipients: next }),
            })
            const j = await res.json()
            if (!res.ok) {
                setMsg({ type: "err", text: j.error || "저장 실패" })
                return false
            }
            setRecipients(j.recipients ?? next)
            return true
        } finally {
            setSavingRecipients(false)
        }
    }

    const addRecipient = async () => {
        const email = newEmail.trim()
        if (!email) return
        if (recipients.includes(email)) {
            setMsg({ type: "err", text: "이미 등록된 이메일입니다." })
            return
        }
        const ok = await saveRecipients([...recipients, email])
        if (ok) {
            setNewEmail("")
            setMsg({ type: "ok", text: "수신처가 추가되었습니다." })
        }
    }

    const removeRecipient = async (email: string) => {
        await saveRecipients(recipients.filter((e) => e !== email))
    }

    const sendNow = async () => {
        setSending(true)
        setMsg(null)
        try {
            const { data: sessionData } = await supabase.auth.getSession()
            const res = await fetch("/api/reports/send", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionData?.session?.access_token}` },
                body: JSON.stringify({ which: "current" }),
            })
            const j = await res.json()
            if (!res.ok) {
                setMsg({ type: "err", text: j.error || "발송 실패" })
                return
            }
            setMsg({ type: "ok", text: `이번 달 보고서를 ${recipients.length}곳으로 발송했습니다.` })
        } finally {
            setSending(false)
        }
    }

    const handleCancel = async () => {
        if (
            !confirm(
                "정말 구독을 해지하시겠어요?\n무료체험 중이면 남은 기간까지 이용할 수 있고, 유료 이용 중이면 사용하지 않은 잔여 기간을 일할 계산해 환불해 드립니다."
            )
        )
            return
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
            const text = json.refundNotice
                ? json.refundNotice
                : json.refunded > 0
                ? `구독이 해지되었습니다. 잔여 기간분 ${Number(json.refunded).toLocaleString()}원이 환불 처리되었습니다.`
                : "구독이 해지되었습니다. 남은 기간까지 이용 가능합니다."
            setMsg({ type: "ok", text })
            await load()
        } finally {
            setBusy(false)
        }
    }

    const isGrandfather = sub?.plan === "grandfather"
    const active = isAllowed(sub)
    const pro = isProActive(sub)
    // 카드 없는 무료체험(휴대폰인증 가입): card_info 없음 + 상태 trialing.
    // active면 체험 진행 중, 아니면(기간 만료) 체험 종료 상태.
    const cardlessTrial = sub?.status === "trialing" && !sub?.card_info
    const cardlessTrialActive = cardlessTrial && active
    const cardlessTrialExpired = cardlessTrial && !active
    const planLabel =
        sub?.plan === "monthly_pro" ? "Pro 플랜 (4,900원/월)" : "베이직 플랜 (1,900원/월)"
    const nextDate = sub?.current_period_end
        ? new Date(sub.current_period_end).toLocaleDateString("ko-KR")
        : null
    const methodLabel = sub?.card_info?.last4
        ? `${sub.card_info.issuer ?? "카드"} ****${sub.card_info.last4}`
        : sub?.card_info?.provider ?? null

    return (
        <div className="min-h-screen bg-cur-canvas flex flex-col font-sans text-cur-body">
            <div className="w-full max-w-md mx-auto px-4 pt-4">
                <TBMHeader title="구독 및 결제" />
            </div>

            <div className="flex-1 w-full max-w-md mx-auto px-4 py-6 space-y-5">
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
                                    {isGrandfather
                                        ? "베이직 · 영구 무료"
                                        : cardlessTrialExpired
                                        ? "무료체험 종료"
                                        : STATUS_LABEL[sub?.status ?? ""] ?? "구독 없음"}
                                </h2>
                            </div>

                            {isGrandfather ? (
                                <p className="text-[14px] text-cur-muted leading-relaxed">
                                    기존 가입자 혜택으로 베이직 요금제를 영구 무료로 이용 중입니다. AI 분석 보고서·월간 보고서 등 Pro 기능은 카드 등록 후 Pro로 업그레이드하면 이용하실 수 있어요.
                                </p>
                            ) : (
                                <div className="space-y-2 text-[14px]">
                                    <div className="flex justify-between">
                                        <span className="text-cur-muted">플랜</span>
                                        <span className="text-cur-ink font-medium">{planLabel}</span>
                                    </div>
                                    {methodLabel && (
                                        <div className="flex justify-between">
                                            <span className="text-cur-muted">결제수단</span>
                                            <span className="text-cur-ink font-medium">{methodLabel}</span>
                                        </div>
                                    )}
                                    {nextDate && (
                                        <div className="flex justify-between">
                                            <span className="text-cur-muted">
                                                {sub?.status === "canceled" ? "이용 종료일" : cardlessTrial ? "체험 종료일" : "다음 결제일"}
                                            </span>
                                            <span className="text-cur-ink font-medium">{nextDate}</span>
                                        </div>
                                    )}
                                    {sub?.pending_plan && sub.pending_plan !== sub.plan && (
                                        <div className="rounded-lg bg-cur-primary/[0.06] border border-cur-primary/30 px-3 py-2 text-[13px] text-cur-primary">
                                            다음 결제일부터 {sub.pending_plan === "monthly_pro" ? "Pro 플랜(4,900원)" : "베이직 플랜(1,900원)"}으로 변경 예정
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* 액션: 카드 없는 무료체험(진행/종료) → 등록 안내 / 그 외 → 변경·해지·재구독 */}
                        {!isGrandfather && cardlessTrialActive && (
                            <div className="bg-cur-card rounded-2xl p-6 border border-cur-hairline space-y-4">
                                <div className="rounded-xl bg-cur-primary/[0.06] border border-cur-primary/30 p-4 space-y-1.5">
                                    <p className="text-[14px] font-bold text-cur-ink flex items-center gap-1.5">
                                        <Sparkles className="w-4 h-4 text-cur-primary" /> Pro 1개월 무료체험 중
                                    </p>
                                    <p className="text-[13px] text-cur-muted leading-relaxed">
                                        {nextDate ? `${nextDate}까지 ` : ""}모든 기능을 무료로 이용하세요.
                                        체험이 끝난 뒤에도 계속 이용하려면 아래에서 결제수단을 등록해 주세요.
                                        <b className="text-cur-ink"> 등록 전에는 자동으로 결제되지 않습니다.</b>
                                    </p>
                                </div>
                                {showRegister ? (
                                    <div className="space-y-3">
                                        <SubscribeButtons
                                            plan={sub?.plan === "monthly_basic" ? "monthly_basic" : "monthly_pro"}
                                            onSuccess={async () => {
                                                setShowRegister(false)
                                                await load()
                                            }}
                                            ctaSuffix="로 계속 이용"
                                            successText="결제수단이 등록되었습니다. 체험 종료 후 자동으로 결제됩니다."
                                        />
                                        <Button
                                            variant="ghost"
                                            onClick={() => setShowRegister(false)}
                                            className="w-full h-9 text-cur-muted hover:text-cur-ink text-[13px]"
                                        >
                                            나중에 하기
                                        </Button>
                                    </div>
                                ) : (
                                    <Button
                                        onClick={() => setShowRegister(true)}
                                        className="w-full h-11 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90"
                                    >
                                        결제수단 등록하고 계속 이용
                                    </Button>
                                )}
                            </div>
                        )}

                        {!isGrandfather && cardlessTrialExpired && (
                            <div className="bg-cur-card rounded-2xl p-6 border border-cur-hairline space-y-4">
                                <div className="rounded-xl bg-cur-elevated border border-cur-hairline p-4">
                                    <p className="text-[14px] text-cur-ink leading-relaxed">
                                        무료체험이 종료되었습니다. 계속 이용하시려면 결제수단을 등록해 주세요. 등록 즉시 결제되어 바로 이어서 사용할 수 있습니다.
                                    </p>
                                </div>
                                <SubscribeButtons
                                    plan={sub?.plan === "monthly_basic" ? "monthly_basic" : "monthly_pro"}
                                    onSuccess={load}
                                    ctaSuffix="로 이어서 이용"
                                    successText="결제가 완료되어 이어서 이용하실 수 있습니다."
                                />
                                <Button
                                    variant="ghost"
                                    onClick={() => router.push("/pricing")}
                                    className="w-full h-9 text-cur-muted hover:text-cur-ink text-[13px]"
                                >
                                    플랜(베이직/Pro) 다시 선택하기
                                </Button>
                            </div>
                        )}

                        {!isGrandfather && !cardlessTrial && (
                            <div className="bg-cur-card rounded-2xl p-6 border border-cur-hairline space-y-4">
                                {active && sub?.status !== "canceled" ? (
                                    <>
                                        {changingMethod ? (
                                            <div className="space-y-3">
                                                {methodLabel && (
                                                    <div className="rounded-xl bg-cur-elevated border border-cur-hairline p-3 flex items-center justify-between opacity-60">
                                                        <span className="text-[13px] text-cur-muted">현재 결제수단</span>
                                                        <span className="text-[14px] text-cur-ink font-medium">{methodLabel}</span>
                                                    </div>
                                                )}
                                                <p className="text-[13px] text-cur-muted text-center">변경할 결제수단을 선택하세요</p>
                                                <SubscribeButtons
                                                    mode="update"
                                                    plan={sub?.plan === "monthly_pro" ? "monthly_pro" : "monthly_basic"}
                                                    onSuccess={async () => {
                                                        setChangingMethod(false)
                                                        await load()
                                                    }}
                                                    ctaSuffix="로 변경"
                                                    successText="결제수단이 변경되었습니다."
                                                />
                                                <Button
                                                    variant="ghost"
                                                    onClick={() => setChangingMethod(false)}
                                                    className="w-full h-9 text-cur-muted hover:text-cur-ink text-[13px]"
                                                >
                                                    취소
                                                </Button>
                                            </div>
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
                                        {/* 재구독은 기존 플랜 유지 → 선택 플랜에 맞는 금액이 안내되도록 plan 전달 */}
                                        <SubscribeButtons onSuccess={load} plan={sub?.plan === "monthly_pro" ? "monthly_pro" : "monthly_basic"} />
                                    </>
                                )}
                            </div>
                        )}

                        {/* Pro: 월간 보고서 자동 발송 설정 */}
                        {pro && (
                            <div className="bg-cur-card rounded-2xl p-6 border border-cur-hairline space-y-4">
                                <div className="flex items-center gap-2">
                                    <Mail className="w-5 h-5 text-cur-primary" />
                                    <h2 className="text-[16px] font-bold text-cur-ink">월간 보고서 자동 발송</h2>
                                </div>
                                <p className="text-[13px] text-cur-muted leading-relaxed">
                                    매월 1일, 지난 달 안전활동을 AI가 분석한 보고서를 아래 이메일로 자동 발송합니다. 최대 5명까지 발송 가능합니다.
                                </p>

                                <div className="space-y-2">
                                    {recipients.length === 0 ? (
                                        <p className="text-[13px] text-cur-muted-soft py-2">등록된 수신처가 없습니다.</p>
                                    ) : (
                                        recipients.map((email) => (
                                            <div key={email} className="flex items-center justify-between bg-cur-elevated rounded-lg px-3 py-2">
                                                <span className="text-[14px] text-cur-ink">{email}</span>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => removeRecipient(email)}
                                                    disabled={savingRecipients}
                                                    className="h-7 w-7 text-cur-muted hover:text-cur-error"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </Button>
                                            </div>
                                        ))
                                    )}
                                </div>

                                <div className="flex gap-2">
                                    <Input
                                        type="email"
                                        value={newEmail}
                                        onChange={(e) => setNewEmail(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === "Enter") addRecipient() }}
                                        placeholder="대표자 이메일, 담당자 이메일 등"
                                        className="h-11"
                                    />
                                    <Button
                                        onClick={addRecipient}
                                        disabled={savingRecipients || !newEmail.trim()}
                                        className="h-11 px-4 rounded-xl bg-cur-ink text-white font-bold hover:opacity-90 shrink-0"
                                    >
                                        {savingRecipients ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                                    </Button>
                                </div>

                                {recipients.length > 0 && (
                                    <Button
                                        onClick={sendNow}
                                        disabled={sending}
                                        className="w-full h-11 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90"
                                    >
                                        {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Send className="w-4 h-4 mr-2" /> 이번 달 보고서 지금 보내기</>}
                                    </Button>
                                )}
                            </div>
                        )}

                        {/* 베이직/화이트리스트 → Pro 업그레이드 권유 */}
                        {active && !pro && (
                            <div className="bg-cur-primary/5 rounded-2xl p-6 border border-cur-primary/30 space-y-3">
                                <div className="flex items-center gap-2">
                                    <Sparkles className="w-5 h-5 text-cur-primary" />
                                    <h2 className="text-[16px] font-bold text-cur-ink">Pro로 업그레이드</h2>
                                </div>
                                <p className="text-[13px] text-cur-muted leading-relaxed">
                                    AI 분석 보고서 자동 생성과 월간 안전 보고서 자동 발송까지. 월 4,900원으로 이용하세요.
                                </p>
                                <Button
                                    onClick={() => router.push("/pricing")}
                                    className="w-full h-11 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90"
                                >
                                    Pro 플랜 보기
                                </Button>
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
