// app/analytics/page.tsx
"use client"

import { useState, useRef } from "react"
import { useRouter } from "next/navigation"
import { TBMHeader } from "@/components/TBMHeader"
import { useRequireSubscription } from "@/lib/useSubscription"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AlertCircle, Camera, CheckCircle2, AlertTriangle, TrendingUp, Hash, Activity } from "lucide-react"

export default function AnalyticsDashboardPage() {
    const router = useRouter()
    useRequireSubscription()
    
    const keywords = [
        { word: "추락방지", count: 24, trend: "up" },
        { word: "안전대", count: 18, trend: "same" },
        { word: "개구부", count: 15, trend: "up" },
        { word: "크레인", count: 12, trend: "down" },
        { word: "협착", count: 9, trend: "same" },
        { word: "안전모", count: 8, trend: "down" },
    ]

    const [risks, setRisks] = useState([
        {
            id: 1,
            level: "상",
            category: "추락",
            subCategory: "개구부 덮개 미설치",
            workName: "A동 2층 슬라브 철근 배근",
            date: "2026-05-04",
            status: "pending"
        },
        {
            id: 2,
            level: "중",
            category: "낙하",
            subCategory: "상부 자재 낙하 위험",
            workName: "B동 외부 비계 설치",
            date: "2026-05-03",
            status: "completed"
        },
        {
            id: 3,
            level: "상",
            category: "감전",
            subCategory: "가설 분전반 접지 불량",
            workName: "C동 지하 전기 배관",
            date: "2026-05-02",
            status: "pending"
        }
    ])

    const fileInputRef = useRef<HTMLInputElement>(null)
    const [uploadTargetId, setUploadTargetId] = useState<number | null>(null)

    const handleUploadClick = (id: number) => {
        setUploadTargetId(id)
        fileInputRef.current?.click()
    }

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (file && uploadTargetId) {
            alert("사진이 성공적으로 등록되었으며, 개선 조치가 완료 처리되었습니다.")
            setRisks(prev => prev.map(r => r.id === uploadTargetId ? { ...r, status: 'completed' } : r))
            setUploadTargetId(null)
        }
    }

    const getLevelStyle = (level: string) => {
        switch(level) {
            case '상': return "bg-cur-error/15 text-cur-error border-cur-error/30"
            case '중': return "bg-cur-primary/15 text-cur-primary border-cur-primary/30"
            case '하': return "bg-cur-success/15 text-cur-success border-cur-success/30"
            default: return "bg-cur-elevated text-cur-muted"
        }
    }

    return (
        <div className="bg-cur-canvas min-h-screen sm:py-8 flex sm:block items-center justify-center font-sans text-cur-body pb-20">
            <div className="max-w-lg w-full mx-auto bg-cur-card sm:rounded-[12px] relative flex flex-col min-h-[100dvh] sm:min-h-[85vh] border-x sm:border border-cur-hairline mb-[env(safe-area-inset-bottom)] overflow-hidden">
                
                <div className="p-4 bg-cur-card border-b border-cur-hairline sticky top-0 z-50">
                    <TBMHeader title="종합 데이터 분석" />
                </div>

                <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
                    
                    <div className="grid grid-cols-3 gap-3">
                        <div className="bg-cur-card p-4 rounded-[8px] border border-cur-hairline text-center">
                            <div className="text-[12px] text-cur-muted font-medium mb-1">총 분석 일지</div>
                            <div className="text-[24px] font-bold text-cur-ink font-mono">42<span className="text-[14px] font-medium text-cur-muted ml-1">건</span></div>
                        </div>
                        <div className="bg-cur-error/10 p-4 rounded-[8px] border border-cur-error/20 text-center">
                            <div className="text-[12px] text-cur-error font-medium mb-1">위험성 (상)</div>
                            <div className="text-[24px] font-bold text-cur-error font-mono">5<span className="text-[14px] font-medium text-cur-error/70 ml-1">건</span></div>
                        </div>
                        <div className="bg-cur-primary/10 p-4 rounded-[8px] border border-cur-primary/20 text-center">
                            <div className="text-[12px] text-cur-primary font-medium mb-1">개선 필요</div>
                            <div className="text-[24px] font-bold text-cur-primary font-mono">2<span className="text-[14px] font-medium text-cur-primary/70 ml-1">건</span></div>
                        </div>
                    </div>

                    <div className="space-y-4 relative pt-5 mt-2">
                        <div className="absolute top-0 left-0">
                            <span className="bg-cur-primary/15 text-cur-primary text-[11px] font-bold px-2.5 py-0.5 rounded-[4px] border border-cur-primary/30 flex items-center gap-1">
                                🚧 기능 개발 중입니다 (테스트 화면)
                            </span>
                        </div>
                        <h2 className="text-[18px] font-bold text-cur-ink flex items-center gap-2">
                            <Hash className="w-5 h-5 text-cur-primary" /> 핵심 위험 키워드 분석
                        </h2>
                        <div className="bg-cur-card p-5 rounded-[12px] border border-cur-hairline">
                            <div className="flex flex-wrap gap-2">
                                {keywords.map((kw, idx) => (
                                    <div key={idx} className="flex items-center gap-1.5 bg-cur-elevated px-3 py-1.5 rounded-full border border-cur-hairline">
                                        <span className="text-[14px] font-semibold text-cur-ink">#{kw.word}</span>
                                        <span className="text-[12px] text-cur-muted font-medium">({kw.count})</span>
                                        {kw.trend === 'up' && <TrendingUp className="w-3.5 h-3.5 text-cur-error ml-0.5" />}
                                    </div>
                                ))}
                            </div>
                            <p className="text-[13px] text-cur-muted mt-4 leading-relaxed">
                                최근 7일간 <span className="font-semibold text-cur-error">추락방지</span> 및 <span className="font-semibold text-cur-error">개구부</span> 관련 키워드 언급 빈도가 상승하고 있습니다. 해당 작업 전 집중 안전점검이 필요합니다.
                            </p>
                        </div>
                    </div>

                    <div className="space-y-4">
                        <h2 className="text-[18px] font-bold text-cur-ink flex items-center gap-2">
                            <Activity className="w-5 h-5 text-cur-primary" /> 위험성 평가 및 개선 조치
                        </h2>
                        
                        <div className="space-y-3">
                            {risks.map(risk => (
                                <div key={risk.id} className="bg-cur-card p-4 rounded-[12px] border border-cur-hairline">
                                    <div className="flex justify-between items-start mb-3">
                                        <div className="flex items-center gap-2">
                                            <Badge variant="outline" className={getLevelStyle(risk.level)}>위험 {risk.level}</Badge>
                                            <span className="text-[13px] font-semibold text-cur-muted">{risk.category}</span>
                                        </div>
                                        <div className="text-[12px] text-cur-muted">{risk.date}</div>
                                    </div>
                                    
                                    <div className="mb-4">
                                        <h3 className="text-[16px] font-bold text-cur-ink mb-1">{risk.subCategory}</h3>
                                        <p className="text-[14px] text-cur-muted-soft">{risk.workName}</p>
                                    </div>

                                    <div className="pt-3 border-t border-cur-hairline flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            {risk.status === 'completed' ? (
                                                <span className="flex items-center text-[13px] font-semibold text-cur-success bg-cur-success/10 px-2 py-1 rounded-[4px]">
                                                    <CheckCircle2 className="w-4 h-4 mr-1" /> 조치 완료
                                                </span>
                                            ) : (
                                                <span className="flex items-center text-[13px] font-semibold text-cur-error bg-cur-error/10 px-2 py-1 rounded-[4px]">
                                                    <AlertTriangle className="w-4 h-4 mr-1" /> 개선 필요
                                                </span>
                                            )}
                                        </div>
                                        
                                        {risk.status === 'pending' && (
                                            <Button 
                                                size="sm" 
                                                onClick={() => handleUploadClick(risk.id)}
                                                className="h-8 bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[12px] font-semibold rounded-[6px]"
                                            >
                                                <Camera className="w-3.5 h-3.5 mr-1.5" /> 개선 사진 등록
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                </div>
            </div>
            
            <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                className="hidden" 
                accept="image/*" 
            />
        </div>
    )
}
