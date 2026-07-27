"use client"

// 회사 공통 문서 출력 형식 카드 — 보고서 화면의 '발송 설정' 탭에서 쓴다.
// (처음엔 현장 계정 관리에 뒀는데 "문서 설정은 보고서 설정에 있어야지"(Chris)로 이동)
// 탭 즉시 저장: POST /api/org/export-format이 감독자 본인 + 전 현장 계정에 전파한다.
import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabaseClient"
import { ExportFormatPicker } from "@/components/ExportFormatPicker"
import { type ExportFormat } from "@/lib/exportFormats"

export function CompanyDocFormatCard() {
    const [docFormat, setDocFormat] = useState<string>("")
    const [busy, setBusy] = useState(false)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)

    useEffect(() => {
        ;(async () => {
            const { data } = await supabase.auth.getUser()
            setDocFormat(String(data?.user?.user_metadata?.preferred_export_format ?? ""))
        })()
    }, [])

    const changeDocFormat = async (v: ExportFormat) => {
        if (busy || v === docFormat) return
        const prev = docFormat
        setDocFormat(v)
        setBusy(true)
        setMsg(null)
        try {
            const { data: s } = await supabase.auth.getSession()
            const res = await fetch("/api/org/export-format", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${s?.session?.access_token}` },
                body: JSON.stringify({ format: v }),
            })
            // 게이트웨이 5xx는 HTML 본문일 수 있어 json 파싱을 ok 판정보다 방어적으로
            const j = await res.json().catch(() => ({}))
            if (!res.ok) { setDocFormat(prev); setMsg({ type: "err", text: j.error || "형식 변경 실패" }); return }
            setMsg({ type: "ok", text: j.total > 0 ? `문서 형식을 바꿨어요. 현장 계정 ${j.updated}개에도 함께 적용했습니다.` : "문서 형식을 바꿨어요." })
        } catch {
            // 오프라인·네트워크 실패 — 되돌리지 않으면 저장 안 된 형식이 남고 재클릭도 막힌다
            setDocFormat(prev)
            setMsg({ type: "err", text: "네트워크 오류로 형식을 바꾸지 못했어요. 다시 시도해주세요." })
        } finally {
            setBusy(false)
        }
    }

    return (
        <section className="bg-cur-card rounded-2xl border border-cur-hairline p-5 space-y-3">
            <div>
                <h2 className="text-[15px] font-bold text-cur-ink">문서 출력 형식 (회사 공통)</h2>
                <p className="text-[12px] text-cur-muted mt-1 leading-relaxed">
                    회의록·교육일지를 저장하는 형식이에요. 내 계정과 모든 현장 계정에 함께 적용됩니다.
                </p>
            </div>
            {msg && (
                <div className={`text-[13px] rounded-lg p-3 ${msg.type === "ok" ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-error/10 text-cur-error"}`}>{msg.text}</div>
            )}
            <div className={busy ? "opacity-60 pointer-events-none" : undefined}>
                <ExportFormatPicker value={(docFormat || null) as ExportFormat | null} onChange={changeDocFormat} />
            </div>
        </section>
    )
}
