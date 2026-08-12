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
    // 서버가 "본인 스토어 구독을 유지한 채 편입했다"고 알려주면 새로고침 전에 **반드시** 보여준다.
    // 이 화면의 안내("개인 구독은 일할 환불 후 해지")가 그 경우에만 사실이 아니기 때문이다 —
    // 판정은 서버가 하고(좌석 회계), 화면은 문장을 그대로 옮긴다.
    const [notice, setNotice] = useState<string | null>(null)
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
            if (accept && typeof j.notice === "string" && j.notice) { setNotice(j.notice); return }
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
                    {/* 스토어(구글·애플) 구독은 서버가 해지할 권한이 없다 — 위 첫 줄이 그 경우에만
                        다르게 동작하므로 여기서 미리 말해둔다. 수락 후에는 서버가 준 문구를 다시 띄운다. */}
                    <p className="text-cur-muted">· 앱 스토어에서 직접 결제 중이라면 그 구독은 <b>그대로 유지</b>되고, 회사는 이 계정 요금을 청구하지 않아요</p>
                </div>
                {notice && (
                    <div className="text-[13px] rounded-lg p-3 bg-cur-primary/10 text-cur-primary leading-relaxed">{notice}</div>
                )}
                {error && <div className="text-[13px] rounded-lg p-3 bg-cur-error/10 text-cur-error">{error}</div>}
                {notice ? (
                    <Button onClick={() => { onDone(); window.location.reload() }}
                        className="w-full h-11 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90">
                        확인
                    </Button>
                ) : (
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
                )}
            </div>
        </div>
    )
}
