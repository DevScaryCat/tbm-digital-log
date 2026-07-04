"use client"

import { useState, useEffect } from "react"
import { supabase } from "@/lib/supabaseClient"
import { resolveSignedMap, signed } from "@/lib/storageSign"
import { Button } from "@/components/ui/button"
import { MinutesView } from "@/components/MinutesView"
import { Printer, ArrowLeft, Loader2 } from "lucide-react"

export default function BatchMinutesReportPage() {
    const [minutes, setMinutes] = useState<any[]>([])
    const [participantsMap, setParticipantsMap] = useState<Record<string, any[]>>({})
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        const loadBatch = async () => {
            const idsString = localStorage.getItem("batch_minute_ids")
            if (!idsString) return setLoading(false)

            let ids: string[] = []
            try {
                const parsed = JSON.parse(idsString)
                ids = Array.isArray(parsed) ? parsed : []
            } catch { ids = [] }
            if (ids.length === 0) return setLoading(false)

            const { data: minutesData } = await supabase.from('tbm_minutes').select('*').in('id', ids).order('date', { ascending: true })

            if (minutesData) {
                // 참석자 한 번에 조회 후 minutes_id별 그룹핑
                const { data: allParts } = await supabase.from('tbm_minutes_participants').select('*').in('minutes_id', ids)
                const pMap: Record<string, any[]> = {}
                for (const m of minutesData) pMap[m.id] = []
                for (const p of (allParts || [])) (pMap[p.minutes_id] ||= []).push(p)

                // 서명: 저장된 public URL → signed URL (버킷 private 대응)
                const allUrls: (string | null | undefined)[] = []
                for (const m of minutesData) allUrls.push(m.leader_signature)
                for (const arr of Object.values(pMap)) for (const p of arr) allUrls.push(p.signature)
                const sig = await resolveSignedMap(allUrls)

                setMinutes(minutesData.map((m: any) => ({
                    ...m,
                    hazards: typeof m.hazards === 'string' ? safeParse(m.hazards) : (Array.isArray(m.hazards) ? m.hazards : []),
                    leader_signature: signed(sig, m.leader_signature),
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
                <Button onClick={() => window.print()} className="bg-blue-900 text-cur-on-primary"><Printer className="mr-2" /> 회의록 전체 인쇄 / PDF 저장</Button>
            </div>

            {minutes.map((m) => (
                <MinutesView key={m.id} minutes={m} participants={participantsMap[m.id] || []} />
            ))}
        </div>
    )
}

function safeParse(s: string): any[] {
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : [] } catch { return [] }
}
