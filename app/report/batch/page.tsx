"use client"

import { useState, useEffect } from "react"
import { supabase } from "@/lib/supabaseClient"
import { resolveSignedMap, signed } from "@/lib/storageSign"
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

            let ids: string[] = []
            try {
                const parsed = JSON.parse(idsString)
                ids = Array.isArray(parsed) ? parsed : []
            } catch {
                ids = []
            }
            if (ids.length === 0) return setLoading(false)

            // 1. 로그 데이터 가져오기 (in 필터 사용)
            const { data: logsData } = await supabase.from('tbm_logs').select('*').in('id', ids).order('date', { ascending: true })

            if (logsData) {
                // 2. 참석자를 한 번에 조회(N+1 제거) 후 log_id별로 그룹핑
                const logIds = logsData.map((l: any) => l.id)
                const { data: allParts } = await supabase.from('tbm_participants').select('*').in('log_id', logIds)
                const pMap: Record<string, any[]> = {}
                for (const l of logsData) pMap[l.id] = []
                for (const p of (allParts || [])) (pMap[p.log_id] ||= []).push(p)

                // 3. 서명/사진: 저장된 public URL → signed URL (버킷 private 대응) — 전체를 한 번에 발급
                const allUrls: (string | null | undefined)[] = []
                for (const log of logsData) allUrls.push(log.instructor_signature, log.confirmation_signature, log.photo_url)
                for (const arr of Object.values(pMap)) for (const p of arr) allUrls.push(p.signature)
                const sig = await resolveSignedMap(allUrls)

                setLogs(logsData.map((l: any) => ({
                    ...l,
                    instructor_signature: signed(sig, l.instructor_signature),
                    confirmation_signature: signed(sig, l.confirmation_signature),
                    photo_url: signed(sig, l.photo_url),
                })))
                const signedMap: Record<string, any[]> = {}
                for (const [k, arr] of Object.entries(pMap)) signedMap[k] = arr.map((p: any) => ({ ...p, signature: signed(sig, p.signature) }))
                setParticipantsMap(signedMap)
            }
            setLoading(false)
        }
        loadBatch()
    }, [])

    if (loading) return <div className="min-h-screen flex justify-center items-center"><Loader2 className="animate-spin w-10 h-10" /></div>

    return (
        <div className="min-h-screen bg-gray-100 p-8 print:p-0 print:bg-cur-card">
            <div className="max-w-[210mm] mx-auto mb-6 flex justify-between print:hidden">
                <Button variant="outline" onClick={() => window.history.back()}><ArrowLeft className="mr-2" /> 돌아가기</Button>
                <Button onClick={() => window.print()} className="bg-blue-900 text-cur-on-primary"><Printer className="mr-2" /> 전체 인쇄 / PDF 저장</Button>
            </div>

            {logs.map((log) => (
                <ReportView key={log.id} log={log} participants={participantsMap[log.id] || []} />
            ))}
        </div>
    )
}