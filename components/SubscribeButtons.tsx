"use client"

import { useEffect, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Loader2, CreditCard } from "lucide-react"
import { supabase } from "@/lib/supabaseClient"
import { paymentsEnabled } from "@/lib/utils"
import { fetchOrgContext } from "@/lib/useOrgContext"
import { fetchSubscriptionCached, isWhitelist } from "@/lib/useSubscription"
import { GrandfatherNotice } from "@/components/GrandfatherNotice"
import { REDIRECT_CTX_KEY } from "@/components/BillingRedirectHandler"

// 단일 요금제 단가 — 서버 lib/portone.ts SEAT_PRICE와 같은 값이어야 한다.
// (클라이언트 번들에 서버 모듈을 끌어오지 않으려고 상수만 복제한다)
const SEAT_PRICE = 3900

const STORE_ID = process.env.NEXT_PUBLIC_PORTONE_STORE_ID

const CHANNELS: Record<string, string | undefined> = {
    card: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY,
    kakaopay: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY,
    naverpay: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_NAVERPAY,
    tosspay: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY,
}

// 카카오 말풍선 마크. 버튼이 흰 바탕이 되면서 브랜드색을 마크 쪽으로 옮겼다
// (노란 판 위 검정 버블 = 노란 판이 있을 때의 표기법이라, 판이 없어지면 마크가 색을 가져야 식별된다)
const KakaoIcon = () => (
    <svg viewBox="0 0 256 256" fill="#FEE500" className="w-[22px] h-[22px]" aria-hidden="true">
        <path d="M128 36C70.562 36 24 72.713 24 118c0 29.279 19.466 54.97 48.748 69.477-1.593 5.494-10.237 35.344-10.581 37.689 0 0-.207 1.762.934 2.434s2.483.15 2.483.15c3.272-.457 37.943-24.811 43.944-29.04 5.995.849 12.168 1.29 18.472 1.29 57.438 0 104-36.712 104-82 0-45.287-46.562-82-104-82z" />
    </svg>
)

// 토스 공식 심볼 (static.toss.im 제공 자산) — 파란 버튼 위 흰색 표기가 브랜드 가이드 표준
const TossIcon = () => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/toss-symbol.png" alt="" className="w-[20px] h-[20px] object-contain" />
)

type Method = {
    key: string
    label: string
    billingKeyMethod: "CARD" | "EASY_PAY"
    style: string
    icon: ReactNode
}

// 결제수단 버튼은 전부 같은 판(흰 바탕 + 옅은 보더)을 쓴다(Chris).
// 브랜드 원색 판 3개가 나란히 서면 화면에서 그 줄만 튀고, 어느 것을 골라야 하는지도 아니라
// 그냥 시끄럽기만 하다. 식별은 아이콘의 브랜드색이 맡는다.
const METHOD_STYLE = "bg-cur-card text-cur-ink hover:bg-cur-elevated/60"

const ALL_METHODS: Method[] = [
    { key: "card", label: "카드", billingKeyMethod: "CARD", style: METHOD_STYLE, icon: <CreditCard className="w-[22px] h-[22px] text-cur-muted" /> },
    { key: "kakaopay", label: "카카오페이", billingKeyMethod: "EASY_PAY", style: METHOD_STYLE, icon: <KakaoIcon /> },
    { key: "naverpay", label: "네이버페이", billingKeyMethod: "EASY_PAY", style: METHOD_STYLE, icon: <span className="text-[18px] font-black leading-none text-[#03C75A]">N</span> },
    { key: "tosspay", label: "토스페이", billingKeyMethod: "EASY_PAY", style: METHOD_STYLE, icon: <TossIcon /> },
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
    plan = "monthly_pro",
    currentMethod = null,
    seatOnly = false,
}: {
    onSuccess?: () => void
    ctaSuffix?: string
    successText?: string
    mode?: "subscribe" | "update"
    plan?: "monthly_pro"
    // 현재 적용된 결제수단 key (update 모드에서 '사용 중'으로 비활성 표시). card/kakaopay/naverpay/tosspay
    currentMethod?: string | null
    // 스토어(인앱) 구독자의 '현장 계정 청구용 카드' 등록 — 본인 몫(월 4,900)은 스토어가 받고
    // 이 카드로는 좌석 몫(N×3,900)만 나간다(서버 resolveBillableAmount의 isStoreSource 셈법).
    // true면 표기 금액에서 본인 1계정을 빼고, 7일 전액환불 등 PortOne 구독 전제의 안내문도 바꾼다.
    seatOnly?: boolean
}) {
    const router = useRouter()
    const [processing, setProcessing] = useState<string | null>(null)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
    // 실제로 청구될 금액 = (본인 1 + 활성 소속 현장 수) x 단가.
    // 카드사 정기결제창에 표기하는 금액이라, 서버 resolveBillableAmount와 반드시 같아야 한다.
    // 스토어 구독자(seatOnly)는 본인 몫을 스토어가 받으므로 이 카드 몫은 좌석 수 × 단가만.
    const [accountCount, setAccountCount] = useState(1)
    const chargeCount = seatOnly ? Math.max(accountCount - 1, 0) : accountCount
    const billedAmount = chargeCount * SEAT_PRICE
    // 영구 무료(grandfather) 안전망. 호출부(/pricing·/account)가 이미 이 컴포넌트를 렌더하지
    // 않지만, 결제수단 버튼은 한 군데서만 새 나가도 카드가 붙고 그 순간 영구 무료 지위가
    // plan 덮어쓰기로 사라진다(2026-08-10). 어느 화면에 붙여도 안전하도록 여기서도 막는다.
    // (진짜 방벽은 서버 — /api/payments/billing-key·/api/billing/card가 409로 거절한다)
    const [grandfather, setGrandfather] = useState(false)

    useEffect(() => {
        let alive = true
        fetchOrgContext().then((c) => {
            if (!alive) return
            if (c?.kind === "owner") setAccountCount(1 + (c.memberIds?.length ?? 0))
        })
        fetchSubscriptionCached().then((s) => {
            if (alive) setGrandfather(isWhitelist(s))
        })
        return () => { alive = false }
    }, [])

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
                "안톡 사용자"
            const phoneNumber = user.user_metadata?.phone || "010-0000-0000"

            // 모바일(리디렉션 방식) 복귀 후에도 어떤 요청이었는지 알 수 있게 컨텍스트 보관
            sessionStorage.setItem(REDIRECT_CTX_KEY, JSON.stringify({ plan, mode, method: method.key }))

            const issueResponse = await PortOne.requestIssueBillingKey({
                storeId: STORE_ID,
                channelKey,
                billingKeyMethod: method.billingKeyMethod,
                issueId: crypto.randomUUID().replace(/-/g, ""),
                issueName: "안톡 월간구독",
                // KG이니시스 정기결제창에 결제금액 표기(카드사 심사 요건). 매월 청구 금액.
                // 스토어 구독자가 좌석 0개로 선등록하는 경우엔 좌석 단가(계정당 3,900)를 표기한다 — 0원 표기는 심사·사용자 모두에게 무의미.
                displayAmount: billedAmount || SEAT_PRICE,
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

    // 영구 무료 계정에는 팔 것이 없다 — 결제수단 목록 대신 안내 한 장만
    if (grandfather) return <GrandfatherNotice />

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
            {/* 버튼 3개가 각자 보더를 갖고 떨어져 있으면 '서로 다른 것 3개'로 보인다.
                한 카드 안에 구분선으로 이어붙여 '하나에서 고르는 목록'으로 만든다(Chris). */}
            <div className="rounded-xl border border-cur-hairline divide-y divide-cur-hairline overflow-hidden bg-cur-card">
            {METHODS.map((m) => {
                // update 모드에서 이미 사용 중인 수단은 '현재 사용 중'으로 표시하고 선택 불가 처리
                const isCurrent = mode === "update" && m.key === currentMethod
                return (
                    <Button
                        key={m.key}
                        onClick={() => handleIssue(m)}
                        disabled={!!processing || isCurrent}
                        aria-disabled={isCurrent}
                        className={`w-full font-bold h-14 rounded-none shadow-none transition-colors justify-center px-4 ${
                            isCurrent
                                ? "bg-cur-elevated text-cur-muted hover:opacity-100 disabled:opacity-100 cursor-default"
                                : m.style
                        }`}
                    >
                        {processing === m.key ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            // 아이콘 + 라벨을 가운데로 — 소셜 로그인 버튼과 같은 읽는 방식
                            <span className="flex items-center justify-center gap-2.5 w-full relative">
                                <span className="flex w-[22px] h-[22px] items-center justify-center shrink-0">{m.icon}</span>
                                <span className="text-[15px]">{isCurrent ? m.label : `${m.label}${ctaSuffix}`}</span>
                                {isCurrent && (
                                    <span className="absolute right-0 text-[11px] font-semibold text-cur-muted">현재 사용 중</span>
                                )}
                            </span>
                        )}
                    </Button>
                )
            })}
            </div>
            {METHODS.length === 0 && (
                <p className="text-[13px] text-cur-error text-center">결제수단이 설정되지 않았습니다. (환경변수 확인)</p>
            )}
            <div className="mt-1 rounded-lg bg-cur-elevated/60 border border-cur-hairline p-3 text-[12px] leading-relaxed text-cur-muted">
                <p className="font-medium text-cur-ink mb-1">정기결제(자동결제) 안내</p>
                {seatOnly ? (
                    <p>· 이 카드에는 현장 계정 몫만 청구되며, 스토어에서 결제 중인 내 구독은 그대로 유지됩니다.</p>
                ) : mode === "update" ? (
                    <p>· 결제수단만 변경되며, 구독 플랜·다음 결제일·결제 금액은 그대로 유지됩니다.</p>
                ) : (
                    <p>· 서비스 제공 기간: 결제일로부터 1개월(30일) 이용 후 자동 갱신되며, 매월 동일한 날짜에 자동 결제됩니다.</p>
                )}
                {seatOnly ? (
                    <p>· 이용요금: 현장 계정당 월 {SEAT_PRICE.toLocaleString()}원(VAT 포함) — 현재 현장 계정 {chargeCount}개, 월 {billedAmount.toLocaleString()}원. 현장 계정을 추가하면 그만큼 더해집니다.</p>
                ) : (
                    <p>· 이용요금: 월 {billedAmount.toLocaleString()}원(VAT 포함){accountCount > 1 ? ` — 계정 ${accountCount}개 x ${SEAT_PRICE.toLocaleString()}원` : " · 계정 1개"}. 현장 계정을 추가하면 그만큼 더해집니다.</p>
                )}
                {mode !== "update" && (
                    <p>· 첫 달은 무료 체험으로 제공되며, 체험 종료 후 자동 결제가 시작됩니다.</p>
                )}
                {/* 7일 전액환불은 PortOne(웹 카드) 구독 정책 — 스토어 구독자의 좌석 카드에는 해당 없음(환불·해지는 스토어) */}
                {seatOnly ? (
                    <p>· 현장 계정을 줄이면 다음 결제부터 그만큼 청구되지 않습니다.</p>
                ) : (
                    <p>· 해지는 언제든 가능합니다. 결제 후 7일 이내에 한 번도 사용하지 않았다면 <b>전액 환불</b>되고, 그 외에는 이용하지 않은 잔여 기간을 일할 계산해 환불해 드립니다.</p>
                )}
            </div>
        </div>
    )
}
