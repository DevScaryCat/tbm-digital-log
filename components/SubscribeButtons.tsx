"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Loader2, CreditCard } from "lucide-react"
import { supabase } from "@/lib/supabaseClient"
import { paymentsEnabled } from "@/lib/utils"

const STORE_ID = process.env.NEXT_PUBLIC_PORTONE_STORE_ID

const CHANNELS: Record<string, string | undefined> = {
    card: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY,
    kakaopay: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY,
    naverpay: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_NAVERPAY,
    tosspay: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY,
}

type Method = {
    key: string
    label: string
    billingKeyMethod: "CARD" | "EASY_PAY"
    style: string
}

const ALL_METHODS: Method[] = [
    { key: "card", label: "카드", billingKeyMethod: "CARD", style: "bg-cur-ink text-white hover:opacity-90" },
    { key: "kakaopay", label: "카카오페이", billingKeyMethod: "EASY_PAY", style: "bg-[#FEE500] text-[#191600] hover:brightness-95" },
    { key: "naverpay", label: "네이버페이", billingKeyMethod: "EASY_PAY", style: "bg-[#03C75A] text-white hover:brightness-95" },
    { key: "tosspay", label: "토스페이", billingKeyMethod: "EASY_PAY", style: "bg-[#0064FF] text-white hover:brightness-95" },
]
// 실연동(라이브) 완료된 결제수단만 운영(실서버)에 노출.
// 현재 카드(KG이니시스)만 실연동 — 토스·카카오는 테스트 채널이라 운영에서 숨김.
// (로컬/개발에서는 테스트용으로 모두 노출) 토스·카카오 실연동 시 LIVE_METHODS에 추가.
const LIVE_METHODS = ["card"]
const METHODS = ALL_METHODS.filter(
    (m) => CHANNELS[m.key] && (process.env.NODE_ENV !== "production" || LIVE_METHODS.includes(m.key))
)

export function SubscribeButtons({
    onSuccess,
    ctaSuffix = "로 시작하기",
    successText = "구독이 시작되었습니다! 첫 달은 무료입니다.",
    mode = "subscribe",
    plan = "monthly_basic",
}: {
    onSuccess?: () => void
    ctaSuffix?: string
    successText?: string
    mode?: "subscribe" | "update"
    plan?: "monthly_basic" | "monthly_pro"
}) {
    const router = useRouter()
    const [processing, setProcessing] = useState<string | null>(null)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)

    const handleIssue = async (method: Method) => {
        setMsg(null)
        const {
            data: { user },
        } = await supabase.auth.getUser()
        if (!user) {
            router.push("/login")
            return
        }
        const channelKey = CHANNELS[method.key]
        if (!STORE_ID || !channelKey) {
            setMsg({ type: "err", text: "결제 설정이 준비되지 않았습니다. (환경변수)" })
            return
        }
        setProcessing(method.key)
        try {
            const PortOne = await import("@portone/browser-sdk/v2")
            const fullName =
                user.user_metadata?.full_name ||
                user.user_metadata?.company_name ||
                "안전톡톡사용자"
            const phoneNumber = user.user_metadata?.phone || "010-0000-0000"

            const issueResponse = await PortOne.requestIssueBillingKey({
                storeId: STORE_ID,
                channelKey,
                billingKeyMethod: method.billingKeyMethod,
                issueId: crypto.randomUUID().replace(/-/g, ""),
                issueName: plan === "monthly_pro" ? "안전톡톡e Pro 월간구독" : "안전톡톡e 월간구독",
                customer: {
                    customerId: user.id,
                    fullName,
                    phoneNumber,
                    email: user.email || `${user.id}@tbm.com`,
                },
            })

            if (!issueResponse || issueResponse.code) {
                setMsg({ type: "err", text: `등록 실패: ${issueResponse?.message ?? "취소되었습니다."}` })
                return
            }

            const { data: sessionData } = await supabase.auth.getSession()
            const token = sessionData?.session?.access_token
            const res = await fetch("/api/payments/billing-key", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ billingKey: issueResponse.billingKey, method: method.key, mode, plan }),
            })
            const json = await res.json()
            if (!res.ok) {
                setMsg({ type: "err", text: json.error || "구독 처리 실패" })
                return
            }
            setMsg({ type: "ok", text: successText })
            onSuccess?.()
        } catch (e) {
            console.error(e)
            setMsg({ type: "err", text: "결제 처리 중 오류가 발생했습니다." })
        } finally {
            setProcessing(null)
        }
    }

    if (!paymentsEnabled()) {
        return (
            <div className="rounded-xl bg-cur-elevated border border-cur-hairline p-4 text-center">
                <p className="text-[14px] font-medium text-cur-ink">결제 준비 중입니다</p>
                <p className="text-[13px] text-cur-muted mt-1">실제 결제 연동 작업 중이에요. 곧 오픈됩니다.</p>
            </div>
        )
    }

    return (
        <div className="space-y-3">
            {msg && (
                <div
                    className={`text-[13px] rounded-lg p-3 ${
                        msg.type === "ok" ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-error/10 text-cur-error"
                    }`}
                >
                    {msg.text}
                </div>
            )}
            <p className="text-[13px] text-cur-muted text-center">결제수단을 선택하세요</p>
            {METHODS.map((m) => (
                <Button
                    key={m.key}
                    onClick={() => handleIssue(m)}
                    disabled={!!processing}
                    className={`w-full font-bold h-12 rounded-xl transition-all ${m.style}`}
                >
                    {processing === m.key ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                        <span className="flex items-center justify-center gap-2">
                            {m.key === "card" && <CreditCard className="w-4 h-4" />}
                            {m.label}
                            {ctaSuffix}
                        </span>
                    )}
                </Button>
            ))}
            {METHODS.length === 0 && (
                <p className="text-[13px] text-cur-error text-center">결제수단이 설정되지 않았습니다. (환경변수 확인)</p>
            )}
            <div className="mt-1 rounded-lg bg-cur-elevated/60 border border-cur-hairline p-3 text-[12px] leading-relaxed text-cur-muted">
                <p className="font-medium text-cur-ink mb-1">정기결제(자동결제) 안내</p>
                <p>· 서비스 제공 기간: 결제일로부터 1개월(30일) 이용 후 자동 갱신되며, 매월 동일한 날짜에 자동 결제됩니다.</p>
                <p>· 이용요금: {plan === "monthly_pro" ? "Pro 월 4,900원(VAT 포함)" : "월 1,900원(VAT 포함)"}.</p>
                <p>· 첫 달은 무료 체험으로 제공되며, 체험 종료 후 자동 결제가 시작됩니다.</p>
                <p>· 해지는 언제든 가능하며, 중도 해지 시 이용하지 않은 잔여 기간은 일할 계산하여 환불해 드립니다.</p>
            </div>
        </div>
    )
}
