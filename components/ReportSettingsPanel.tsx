"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ExternalLink, Loader2, Sparkles } from "lucide-react"

type ConsentStatus = "pending" | "approved" | "declined"
type Recipient = { email: string; status: ConsentStatus }

const STATUS_BADGE: Record<ConsentStatus, { label: string; cls: string }> = {
    pending: { label: "승인 대기", cls: "text-cur-muted bg-cur-elevated" },
    approved: { label: "승인됨", cls: "text-cur-primary bg-cur-primary/10" },
    declined: { label: "거부됨", cls: "text-cur-error bg-cur-error/10" },
}

/**
 * 자동 보고서 설정 본문 — 수신처(승인제)·미리보기.
 * 전용 페이지(/report-settings)에서 사용. 보고서는 매월 1일 지난달 종합으로 발송.
 * pro=false면 '예시 화면' 모드: 미리보기는 보이되 저장은 막고 업그레이드를 유도.
 */
export function ReportSettingsPanel({ pro = false }: { pro?: boolean }) {
    const router = useRouter()
    const [recipients, setRecipients] = useState<Recipient[]>([])
    const [newEmail, setNewEmail] = useState("")
    const [saving, setSaving] = useState(false)
    const [loaded, setLoaded] = useState(false)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)

    const authToken = async () => {
        const { data } = await supabase.auth.getSession()
        return data?.session?.access_token
    }

    const applyResponse = (j: any) => {
        if (Array.isArray(j.recipients)) setRecipients(j.recipients)
    }

    useEffect(() => {
        let cancelled = false
        ;(async () => {
            try {
                const token = await authToken()
                const res = await fetch("/api/reports/recipients", { headers: { Authorization: `Bearer ${token}` } })
                if (res.ok && !cancelled) applyResponse(await res.json())
            } finally {
                if (!cancelled) setLoaded(true)
            }
        })()
        return () => { cancelled = true }
    }, [])

    // 설정 저장 공용 (수신처 추가/삭제)
    const post = async (body: Record<string, unknown>): Promise<any | null> => {
        setSaving(true)
        setMsg(null)
        try {
            const res = await fetch("/api/reports/recipients", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${await authToken()}` },
                body: JSON.stringify(body),
            })
            const j = await res.json()
            if (!res.ok) { setMsg({ type: "err", text: j.error || "저장 실패" }); return null }
            applyResponse(j)
            return j
        } finally { setSaving(false) }
    }

    const addRecipient = async () => {
        const email = newEmail.trim()
        if (!email) return
        if (!pro) { setMsg({ type: "err", text: "예시 화면입니다 — 구독하면 실제로 등록·발송됩니다." }); return }
        const j = await post({ addRecipient: email })
        if (j) {
            setNewEmail("")
            setMsg(j.mailed
                ? { type: "ok", text: `확인 메일을 ${email} 로 보냈어요. 수신자가 승인하면 발송됩니다.` }
                : { type: "err", text: `${email} 추가했지만 확인 메일을 못 보냈어요 (${j.mailNote || "메일 오류"}). 아래 '재발송'을 눌러 다시 시도하세요.` })
        }
    }
    const resendRecipient = async (email: string) => {
        const j = await post({ resendRecipient: email })
        if (j) setMsg(j.mailed
            ? { type: "ok", text: `확인 메일을 ${email} 로 다시 보냈어요.` }
            : { type: "err", text: `재발송 실패: ${j.mailNote || "메일 오류"}` })
    }
    const removeRecipient = async (email: string) => { if (!pro) return; await post({ removeRecipient: email }) }

    return (
        <div className="space-y-5">
            {!pro && (
                <div className="rounded-xl bg-cur-primary/[0.06] border border-cur-primary/30 p-3 space-y-2">
                    <p className="text-[13px] text-cur-primary font-semibold flex items-center gap-1.5">
                        <Sparkles className="w-4 h-4" /> 예시 화면입니다
                    </p>
                    <p className="text-[12px] text-cur-muted leading-relaxed">
                        아래 미리보기처럼 매월 자동으로 보고서가 발송됩니다. 구독하면 받는 사람·발송 방법을 실제로 설정할 수 있어요.
                    </p>
                    <Button onClick={() => router.push("/pricing")} className="w-full h-9 rounded-lg bg-cur-primary text-white text-[13px] font-bold hover:opacity-90">
                        Pro 플랜 보기
                    </Button>
                </div>
            )}
            <p className="text-[13px] text-cur-muted leading-relaxed">
                매월 1일, 지난달 안전활동(TBM 회의록·안전보건교육일지)을 분석한 보고서를 승인한 수신자에게 자동 발송합니다.
            </p>

            {msg && (
                <div className={`text-[13px] rounded-lg p-3 ${msg.type === "ok" ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-error/10 text-cur-error"}`}>{msg.text}</div>
            )}

            {/* 수신처 (승인제) — Pro 전용 */}
            {pro && (
                <div className="bg-cur-card rounded-2xl p-5 border border-cur-hairline space-y-3">
                    <div>
                        <Label className="text-[13px]">받는 사람 (최대 5명)</Label>
                        <p className="text-[12px] text-cur-muted-soft mt-1 leading-relaxed">
                            수신자를 추가하면 <b>확인 메일</b>이 가고, 수신자가 승인해야 발송됩니다. 여러 현장이 같은 이메일을 등록하면 <b>한 통으로 합쳐</b> 보내드려요.
                        </p>
                    </div>
                    {!loaded ? (
                        <div className="py-3 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-cur-muted-soft" /></div>
                    ) : recipients.length === 0 ? (
                        <p className="text-[13px] text-cur-muted-soft py-1">등록된 수신처가 없습니다.</p>
                    ) : (
                        <div className="rounded-xl border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                            {recipients.map((r) => (
                                <div key={r.email} className="flex items-center gap-2 px-3 py-2.5">
                                    <span className="text-[14px] text-cur-ink truncate flex-1 min-w-0">{r.email}</span>
                                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${STATUS_BADGE[r.status].cls}`}>
                                        {STATUS_BADGE[r.status].label}
                                    </span>
                                    {r.status !== "approved" && (
                                        <button onClick={() => resendRecipient(r.email)} disabled={saving} className="text-[12px] text-cur-primary hover:opacity-70 shrink-0 transition-colors">재발송</button>
                                    )}
                                    <button onClick={() => removeRecipient(r.email)} disabled={saving} className="text-[12px] text-cur-muted hover:text-cur-error shrink-0 transition-colors">삭제</button>
                                </div>
                            ))}
                        </div>
                    )}
                    <div className="flex gap-2">
                        <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addRecipient() }} placeholder="대표자 이메일, 담당자 이메일 등" className="h-11" />
                        <Button onClick={addRecipient} disabled={saving || !newEmail.trim()} className="h-11 px-4 rounded-xl bg-cur-ink text-white font-bold hover:opacity-90 shrink-0">
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "추가"}
                        </Button>
                    </div>
                </div>
            )}

            {/* 미리보기 — 인라인 축소 렌더는 작아서 안 읽히므로 새 탭 전체 화면으로 연다 */}
            <div className="bg-cur-card rounded-2xl p-5 border border-cur-hairline space-y-3">
                <div>
                    <Label className="text-[13px]">보고서 미리보기</Label>
                    <p className="text-[12px] text-cur-muted-soft mt-1 leading-relaxed">
                        실제로는 지난달 데이터로 채워져 발송됩니다. 예시를 새 탭에서 크게 볼 수 있어요.
                    </p>
                </div>
                <div className="rounded-xl border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                    {([["minutes", "TBM 회의록 종합"], ["edu", "안전보건교육일지 종합"]] as const).map(([kind, label]) => (
                        <a
                            key={kind}
                            href={`/report/sample/${kind}`}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-2 px-3 py-3 hover:bg-cur-elevated/50 transition-colors"
                        >
                            <span className="text-[14px] text-cur-ink flex-1 min-w-0 truncate">{label}</span>
                            <span className="text-[12px] text-cur-primary font-semibold shrink-0">예시 보기</span>
                            <ExternalLink className="w-3.5 h-3.5 text-cur-muted-soft shrink-0" />
                        </a>
                    ))}
                </div>
            </div>
        </div>
    )
}
