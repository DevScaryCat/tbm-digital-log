// app/analytics/education/page.tsx
"use client"

import { TBMHeader } from "@/components/TBMHeader"
import { useRequireSubscription } from "@/lib/useSubscription"
import { HardHat, Hammer } from "lucide-react"

export default function EducationAnalyticsPage() {
    useRequireSubscription()

    return (
        <div className="bg-cur-canvas min-h-screen sm:py-8 flex sm:block items-center justify-center font-sans text-cur-body pb-20">
            <div className="max-w-lg w-full mx-auto bg-cur-card sm:rounded-[12px] relative flex flex-col min-h-[100dvh] sm:min-h-[85vh] border-x sm:border border-cur-hairline mb-[env(safe-area-inset-bottom)] overflow-hidden">

                <div className="p-4 bg-cur-card border-b border-cur-hairline sticky top-0 z-50">
                    <TBMHeader title="안전교육일지 종합분석" backHref="/" />
                </div>

                <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-4">
                    <div className="w-16 h-16 rounded-[16px] bg-cur-elevated flex items-center justify-center text-cur-muted">
                        <Hammer className="w-8 h-8" />
                    </div>
                    <div className="space-y-1.5">
                        <h2 className="text-[20px] font-bold text-cur-ink flex items-center justify-center gap-2">
                            <HardHat className="w-5 h-5 text-cur-primary" /> 준비 중이에요
                        </h2>
                        <p className="text-[14px] text-cur-muted leading-relaxed">
                            안전교육일지 종합분석은 현재 작업 중입니다.<br />곧 만나보실 수 있어요.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    )
}
