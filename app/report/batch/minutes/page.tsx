"use client"

import { useState, useEffect } from "react"
import { supabase } from "@/lib/supabaseClient"
import { resolveSignedMap, signed } from "@/lib/storageSign"
import { Button } from "@/components/ui/button"
import { MinutesView } from "@/components/MinutesView"
import { Printer, ArrowLeft, Loader2, FileDown } from "lucide-react"

// 파일명용 기간 표기 — "2026-07-01" → "0701"
function mmdd(date?: string): string {
    return (date || "").slice(5).replace("-", "")
}

export default function BatchMinutesReportPage() {
    const [minutes, setMinutes] = useState<any[]>([])
    const [participantsMap, setParticipantsMap] = useState<Record<string, any[]>>({})
    const [loading, setLoading] = useState(true)
    // 문서 출력 형식(user_metadata) — 조회 실패 시 PDF 기본 동작 유지
    const [exportFormat, setExportFormat] = useState<string>("pdf")
    const [exporting, setExporting] = useState(false)

    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            setExportFormat(session?.user.user_metadata?.preferred_export_format || "pdf")
        })
    }, [])

    const handleDocxSave = async () => {
        if (minutes.length === 0 || exporting) return
        setExporting(true)
        try {
            // minutes는 date 오름차순 정렬 — 처음/마지막이 기간
            const period = `${mmdd(minutes[0].date)}-${mmdd(minutes[minutes.length - 1].date)}`
            // 빌더는 클릭 시점에만 로드 — 초기 번들 비대 방지
            if (exportFormat === "hwp") {
                // 한글 선택 시 정식 .hwpx로 저장
                const [{ buildMinutesHwpx, suggestHwpxFilename }, { downloadBlob }] = await Promise.all([
                    import("@/lib/exportHwpx"),
                    import("@/lib/exportDocx"),
                ])
                const { blob, imageFailures } = await buildMinutesHwpx(minutes.map((m) => ({ minutes: m, participants: participantsMap[m.id] || [] })))
                if (imageFailures > 0 && !confirm(`서명·사진 ${imageFailures}건을 불러오지 못해 문서에서 빠졌습니다.\n페이지를 새로고침한 뒤 다시 시도하면 포함될 수 있어요. 그래도 저장할까요?`)) return
                downloadBlob(blob, suggestHwpxFilename("minutes", period))
            } else if (exportFormat === "xlsx") {
                // 엑셀 선택 시 서식 있는 .xlsx로 저장 — 1건 = 시트 1장
                const [{ buildMinutesXlsx, suggestXlsxFilename }, { downloadBlob }] = await Promise.all([
                    import("@/lib/exportXlsx"),
                    import("@/lib/exportDocx"),
                ])
                const { blob, imageFailures } = await buildMinutesXlsx(minutes.map((m) => ({ minutes: m, participants: participantsMap[m.id] || [] })))
                if (imageFailures > 0 && !confirm(`서명·사진 ${imageFailures}건을 불러오지 못해 문서에서 빠졌습니다.\n페이지를 새로고침한 뒤 다시 시도하면 포함될 수 있어요. 그래도 저장할까요?`)) return
                downloadBlob(blob, suggestXlsxFilename("minutes", period))
            } else {
                const { buildMinutesDocx, downloadBlob, suggestFilename } = await import("@/lib/exportDocx")
                const { blob, imageFailures } = await buildMinutesDocx(minutes.map((m) => ({ minutes: m, participants: participantsMap[m.id] || [] })))
                if (imageFailures > 0 && !confirm(`서명·사진 ${imageFailures}건을 불러오지 못해 문서에서 빠졌습니다.\n페이지를 새로고침한 뒤 다시 시도하면 포함될 수 있어요. 그래도 저장할까요?`)) return
                downloadBlob(blob, suggestFilename("minutes", period))
            }
        } catch (error) {
            console.error("문서 파일 생성 실패:", error)
            alert("문서 파일 생성에 실패했습니다. 잠시 후 다시 시도해주세요.")
        } finally {
            setExporting(false)
        }
    }

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

            // raw_transcript(최대 20분 분량 STT 원문) 제외 — 일괄 인쇄는 수백 건 × 수십 KB가 될 수 있음
            const { data: minutesData } = await supabase
                .from('tbm_minutes')
                .select('id, user_id, date, start_time, end_time, location, process_name, work_name, work_content, leader_title, leader_name, leader_signature, health_check, ppe_check, safety_phrase, instructions, hazards, created_at')
                .in('id', ids)
                .order('date', { ascending: true })

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
                <div className="flex flex-col items-end gap-1">
                    <div className="flex gap-2">
                        {(exportFormat === "docx" || exportFormat === "hwp" || exportFormat === "xlsx") ? (
                            <>
                                <Button onClick={handleDocxSave} disabled={exporting} className="bg-blue-900 text-cur-on-primary">
                                    {exporting ? <Loader2 className="mr-2 animate-spin" /> : <FileDown className="mr-2" />}
                                    {exportFormat === "hwp" ? "전체 한글로 저장" : exportFormat === "xlsx" ? "전체 엑셀로 저장" : "전체 워드로 저장"}
                                </Button>
                                <Button variant="outline" onClick={() => window.print()}><Printer className="mr-2" /> 회의록 전체 인쇄 / PDF 저장</Button>
                            </>
                        ) : (
                            <Button onClick={() => window.print()} className="bg-blue-900 text-cur-on-primary"><Printer className="mr-2" /> 회의록 전체 인쇄 / PDF 저장</Button>
                        )}
                    </div>
                    {exportFormat === "hwp" && (
                        <p className="text-[11px] text-cur-muted">정식 한글 파일(.hwpx)로 저장돼요 — 한글 2014 이상에서 열립니다.</p>
                    )}
                </div>
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
