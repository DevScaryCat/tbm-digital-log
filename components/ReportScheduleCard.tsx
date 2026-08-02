"use client"

// 보고서 발송 주기 카드 — 월간·주간을 동시에 켤 수 있다 (Chris: 둘 다 받아볼 수 있게).
// 저장은 토글 즉시 반영(POST /api/reports/schedule). Pro 전용 기능 자리.
import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabaseClient"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, BellOff } from "lucide-react"
import { showConfirm } from "@/lib/uiDialog"

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"]

function Toggle({ on, disabled, onClick }: { on: boolean; disabled?: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            disabled={disabled}
            onClick={onClick}
            className={`relative w-11 h-6 rounded-full shrink-0 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary ${on ? "bg-cur-primary" : "bg-cur-hairline-strong"}`}
        >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : ""}`} />
        </button>
    )
}

export function ReportScheduleCard({ pro = false }: { pro?: boolean }) {
    const [monthly, setMonthly] = useState(true)
    const [weekly, setWeekly] = useState(false)
    const [weekday, setWeekday] = useState(1)
    const [loaded, setLoaded] = useState(false)
    const [busy, setBusy] = useState(false)
    const [msg, setMsg] = useState<string | null>(null)

    const authHeaders = async () => {
        const { data } = await supabase.auth.getSession()
        return { "Content-Type": "application/json", Authorization: `Bearer ${data?.session?.access_token}` }
    }

    useEffect(() => {
        let cancelled = false
        ;(async () => {
            try {
                const res = await fetch("/api/reports/schedule", { headers: await authHeaders() })
                if (res.ok && !cancelled) {
                    const j = await res.json()
                    setMonthly(j.monthly); setWeekly(j.weekly); setWeekday(j.weekday)
                }
            } finally {
                if (!cancelled) setLoaded(true)
            }
        })()
        return () => { cancelled = true }
    }, [])

    // 낙관 반영 + 실패 시 복구.
    // 둘 다 끄는 것도 허용한다(Chris) — 메일을 받고 싶지 않을 수 있고, 막아두면 수신처를
    // 지우는 우회로밖에 안 남아 설정이 실제와 어긋난다. 대신 끄기 직전에 결과를 분명히 말한다.
    const save = async (patch: { monthly?: boolean; weekly?: boolean; weekday?: number }) => {
        if (!pro) { setMsg("구독하면 발송 주기를 설정할 수 있어요."); return }
        const prev = { monthly, weekly, weekday }
        const next = { ...prev, ...patch }
        if (!next.monthly && !next.weekly) {
            const ok = await showConfirm(
                "월간·주간 보고서가 모두 꺼집니다. 지금부터는 등록된 받는 사람에게 보고서 메일이 한 통도 가지 않아요.\n\n필요할 때 여기서 다시 켤 수 있고, 문서 출력은 그대로 됩니다.",
                { title: "이제 보고서를 받지 못합니다", confirmText: "모두 끄기", danger: true }
            )
            if (!ok) return
        }
        setMonthly(next.monthly); setWeekly(next.weekly); setWeekday(next.weekday)
        setBusy(true); setMsg(null)
        try {
            const res = await fetch("/api/reports/schedule", { method: "POST", headers: await authHeaders(), body: JSON.stringify(patch) })
            if (!res.ok) {
                const j = await res.json().catch(() => ({}))
                setMonthly(prev.monthly); setWeekly(prev.weekly); setWeekday(prev.weekday)
                setMsg(j.error || "저장 실패")
            }
        } catch {
            setMonthly(prev.monthly); setWeekly(prev.weekly); setWeekday(prev.weekday)
            setMsg("네트워크 오류로 저장하지 못했어요.")
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="bg-cur-card rounded-2xl p-5 border border-cur-hairline space-y-3">
            <div>
                <p className="text-[13px] font-semibold text-cur-ink">발송 주기</p>
                <p className="text-[12px] text-cur-muted-soft mt-1 leading-relaxed">월간·주간을 함께 켜면 둘 다 받아볼 수 있어요. 둘 다 끄면 메일이 나가지 않습니다.</p>
            </div>
            {!loaded ? (
                <div className="py-3 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-cur-muted-soft" /></div>
            ) : (
                <div className={`rounded-xl border border-cur-hairline divide-y divide-cur-hairline overflow-hidden ${busy ? "opacity-60" : ""}`}>
                    <div className="flex items-center gap-3 px-3 py-3">
                        <span className="flex-1 min-w-0">
                            <span className="block text-[14px] font-medium text-cur-ink">월간 보고서</span>
                            <span className="block text-[12px] text-cur-muted-soft">매월 1일 · 지난달 종합</span>
                        </span>
                        <Toggle on={monthly} disabled={busy} onClick={() => save({ monthly: !monthly })} />
                    </div>
                    <div className="flex items-center gap-3 px-3 py-3">
                        <span className="flex-1 min-w-0">
                            <span className="block text-[14px] font-medium text-cur-ink">주간 보고서</span>
                            <span className="block text-[12px] text-cur-muted-soft">매주 · 지난 7일 종합</span>
                        </span>
                        {weekly && (
                            <Select value={String(weekday)} onValueChange={(v) => save({ weekday: Number(v) })}>
                                <SelectTrigger className="w-[76px] h-9 text-[13px] border-cur-hairline rounded-[8px] bg-cur-elevated text-cur-ink shrink-0">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                                    {WEEKDAYS.map((d, i) => <SelectItem key={i} value={String(i)}>{d}요일</SelectItem>)}
                                </SelectContent>
                            </Select>
                        )}
                        <Toggle on={weekly} disabled={busy} onClick={() => save({ weekly: !weekly })} />
                    </div>
                </div>
            )}
            {/* 다 꺼진 상태는 화면이 계속 말해줘야 한다 — 안 그러면 '왜 메일이 안 오지'가 된다 */}
            {loaded && !monthly && !weekly && (
                <div className="flex gap-2.5 rounded-xl bg-cur-elevated border border-cur-hairline-strong p-3">
                    <BellOff className="w-4 h-4 text-cur-ink shrink-0 mt-0.5" />
                    <p className="text-[12px] text-cur-body leading-relaxed">
                        <b className="text-cur-ink">보고서 메일이 나가지 않는 상태예요.</b> 위 토글을 켜면 다시 발송됩니다.
                        (문서 출력·AI 분석 보고서는 영향 없어요)
                    </p>
                </div>
            )}
            {msg && <p className="text-[12px] text-cur-error">{msg}</p>}
        </div>
    )
}
