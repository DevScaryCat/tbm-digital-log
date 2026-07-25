"use client"

// 기존 계정의 조직 편입(attach) 수락 모달 — 홈에서 pendingAttach가 있으면 노출.
// 수락 전 고지(§3): 개인 구독은 일할 환불 후 해지되고, 기존 수신자에게 가던 보고서가 중단된다.
import { useRef, useEffect, useState } from "react"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { Loader2, Building2 } from "lucide-react"
import { clearOrgContextCache } from "@/lib/useOrgContext"

export function AttachInviteModal({
    orgName,
    token,
    onDone,
}: {
    orgName: string
    token: string
    onDone: () => void
}) {
    const [busy, setBusy] = useState<"accept" | "decline" | null>(null)
    const [error, setError] = useState<string | null>(null)
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => { ref.current?.focus() }, [])

    const respond = async (accept: boolean) => {
        setBusy(accept ? "accept" : "decline")
        setError(null)
        try {
            const { data } = await supabase.auth.getSession()
            const res = await fetch("/api/org/attach", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${data?.session?.access_token}` },
                body: JSON.stringify({ token, accept }),
            })
            const j = await res.json()
            if (!res.ok) { setError(j.error || "처리에 실패했습니다."); return }
            clearOrgContextCache()
            onDone()
            if (accept) window.location.reload()
        } finally {
            setBusy(null)
        }
    }

    return (
        <div role="dialog" aria-modal="true" aria-label="조직 편입 초대" tabIndex={-1} ref={ref}
            className="fixed inset-0 z-[90] bg-black/50 backdrop-blur-sm flex items-center justify-center px-5">
            <div className="w-full max-w-sm bg-cur-card rounded-2xl border border-cur-hairline p-6 space-y-4">
                <div className="flex items-center gap-3">
                    <span className="w-11 h-11 rounded-xl bg-cur-primary/12 text-cur-primary flex items-center justify-center shrink-0">
                        <Building2 className="w-5 h-5" />
                    </span>
                    <div>
                        <h2 className="text-[16px] font-bold text-cur-ink leading-snug">{orgName}</h2>
                        <p className="text-[13px] text-cur-muted">우리 현장을 회사 계정에 연결할까요?</p>
                    </div>
                </div>
                <div className="rounded-xl bg-cur-elevated p-4 text-[13px] text-cur-body leading-relaxed space-y-1.5">
                    <p>수락하면 이렇게 바뀝니다:</p>
                    <p>· 이용 요금은 <b>회사가 결제</b>해요 (내 개인 구독은 잔여 기간을 일할 환불 후 해지)</p>
                    <p>· 현재 <b>수신자에게 가던 월간 보고서는 중단</b>되고, 회사 안전관리자가 보고서를 관리해요</p>
                    <p>· 지금까지 기록한 현장 데이터는 그대로 유지됩니다</p>
                </div>
                {error && <div className="text-[13px] rounded-lg p-3 bg-cur-error/10 text-cur-error">{error}</div>}
                <div className="flex gap-2">
                    <Button onClick={() => respond(false)} disabled={!!busy} variant="outline"
                        className="flex-1 h-11 rounded-xl border-cur-hairline text-cur-muted font-semibold">
                        {busy === "decline" ? <Loader2 className="w-4 h-4 animate-spin" /> : "거절"}
                    </Button>
                    <Button onClick={() => respond(true)} disabled={!!busy}
                        className="flex-1 h-11 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90">
                        {busy === "accept" ? <Loader2 className="w-4 h-4 animate-spin" /> : "수락하고 연결"}
                    </Button>
                </div>
            </div>
        </div>
    )
}
