"use client"

// 모바일 결제수단 등록(빌링키 발급)의 리디렉션 복귀 처리.
// 이니시스 등은 모바일에서 결제사 페이지로 이동(리디렉션 방식) 후 redirectUrl로 돌아오며
// 결과를 쿼리 파라미터로 전달한다. SubscribeButtons는 플랜 선택 후에만 마운트되는 페이지가
// 있어(/pricing) 복귀 파라미터를 놓칠 수 있음 → 이 핸들러를 페이지 레벨에 무조건 마운트한다.
// 발급 요청 시점의 컨텍스트(플랜·모드·수단)는 SubscribeButtons가 sessionStorage에 저장한다.

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { supabase } from "@/lib/supabaseClient"

export const REDIRECT_CTX_KEY = "billing_redirect_ctx"

// 페이지에 중복 마운트돼도 복귀 처리는 한 번만
let handled = false

export function BillingRedirectHandler() {
    const [processing, setProcessing] = useState(false)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)

    useEffect(() => {
        if (handled || typeof window === "undefined") return
        const sp = new URLSearchParams(window.location.search)
        const billingKey = sp.get("billingKey") || sp.get("billing_key")
        const code = sp.get("code")
        if (!billingKey && !code) return
        handled = true

        const ctxRaw = sessionStorage.getItem(REDIRECT_CTX_KEY)
        sessionStorage.removeItem(REDIRECT_CTX_KEY)
        // org 결제 복귀 마커 — sessionStorage가 유실돼도 URL로 org 결제였음을 안다
        const isOrgReturn = sp.get("occtx") === "1"
        // PG 파라미터가 붙은 URL은 새로고침 시 중복 처리 위험 — 즉시 정리
        window.history.replaceState(null, "", window.location.pathname)

        if (code) {
            const pg = [sp.get("pgCode"), sp.get("pgMessage")].filter(Boolean).join(" · ")
            const base = sp.get("message") || "취소되었습니다."
            setMsg({ type: "err", text: `등록 실패: ${base}${pg ? ` — PG: ${pg}` : ""}` })
            return
        }
        if (!billingKey) return

        const ctx = (() => {
            try {
                return ctxRaw
                    ? (JSON.parse(ctxRaw) as {
                          plan?: string
                          mode?: string
                          method?: string
                          // 안전관리자 회사 플랜 결제(좌석제) 복귀 — /api/org/checkout으로 라우팅
                          orgCheckout?: boolean
                          seatCount?: number
                          orgName?: string
                      })
                    : null
            } catch {
                return null
            }
        })()

        // org 결제 복귀인데 컨텍스트(좌석·회사명)가 유실됨 — 기본값으로 개인 플랜을
        // 등록해버리면 안 되므로(리뷰 O/의심) 아무 것도 등록하지 않고 재시도 안내
        if (isOrgReturn && !ctx?.orgCheckout) {
            setMsg({ type: "err", text: "결제 복귀 정보가 유실됐어요. 결제창을 다시 열어 진행해주세요. (카드가 등록됐다면 결제는 되지 않았으니 안심하세요)" })
            return
        }

        ;(async () => {
            setProcessing(true)
            try {
                const { data: sessionData } = await supabase.auth.getSession()
                const token = sessionData?.session?.access_token
                const res = ctx?.orgCheckout
                    ? await fetch("/api/org/checkout", {
                          method: "POST",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                          body: JSON.stringify({
                              billingKey,
                              seatCount: ctx?.seatCount ?? 1,
                              orgName: ctx?.orgName ?? "",
                          }),
                      })
                    : await fetch("/api/payments/billing-key", {
                          method: "POST",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                          body: JSON.stringify({
                              billingKey,
                              method: ctx?.method ?? "card",
                              mode: ctx?.mode ?? "subscribe",
                              plan: ctx?.plan ?? "monthly_basic",
                          }),
                      })
                const json = await res.json()
                if (!res.ok) {
                    setMsg({ type: "err", text: json.error || "구독 처리 실패" })
                    return
                }
                setMsg({ type: "ok", text: ctx?.orgCheckout ? "결제가 완료되었습니다! 화면을 새로 불러옵니다…" : "결제수단 등록이 완료되었습니다! 화면을 새로 불러옵니다…" })
                // 구독 상태를 다시 불러오도록 정리된 URL로 새로고침
                setTimeout(() => window.location.reload(), 1200)
            } catch (e) {
                console.error(e)
                setMsg({ type: "err", text: "결제 처리 중 오류가 발생했습니다." })
            } finally {
                setProcessing(false)
            }
        })()
    }, [])

    if (!processing && !msg) return null

    return (
        <>
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
                    className={`text-[13px] rounded-lg p-3 mb-3 ${
                        msg.type === "ok" ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-error/10 text-cur-error"
                    }`}
                >
                    {msg.text}
                </div>
            )}
        </>
    )
}
