"use client"

// 보고서 설정 (안전관리자 전용) — 항상 2탭: [문서 형식(형식+미리보기)] [발송 설정(받는 사람+주기)] (Chris 그룹핑).
// 위저드 모드는 제거(앱과 동일 결정) — 미설정 상태도 탭 화면에서 그대로 채우면 된다.
// 받은 보고서 탭은 제거 — 이메일 수신이 본선이고, 화면 하나에 역할 하나만.
// AI 분석 보고서는 이 설정을 끝내야 열린다.
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { TBMHeader } from "@/components/TBMHeader"
import { Loader2 } from "lucide-react"
import { useOrgContext } from "@/lib/useOrgContext"
import { ReportSettingsPanel, ReportPreviewCard } from "@/components/ReportSettingsPanel"
import { CompanyDocFormatCard } from "@/components/CompanyDocFormatCard"
import { ReportScheduleCard } from "@/components/ReportScheduleCard"
import { fetchSubscription, isProActive, isExpired } from "@/lib/useSubscription"

export default function OrgReportsPage() {
    const router = useRouter()
    const { ctx, loading: ctxLoading } = useOrgContext()
    const [loading, setLoading] = useState(true)
    const [pro, setPro] = useState(false)
    const [tab, setTab] = useState<"format" | "delivery">("format")

    useEffect(() => {
        if (ctxLoading) return
        if (!ctx || ctx.kind === "member") { router.replace("/"); return }
        ;(async () => {
            try {
                const sub = await fetchSubscription()
                // 만료(행 있음 && 불허)는 '예시' 패널(C)로 새면 안 된다 — 솔로용 /report-settings가
                // useRequireSubscription으로 만료자를 축출하는 것과 동일하게 결제 유도로 보낸다.
                // 스피너를 유지한 채 나간다(setLoading(false)를 태우면 이동 직전 예시 패널이 번쩍인다).
                if (isExpired(sub)) { router.replace("/pricing"); return }
                setPro(isProActive(sub))
                setLoading(false)
            } catch {
                // 조회 실패로 화면을 잠그지 않는다 — 기존 finally와 동일하게 열어준다
                setLoading(false)
            }
        })()
    }, [ctx, ctxLoading, router])

    return (
        <div className="min-h-screen bg-cur-canvas font-sans">
            <div className="max-w-lg mx-auto px-4 pt-4">
                <TBMHeader title="출력/발송 설정" backHref="/" />
            </div>
            <main className="max-w-lg mx-auto px-5 py-6 space-y-4 pb-16">
                {loading || ctxLoading ? (
                    <div className="py-24 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-cur-muted" /></div>
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
                            <CompanyDocFormatCard />
                            <ReportPreviewCard />
                        </div>
                        <div className={tab === "delivery" ? "space-y-4" : "hidden"}>
                            <ReportSettingsPanel pro={pro} />
                            <ReportScheduleCard pro={pro} />
                        </div>
                    </>
                )}
            </main>
        </div>
    )
}
