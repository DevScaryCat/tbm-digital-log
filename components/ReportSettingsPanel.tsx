"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, Sparkles } from "lucide-react"

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"]

/**
 * 자동 보고서 설정 본문 — 발송 주기(월간/주간)·수신처·미리보기.
 * 전용 페이지(/report-settings)에서 사용.
 * pro=false면 '예시 화면' 모드: 미리보기는 보이되 저장은 막고 업그레이드를 유도.
 */
export function ReportSettingsPanel({ pro = false }: { pro?: boolean }) {
    const router = useRouter()
    const [recipients, setRecipients] = useState<string[]>([])
    const [newEmail, setNewEmail] = useState("")
    const [sendDay, setSendDay] = useState(1)
    const [frequency, setFrequency] = useState<"monthly" | "weekly">("monthly")
    const [weekday, setWeekday] = useState(1)
    const [saving, setSaving] = useState(false)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
    const [previewHtml, setPreviewHtml] = useState("")
    const [loadingPreview, setLoadingPreview] = useState(false)
    const [previewReady, setPreviewReady] = useState(false)

    const authToken = async () => {
        const { data } = await supabase.auth.getSession()
        return data?.session?.access_token
    }

    useEffect(() => {
        let cancelled = false
        ;(async () => {
            const token = await authToken()
            const res = await fetch("/api/reports/recipients", { headers: { Authorization: `Bearer ${token}` } })
            if (res.ok && !cancelled) {
                const j = await res.json()
                setRecipients(Array.isArray(j.recipients) ? j.recipients : [])
                setSendDay(j.sendDay ?? 1)
                setFrequency(j.frequency === "weekly" ? "weekly" : "monthly")
                setWeekday(j.weekday ?? 1)
            }
            setLoadingPreview(true)
            try {
                const pre = await fetch("/api/reports/monthly/preview", { headers: { Authorization: `Bearer ${token}` } })
                if (pre.ok && !cancelled) { const j = await pre.json(); setPreviewHtml(j.html || "") }
            } finally { if (!cancelled) setLoadingPreview(false) }
        })()
        return () => { cancelled = true }
    }, [])

    const saveSettings = async (next: { recipients?: string[]; sendDay?: number; frequency?: string; weekday?: number }) => {
        setSaving(true)
        setMsg(null)
        try {
            const res = await fetch("/api/reports/recipients", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${await authToken()}` },
                body: JSON.stringify(next),
            })
            const j = await res.json()
            if (!res.ok) { setMsg({ type: "err", text: j.error || "저장 실패" }); return false }
            setRecipients(j.recipients ?? [])
            setSendDay(j.sendDay ?? 1)
            setFrequency(j.frequency === "weekly" ? "weekly" : "monthly")
            setWeekday(j.weekday ?? 1)
            return true
        } finally { setSaving(false) }
    }

    const addRecipient = async () => {
        const email = newEmail.trim()
        if (!email) return
        if (!pro) { setMsg({ type: "err", text: "예시 화면입니다 — Pro 구독 시 실제로 등록·발송됩니다." }); return }
        if (recipients.includes(email)) { setMsg({ type: "err", text: "이미 등록된 이메일입니다." }); return }
        const ok = await saveSettings({ recipients: [...recipients, email] })
        if (ok) { setNewEmail(""); setMsg({ type: "ok", text: "수신처가 추가되었습니다." }) }
    }
    const removeRecipient = async (email: string) => { if (!pro) return; await saveSettings({ recipients: recipients.filter((e) => e !== email) }) }
    const changeSendDay = async (d: number) => { if (!pro) { setSendDay(d); return } await saveSettings({ sendDay: d }) }
    const changeWeekday = async (w: number) => { if (!pro) { setWeekday(w); return } await saveSettings({ weekday: w }) }
    const changeFrequency = async (f: "monthly" | "weekly") => { if (!pro) { setFrequency(f); return } await saveSettings({ frequency: f }) }

    return (
        <div className="space-y-5">
            {!pro && (
                <div className="rounded-xl bg-cur-primary/[0.06] border border-cur-primary/30 p-3 space-y-2">
                    <p className="text-[13px] text-cur-primary font-semibold flex items-center gap-1.5">
                        <Sparkles className="w-4 h-4" /> 예시 화면입니다
                    </p>
                    <p className="text-[12px] text-cur-muted leading-relaxed">
                        아래 미리보기처럼 매주/매달 자동으로 보고서가 발송됩니다. Pro 구독 시 발송 주기·받는 사람을 실제로 설정할 수 있어요.
                    </p>
                    <Button onClick={() => router.push("/pricing")} className="w-full h-9 rounded-lg bg-cur-primary text-white text-[13px] font-bold hover:opacity-90">
                        Pro 플랜 보기
                    </Button>
                </div>
            )}
            <p className="text-[13px] text-cur-muted leading-relaxed">
                지정한 주기(매주·매달)에 안전활동을 분석한 보고서를 사장·안전보건 담당자에게 자동 발송합니다.
                <span className="text-cur-body font-medium"> 회의록 종합·안전보건교육일지 종합 메일 2개</span>로 발송되며, 받는 분은 가입·로그인 불필요.
            </p>

            {msg && (
                <div className={`text-[13px] rounded-lg p-3 ${msg.type === "ok" ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-error/10 text-cur-error"}`}>{msg.text}</div>
            )}

            {/* 발송 주기 + 발송 시점 + 수신처 — Pro 전용 */}
            {pro && (
                <>
                    {/* 발송 주기 토글 */}
                    <div className="space-y-1.5">
                        <Label className="text-[13px]">발송 주기</Label>
                        <div className="flex gap-1 p-1 bg-cur-elevated rounded-lg">
                            {([["monthly", "월간"], ["weekly", "주간"]] as const).map(([key, label]) => (
                                <button
                                    key={key}
                                    onClick={() => changeFrequency(key)}
                                    disabled={saving}
                                    className={`flex-1 h-9 rounded-md text-[14px] font-semibold transition-colors ${frequency === key ? "bg-cur-card text-cur-ink shadow-sm" : "text-cur-muted hover:text-cur-ink"}`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* 발송 시점: 월간=날짜 / 주간=요일 */}
                    <div className="space-y-1.5">
                        <Label className="text-[13px]">{frequency === "weekly" ? "발송 요일" : "발송일"}</Label>
                        {frequency === "weekly" ? (
                            <select
                                value={weekday}
                                onChange={(e) => changeWeekday(Number(e.target.value))}
                                disabled={saving}
                                className="w-full h-11 rounded-lg border border-cur-hairline bg-cur-elevated px-3 text-[14px] text-cur-ink focus:outline-none focus:ring-1 focus:ring-cur-primary"
                            >
                                {WEEKDAYS.map((w, i) => (
                                    <option key={i} value={i}>매주 {w}요일 (직전 7일)</option>
                                ))}
                            </select>
                        ) : (
                            <select
                                value={sendDay}
                                onChange={(e) => changeSendDay(Number(e.target.value))}
                                disabled={saving}
                                className="w-full h-11 rounded-lg border border-cur-hairline bg-cur-elevated px-3 text-[14px] text-cur-ink focus:outline-none focus:ring-1 focus:ring-cur-primary"
                            >
                                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                                    <option key={d} value={d}>매달 {d}일 (지난달 종합)</option>
                                ))}
                            </select>
                        )}
                    </div>

                    {/* 수신처 */}
                    <div className="space-y-2">
                        <Label className="text-[13px]">받는 사람 (최대 5명)</Label>
                        {recipients.length === 0 ? (
                            <p className="text-[13px] text-cur-muted-soft py-1">등록된 수신처가 없습니다.</p>
                        ) : (
                            recipients.map((email) => (
                                <div key={email} className="flex items-center justify-between bg-cur-elevated rounded-lg px-3 py-2">
                                    <span className="text-[14px] text-cur-ink truncate">{email}</span>
                                    <button onClick={() => removeRecipient(email)} disabled={saving} className="text-[12px] text-cur-muted hover:text-cur-error shrink-0 ml-2">삭제</button>
                                </div>
                            ))
                        )}
                        <div className="flex gap-2">
                            <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addRecipient() }} placeholder="사장님/안전관리자 이메일" className="h-11" />
                            <Button onClick={addRecipient} disabled={saving || !newEmail.trim()} className="h-11 px-4 rounded-xl bg-cur-ink text-white font-bold hover:opacity-90 shrink-0">
                                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "추가"}
                            </Button>
                        </div>
                    </div>
                </>
            )}

            {/* 미리보기 — iframe 콘텐츠가 그려진 뒤 페이드인(툭 튀어나옴 방지) */}
            <div className="space-y-2">
                <Label className="text-[13px]">보고서 미리보기</Label>
                <div className="relative h-[360px] border border-cur-hairline rounded-lg overflow-hidden bg-white">
                    {previewHtml ? (
                        <iframe
                            title="보고서 미리보기"
                            srcDoc={previewHtml}
                            onLoad={() => setPreviewReady(true)}
                            className={`w-full h-full transition-opacity duration-500 ${previewReady ? "opacity-100" : "opacity-0"}`}
                        />
                    ) : null}
                    {(!previewReady || loadingPreview) && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-cur-card">
                            {!loadingPreview && !previewHtml ? (
                                <p className="text-[13px] text-cur-muted-soft">미리보기를 불러오지 못했습니다.</p>
                            ) : (
                                <>
                                    <Loader2 className="w-6 h-6 animate-spin text-cur-muted" />
                                    <p className="text-[12px] text-cur-muted-soft">미리보기 불러오는 중…</p>
                                </>
                            )}
                        </div>
                    )}
                </div>
                <p className="text-[12px] text-cur-muted-soft">실제로는 이번 데이터로 채워져 발송됩니다. (위는 예시)</p>
            </div>
        </div>
    )
}
