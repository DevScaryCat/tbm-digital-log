"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Zap, Lightbulb, Loader2, ChevronDown, ChevronUp, FileText, CheckCircle2 } from "lucide-react"
import { cn } from "@/lib/utils"

export default function AIConsultingHistoryPage() {
    const router = useRouter()
    const [assets, setAssets] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [expandedId, setExpandedId] = useState<string | null>(null)

    useEffect(() => {
        const fetchAssets = async () => {
            const { data: { session } } = await supabase.auth.getSession()
            if (!session) return router.push('/')

            // ai_assets 테이블에서 내 데이터만 최신순으로 가져오기
            const { data } = await supabase
                .from('ai_assets')
                .select('*')
                .eq('user_id', session.user.id)
                .order('created_at', { ascending: false })

            if (data) setAssets(data)
            setLoading(false)
        }
        fetchAssets()
    }, [router])

    // 특허 가능성 점수에 따른 색상 및 텍스트 반환 함수
    const getScoreConfig = (score: number) => {
        if (score >= 80) return { color: "text-green-600", bg: "bg-green-100", border: "border-green-500", text: "특허 출원 강력 추천" }
        if (score >= 50) return { color: "text-orange-600", bg: "bg-orange-100", border: "border-orange-500", text: "아이디어 보완 필요" }
        return { color: "text-red-600", bg: "bg-red-100", border: "border-red-500", text: "특허 등록 어려움" }
    }

    if (loading) return <div className="min-h-screen flex justify-center items-center bg-slate-50"><Loader2 className="w-10 h-10 animate-spin text-slate-500" /></div>

    return (
        <div className="min-h-screen bg-slate-50 pb-20">
            <div className="max-w-lg mx-auto min-h-screen bg-white shadow-lg flex flex-col">

                {/* 헤더 */}
                <div className="p-4 flex items-center border-b bg-white sticky top-0 z-10">
                    <Button variant="ghost" size="icon" onClick={() => router.push('/')} className="mr-2">
                        <ArrowLeft className="w-6 h-6" />
                    </Button>
                    <div className="flex items-center gap-2">
                        <Zap className="w-5 h-5 text-purple-600" />
                        <h1 className="text-xl font-bold text-slate-800">AI 특허/컨설팅 내역</h1>
                    </div>
                </div>

                {/* 목록 */}
                <div className="p-4 space-y-4 flex-1 bg-slate-50">
                    {assets.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                            <Lightbulb className="w-16 h-16 mb-4 opacity-50 text-purple-400" />
                            <p>평가받은 아이디어가 아직 없습니다.</p>
                        </div>
                    ) : (
                        assets.map((item) => {
                            const score = item.patentability_score || 0
                            const config = getScoreConfig(score)
                            const isExpanded = expandedId === item.id

                            return (
                                <Card
                                    key={item.id}
                                    className={cn("border-l-4 shadow-sm transition-all duration-300", config.border)}
                                >
                                    <CardContent className="p-0">

                                        {/* 카드 헤더 (항상 보임) */}
                                        <div
                                            className="p-4 flex items-start justify-between cursor-pointer hover:bg-slate-50"
                                            onClick={() => setExpandedId(isExpanded ? null : item.id)}
                                        >
                                            <div className="flex-1 pr-4">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <span className={cn("px-2 py-0.5 rounded text-sm font-extrabold flex items-center gap-1", config.bg, config.color)}>
                                                        가능성 {score}%
                                                    </span>
                                                    <span className="text-xs font-bold text-slate-500 bg-slate-200 px-2 py-0.5 rounded">
                                                        {config.text}
                                                    </span>
                                                </div>
                                                <h3 className="font-bold text-slate-800 leading-tight text-lg mb-1">{item.title}</h3>
                                                <p className="text-xs text-slate-400">
                                                    {new Date(item.created_at).toLocaleDateString('ko-KR')} 심사 완료
                                                </p>
                                            </div>
                                            <div className="text-slate-400 mt-2">
                                                {isExpanded ? <ChevronUp /> : <ChevronDown />}
                                            </div>
                                        </div>

                                        {/* 카드 디테일 (명세서 본문 - 클릭 시 펼쳐짐) */}
                                        {isExpanded && (
                                            <div className="px-4 pb-4 pt-2 border-t border-slate-100 bg-purple-50/30 text-sm animate-in fade-in slide-in-from-top-2">

                                                <div className="space-y-4 mt-2">
                                                    {/* 1. 배경 및 문제점 */}
                                                    <div>
                                                        <span className="font-bold text-purple-800 flex items-center gap-1 mb-1">
                                                            <FileText className="w-4 h-4" /> 배경 기술 및 문제점
                                                        </span>
                                                        <p className="text-slate-600 leading-relaxed bg-white p-3 rounded border border-slate-200 whitespace-pre-wrap">
                                                            {item.background}
                                                        </p>
                                                    </div>

                                                    {/* 2. 핵심 해결 방안 */}
                                                    <div>
                                                        <span className="font-bold text-purple-800 flex items-center gap-1 mb-1">
                                                            <CheckCircle2 className="w-4 h-4" /> 핵심 해결 방안
                                                        </span>
                                                        <p className="text-slate-600 leading-relaxed bg-white p-3 rounded border border-slate-200 whitespace-pre-wrap">
                                                            {item.core_idea}
                                                        </p>
                                                    </div>

                                                    {/* 3. 기대 효과 */}
                                                    <div>
                                                        <span className="font-bold text-purple-800 flex items-center gap-1 mb-1">
                                                            <Zap className="w-4 h-4" /> 기대 효과
                                                        </span>
                                                        <p className="text-slate-600 leading-relaxed bg-white p-3 rounded border border-slate-200 whitespace-pre-wrap">
                                                            {item.effect}
                                                        </p>
                                                    </div>

                                                    {/* 4. 변리사 피드백 */}
                                                    <div className="mt-4 border-t border-purple-200 pt-4">
                                                        <span className="font-bold text-slate-800 block mb-2">💡 AI 변리사 종합 피드백</span>
                                                        <div className="bg-slate-800 text-slate-200 p-4 rounded-xl text-sm leading-relaxed whitespace-pre-wrap shadow-inner">
                                                            {item.consulting_feedback}
                                                        </div>
                                                    </div>
                                                </div>

                                            </div>
                                        )}
                                    </CardContent>
                                </Card>
                            )
                        })
                    )}
                </div>
            </div>
        </div>
    )
}