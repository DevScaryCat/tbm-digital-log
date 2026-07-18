// app/report/minutes/[id]/page.tsx
"use client"

import { useState, useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { resolveSignedMap, signed } from "@/lib/storageSign"
import { Button } from "@/components/ui/button"
import { Printer, ArrowLeft, Loader2, Home, FileDown } from "lucide-react"

interface Hazard {
    factor: string;
    level: string;
    measure: string;
}

interface TbmMinute {
    id: string;
    user_id: string;
    created_at: string;
    date: string;
    start_time: string | null;
    end_time: string | null;
    location: string | null;
    process_name: string | null;
    work_name: string | null;
    work_content: string | null;
    leader_title: string | null;
    leader_name: string | null;
    leader_signature: string | null;
    health_check: string;
    ppe_check: string;
    safety_phrase: string | null;
    instructions: string | null;
    hazards: Hazard[];
}

interface MinuteParticipant {
    id: string;
    minutes_id: string;
    created_at: string;
    name: string;
    signature: string;
}

export default function MinutesReportPage() {
    const { id } = useParams()
    const router = useRouter()
    const [minutes, setMinutes] = useState<TbmMinute | null>(null)
    const [participants, setParticipants] = useState<MinuteParticipant[]>([])
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
        if (!minutes || exporting) return
        setExporting(true)
        try {
            // docx 빌더는 클릭 시점에만 로드 — 초기 번들 비대 방지
            const { buildMinutesDocx, downloadBlob, suggestFilename } = await import("@/lib/exportDocx")
            const { blob, imageFailures } = await buildMinutesDocx([{ minutes, participants }])
            if (imageFailures > 0 && !confirm(`서명·사진 ${imageFailures}건을 불러오지 못해 문서에서 빠졌습니다.\n페이지를 새로고침한 뒤 다시 시도하면 포함될 수 있어요. 그래도 저장할까요?`)) return
            downloadBlob(blob, suggestFilename("minutes", minutes.date))
        } catch (error) {
            console.error("문서 파일 생성 실패:", error)
            alert("문서 파일 생성에 실패했습니다. 잠시 후 다시 시도해주세요.")
        } finally {
            setExporting(false)
        }
    }

    useEffect(() => {
        const load = async () => {
            try {
                // 서로 독립적인 두 조회를 병렬로 (직렬 대기 왕복 1회 제거)
                const [{ data: minutesData, error: minutesError }, { data: partData }] = await Promise.all([
                    supabase.from('tbm_minutes').select('*').eq('id', id).maybeSingle(),
                    supabase.from('tbm_minutes_participants').select('*').eq('minutes_id', id).order('id', { ascending: true }),
                ])

                if (minutesError) throw minutesError

                const parts = (partData || []) as MinuteParticipant[]
                // 서명: 저장된 public URL → signed URL (버킷 private 대응)
                const sig = await resolveSignedMap([
                    minutesData?.leader_signature,
                    ...parts.map((p) => p.signature),
                ])

                let parsedHazards: Hazard[] = []
                if (minutesData) {
                    if (typeof minutesData.hazards === 'string') {
                        try {
                            parsedHazards = JSON.parse(minutesData.hazards)
                        } catch (e) {
                            parsedHazards = []
                        }
                    } else if (Array.isArray(minutesData.hazards)) {
                        parsedHazards = minutesData.hazards as Hazard[]
                    }

                    const finalData: TbmMinute = {
                        ...minutesData,
                        hazards: parsedHazards,
                        leader_signature: signed(sig, minutesData.leader_signature),
                    }
                    setMinutes(finalData)
                }
                setParticipants(parts.map((p) => ({ ...p, signature: signed(sig, p.signature) })))
            } catch (error) {
                console.error("데이터 로드 실패:", error)
                alert("회의록 데이터를 불러오지 못했습니다.")
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [id])

    if (loading) {
        return <div className="min-h-screen flex items-center justify-center bg-gray-100"><Loader2 className="w-10 h-10 animate-spin text-cur-muted" /></div>
    }

    if (!minutes) return <div className="min-h-screen flex items-center justify-center bg-gray-100">데이터가 없습니다.</div>

    return (
        <div className="min-h-screen bg-gray-100 p-8 print:p-0 print:bg-cur-card text-black font-sans">
            
            <div className="max-w-[210mm] mx-auto mb-4 flex justify-between print:hidden">
                <div className="flex gap-2">
                    <Button variant="outline" onClick={() => window.history.back()}><ArrowLeft className="mr-2 h-4 w-4" /> 뒤로가기</Button>
                    <Button variant="outline" onClick={() => router.push('/')}><Home className="mr-2 h-4 w-4" /> 홈으로</Button>
                </div>
                <div className="flex flex-col items-end gap-1">
                    <div className="flex gap-2">
                        {(exportFormat === "docx" || exportFormat === "hwp") ? (
                            <>
                                <Button onClick={handleDocxSave} disabled={exporting} className="bg-blue-900 hover:bg-blue-800 text-cur-on-primary font-bold px-6">
                                    {exporting ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <FileDown className="mr-2 h-5 w-5" />}
                                    {exportFormat === "hwp" ? "한글로 저장" : "워드로 저장"}
                                </Button>
                                <Button variant="outline" onClick={() => window.print()} className="font-bold px-6">
                                    <Printer className="mr-2 h-5 w-5" /> PDF 저장 / 인쇄
                                </Button>
                            </>
                        ) : (
                            <Button onClick={() => window.print()} className="bg-blue-900 hover:bg-blue-800 text-cur-on-primary font-bold px-6">
                                <Printer className="mr-2 h-5 w-5" /> PDF 저장 / 인쇄
                            </Button>
                        )}
                    </div>
                    {exportFormat === "hwp" && (
                        <p className="text-[11px] text-cur-muted">지금은 워드 형식(.docx)으로 저장돼요 — 한글에서 바로 열립니다. 정식 HWP 파일은 준비 중.</p>
                    )}
                    {exportFormat === "xlsx" && (
                        <p className="text-[11px] text-cur-muted">엑셀 내보내기는 준비 중이에요</p>
                    )}
                </div>
            </div>

            <div className="max-w-[210mm] mx-auto bg-cur-card  print:shadow-none print:w-full min-h-[297mm] box-border pb-10">
                <div className="bg-[#0b285b] text-cur-on-primary text-center py-5 border-2 border-black border-b-0">
                    <h1 className="text-3xl font-bold tracking-widest">Tool Box Meeting 회의록</h1>
                </div>

                <table className="w-full border-collapse border-2 border-black text-sm">
                    <tbody>
                        <tr className="h-10 text-center">
                            <td className="border border-black bg-gray-200 font-bold w-32">TBM 일시</td>
                            <td className="border border-black bg-cur-card font-bold w-[35%] tracking-wide">
                                {minutes.date ? `${minutes.date.split('-')[0]}년 ${minutes.date.split('-')[1]}월 ${minutes.date.split('-')[2]}일` : '년 월 일'} &nbsp; {minutes.start_time?.slice(0, 5) || ''} ~ {minutes.end_time?.slice(0, 5) || ''}
                            </td>
                            <td className="border border-black bg-gray-200 font-bold w-32">TBM 장소</td>
                            <td className="border border-black bg-cur-card font-bold">{minutes.location}</td>
                        </tr>
                        <tr className="h-10 text-center">
                            <td className="border border-black bg-gray-200 font-bold">공정명</td>
                            <td className="border border-black bg-cur-card font-bold">{minutes.process_name}</td>
                            <td className="border border-black bg-gray-200 font-bold">작업명</td>
                            <td className="border border-black font-bold h-10">{minutes.work_name}</td>
                        </tr>
                        <tr>
                            <td className="border border-black bg-gray-200 font-bold text-center h-20">작업내용</td>
                            <td colSpan={3} className="border border-black p-0 align-top">
                                <div className="h-[20mm] p-3 whitespace-pre-wrap font-medium break-all overflow-hidden text-[13px]">
                                    {minutes.work_content}
                                </div>
                            </td>
                        </tr>
                        <tr className="h-12">
                            <td className="border border-black bg-gray-200 font-bold text-center">TBM 리더</td>
                            <td colSpan={3} className="border border-black bg-cur-card font-bold p-0">
                                <div className="flex items-center w-full h-full">
                                    <div className="px-4 flex-1">직책 : {minutes.leader_title}</div>
                                    <div className="px-4 flex-1">성명 : {minutes.leader_name}</div>
                                    <div className="px-4 flex-[2] flex items-center gap-2">
                                        <span>(서명)</span>
                                        <div className="h-10 w-24 relative inline-block">
                                            {minutes.leader_signature && (
                                                <img src={minutes.leader_signature} className="absolute inset-0 w-full h-full object-contain" alt="리더 서명" />
                                            )}
                                        </div>
                                        {minutes.leader_signature && (
                                            <span className="text-[10px] text-gray-500 font-normal leading-tight ml-2">
                                                * 본인은 일지의 내용을 정확하게 확인하였으며, 최종 검토 및 수정의 법적 책임이 본인에게 있음을 동의합니다.
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </td>
                        </tr>

                        <tr className="bg-orange-50/50">
                            <td colSpan={4} className="border-l border-r border-black p-2 font-bold text-sm">
                                ■ 근로자 참여 위험성평가
                            </td>
                        </tr>
                        <tr className="text-center font-bold bg-gray-200 h-8">
                            <td colSpan={2} className="border border-black">잠재 유해위험요인</td>
                            <td className="border border-black w-24">위험성</td>
                            <td className="border border-black">대책(※ 제거 → 대체 → 통제 순서 고려)</td>
                        </tr>
                        {Array.from({ length: Math.max(3, minutes.hazards?.length || 0) }).map((_, i) => {
                            const hazard = minutes.hazards?.[i];
                            return (
                                <tr key={i} className="min-h-[40px]">
                                    <td colSpan={2} className="border border-black p-2 align-top text-xs break-all">
                                        □ {hazard?.factor}
                                    </td>
                                    <td className="border border-black p-2 text-center font-bold text-red-600">
                                        {hazard?.level || '상/중/하'}
                                    </td>
                                    <td className="border border-black p-2 align-top text-xs break-all">
                                        □ {hazard?.measure}
                                    </td>
                                </tr>
                            );
                        })}

                        <tr>
                            <td colSpan={4} className="border border-black border-t-2 p-2 font-bold text-sm">
                                ■ 작업 시작전 확인사항
                            </td>
                        </tr>
                        <tr className="h-10 text-center font-bold text-sm">
                            <td colSpan={2} className="border border-black bg-cur-card text-left px-2">□ 개인별 건강상태 이상 유무</td>
                            <td colSpan={2} className="border border-black bg-cur-card">{minutes.health_check}</td>
                        </tr>
                        <tr className="h-10 text-center font-bold text-sm">
                            <td colSpan={2} className="border border-black bg-cur-card text-left px-2">□ 개인 보호구 착용 상태</td>
                            <td colSpan={2} className="border border-black bg-cur-card">{minutes.ppe_check}</td>
                        </tr>
                        <tr className="h-10 text-center font-bold text-sm">
                            <td colSpan={2} className="border border-black text-left px-2">□ 안전구호 제창</td>
                            <td colSpan={2} className="border border-black tracking-widest text-blue-900">&quot;{minutes.safety_phrase || "안전, 안전, 안전"}&quot;</td>
                        </tr>

                        <tr>
                            <td colSpan={4} className="border border-black p-2 font-bold text-sm border-t-2">
                                ■ 작업 시작전 협의 및 지시사항(작업전에 협의할 사항을 음성으로 녹음하세요)
                            </td>
                        </tr>
                        <tr>
                            <td colSpan={4} className="border border-black p-0 align-top">
                                <div className="h-[28mm] p-3 whitespace-pre-wrap text-sm leading-relaxed break-all overflow-hidden text-[13px]">
                                    {minutes.instructions}
                                </div>
                            </td>
                        </tr>

                        <tr>
                            <td colSpan={4} className="border border-black p-2 font-bold text-sm border-t-2">
                                ■ 참석자 확인(※ TBM에 참여하지 않은 작업자를 확인하여 미팅 참석 유도)
                            </td>
                        </tr>
                        <tr className="bg-gray-300 font-bold h-8 text-center text-sm">
                            <td colSpan={2} className="border border-black !w-1/2">
                                <div className="flex w-full">
                                    <div className="flex-1 border-r border-black">이름</div>
                                    <div className="flex-1">서명</div>
                                </div>
                            </td>
                            <td colSpan={2} className="border border-black !w-1/2">
                                <div className="flex w-full">
                                    <div className="flex-1 border-r border-black">이름</div>
                                    <div className="flex-1">서명</div>
                                </div>
                            </td>
                        </tr>
                        
                        {(() => {
                        // 참석자 전원 표시(2열). 31명 이상도 유실 없이 — 열 분할점을 인원수에 맞춰 동적 산정(최소 15행).
                        const rows = Math.max(15, Math.ceil(participants.length / 2));
                        return Array.from({ length: rows }).map((_, i) => {
                            const p1 = participants[i];
                            const p2 = participants[i + rows];
                            return (
                                <tr key={i} className="h-10 text-center">
                                    <td colSpan={2} className="border border-black p-0 h-10">
                                        <div className="flex w-full h-10 items-center">
                                            <div className="flex-1 border-r border-black h-full flex items-center justify-center font-bold text-sm truncate px-1">
                                                {p1?.name || ''}
                                            </div>
                                            <div className="flex-1 h-full relative">
                                                {p1?.signature && <img src={p1.signature} className="absolute inset-0 w-full h-full object-contain p-1" alt="서명" />}
                                            </div>
                                        </div>
                                    </td>
                                    <td colSpan={2} className="border border-black p-0 h-10">
                                        <div className="flex w-full h-10 items-center">
                                            <div className="flex-1 border-r border-black h-full flex items-center justify-center font-bold text-sm truncate px-1">
                                                {p2?.name || ''}
                                            </div>
                                            <div className="flex-1 h-full relative">
                                                {p2?.signature && <img src={p2.signature} className="absolute inset-0 w-full h-full object-contain p-1" alt="서명" />}
                                            </div>
                                        </div>
                                    </td>
                                </tr>
                            );
                        });
                        })()}
                    </tbody>
                </table>
            </div>

        </div>
    )
}
