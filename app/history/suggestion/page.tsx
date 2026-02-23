"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Mic, AlertTriangle, Lightbulb, Wrench, Loader2, ChevronDown, ChevronUp } from "lucide-react"
import { cn } from "@/lib/utils"

export default function SuggestionHistoryPage() {
    const router = useRouter()
    const [suggestions, setSuggestions] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [expandedId, setExpandedId] = useState<string | null>(null) // 펼쳐진 카드 ID

    useEffect(() => {
        const fetchSuggestions = async () => {
            const { data: { session } } = await supabase.auth.getSession()
            if (!session) return router.push('/')

            const { data } = await supabase
                .from('suggestions')
                .select('*')
                .eq('user_id', session.user.id)
                .order('created_at', { ascending: false })

            if (data) setSuggestions(data)
            setLoading(false)
        }
        fetchSuggestions()
    }, [router])

    // 카테고리별 디자인 세팅 함수
    const getCategoryConfig = (category: string) => {
        switch (category) {
            case "SAFETY": return { color: "text-red-600 bg-red-100", border: "border-red-500", icon: <AlertTriangle className="w-4 h-4" />, label: "안전" }
            case "INNOVATION": return { color: "text-purple-600 bg-purple-100", border: "border-purple-500", icon: <Lightbulb className="w-4 h-4" />, label: "혁신" }
            default: return { color: "text-blue-600 bg-blue-100", border: "border-blue-500", icon: <Wrench className="w-4 h-4" />, label: "민원" }
        }
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
                        <Mic className="w-5 h-5 text-emerald-600" />
                        <h1 className="text-xl font-bold text-slate-800">현장 제안 처리 현황</h1>
                    </div>
                </div>

                {/* 목록 */}
                <div className="p-4 space-y-4 flex-1 bg-slate-50">
                    {suggestions.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                            <Mic className="w-16 h-16 mb-4 opacity-50" />
                            <p>접수한 현장 제안이 없습니다.</p>
                        </div>
                    ) : (
                        suggestions.map((item) => {
                            const config = getCategoryConfig(item.category)
                            const isExpanded = expandedId === item.id

                            return (
                                <Card
                                    key={item.id}
                                    className={cn("border-l-4 shadow-sm transition-all duration-300", config.border)}
                                >
                                    <CardContent className="p-0">
                                        {/* 카드 헤더 (항상 보임) */}
                                        <div
                                            className="p-4 flex items-center justify-between cursor-pointer hover:bg-slate-50"
                                            onClick={() => setExpandedId(isExpanded ? null : item.id)}
                                        >
                                            <div className="flex-1 pr-4">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <span className={cn("px-2 py-0.5 rounded text-xs font-bold flex items-center gap-1", config.color)}>
                                                        {config.icon} {config.label}
                                                    </span>
                                                    <span className="text-xs font-bold text-slate-500 bg-slate-200 px-2 py-0.5 rounded">
                                                        {item.status}
                                                    </span>
                                                </div>
                                                <h3 className="font-bold text-slate-800 leading-tight">{item.title}</h3>
                                                <p className="text-xs text-slate-400 mt-1">
                                                    {new Date(item.created_at).toLocaleDateString('ko-KR')} | 담당: {item.department}
                                                </p>
                                            </div>
                                            <div className="text-slate-400">
                                                {isExpanded ? <ChevronUp /> : <ChevronDown />}
                                            </div>
                                        </div>

                                        {/* 카드 디테일 (클릭 시 펼쳐짐) */}
                                        {isExpanded && (
                                            <div className="px-4 pb-4 pt-2 border-t border-slate-100 bg-slate-50/50 text-sm animate-in fade-in slide-in-from-top-2">
                                                <div className="mb-3">
                                                    <span className="font-bold text-slate-700 block mb-1">AI 요약 내용:</span>
                                                    <p className="text-slate-600 leading-relaxed bg-white p-3 rounded border border-slate-200">{item.summary}</p>
                                                </div>
                                                <div>
                                                    <span className="font-bold text-slate-500 block mb-1 text-xs">내가 말한 원본 음성:</span>
                                                    <p className="text-slate-400 italic text-xs leading-relaxed">"{item.original_transcript}"</p>
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