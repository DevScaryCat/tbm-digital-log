"use client"

import { useEffect, useState, Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ArrowLeft, FileText, HardHat, Calendar, Clock, Loader2, Users } from "lucide-react"
import { format, parseISO } from "date-fns"
import { cn } from "@/lib/utils"

function TBMHistoryContent() {
    const router = useRouter()
    const searchParams = useSearchParams()
    const initialTab = searchParams.get('tab') === 'minutes' ? 'minutes' : 'logs'
    
    const [activeTab, setActiveTab] = useState<'logs' | 'minutes'>(initialTab)
    const [logs, setLogs] = useState<any[]>([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        const fetchLogs = async () => {
            setLoading(true)
            const { data: { session } } = await supabase.auth.getSession()
            if (!session) return router.push('/')

            if (activeTab === 'logs') {
                const { data } = await supabase
                    .from('tbm_logs')
                    .select('id, education_type, date, location, company_name, start_time, created_at')
                    .eq('user_id', session.user.id)
                    .order('created_at', { ascending: false })
                setLogs(data || [])
            } else {
                const { data } = await supabase
                    .from('tbm_minutes')
                    .select('id, process_name, work_name, date, location, start_time, created_at')
                    .eq('user_id', session.user.id)
                    .order('created_at', { ascending: false })
                setLogs(data || [])
            }
            setLoading(false)
        }
        fetchLogs()
    }, [router, activeTab])

    const handleBack = () => {
        router.push('/')
    }

    return (
        <div className="min-h-screen bg-slate-50 pb-20">
            <div className="max-w-lg mx-auto min-h-screen bg-white shadow-lg flex flex-col">
                {/* 헤더 */}
                <div className="p-4 flex flex-col gap-4 border-b bg-white sticky top-0 z-10 shadow-sm">
                    <div className="flex items-center">
                        <Button variant="ghost" size="icon" onClick={handleBack} className="mr-2">
                            <ArrowLeft className="w-6 h-6" />
                        </Button>
                        <div className="flex items-center gap-2">
                            <HardHat className="w-5 h-5 text-blue-600" />
                            <h1 className="text-xl font-bold text-slate-800">내 작성 내역</h1>
                        </div>
                    </div>
                    
                    {/* 탭 전환 박스 */}
                    <div className="flex bg-slate-100 p-1 rounded-xl">
                        <button 
                            onClick={() => setActiveTab('logs')}
                            className={cn(
                                "flex-1 py-2 text-sm font-bold flex items-center justify-center gap-2 rounded-lg transition-all",
                                activeTab === 'logs' ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                            )}
                        >
                            <HardHat className="w-4 h-4" /> TBM 일지
                        </button>
                        <button 
                            onClick={() => setActiveTab('minutes')}
                            className={cn(
                                "flex-1 py-2 text-sm font-bold flex items-center justify-center gap-2 rounded-lg transition-all",
                                activeTab === 'minutes' ? "bg-white text-purple-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                            )}
                        >
                            <Users className="w-4 h-4" /> TBM 회의록
                        </button>
                    </div>
                </div>

                {/* 목록 */}
                <div className="p-4 space-y-4 flex-1 bg-slate-50 relative">
                    {loading ? (
                        <div className="absolute inset-0 flex items-center justify-center bg-slate-50/50 backdrop-blur-sm z-10">
                            <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
                        </div>
                    ) : logs.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                            <FileText className="w-16 h-16 mb-4 opacity-50" />
                            <p>아직 작성한 {activeTab === 'logs' ? '일지' : '회의록'}가 없습니다.</p>
                        </div>
                    ) : (
                        logs.map((log) => (
                            <Card
                                key={log.id}
                                onClick={() => router.push(activeTab === 'logs' ? `/report/${log.id}` : `/report/minutes/${log.id}`)}
                                className="cursor-pointer hover:shadow-md transition-shadow active:scale-[0.98] border border-slate-200 shadow-sm overflow-hidden"
                            >
                                <CardContent className="p-0">
                                    <div className={cn("h-1 w-full", activeTab === 'logs' ? "bg-blue-500" : "bg-purple-500")} />
                                    <div className="p-4">
                                        <div className="flex justify-between items-start mb-3">
                                            <span className={cn(
                                                "px-2 py-1 rounded text-xs font-bold",
                                                activeTab === 'logs' ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                                            )}>
                                                {activeTab === 'logs' ? (log.education_type || 'TBM') : (log.process_name || 'TBM 회의')}
                                            </span>
                                            <span className="text-sm text-slate-500 flex items-center gap-1">
                                                <Calendar className="w-4 h-4" /> {log.date ? format(parseISO(log.date), 'yyyy.MM.dd') : ''}
                                            </span>
                                        </div>
                                        <h3 className="font-bold text-lg text-slate-800 line-clamp-1 mb-1">{activeTab === 'logs' ? log.location : log.work_name}</h3>
                                        <div className="text-sm text-slate-500 flex items-center gap-4">
                                            <span className="flex items-center gap-1">
                                                {activeTab === 'logs' ? <HardHat className="w-4 h-4" /> : <HardHat className="w-4 h-4" />} 
                                                {activeTab === 'logs' ? log.company_name : log.location}
                                            </span>
                                            <span className="flex items-center gap-1"><Clock className="w-4 h-4" /> {log.start_time?.slice(0, 5)}</span>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        ))
                    )}
                </div>
            </div>
        </div>
    )
}

export default function TBMHistoryPage() {
    return (
        <Suspense fallback={<div className="min-h-screen flex justify-center items-center bg-slate-50"><Loader2 className="w-10 h-10 animate-spin text-slate-500" /></div>}>
            <TBMHistoryContent />
        </Suspense>
    )
}