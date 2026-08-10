"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { SubscribeButtons } from "@/components/SubscribeButtons"
import { BillingRedirectHandler } from "@/components/BillingRedirectHandler"
import { isAllowed, isProActive, isWhitelist, SubscriptionRow } from "@/lib/useSubscription"
import { fetchOrgContext } from "@/lib/useOrgContext"
import { Button } from "@/components/ui/button"
import { SettingsCard, SettingsRow } from "@/components/ui/list-row"
import { Loader2, CheckCircle2, XCircle, Receipt, Sparkles, CreditCard, ExternalLink } from "lucide-react"
import { showConfirm } from "@/lib/uiDialog"

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
    partial_canceled: "부분환불",
}

// 스토어(인앱) 구독 판별을 위해 source까지 읽는다 — 공용 fetchSubscription은 source를
// 조회하지 않으므로 이 화면만 직접 select한다 (앱 lib/subscription.ts와 같은 컬럼 셋).
type AccountSub = SubscriptionRow & { source?: string | null }

// 모바일 스토어 구독 단가(본인 몫) — 구글/애플 인앱 상품 가격. 웹 단가(3,900)와 다르다.
// 서버 resolveBillableAmount의 스토어 소유주 셈법: 본인 4,900은 스토어가, 좌석 N×3,900은 등록 카드가 청구.
const STORE_PRICE = 4900

export default function AccountPage() {
    const router = useRouter()
    const [loading, setLoading] = useState(true)
    const [sub, setSub] = useState<AccountSub | null>(null)
    const [payments, setPayments] = useState<Payment[]>([])
    const [busy, setBusy] = useState(false)
    const [changingMethod, setChangingMethod] = useState(false)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
    // 과금 계정 수(감독자 본인 1 + 활성 현장) — 여기가 '회사 전체 결제'라는 걸 명시하기 위한 값
    const [accountCount, setAccountCount] = useState<number>(1)


    const load = async () => {
        const {
            data: { user },
        } = await supabase.auth.getUser()
        if (!user) {
            router.replace("/login")
            return
        }
        // 소속 현장 계정은 결제 주체가 아니다 — 헤더 잠금을 뚫고 들어와도(역할 로딩 틈) 홈으로
        const ctx = await fetchOrgContext()
        if (ctx?.kind === "member") {
            router.replace("/")
            return
        }
        setAccountCount(ctx?.kind === "owner" ? 1 + (ctx.memberIds?.length ?? 0) : 1)
        const { data: subRow } = await supabase
            .from("subscriptions")
            .select("status, plan, pending_plan, card_info, current_period_end, trial_end, trial_used, amount, source")
            .maybeSingle()
        setSub((subRow as AccountSub) || null)
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
        const ok = await showConfirm(
            "무료체험 중이면 남은 기간까지 그대로 이용할 수 있고, 유료 이용 중이면 사용하지 않은 잔여 기간을 일할 계산해 환불해 드립니다.",
            { title: "정말 구독을 해지할까요?", confirmText: "해지하기", danger: true }
        )
        if (!ok) return
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

    const isGrandfather = isWhitelist(sub)
    // 스토어(인앱) 구독 — 본인 몫(월 4,900)은 스토어가 청구·갱신한다. 해지·결제수단 변경도
    // 결제한 스토어에서만 가능(앱 account.tsx의 storeManaged 분기와 동일 판정·워딩).
    const playManaged = sub?.source === "google_play"
    const appStoreManaged = sub?.source === "app_store"
    const storeManaged = playManaged || appStoreManaged
    const storeName = playManaged ? "Google Play" : "App Store"
    const active = isAllowed(sub)
    const pro = isProActive(sub)
    // 카드 없는 무료체험(휴대폰인증 가입): card_info 없음 + 상태 trialing.
    // active면 체험 진행 중, 아니면(기간 만료) 체험 종료 상태.
    const cardlessTrial = sub?.status === "trialing" && !sub?.card_info
    const cardlessTrialActive = cardlessTrial && active
    const cardlessTrialExpired = cardlessTrial && !active
    // 카드가 붙은 체험 = 결제일 자동청구 확정 구독 → 상태 헤더를 '무료체험 중'이 아니라 '이용 중'으로
    const committedTrial = sub?.status === "trialing" && !!sub?.card_info
    // 단일 요금제 — 유료(pro)면 '지난번 청구 스냅샷'이 아니라 실시간 계정 수로 계산해 보여준다.
    // 크론이 청구 시점에 같은 식(계정 수 × 3,900)으로 재계산하므로 이쪽이 다음 청구액의 진실이고,
    // 스냅샷을 보여주면 계정을 추가한 직후 금액이 달라 "내 것만 결제하는 화면"처럼 읽힌다 (혼란의 원인).
    const SEAT_PRICE = 3900
    const seatBilled = pro && sub?.plan !== "grandfather" && sub?.plan !== "org_seat"
    const planLabel =
        sub?.plan === "grandfather"
            ? "영구 무료"
            : sub?.plan === "org_seat"
              ? "소속 현장 (회사에서 결제)"
              : seatBilled
                ? accountCount > 1
                    ? `계정 ${accountCount}개 × 3,900원 = 월 ${(accountCount * SEAT_PRICE).toLocaleString()}원`
                    : "계정 1개 · 월 3,900원"
                : `월 ${(sub?.amount ?? 3900).toLocaleString()}원`
    const nextDate = sub?.current_period_end
        ? new Date(sub.current_period_end).toLocaleDateString("ko-KR")
        : null
    const methodLabel = sub?.card_info?.last4
        ? `${sub.card_info.issuer ?? "카드"} ****${sub.card_info.last4}`
        : sub?.card_info?.provider ?? null
    // 현재 적용된 결제수단 key — 변경 화면에서 '이미 사용 중'인 수단을 비활성 처리하는 데 사용.
    // 카드(KG)는 last4/issuer 보유, 간편결제는 provider 라벨만 보유.
    const PROVIDER_TO_KEY: Record<string, string> = {
        카카오페이: "kakaopay",
        네이버페이: "naverpay",
        토스페이: "tosspay",
        카드: "card",
    }
    const currentMethodKey: string | null = sub?.card_info
        ? sub.card_info.last4 || sub.card_info.issuer
            ? "card"
            : PROVIDER_TO_KEY[sub.card_info.provider ?? ""] ?? null
        : null

    return (
        <div className="min-h-screen bg-cur-canvas flex flex-col font-sans text-cur-body">
            <div className="w-full max-w-lg mx-auto px-4 pt-4">
                {/* 영구 무료 계정에는 '결제'가 없다 — 메뉴 라벨(TBMHeader)과 같은 말로 맞춘다 */}
                <TBMHeader title={isGrandfather ? "이용 정보" : "구독 및 결제"} />
            </div>

            <div className="flex-1 w-full max-w-lg mx-auto px-4 py-6 space-y-5">
                {/* 모바일 결제수단 등록(리디렉션) 복귀 처리 */}
                <BillingRedirectHandler />
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
                                        ? "영구 무료"
                                        : storeManaged
                                        ? `${STATUS_LABEL[sub?.status ?? ""] ?? "구독 중"} · ${storeName} 결제`
                                        : cardlessTrialExpired
                                        ? "무료체험 종료"
                                        : committedTrial
                                        ? "이용 중"
                                        : STATUS_LABEL[sub?.status ?? ""] ?? "구독 없음"}
                                </h2>
                            </div>

                            {/* 체험이 공짜로 끝나는 게 아니라 유료로 이어진다는 걸 상단에서 먼저 말한다 */}
                            {cardlessTrialActive && (
                                <p className="text-[12px] text-cur-muted -mt-2 mb-4">
                                    무료체험 1달 후부터 월 사용료가 청구됩니다
                                </p>
                            )}

                            {/* 2026-08-10 Chris: 영구 무료 = "결제 시스템만 빠진 유료 계정".
                                여기선 GrandfatherNotice(카드형)를 쓰지 않는다 — 이 상태 카드가 이미
                                "영구 무료" 제목을 달고 있어 카드 안에 카드를 끼우면 같은 말이 두 번 나온다.
                                AI 분석도 유료와 같은 월 20회로 열렸으므로 예전의 '카드 등록 후 유료 전환하면
                                이용할 수 있어요'는 거짓이 됐다(등록 자체가 서버에서 409로 막힌다).
                                금액·결제수단·다음 결제일은 이 분기에서 한 줄도 그리지 않는다. */}
                            {isGrandfather ? (
                                <div className="space-y-2">
                                    <p className="text-[14px] text-cur-body leading-relaxed">
                                        정책 변경 전까지 무료로 사용 가능합니다.
                                    </p>
                                    <p className="text-[13px] text-cur-muted leading-relaxed">
                                        모든 기능을 유료 구독과 똑같이 쓸 수 있어요. 결제하실 것은 없습니다.
                                    </p>
                                </div>
                            ) : (
                                <div className="space-y-2 text-[14px]">
                                    {/* 요금 구성 — 계정이 곧 청구 항목이라는 걸 표로 보여준다. 설명 문단보다 행 두 줄이 낫다 */}
                                    {storeManaged ? (
                                        // 스토어 구독: 본인 몫은 스토어 가격(4,900). 웹 단가(3,900) 표시는 거짓이 된다.
                                        // 좌석이 있으면 서버 셈법(본인 4,900 스토어 + 좌석 N×3,900 카드)대로 분해해 보여준다.
                                        accountCount > 1 ? (
                                            <>
                                                <div className="flex justify-between">
                                                    <span className="text-cur-muted">내 계정 ({storeName} 구독)</span>
                                                    <span className="text-cur-ink font-medium">{STORE_PRICE.toLocaleString()}원</span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-cur-muted">현장 계정 {accountCount - 1}개</span>
                                                    <span className="text-cur-ink font-medium">{((accountCount - 1) * SEAT_PRICE).toLocaleString()}원</span>
                                                </div>
                                                <div className="flex justify-between pt-2 border-t border-cur-hairline">
                                                    <span className="text-cur-ink font-bold">월 합계</span>
                                                    <span className="text-cur-ink font-bold">{(STORE_PRICE + (accountCount - 1) * SEAT_PRICE).toLocaleString()}원</span>
                                                </div>
                                            </>
                                        ) : (
                                            <div className="flex justify-between">
                                                <span className="text-cur-muted">월 사용료</span>
                                                <span className="text-cur-ink font-medium">{STORE_PRICE.toLocaleString()}원</span>
                                            </div>
                                        )
                                    ) : seatBilled ? (
                                        cardlessTrial ? (
                                            // 체험 중엔 아직 청구 전 — 상세 내역은 결제수단 등록 카드로 옮기고, 요약도 비활성 톤으로
                                            <div className="flex justify-between">
                                                <span className="text-cur-muted">월 사용료</span>
                                                <span className="text-cur-muted font-medium">{(accountCount * SEAT_PRICE).toLocaleString()}원</span>
                                            </div>
                                        ) : accountCount > 1 ? (
                                        <>
                                            <div className="flex justify-between">
                                                <span className="text-cur-muted">내 계정 (감독자)</span>
                                                <span className="text-cur-ink font-medium">3,900원</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-cur-muted">현장 계정 {accountCount - 1}개</span>
                                                <span className="text-cur-ink font-medium">{((accountCount - 1) * SEAT_PRICE).toLocaleString()}원</span>
                                            </div>
                                            <div className="flex justify-between pt-2 border-t border-cur-hairline">
                                                <span className="text-cur-ink font-bold">월 합계</span>
                                                <span className="text-cur-ink font-bold">{(accountCount * SEAT_PRICE).toLocaleString()}원</span>
                                            </div>
                                        </>
                                        ) : (
                                            // 계정 1개(솔로)에겐 '(감독자)' 분해·합계가 회사 문구 누수 — 앱과 같은 규칙으로 2개부터만 분해
                                            <div className="flex justify-between">
                                                <span className="text-cur-muted">월 사용료</span>
                                                <span className="text-cur-ink font-medium">3,900원</span>
                                            </div>
                                        )
                                    ) : (
                                        <div className="flex justify-between">
                                            <span className="text-cur-muted">플랜</span>
                                            <span className="text-cur-ink font-medium">{planLabel}</span>
                                        </div>
                                    )}
                                    {/* 해지되면 빌링키·card_info를 폐기하므로 결제수단 표시도 숨김
                                        (구버전 해지 데이터에 card_info가 남아 있어도 여기서 걸러짐) */}
                                    {methodLabel && sub?.status !== "canceled" && (
                                        <div className="flex justify-between">
                                            {/* 스토어 구독의 등록 카드는 본인 몫이 아니라 좌석(현장 계정) 몫 청구용 */}
                                            <span className="text-cur-muted">{storeManaged ? "현장 계정 청구용 카드" : "결제수단"}</span>
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
                                            다음 결제일부터 요금제가 변경될 예정입니다
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* 재구독·체험종료 유도는 별도 카드가 아니라 상태 카드의 한 구획 —
                                "해지됨"과 "다시 구독"은 같은 이야기라 한 묶음으로 읽혀야 한다(Chris).
                                구분은 카드 사이 여백 대신 얇은 보더 하나로. */}
                            {!isGrandfather && cardlessTrialExpired && (
                                <div className="mt-5 pt-5 border-t border-cur-hairline space-y-4">
                                    <p className="text-[14px] text-cur-body leading-relaxed">
                                        결제수단을 등록하면 즉시 결제 후 이어서 쓸 수 있어요.
                                    </p>
                                    <SubscribeButtons
                                        onSuccess={load}
                                        ctaSuffix="로 이어서 이용"
                                        successText="결제가 완료되어 이어서 이용하실 수 있습니다."
                                    />
                                </div>
                            )}
                            {!isGrandfather && !cardlessTrial && !(active && sub?.status !== "canceled") && (
                                <div className="mt-5 pt-5 border-t border-cur-hairline space-y-4">
                                    <p className="text-[14px] text-cur-muted text-center">
                                        {sub?.status === "canceled"
                                            ? "다시 구독하면 모든 기능을 계속 이용할 수 있습니다."
                                            : "구독하고 모든 기능을 이용하세요."}
                                    </p>
                                    <SubscribeButtons onSuccess={load} />
                                </div>
                            )}
                        </div>

                        {/* PortOne(웹 카드) 구독 관리 — 스토어 구독엔 이 UI가 거짓 약속("결제수단만 변경되며")이
                            되므로 숨기고, 아래 스토어 안내 블록으로 대체한다 */}
                        {!isGrandfather && !storeManaged && !cardlessTrial && active && sub?.status !== "canceled" && (
                            (
                                changingMethod ? (
                                    // 결제수단 변경 진행 — 패딩 카드로 인라인 폼 표시
                                    <div className="bg-cur-card rounded-2xl p-6 border border-cur-hairline space-y-3">
                                        {methodLabel && (
                                            <div className="rounded-xl bg-cur-elevated border border-cur-hairline p-3 flex items-center justify-between opacity-60">
                                                <span className="text-[13px] text-cur-muted">현재 결제수단</span>
                                                <span className="text-[14px] text-cur-ink font-medium">{methodLabel}</span>
                                            </div>
                                        )}
                                        <p className="text-[13px] text-cur-muted text-center">변경할 결제수단을 선택하세요</p>
                                        <SubscribeButtons
                                            mode="update"
                                            currentMethod={currentMethodKey}
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
                                    // A안: 관리 항목은 리스트로우, 해지는 조용한 회색 텍스트
                                    <div className="space-y-3">
                                        <SettingsCard>
                                            <SettingsRow
                                                icon={<CreditCard className="w-[18px] h-[18px]" />}
                                                label="결제수단 변경"
                                                value={methodLabel ?? undefined}
                                                onClick={() => setChangingMethod(true)}
                                                chevron
                                            />
                                        </SettingsCard>
                                        <button
                                            onClick={handleCancel}
                                            disabled={busy}
                                            className="w-full h-10 text-[13px] text-cur-muted hover:text-cur-error transition-colors disabled:opacity-50"
                                        >
                                            {busy ? <Loader2 className="w-4 h-4 animate-spin inline" /> : "구독 해지"}
                                        </button>
                                    </div>
                                )
                            )
                        )}

                        {/* 스토어(인앱) 구독 관리 — 해지·결제수단 변경은 결제한 스토어에서만 가능하다.
                            7일 전액환불 안내(PortOne 정책)도 스토어 결제엔 부적용이라 노출하지 않는다.
                            (앱 account.tsx의 storeManaged 분기와 동일 워딩) */}
                        {!isGrandfather && storeManaged && active && sub?.status !== "canceled" && (
                            <>
                                <SettingsCard>
                                    <SettingsRow
                                        icon={<ExternalLink className="w-[18px] h-[18px]" />}
                                        label="구독 관리 · 해지"
                                        sublabel={
                                            playManaged
                                                ? "해지·결제수단 변경은 Google Play → 정기 결제에서 하세요."
                                                : "해지·결제수단 변경은 설정 > Apple 계정 > 구독에서 할 수 있습니다."
                                        }
                                        onClick={() =>
                                            window.open(
                                                playManaged
                                                    ? "https://play.google.com/store/account/subscriptions"
                                                    : "https://apps.apple.com/account/subscriptions",
                                                "_blank",
                                                "noopener"
                                            )
                                        }
                                        chevron
                                    />
                                </SettingsCard>

                                {/* 현장 계정 청구용 카드 — 좌석 몫(계정당 월 3,900원)은 스토어가 아니라 이 카드로
                                    청구된다(서버 chargeGoogleOwnerSeats).

                                    2026-08-10: 노출 조건 (accountCount > 1 || multiSite)을 없앴다. 좌석을 만들려면
                                    카드가 있어야 하는데(서버 invites/bulk의 선검사) 카드 등록 UI를 보려면 좌석이
                                    이미 있거나 가입 때 '여러 현장'을 고른 사람이어야 해서, 신규 스토어 구독자는
                                    좌석 0개·billing_key null인 채로 영원히 갇혔다(닭-달걀). 이 블록은 이미
                                    !isGrandfather && storeManaged && active로 감싸여 있고, 소속 현장 계정(org member)은
                                    load()에서 홈으로 돌려보내므로 — 여기 닿는 사람은 전부 좌석 청구의 결제 주체다. */}
                                {changingMethod ? (
                                    <div className="bg-cur-card rounded-2xl p-6 border border-cur-hairline space-y-3">
                                        <p className="text-[15px] font-bold text-cur-ink">현장 계정 청구용 카드</p>
                                        {methodLabel && (
                                            <div className="rounded-xl bg-cur-elevated border border-cur-hairline p-3 flex items-center justify-between opacity-60">
                                                <span className="text-[13px] text-cur-muted">현재 카드</span>
                                                <span className="text-[14px] text-cur-ink font-medium">{methodLabel}</span>
                                            </div>
                                        )}
                                        <p className="text-[12px] text-cur-muted leading-relaxed">
                                            이 카드는 현장 계정 몫(계정당 월 3,900원)에만 청구돼요. 내 구독(월 {STORE_PRICE.toLocaleString()}원)은 {storeName}에서 결제돼요.
                                        </p>
                                        <SubscribeButtons
                                            mode="update"
                                            seatOnly
                                            currentMethod={currentMethodKey}
                                            onSuccess={async () => {
                                                setChangingMethod(false)
                                                await load()
                                            }}
                                            ctaSuffix={methodLabel ? "로 변경" : "로 등록"}
                                            successText="현장 계정 청구용 카드가 등록되었습니다."
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
                                    <SettingsCard>
                                        <SettingsRow
                                            icon={<CreditCard className="w-[18px] h-[18px]" />}
                                            label={methodLabel ? "현장 계정 청구용 카드" : "현장 계정 청구용 카드 등록"}
                                            sublabel={
                                                methodLabel
                                                    ? "현장 계정 몫(계정당 월 3,900원)에만 청구돼요"
                                                    : "현장 계정을 만들려면 먼저 등록해야 해요 (계정당 월 3,900원)"
                                            }
                                            value={methodLabel ?? undefined}
                                            onClick={() => setChangingMethod(true)}
                                            chevron
                                        />
                                    </SettingsCard>
                                )}
                            </>
                        )}

                        {/* 월간 보고서 수신처·발송주기 설정은 /report-settings 로 이관 (중복 제거) */}

                        {/* legacy 요금제 업셀 — 이제 구 베이직(monthly_basic) 전용이다.
                            영구 무료는 2026-08-10부터 pro=true(AI 분석 20회 포함)라 !pro에 걸리지 않지만,
                            판정이 한 번이라도 흔들리면 "결제 없는 계정"에 결제 유도가 뜬다 — 명시로 못 박는다. */}
                        {active && !pro && !isGrandfather && (
                            <div className="bg-cur-primary/5 rounded-2xl p-6 border border-cur-primary/30 space-y-3">
                                <div className="flex items-center gap-2">
                                    <Sparkles className="w-5 h-5 text-cur-primary" />
                                    <h2 className="text-[16px] font-bold text-cur-ink">AI 분석·월간 보고서 이용하기</h2>
                                </div>
                                <p className="text-[13px] text-cur-muted leading-relaxed">
                                    지금 요금제엔 AI 분석·월간 보고서가 없어요.
                                    계정당 월 3,900원에 전부 이용할 수 있어요.
                                </p>
                                <Button
                                    onClick={() => router.push("/pricing")}
                                    className="w-full h-12 rounded-[8px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary font-bold"
                                >
                                    요금제 보기
                                </Button>
                            </div>
                        )}

                        {/* 결제 내역 — 영구 무료 계정엔 애초에 결제가 없다. 빈 '결제 내역' 카드는
                            결제라는 개념을 다시 불러오는 장식일 뿐이라 숨긴다. 다만 과거에 결제한
                            이력이 남아 있으면(구독했다가 영구 무료로 복원된 계정) 영수증은 계속 보여준다. */}
                        {(!isGrandfather || payments.length > 0) && (
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
                        )}
                    </>
                )}
            </div>
        </div>
    )
}
