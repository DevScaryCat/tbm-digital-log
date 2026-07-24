"use client"

import { useEffect, useState } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { Loader2, CheckCircle2, XCircle } from "lucide-react"

type Info = { site: string; email: string; status: string }

export default function ConsentPage() {
    const params = useParams<{ token: string }>()
    const search = useSearchParams()
    const token = (params?.token as string) || ""
    const intent = search.get("a") // 'approve' | 'decline' — 메일에서 온 힌트(클릭 확정은 여기서)

    const [loading, setLoading] = useState(true)
    const [info, setInfo] = useState<Info | null>(null)
    const [result, setResult] = useState<"approved" | "declined" | null>(null)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!token) return
        ;(async () => {
            try {
                const res = await fetch(`/api/consent/${token}`)
                if (!res.ok) {
                    setError("잘못되었거나 만료된 링크입니다.")
                    return
                }
                const j: Info = await res.json()
                setInfo(j)
                if (j.status === "approved") setResult("approved")
                else if (j.status === "declined") setResult("declined")
            } catch {
                setError("불러오지 못했습니다.")
            } finally {
                setLoading(false)
            }
        })()
    }, [token])

    const respond = async (approve: boolean) => {
        setSubmitting(true)
        setError(null)
        try {
            const res = await fetch(`/api/consent/${token}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ approve }),
            })
            const j = await res.json()
            if (!res.ok) {
                setError(j.error || "처리에 실패했습니다.")
                return
            }
            setResult(j.status)
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <div className="min-h-screen bg-cur-canvas flex items-center justify-center px-4 font-sans">
            <div className="w-full max-w-sm bg-cur-card rounded-2xl border border-cur-hairline p-6 shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
                <p className="text-[13px] font-bold text-cur-primary mb-4">안톡</p>

                {loading ? (
                    <div className="py-10 flex justify-center"><Loader2 className="w-7 h-7 text-cur-primary animate-spin" /></div>
                ) : error ? (
                    <div className="py-6 text-center">
                        <XCircle className="w-10 h-10 text-cur-muted mx-auto mb-3" />
                        <p className="text-[15px] font-bold text-cur-ink">{error}</p>
                    </div>
                ) : result === "approved" ? (
                    <div className="py-4 text-center">
                        <CheckCircle2 className="w-11 h-11 text-cur-primary mx-auto mb-3" />
                        <p className="text-[16px] font-bold text-cur-ink mb-1.5">수신 승인 완료</p>
                        <p className="text-[13px] text-cur-muted leading-relaxed">
                            앞으로 <b className="text-cur-ink">{info?.site}</b>의 월간 안전 보고서를 받으시게 됩니다.
                            여러 현장이 같은 이메일로 등록하면 한 통으로 합쳐 보내드립니다.
                        </p>
                    </div>
                ) : result === "declined" ? (
                    <div className="py-4 text-center">
                        <XCircle className="w-11 h-11 text-cur-muted mx-auto mb-3" />
                        <p className="text-[16px] font-bold text-cur-ink mb-1.5">수신을 거부하셨습니다</p>
                        <p className="text-[13px] text-cur-muted leading-relaxed">
                            <b className="text-cur-ink">{info?.site}</b>에서 오는 보고서는 이제 발송되지 않습니다.
                        </p>
                    </div>
                ) : (
                    <div>
                        <p className="text-[16px] font-bold text-cur-ink mb-2">안전 보고서 수신 확인</p>
                        <p className="text-[14px] text-cur-body leading-relaxed mb-1">
                            <b className="text-cur-ink">{info?.site}</b>에서 매월 안전활동(TBM 회의록·안전보건교육일지) 종합 보고서를
                            <b className="text-cur-ink"> {info?.email}</b> 로 보내려고 합니다.
                        </p>
                        <p className="text-[13px] text-cur-muted leading-relaxed mb-5">
                            받아보시겠어요? 본인이 요청하지 않았다면 <b>받지 않기</b>를 누르시면 발송되지 않습니다.
                        </p>
                        <div className="space-y-2.5">
                            <button
                                onClick={() => respond(true)}
                                disabled={submitting}
                                className={`w-full h-12 rounded-xl font-bold text-white bg-cur-primary hover:opacity-90 transition ${intent === "approve" ? "ring-2 ring-cur-primary/40" : ""}`}
                            >
                                {submitting ? <Loader2 className="w-4 h-4 animate-spin inline" /> : "받기 (승인)"}
                            </button>
                            <button
                                onClick={() => respond(false)}
                                disabled={submitting}
                                className="w-full h-11 rounded-xl font-semibold text-cur-muted bg-cur-elevated border border-cur-hairline hover:text-cur-ink transition"
                            >
                                받지 않기
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
