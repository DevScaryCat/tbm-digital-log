"use client"

// 안전관리자 회사 플랜 결제 버튼 — SubscribeButtons와 같은 발급 플로우지만
// 등록 대상이 /api/org/checkout (체험 없음, 좌석 수 × 4,900 즉시 청구)이다.
import { useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Loader2, CreditCard } from "lucide-react"
import { supabase } from "@/lib/supabaseClient"
import { paymentsEnabled } from "@/lib/utils"
import { REDIRECT_CTX_KEY } from "@/components/BillingRedirectHandler"
import { clearOrgContextCache } from "@/lib/useOrgContext"

const STORE_ID = process.env.NEXT_PUBLIC_PORTONE_STORE_ID
const SEAT_PRICE = 4900

const CHANNELS: Record<string, string | undefined> = {
    card: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY,
    kakaopay: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY,
    tosspay: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY,
}

const KakaoIcon = () => (
    <svg viewBox="0 0 256 256" fill="currentColor" className="w-[18px] h-[18px]" aria-hidden="true">
        <path d="M128 36C70.562 36 24 72.713 24 118c0 29.279 19.466 54.97 48.748 69.477-1.593 5.494-10.237 35.344-10.581 37.689 0 0-.207 1.762.934 2.434s2.483.15 2.483.15c3.272-.457 37.943-24.811 43.944-29.04 5.995.849 12.168 1.29 18.472 1.29 57.438 0 104-36.712 104-82 0-45.287-46.562-82-104-82z" />
    </svg>
)
const TossIcon = () => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/toss-symbol.png" alt="" className="w-[18px] h-[18px] brightness-0 invert" />
)

type Method = { key: string; label: string; billingKeyMethod: "CARD" | "EASY_PAY"; style: string; icon: ReactNode }
const ALL_METHODS: Method[] = [
    { key: "card", label: "카드", billingKeyMethod: "CARD", style: "bg-cur-ink text-white hover:opacity-90", icon: <CreditCard className="w-[18px] h-[18px]" /> },
    { key: "kakaopay", label: "카카오페이", billingKeyMethod: "EASY_PAY", style: "bg-[#FEE500] text-[#191600] hover:brightness-95", icon: <KakaoIcon /> },
    { key: "tosspay", label: "토스페이", billingKeyMethod: "EASY_PAY", style: "bg-[#0064FF] text-white hover:brightness-95", icon: <TossIcon /> },
]
const LIVE_METHODS = ["card", "kakaopay", "tosspay"]
const METHODS = ALL_METHODS.filter(
    (m) => CHANNELS[m.key] && (process.env.NODE_ENV !== "production" || LIVE_METHODS.includes(m.key))
)

export function OrgCheckoutButtons({
    seatCount,
    orgName,
    onSuccess,
}: {
    seatCount: number
    orgName: string
    onSuccess?: () => void
}) {
    const router = useRouter()
    const [processing, setProcessing] = useState<string | null>(null)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
    // 카카오페이는 빌링키 발급 확정까지 실측 ~50초가 걸린다(그동안 조회 불가).
    // 그 사이엔 자동으로 재시도하고, 그래도 안 되면 수동 버튼을 남긴다.
    const [pendingKey, setPendingKey] = useState<string | null>(null)
    const [waitingSec, setWaitingSec] = useState(0)
    const total = seatCount * SEAT_PRICE

    /** 한 번 시도. 아직 발급 확정 전이면 "pending" 반환 */
    const attemptCheckout = async (billingKey: string): Promise<"ok" | "pending" | "failed"> => {
        const { data: sessionData } = await supabase.auth.getSession()
        const token = sessionData?.session?.access_token
        const res = await fetch("/api/org/checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ billingKey, seatCount, orgName }),
        })
        const json = await res.json()
        if (res.ok) {
            clearOrgContextCache()
            setPendingKey(null)
            setMsg({ type: "ok", text: "결제가 완료되었습니다!" })
            onSuccess?.()
            return "ok"
        }
        if (json.retryableBillingKey) {
            setPendingKey(json.retryableBillingKey)
            return "pending"
        }
        setMsg({ type: "err", text: json.error || "결제 처리 실패" })
        return "failed"
    }

    /** 발급 확정될 때까지 자동 폴링 (최대 ~2분) */
    const registerCheckout = async (billingKey: string) => {
        const DEADLINE_MS = 120_000
        const started = Date.now()
        setWaitingSec(0)
        while (Date.now() - started < DEADLINE_MS) {
            const r = await attemptCheckout(billingKey)
            if (r === "ok") return true
            if (r === "failed") return false
            setWaitingSec(Math.round((Date.now() - started) / 1000))
            setMsg({ type: "ok", text: "카카오페이 결제수단을 확인하는 중이에요. 최대 1분 정도 걸립니다…" })
            await new Promise((r) => setTimeout(r, 5000))
        }
        setMsg({
            type: "err",
            text: "결제수단 확인이 예상보다 오래 걸리고 있어요. 잠시 후 '결제 다시 시도'를 눌러주세요.",
        })
        return false
    }

    const handleIssue = async (method: Method) => {
        setMsg(null)
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) { router.push("/login"); return }
        const channelKey = CHANNELS[method.key]
        if (!STORE_ID || !channelKey) {
            setMsg({ type: "err", text: "결제 설정이 준비되지 않았습니다. (환경변수)" })
            return
        }
        setProcessing(method.key)
        try {
            const PortOne = await import("@portone/browser-sdk/v2")
            sessionStorage.setItem(REDIRECT_CTX_KEY, JSON.stringify({ orgCheckout: true, seatCount, orgName, method: method.key }))
            const issueResponse = await PortOne.requestIssueBillingKey({
                storeId: STORE_ID,
                channelKey,
                billingKeyMethod: method.billingKeyMethod,
                issueId: crypto.randomUUID().replace(/-/g, ""),
                issueName: `안톡 회사 플랜 (관리감독자 ${seatCount}명)`,
                displayAmount: total,
                currency: "KRW",
                ...(method.key === "card"
                    ? { windowType: { pc: "IFRAME" as const, mobile: "REDIRECTION" as const }, offerPeriod: { interval: "1m" as const } }
                    : {}),
                // occtx=1: 리디렉션 복귀가 다른 탭/브라우저로 떨어져 sessionStorage 컨텍스트를
                // 잃어도 "org 결제였다"는 사실이 URL에 남는다 (개인 플랜 오등록 방지)
                redirectUrl: window.location.origin + window.location.pathname + "?occtx=1",
                customer: {
                    customerId: user.id,
                    fullName: user.user_metadata?.company_name || user.user_metadata?.full_name || "안톡 안전관리자",
                    phoneNumber: user.user_metadata?.phone || "010-0000-0000",
                    email: user.email || `${user.id}@tbm.com`,
                },
            })
            if (!issueResponse || issueResponse.code) {
                console.error("빌링키 발급 실패:", issueResponse)
                sessionStorage.removeItem(REDIRECT_CTX_KEY)
                const pg = [issueResponse?.pgCode, issueResponse?.pgMessage].filter(Boolean).join(" · ")
                const base = issueResponse?.message ?? "취소되었습니다."
                setMsg({ type: "err", text: `등록 실패: ${base}${pg ? ` — PG: ${pg}` : ""}` })
                return
            }
            sessionStorage.removeItem(REDIRECT_CTX_KEY)
            if (!issueResponse.billingKey) {
                setMsg({ type: "err", text: "빌링키가 발급되지 않았습니다. 다시 시도해주세요." })
                return
            }
            await registerCheckout(issueResponse.billingKey)
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
            {processing && (
                <div role="alert" aria-busy="true" className="fixed inset-0 z-[100] bg-black/55 backdrop-blur-sm flex flex-col items-center justify-center gap-3 px-6 text-center">
                    <Loader2 className="w-10 h-10 animate-spin text-white" />
                    <p className="text-white text-[15px] font-semibold">
                        {pendingKey ? "결제수단을 확인하고 있어요" : "결제를 처리하고 있어요"}
                    </p>
                    <p className="text-white/70 text-[13px]">
                        {pendingKey
                            ? `카카오페이는 확인에 1분 정도 걸릴 수 있어요${waitingSec ? ` (${waitingSec}초 경과)` : ""}`
                            : "완료될 때까지 화면을 닫거나 이동하지 마세요"}
                    </p>
                    <p className="text-white/50 text-[12px]">화면을 닫거나 이동하지 마세요</p>
                </div>
            )}
            {msg && (
                <div className={`text-[13px] rounded-lg p-3 ${msg.type === "ok" ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-error/10 text-cur-error"}`}>
                    {msg.text}
                </div>
            )}
            {/* 전파 지연으로 첫 청구가 막힌 경우 — 카카오페이 인증을 다시 하지 않고 같은 키로 재시도 */}
            {pendingKey && (
                <Button
                    onClick={async () => {
                        setProcessing("retry")
                        setMsg(null)
                        try { await registerCheckout(pendingKey) } finally { setProcessing(null) }
                    }}
                    disabled={!!processing}
                    className="w-full h-12 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90"
                >
                    {processing === "retry" ? <Loader2 className="w-4 h-4 animate-spin" /> : "결제 다시 시도"}
                </Button>
            )}
            <p className="text-[13px] text-cur-muted text-center">
                {pendingKey ? "다른 수단으로 새로 결제하려면 아래에서 선택하세요" : "결제수단을 선택하세요"}
            </p>
            {METHODS.map((m) => (
                <Button
                    key={m.key}
                    onClick={() => handleIssue(m)}
                    disabled={!!processing}
                    className={`w-full font-bold h-12 rounded-xl transition-all justify-start px-4 ${m.style}`}
                >
                    {processing === m.key ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                        <span className="flex items-center gap-2.5 w-full">
                            <span className="flex w-[18px] h-[18px] items-center justify-center shrink-0">{m.icon}</span>
                            <span>{m.label}로 결제하기</span>
                        </span>
                    )}
                </Button>
            ))}
            {METHODS.length === 0 && (
                <p className="text-[13px] text-cur-error text-center">결제수단이 설정되지 않았습니다. (환경변수 확인)</p>
            )}
            <div className="mt-1 rounded-lg bg-cur-elevated/60 border border-cur-hairline p-3 text-[12px] leading-relaxed text-cur-muted">
                <p className="font-medium text-cur-ink mb-1">정기결제(자동결제) 안내</p>
                <p>· 이용요금: 관리감독자 {seatCount}명 × 4,900원 = <b className="text-cur-ink">월 {total.toLocaleString()}원</b>(VAT 포함). 오늘 첫 결제 후 매월 자동 결제됩니다.</p>
                <p>· 좌석은 언제든 추가(즉시 일할 청구)·축소(다음 결제일 적용)할 수 있습니다.</p>
                <p>· 해지는 언제든 가능하며, 중도 해지 시 이용하지 않은 잔여 기간은 일할 계산하여 환불해 드립니다.</p>
            </div>
        </div>
    )
}
