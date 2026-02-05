"use client"

import { useState, useEffect } from "react"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { ReportView } from "@/components/ReportView"
import { Printer, ArrowLeft, Loader2 } from "lucide-react"

export default function BatchReportPage() {
    const [logs, setLogs] = useState<any[]>([])
    const [participantsMap, setParticipantsMap] = useState<Record<string, any[]>>({})
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        const loadBatch = async () => {
            const idsString = localStorage.getItem("batch_print_ids")
            if (!idsString) return setLoading(false)

            const ids = JSON.parse(idsString)

            // 1. 로그 데이터 가져오기 (in 필터 사용)
            const { data: logsData } = await supabase.from('tbm_logs').select('*').in('id', ids).order('date', { ascending: true })

            if (logsData) {
                setLogs(logsData)

                // 2. 각 로그별 참석자 가져오기
                const pMap: Record<string, any[]> = {}
                for (const log of logsData) {
                    const { data: pData } = await supabase.from('tbm_participants').select('*').eq('log_id', log.id)
                    pMap[log.id] = pData || []
                }
                setParticipantsMap(pMap)
            }
            setLoading(false)
        }
        loadBatch()
    }, [])

    if (loading) return <div className="min-h-screen flex justify-center items-center"><Loader2 className="animate-spin w-10 h-10" /></div>

    return (
        <div className="min-h-screen bg-gray-100 p-8 print:p-0 print:bg-white">
            <div className="max-w-[210mm] mx-auto mb-6 flex justify-between print:hidden">
                <Button variant="outline" onClick={() => window.history.back()}><ArrowLeft className="mr-2" /> 돌아가기</Button>
                <Button onClick={() => window.print()} className="bg-blue-900 text-white"><Printer className="mr-2" /> 전체 인쇄 / PDF 저장</Button>
            </div>

            {logs.map((log) => (
                <ReportView key={log.id} log={log} participants={participantsMap[log.id] || []} />
            ))}
        </div>
    )
}