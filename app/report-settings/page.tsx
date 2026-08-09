// app/report-settings/page.tsx
"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { useRequireSubscription, fetchSubscription, isProActive } from "@/lib/useSubscription"
import { TBMHeader } from "@/components/TBMHeader"
import { ReportSettingsPanel } from "@/components/ReportSettingsPanel"
import { Loader2 } from "lucide-react"
import { fetchOrgContext } from "@/lib/useOrgContext"

export default function ReportSettingsPage() {
    const router = useRouter()
    useRequireSubscription()
    const [checking, setChecking] = useState(true)
    const [pro, setPro] = useState(false)

    useEffect(() => {
        ;(async () => {
            const { data: { user } } = await supabase.auth.getUser()
            if (!user) { router.replace("/login"); return }
            // 조직 하위(member)는 보고서 설정 없음 — 회사(안전관리자)가 관리 (§4-C, URL 직접 접근 차단)
            const ctx = await fetchOrgContext()
            if (ctx?.kind === "member") { router.replace("/"); return }
            setPro(isProActive(await fetchSubscription()))
            setChecking(false)
        })()
    }, [router])

    if (checking) return <div className="min-h-screen flex items-center justify-center bg-cur-canvas"><Loader2 className="w-10 h-10 text-cur-primary animate-spin" /></div>

    return (
        <div className="min-h-screen bg-cur-canvas flex flex-col font-sans text-cur-body">
            <div className="w-full max-w-md mx-auto px-4 pt-4">
                {/* PRO 칩은 옛 이원제 잔재 — 단일 요금제에서 구독자에게 무의미해 삭제(앱과 동일 결정). 비구독 '예시'만 남긴다 */}
                <TBMHeader title="출력/발송 설정" backHref="/" pageBadge={pro ? undefined : "예시"} />
            </div>
            <div className="flex-1 w-full max-w-md mx-auto px-4 py-6 pb-16">
                <ReportSettingsPanel pro={pro} />
            </div>
        </div>
    )
}
