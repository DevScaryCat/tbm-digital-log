"use client"

// 보고서 설정 (안전관리자 전용) — 설정 미완료면 위저드(① 문서 형식 → ② 받는 사람),
// 완료하면 2탭: [문서 형식(형식+미리보기)] [발송 설정(받는 사람+주기)] (Chris 그룹핑).
// 받은 보고서 탭은 제거 — 이메일 수신이 본선이고, 화면 하나에 역할 하나만.
// AI 분석 보고서는 이 설정을 끝내야 열린다.
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { Loader2 } from "lucide-react"
import { useOrgContext } from "@/lib/useOrgContext"
import { ReportSettingsPanel, ReportPreviewCard } from "@/components/ReportSettingsPanel"
import { CompanyDocFormatCard } from "@/components/CompanyDocFormatCard"
import { ReportScheduleCard } from "@/components/ReportScheduleCard"
import { fetchSubscription, isProActive } from "@/lib/useSubscription"
import { countRecipients, EMPTY_COUNTS, type RecipientCounts } from "@/lib/reportRecipients"

export default function OrgReportsPage() {
    const router = useRouter()
    const { ctx, loading: ctxLoading } = useOrgContext()
    const [loading, setLoading] = useState(true)
    const [pro, setPro] = useState(false)
    const [tab, setTab] = useState<"format" | "delivery">("format")

    // 위저드 판정 재료 — 문서 형식(회사 공통)과 수신자 승인 집계.
    // 개수가 아니라 '승인됨' 개수로 판정한다: 크론이 approved만 발송하므로
    // pending을 완료로 세면 화면은 완료, 실발송은 0통이 된다.
    const [docFormat, setDocFormat] = useState<string>("")
    const [counts, setCounts] = useState<RecipientCounts>(EMPTY_COUNTS)
    const [wizStep, setWizStep] = useState<1 | 2>(1)
    // 화면 모드는 진입 시점에 고정 — 위저드 도중 조건이 충족돼도(수신자 추가 순간)
    // '설정 완료'를 누르기 전에 화면이 멋대로 탭으로 바뀌면 안 된다
    const [mode, setMode] = useState<"wizard" | "tabs">("tabs")

    useEffect(() => {
        if (ctxLoading) return
        if (!ctx || ctx.kind === "member") { router.replace("/"); return }
        ;(async () => {
            try {
                const [{ data: u }, sub, { data: sess }] = await Promise.all([
                    supabase.auth.getUser(), // 회사 형식은 admin API로도 바뀌므로 서버 기준으로 읽는다
                    fetchSubscription(),
                    supabase.auth.getSession(),
                ])
                setPro(isProActive(sub))
                const fmt = String(u?.user?.user_metadata?.preferred_export_format ?? "")
                setDocFormat(fmt)
                setWizStep(fmt ? 2 : 1)
                const recipientsRes = await fetch("/api/reports/recipients", { headers: { Authorization: `Bearer ${sess?.session?.access_token}` } })
                    .then((r) => (r.ok ? r.json() : { recipients: [] }))
                    .catch(() => ({ recipients: [] }))
                const c = countRecipients(recipientsRes.recipients)
                setCounts(c)
                // 완료 기준: 형식 설정 + (Pro면) 승인된 수신자 1명 이상 — 비Pro는 수신자를 등록할 수 없으니 형식만
                setMode(fmt && (!isProActive(sub) || c.approved > 0) ? "tabs" : "wizard")
            } finally {
                setLoading(false)
            }
        })()
    }, [ctx, ctxLoading, router])

    const setupDone = !!docFormat && (!pro || counts.approved > 0)

    const stepChip = (n: 1 | 2, label: string) => {
        const active = wizStep === n
        const done = n === 1 ? !!docFormat : setupDone
        return (
            <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[12px] font-semibold ${active ? "bg-cur-primary text-cur-on-primary" : done ? "bg-cur-primary/15 text-cur-primary" : "bg-cur-elevated text-cur-muted"}`}>
                <span className={`w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] ${active ? "bg-white/25" : done ? "bg-cur-primary/20" : "bg-cur-hairline"}`}>{n}</span>
                {label}
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-cur-canvas font-sans">
            <div className="max-w-lg mx-auto px-4 pt-4">
                <TBMHeader title="출력/발송 설정" backHref="/" />
            </div>
            <main className="max-w-lg mx-auto px-5 py-6 space-y-4 pb-16">
                {loading || ctxLoading ? (
                    <div className="py-24 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-cur-muted" /></div>
                ) : mode === "wizard" ? (
                    /* ── 설정 위저드 — 다 보여주지 않고 한 걸음씩. 완료하면 바로 탭 화면으로 ── */
                    <>
                        <div className="flex items-center gap-1.5">
                            {stepChip(1, "문서 형식")}
                            <span className="text-cur-muted-soft text-[12px]">›</span>
                            {stepChip(2, "받는 사람")}
                        </div>

                        {wizStep === 1 ? (
                            <>
                                <p className="text-[13px] text-cur-muted leading-relaxed px-1">
                                    회의록·교육일지를 어떤 형식으로 저장할지 정해주세요. 모든 현장 계정에 함께 적용돼요.
                                </p>
                                <CompanyDocFormatCard onSaved={(f) => setDocFormat(f)} />
                                <button
                                    disabled={!docFormat}
                                    onClick={() => setWizStep(2)}
                                    className="w-full h-11 rounded-[8px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[14px] font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    다음 — 받는 사람 설정
                                </button>
                            </>
                        ) : (
                            <>
                                <ReportSettingsPanel pro={pro} onRecipientsChange={setCounts} />
                                <ReportScheduleCard pro={pro} />
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => setWizStep(1)}
                                        className="flex-1 h-11 rounded-[8px] border border-cur-hairline bg-cur-card text-[13px] font-semibold text-cur-muted hover:text-cur-ink transition-colors"
                                    >
                                        이전
                                    </button>
                                    <button
                                        disabled={pro && counts.approved === 0}
                                        onClick={() => setMode("tabs")}
                                        className="flex-[2] h-11 rounded-[8px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[14px] font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        설정 완료
                                    </button>
                                </div>
                                {pro && counts.approved === 0 && (
                                    <>
                                        <p className="text-[12px] text-cur-muted text-center leading-relaxed">
                                            {counts.pending > 0
                                                ? `승인 대기 ${counts.pending}명 — 받는 사람이 확인 메일의 승인 링크를 눌러야 완료돼요.`
                                                : "받는 사람을 1명 이상 등록하고 승인까지 받아야 완료돼요."}
                                        </p>
                                        <button
                                            onClick={() => setMode("tabs")}
                                            className="w-full h-9 text-[13px] font-medium text-cur-muted hover:text-cur-ink transition-colors"
                                        >
                                            나중에 할게요 (AI 분석 보고서는 설정 완료 후 열려요)
                                        </button>
                                    </>
                                )}
                            </>
                        )}
                    </>
                ) : (
                    /* ── 2탭 — 문서 형식(형식+미리보기) / 발송 설정(받는 사람+주기) ── */
                    <>
                        <div className="flex gap-1 p-1 bg-cur-elevated rounded-lg">
                            {([["format", "문서 형식"], ["delivery", "발송 설정"]] as const).map(([key, label]) => (
                                <button
                                    key={key}
                                    onClick={() => setTab(key)}
                                    className={`flex-1 h-9 rounded-md text-[13px] font-semibold transition-colors ${tab === key ? "bg-cur-card text-cur-ink shadow-sm" : "text-cur-muted hover:text-cur-ink"}`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        {/* 두 탭 모두 항상 마운트(hidden 토글) — 오가도 입력 중이던 값·목록이 유지되고 재조회도 없다 */}
                        <div className={tab === "format" ? "space-y-4" : "hidden"}>
                            <CompanyDocFormatCard onSaved={(f) => setDocFormat(f)} />
                            <ReportPreviewCard />
                        </div>
                        <div className={tab === "delivery" ? "space-y-4" : "hidden"}>
                            <ReportSettingsPanel pro={pro} onRecipientsChange={setCounts} />
                            <ReportScheduleCard pro={pro} />
                        </div>
                    </>
                )}
            </main>
        </div>
    )
}
