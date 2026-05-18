"use client"

import { Button } from "@/components/ui/button"
import { CheckCircle2, ArrowLeft } from "lucide-react"
import { useRouter } from "next/navigation"

export default function PricingPage() {
    const router = useRouter()

    const features = [
        "스마트 TBM 일지 자동 생성",
        "TBM 회의록 자동 요약",
        "무제한 프로젝트 및 인원 등록",
        "클라우드 보안 저장 (1년 보관)",
        "참석자 전자 서명 기능",
    ]

    return (
        <div className="min-h-screen bg-cur-canvas flex flex-col font-sans text-cur-body">
            <div className="sticky top-0 z-10 bg-cur-canvas border-b border-cur-hairline p-4 flex items-center gap-3">
                <Button variant="ghost" size="icon" onClick={() => router.back()}>
                    <ArrowLeft className="w-5 h-5" />
                </Button>
                <h1 className="text-lg font-bold text-cur-ink">요금안내</h1>
            </div>

            <div className="flex-1 max-w-4xl mx-auto w-full py-12 px-6">
                <div className="text-center mb-12">
                    <h2 className="text-[28px] font-bold text-cur-ink mb-4">현장의 안전을 위한 완벽한 선택</h2>
                    <p className="text-cur-muted text-[16px]">안전톡톡과 함께 더 편리하고 안전한 현장을 만들어보세요.</p>
                </div>

                <div className="grid md:grid-cols-2 gap-6">
                    {/* Monthly Plan */}
                    <div className="bg-cur-card rounded-2xl p-8 border border-cur-hairline shadow-sm hover:shadow-md transition-shadow relative overflow-hidden flex flex-col">
                        <div className="mb-6">
                            <h3 className="text-[20px] font-bold text-cur-ink mb-2">월간 구독</h3>
                            <p className="text-cur-muted text-[14px]">매달 부담 없이 결제하는 베이직 플랜</p>
                        </div>
                        
                        <div className="mb-6">
                            <div className="flex items-end gap-2 mb-1">
                                <span className="text-[36px] font-bold text-cur-ink tracking-tight">1,900원</span>
                                <span className="text-[16px] text-cur-muted mb-2">/ 월</span>
                            </div>
                            <div className="inline-block bg-cur-primary/10 text-cur-primary text-[12px] font-bold px-3 py-1 rounded-full">
                                첫 달 무료 체험
                            </div>
                        </div>

                        <div className="space-y-4 mb-8 flex-1">
                            {features.map((feature, idx) => (
                                <div key={idx} className="flex items-start gap-3">
                                    <CheckCircle2 className="w-5 h-5 text-cur-primary shrink-0" />
                                    <span className="text-[15px] text-cur-ink">{feature}</span>
                                </div>
                            ))}
                        </div>

                        <Button className="w-full bg-cur-elevated hover:bg-cur-hairline text-cur-ink font-bold h-12 rounded-xl border border-cur-hairline transition-colors">
                            월간 구독 시작하기
                        </Button>
                    </div>

                    {/* Yearly Plan */}
                    <div className="bg-cur-card rounded-2xl p-8 border-2 border-cur-primary shadow-lg relative overflow-hidden flex flex-col">
                        <div className="absolute top-4 right-4 bg-cur-primary text-cur-on-primary text-[12px] font-bold px-3 py-1 rounded-full shadow-sm">
                            Best Value
                        </div>
                        <div className="mb-6">
                            <h3 className="text-[20px] font-bold text-cur-ink mb-2">연간 구독</h3>
                            <p className="text-cur-muted text-[14px]">26% 할인된 가격으로 1년 내내 든든하게</p>
                        </div>
                        
                        <div className="mb-6">
                            <div className="flex items-end gap-2 mb-1">
                                <span className="text-[36px] font-bold text-cur-primary tracking-tight">16,800원</span>
                                <span className="text-[16px] text-cur-muted mb-2">/ 년</span>
                            </div>
                            <div className="text-[13px] text-cur-muted font-medium">
                                (월 1,400원 상당)
                            </div>
                        </div>

                        <div className="space-y-4 mb-8 flex-1">
                            {features.map((feature, idx) => (
                                <div key={idx} className="flex items-start gap-3">
                                    <CheckCircle2 className="w-5 h-5 text-cur-primary shrink-0" />
                                    <span className="text-[15px] text-cur-ink">{feature}</span>
                                </div>
                            ))}
                        </div>

                        <Button className="w-full bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary font-bold h-12 rounded-xl shadow-md transition-all">
                            연간 구독 시작하기
                        </Button>
                    </div>
                </div>

                <div className="mt-12 text-center text-[13px] text-cur-muted-soft bg-cur-card p-6 rounded-xl border border-cur-hairline">
                    <p className="mb-2 font-medium">환불 규정 안내</p>
                    <p>결제일로부터 7일 이내, 서비스 이용 이력(AI 생성 등)이 없는 경우에 한해 100% 환불 가능합니다.</p>
                    <p>디지털 서비스 특성상 1회라도 이용하신 경우 해당 월/연도 결제건에 대한 환불은 제한됩니다.</p>
                </div>
            </div>
        </div>
    )
}
