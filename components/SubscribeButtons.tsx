"use client"

import { useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Loader2, CreditCard } from "lucide-react"
import { supabase } from "@/lib/supabaseClient"
import { paymentsEnabled } from "@/lib/utils"
import { REDIRECT_CTX_KEY } from "@/components/BillingRedirectHandler"

const STORE_ID = process.env.NEXT_PUBLIC_PORTONE_STORE_ID

const CHANNELS: Record<string, string | undefined> = {
    card: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY,
    kakaopay: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY,
    naverpay: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_NAVERPAY,
    tosspay: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY,
}

// 카카오 공식 말풍선 마크 (결제수단 식별용 — 노란 버튼 위 검정 버블이 표준 표기)
const KakaoIcon = () => (
    <svg viewBox="0 0 256 256" fill="currentColor" className="w-[18px] h-[18px]" aria-hidden="true">
        <path d="M128 36C70.562 36 24 72.713 24 118c0 29.279 19.466 54.97 48.748 69.477-1.593 5.494-10.237 35.344-10.581 37.689 0 0-.207 1.762.934 2.434s2.483.15 2.483.15c3.272-.457 37.943-24.811 43.944-29.04 5.995.849 12.168 1.29 18.472 1.29 57.438 0 104-36.712 104-82 0-45.287-46.562-82-104-82z" />
    </svg>
)

// 토스 공식 심볼 (static.toss.im 제공 자산) — 파란 버튼 위 흰색 표기가 브랜드 가이드 표준
const TossIcon = () => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/toss-symbol.png" alt="" className="w-[18px] h-[18px] brightness-0 invert" />
)

type Method = {
    key: string
    label: string
    billingKeyMethod: "CARD" | "EASY_PAY"
    style: string
    icon: ReactNode
}

const ALL_METHODS: Method[] = [
    { key: "card", label: "카드", billingKeyMethod: "CARD", style: "bg-cur-ink text-white hover:opacity-90", icon: <CreditCard className="w-[18px] h-[18px]" /> },
    { key: "kakaopay", label: "카카오페이", billingKeyMethod: "EASY_PAY", style: "bg-[#FEE500] text-[#191600] hover:brightness-95", icon: <KakaoIcon /> },
    { key: "naverpay", label: "네이버페이", billingKeyMethod: "EASY_PAY", style: "bg-[#03C75A] text-white hover:brightness-95", icon: <span className="text-[15px] font-black leading-none">N</span> },
    { key: "tosspay", label: "토스페이", billingKeyMethod: "EASY_PAY", style: "bg-[#0064FF] text-white hover:brightness-95", icon: <TossIcon /> },
]
// 실연동(라이브) 완료된 결제수단만 운영(실서버)에 노출.
// 카드(KG이니시스) + 카카오페이(CID CA18988263, 2026-07 심사완료) 실연동. 네이버·토스는 아직 진행중이라 숨김.
// 운영 노출 조건: LIVE_METHODS에 있고 + Vercel prod에 해당 채널키(NEXT_PUBLIC_PORTONE_CHANNEL_KEY_*)가 '라이브' 값으로 설정됨.
// (env 미설정 시 CHANNELS[key] undefined라 자동 숨김) 네이버·토스 실연동 시 여기에 추가.
const LIVE_METHODS = ["card", "kakaopay", "tosspay"]
const METHODS = ALL_METHODS.filter(
    (m) => CHANNELS[m.key] && (process.env.NODE_ENV !== "production" || LIVE_METHODS.includes(m.key))
)

// 모바일 카드(이니시스)는 리디렉션 방식 — 발급 컨텍스트를 저장했다가 복귀 시 이어서 처리한다.
// (redirectUrl 없이 호출하면 이니시스 모바일 빌링 페이지가 500으로 깨짐)
// 복귀 처리는 페이지 레벨의 BillingRedirectHandler가 담당 — 이 컴포넌트는 컨텍스트 저장만.

export function SubscribeButtons({
    onSuccess,
    ctaSuffix = "로 시작하기",
    successText = "구독이 시작되었습니다! 첫 달은 무료입니다.",
    mode = "subscribe",
    plan = "monthly_basic",
    currentMethod = null,
}: {
    onSuccess?: () => void
    ctaSuffix?: string
    successText?: string
    mode?: "subscribe" | "update"
    plan?: "monthly_basic" | "monthly_pro"
    // 현재 적용된 결제수단 key (update 모드에서 '사용 중'으로 비활성 표시). card/kakaopay/naverpay/tosspay
    currentMethod?: string | null
}) {
    const router = useRouter()
    const [processing, setProcessing] = useState<string | null>(null)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)

    // 발급된 빌링키를 서버에 등록(구독 시작/수단 변경) — 인라인(프로미스)과 리디렉션 복귀가 공용
    const registerBillingKey = async (billingKey: string, methodKey: string, planV: string, modeV: string) => {
        const { data: sessionData } = await supabase.auth.getSession()
        const token = sessionData?.session?.access_token
        const res = await fetch("/api/payments/billing-key", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ billingKey, method: methodKey, mode: modeV, plan: planV }),
        })
        const json = await res.json()
        if (!res.ok) {
            setMsg({ type: "err", text: json.error || "구독 처리 실패" })
            return false
        }
        setMsg({ type: "ok", text: successText })
        onSuccess?.()
        return true
    }

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

            // 모바일(리디렉션 방식) 복귀 후에도 어떤 요청이었는지 알 수 있게 컨텍스트 보관
            sessionStorage.setItem(REDIRECT_CTX_KEY, JSON.stringify({ plan, mode, method: method.key }))

            const issueResponse = await PortOne.requestIssueBillingKey({
                storeId: STORE_ID,
                channelKey,
                billingKeyMethod: method.billingKeyMethod,
                issueId: crypto.randomUUID().replace(/-/g, ""),
                issueName: plan === "monthly_pro" ? "안톡 Pro 월간구독" : "안톡 월간구독",
                // KG이니시스 정기결제창에 결제금액 표기(카드사 심사 요건). 매월 청구 금액.
                displayAmount: plan === "monthly_pro" ? 4900 : 1900,
                currency: "KRW",
                // 카드(이니시스) 모바일: 이니시스 모바일 빌링 페이지는 iframe 레이어 안에서
                // 동작하지 않음(500) → 결제사 페이지로 완전히 이동하는 REDIRECTION을 강제.
                // (redirectUrl만 넣으면 창 방식이 안 바뀌어 iframe으로 열리다 깨짐)
                // 카카오·토스는 잘 동작 중인 기본 창 방식 유지. 복귀 처리는 BillingRedirectHandler.
                // offerPeriod: 포트원 문서상 이니시스 '모바일' 빌링키 발급 필수 파라미터(월 단위 제공기간).
                ...(method.key === "card"
                    ? { windowType: { pc: "IFRAME" as const, mobile: "REDIRECTION" as const }, offerPeriod: { interval: "1m" as const } }
                    : {}),
                redirectUrl: window.location.origin + window.location.pathname,
                customer: {
                    customerId: user.id,
                    fullName,
                    phoneNumber,
                    email: user.email || `${user.id}@tbm.com`,
                },
            })

            if (!issueResponse || issueResponse.code) {
                // PortOne 일반 메시지("빌링키 발급 과정에서 문제가 발생하였습니다")만으론 원인 파악 불가.
                // 이니시스 등 PG가 내려주는 실제 사유(pgCode/pgMessage)를 함께 노출해 진단 가능하게.
                console.error("빌링키 발급 실패:", issueResponse)
                sessionStorage.removeItem(REDIRECT_CTX_KEY)
                const pg = [issueResponse?.pgCode, issueResponse?.pgMessage].filter(Boolean).join(" · ")
                const base = issueResponse?.message ?? "취소되었습니다."
                setMsg({ type: "err", text: `등록 실패: ${base}${pg ? ` — PG: ${pg}` : ""}` })
                return
            }

            // 인라인(IFRAME/팝업) 흐름 완료 — 리디렉션 복귀 컨텍스트는 불필요
            sessionStorage.removeItem(REDIRECT_CTX_KEY)
            if (!issueResponse.billingKey) {
                setMsg({ type: "err", text: "빌링키가 발급되지 않았습니다. 다시 시도해주세요." })
                return
            }
            await registerBillingKey(issueResponse.billingKey, method.key, plan, mode)
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
            {/* 등록 처리 중 전면 잠금 — PG 인증 후 서버 검증·부착이 끝날 때까지 다른 버튼 오조작 방지 */}
            {processing && (
                <div
                    role="alert"
                    aria-busy="true"
                    className="fixed inset-0 z-[100] bg-black/55 backdrop-blur-sm flex flex-col items-center justify-center gap-3 px-6 text-center"
                >
                    <Loader2 className="w-10 h-10 animate-spin text-white" />
                    <p className="text-white text-[15px] font-semibold">결제수단 등록을 처리하고 있어요</p>
                    <p className="text-white/70 text-[13px]">완료될 때까지 화면을 닫거나 이동하지 마세요</p>
                </div>
            )}
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
            {METHODS.map((m) => {
                // update 모드에서 이미 사용 중인 수단은 '현재 사용 중'으로 표시하고 선택 불가 처리
                const isCurrent = mode === "update" && m.key === currentMethod
                return (
                    <Button
                        key={m.key}
                        onClick={() => handleIssue(m)}
                        disabled={!!processing || isCurrent}
                        aria-disabled={isCurrent}
                        className={`w-full font-bold h-12 rounded-xl transition-all justify-start px-4 ${
                            isCurrent
                                ? "bg-cur-elevated text-cur-muted border border-cur-hairline hover:opacity-100 disabled:opacity-100 cursor-default"
                                : m.style
                        }`}
                    >
                        {processing === m.key ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            // 아이콘을 고정폭 박스에 넣어 버튼끼리 아이콘 라인을 맞추고 왼쪽정렬
                            <span className="flex items-center gap-2.5 w-full">
                                <span className="flex w-[18px] h-[18px] items-center justify-center shrink-0">{m.icon}</span>
                                <span>{isCurrent ? m.label : `${m.label}${ctaSuffix}`}</span>
                                {isCurrent && (
                                    <span className="ml-auto text-[11px] font-semibold text-cur-muted">현재 사용 중</span>
                                )}
                            </span>
                        )}
                    </Button>
                )
            })}
            {METHODS.length === 0 && (
                <p className="text-[13px] text-cur-error text-center">결제수단이 설정되지 않았습니다. (환경변수 확인)</p>
            )}
            <div className="mt-1 rounded-lg bg-cur-elevated/60 border border-cur-hairline p-3 text-[12px] leading-relaxed text-cur-muted">
                <p className="font-medium text-cur-ink mb-1">정기결제(자동결제) 안내</p>
                {mode === "update" ? (
                    <p>· 결제수단만 변경되며, 구독 플랜·다음 결제일·결제 금액은 그대로 유지됩니다.</p>
                ) : (
                    <p>· 서비스 제공 기간: 결제일로부터 1개월(30일) 이용 후 자동 갱신되며, 매월 동일한 날짜에 자동 결제됩니다.</p>
                )}
                <p>· 이용요금: {plan === "monthly_pro" ? "Pro 월 4,900원(VAT 포함)" : "월 1,900원(VAT 포함)"}.</p>
                {mode !== "update" && (
                    <p>· 첫 달은 무료 체험으로 제공되며, 체험 종료 후 자동 결제가 시작됩니다.</p>
                )}
                <p>· 해지는 언제든 가능하며, 중도 해지 시 이용하지 않은 잔여 기간은 일할 계산하여 환불해 드립니다.</p>
            </div>
        </div>
    )
}
