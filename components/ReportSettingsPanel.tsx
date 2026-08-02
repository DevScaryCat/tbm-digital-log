"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ExternalLink, Loader2, Sparkles, MailWarning } from "lucide-react"
import { countRecipients, type ConsentStatus, type Recipient, type RecipientCounts } from "@/lib/reportRecipients"
import { resolveMyReportEmail } from "@/lib/myEmail"

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
export function ReportSettingsPanel({ pro = false, onRecipientsChange }: { pro?: boolean; onRecipientsChange?: (counts: RecipientCounts) => void }) {
    const router = useRouter()
    const [recipients, setRecipients] = useState<Recipient[]>([])
    // 목록에 내 주소가 섞여 있으면 어느 게 '나'인지 알 수 없다 — 표시로 구분한다(Chris).
    // 판정은 분석 보고서 발송과 같은 lib/myEmail 규칙이라 두 화면이 갈리지 않는다.
    const [myEmail, setMyEmail] = useState<string | null>(null)
    useEffect(() => {
        supabase.auth.getUser().then(({ data }) => setMyEmail(resolveMyReportEmail(data?.user as never)))
    }, [])
    const [newEmail, setNewEmail] = useState("")
    const [saving, setSaving] = useState(false)
    const [loaded, setLoaded] = useState(false)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)

    const authToken = async () => {
        const { data } = await supabase.auth.getSession()
        return data?.session?.access_token
    }

    const applyResponse = (j: any) => {
        if (Array.isArray(j.recipients)) {
            setRecipients(j.recipients)
            // 위저드 완료 판정용 — 개수가 아니라 승인 상태별 집계를 넘긴다.
            // 크론은 approved만 발송하므로 pending을 완료로 세면 화면만 완료가 된다.
            onRecipientsChange?.(countRecipients(j.recipients))
        }
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

    // 승인 0명 + 대기 1명 이상 = 화면상 "등록됐다"고 보이지만 실제로는 한 통도 안 나가는 상태.
    // 이 구간을 조용히 두면 사용자는 설정을 끝냈다고 믿는다.
    const counts = countRecipients(recipients)
    const stalled = counts.approved === 0 && counts.pending > 0

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
            {msg && (
                <div className={`text-[13px] rounded-lg p-3 ${msg.type === "ok" ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-error/10 text-cur-error"}`}>{msg.text}</div>
            )}

            {/* 수신처 (승인제) — Pro 전용 */}
            {pro && (
                <div className="bg-cur-card rounded-2xl p-5 border border-cur-hairline space-y-3">
                    <div>
                        <Label className="text-[13px]">받는 사람 (최대 5명)</Label>
                        <p className="text-[12px] text-cur-muted-soft mt-1 leading-relaxed">
                            설정한 주기에 맞춰 지난 기간 안전활동(TBM 회의록·교육일지) 보고서가 자동 발송돼요.
                            수신자를 추가하면 <b>확인 메일</b>이 가고, 수신자가 승인해야 발송됩니다.
                            여러 현장이 같은 이메일을 등록하면 <b>한 통으로 합쳐</b> 보내드려요.
                        </p>
                    </div>
                    {stalled && (
                        <div className="rounded-xl bg-cur-elevated border border-cur-hairline-strong p-3 flex gap-2.5">
                            <MailWarning className="w-4 h-4 text-cur-ink shrink-0 mt-0.5" />
                            <div className="min-w-0 space-y-1">
                                <p className="text-[13px] font-bold text-cur-ink">아직 아무에게도 발송되지 않아요</p>
                                <p className="text-[12px] text-cur-body leading-relaxed">
                                    등록은 됐지만 <b>승인한 사람이 0명</b>이에요. 받는 사람이 확인 메일의 승인 링크를 눌러야
                                    그때부터 보고서가 나갑니다. 메일이 안 보이면 스팸함을 확인해달라고 알려주시고,
                                    필요하면 아래 <b>재발송</b>을 눌러주세요.
                                </p>
                            </div>
                        </div>
                    )}
                    {!loaded ? (
                        <div className="py-3 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-cur-muted-soft" /></div>
                    ) : recipients.length === 0 ? (
                        <p className="text-[13px] text-cur-muted-soft py-1">등록된 수신처가 없습니다.</p>
                    ) : (
                        <div className="rounded-xl border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                            {recipients.map((r) => (
                                <div key={r.email} className="flex items-center gap-2 px-3 py-2.5">
                                    <span className="flex-1 min-w-0">
                                        <span className="block text-[14px] text-cur-ink truncate">{r.email}</span>
                                        {myEmail && r.email.toLowerCase() === myEmail.toLowerCase() && (
                                            <span className="block text-[11px] font-semibold text-cur-primary mt-0.5">내 이메일 · 주소 변경은 내 정보 수정에서</span>
                                        )}
                                    </span>
                                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${STATUS_BADGE[r.status].cls}`}>
                                        {STATUS_BADGE[r.status].label}
                                    </span>
                                    {r.status !== "approved" && (
                                        <button onClick={() => resendRecipient(r.email)} disabled={saving} className="text-[12px] text-cur-primary hover:opacity-70 shrink-0 transition-colors">재발송</button>
                                    )}
                                    {/* 내 이메일은 뺄 수 없다(Chris) — 지우면 "설정은 끝냈는데 아무도 못 받는" 상태가 다시 생긴다.
                                        받고 싶지 않으면 아래 발송 주기를 끄면 된다(그쪽이 의도를 정확히 표현한다) */}
                                    {!(myEmail && r.email.toLowerCase() === myEmail.toLowerCase()) && (
                                        <button onClick={() => removeRecipient(r.email)} disabled={saving} className="text-[12px] text-cur-muted hover:text-cur-error shrink-0 transition-colors">삭제</button>
                                    )}
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

        </div>
    )
}

/** 보고서 미리보기 — 설정 화면 맨 아래 전용 (설정을 다 끝낸 뒤 참고용, Chris).
 *  인라인 축소 렌더는 작아서 안 읽히므로 새 탭 전체 화면으로 연다. */
export function ReportPreviewCard() {
    return (
        <div className="bg-cur-card rounded-2xl p-5 border border-cur-hairline space-y-3">
            <div>
                <Label className="text-[13px]">보고서 미리보기</Label>
                <p className="text-[12px] text-cur-muted-soft mt-1 leading-relaxed">
                    실제로는 지난 기간 데이터로 채워져 발송됩니다. 예시를 새 탭에서 크게 볼 수 있어요.
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
    )
}
