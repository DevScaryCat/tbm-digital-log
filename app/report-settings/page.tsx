// app/report-settings/page.tsx
"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { useRequireSubscription, fetchSubscription, isProActive } from "@/lib/useSubscription"
import { TBMHeader } from "@/components/TBMHeader"
import { ReportSettingsPanel } from "@/components/ReportSettingsPanel"
import { Loader2 } from "lucide-react"

export default function ReportSettingsPage() {
    const router = useRouter()
    useRequireSubscription()
    const [checking, setChecking] = useState(true)
    const [pro, setPro] = useState(false)

    useEffect(() => {
        ;(async () => {
            const { data: { user } } = await supabase.auth.getUser()
            if (!user) { router.replace("/login"); return }
            setPro(isProActive(await fetchSubscription()))
            setChecking(false)
        })()
    }, [router])

    if (checking) return <div className="min-h-screen flex items-center justify-center bg-cur-canvas"><Loader2 className="w-10 h-10 text-cur-primary animate-spin" /></div>

    return (
        <div className="min-h-screen bg-cur-canvas flex flex-col font-sans text-cur-body">
            <div className="w-full max-w-md mx-auto px-4 pt-4">
                <TBMHeader title="보고서 주기 설정" backHref="/" pageBadge={pro ? "PRO" : "예시"} />
            </div>
            <div className="flex-1 w-full max-w-md mx-auto px-4 py-6 pb-16">
                <ReportSettingsPanel pro={pro} />
            </div>
        </div>
    )
}
