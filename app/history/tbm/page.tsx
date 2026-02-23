"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ArrowLeft, FileText, HardHat, Calendar, Clock, Loader2 } from "lucide-react"
import { format, parseISO } from "date-fns"

export default function TBMHistoryPage() {
    const router = useRouter()
    const [logs, setLogs] = useState<any[]>([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        const fetchLogs = async () => {
            const { data: { session } } = await supabase.auth.getSession()
            if (!session) return router.push('/')

            const { data } = await supabase
                .from('tbm_logs')
                .select('*')
                .eq('user_id', session.user.id)
                .order('created_at', { ascending: false })

            if (data) setLogs(data)
            setLoading(false)
        }
        fetchLogs()
    }, [router])

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
                        <HardHat className="w-5 h-5 text-blue-600" />
                        <h1 className="text-xl font-bold text-slate-800">내 TBM 완료 내역</h1>
                    </div>
                </div>

                {/* 목록 */}
                <div className="p-4 space-y-4 flex-1 bg-slate-50">
                    {logs.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                            <FileText className="w-16 h-16 mb-4 opacity-50" />
                            <p>아직 작성한 TBM 일지가 없습니다.</p>
                        </div>
                    ) : (
                        logs.map((log) => (
                            <Card
                                key={log.id}
                                onClick={() => router.push(`/report/${log.id}`)}
                                className="cursor-pointer hover:shadow-md transition-shadow active:scale-[0.98] border-0 shadow-sm"
                            >
                                <CardContent className="p-4">
                                    <div className="flex justify-between items-start mb-3">
                                        <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded text-xs font-bold">
                                            {log.education_type}
                                        </span>
                                        <span className="text-sm text-slate-500 flex items-center gap-1">
                                            <Calendar className="w-4 h-4" /> {log.date ? format(parseISO(log.date), 'yyyy.MM.dd') : ''}
                                        </span>
                                    </div>
                                    <h3 className="font-bold text-lg text-slate-800 line-clamp-1 mb-1">{log.location}</h3>
                                    <div className="text-sm text-slate-500 flex items-center gap-4">
                                        <span className="flex items-center gap-1"><HardHat className="w-4 h-4" /> {log.company_name}</span>
                                        <span className="flex items-center gap-1"><Clock className="w-4 h-4" /> {log.start_time?.slice(0, 5)}</span>
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