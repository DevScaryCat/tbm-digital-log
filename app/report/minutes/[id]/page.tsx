"use client"

import { useState, useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { Printer, ArrowLeft, Loader2, Home } from "lucide-react"

interface Hazard {
    factor: string;
    risk: string;
    countermeasure: string;
}

export default function MinutesReportPage() {
    const { id } = useParams()
    const router = useRouter()
    const [minutes, setMinutes] = useState<any>(null)
    const [participants, setParticipants] = useState<any[]>([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        const load = async () => {
            try {
                const { data: minutesData, error: minutesError } = await supabase.from('tbm_minutes').select('*').eq('id', id).single()
                const { data: partData } = await supabase.from('tbm_minutes_participants').select('*').eq('minutes_id', id).order('id', { ascending: true })

                if (minutesError) throw minutesError

                // Parse hazards if it's a string
                if (typeof minutesData.hazards === 'string') {
                    try {
                        minutesData.hazards = JSON.parse(minutesData.hazards)
                    } catch (e) {
                        minutesData.hazards = []
                    }
                }

                setMinutes(minutesData)
                setParticipants(partData || [])
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
        return <div className="min-h-screen flex items-center justify-center bg-gray-100"><Loader2 className="w-10 h-10 animate-spin text-slate-500" /></div>
    }

    if (!minutes) return <div className="min-h-screen flex items-center justify-center bg-gray-100">데이터가 없습니다.</div>

    return (
        <div className="min-h-screen bg-gray-100 p-8 print:p-0 print:bg-white text-black font-sans">
            
            {/* ⭐️ 인쇄 버튼 (화면에서만 보임) */}
            <div className="max-w-[210mm] mx-auto mb-4 flex justify-between print:hidden">
                <div className="flex gap-2">
                    <Button variant="outline" onClick={() => window.history.back()}><ArrowLeft className="mr-2 h-4 w-4" /> 뒤로가기</Button>
                    <Button variant="outline" onClick={() => router.push('/')}><Home className="mr-2 h-4 w-4" /> 홈으로</Button>
                </div>
                <Button onClick={() => window.print()} className="bg-blue-900 hover:bg-blue-800 text-white font-bold px-6">
                    <Printer className="mr-2 h-5 w-5" /> PDF 저장 / 인쇄
                </Button>
            </div>

            {/* --- 통합 회의록 양식 (A4 1장 타겟) --- */}
            <div className="max-w-[210mm] mx-auto bg-white shadow-lg print:shadow-none print:w-full min-h-[297mm] box-border pb-10">
                {/* 메인 타이틀 (파란 배경) */}
                <div className="bg-[#0b285b] text-white text-center py-5 border-2 border-black border-b-0">
                    <h1 className="text-3xl font-bold tracking-widest">Tool Box Meeting 회의록</h1>
                </div>

                {/* 1. 기본 정보 테이블 */}
                <table className="w-full border-collapse border-2 border-black text-sm">
                    <tbody>
                        <tr className="h-10 text-center">
                            <td className="border border-black bg-gray-200 font-bold w-32">TBM 일시</td>
                            <td className="border border-black bg-white font-bold w-[35%] tracking-wide">
                                {minutes.date ? `${minutes.date.split('-')[0]}년 ${minutes.date.split('-')[1]}월 ${minutes.date.split('-')[2]}일` : '년 월 일'} &nbsp; {minutes.start_time?.slice(0, 5) || ''} ~ {minutes.end_time?.slice(0, 5) || ''}
                            </td>
                            <td className="border border-black bg-gray-200 font-bold w-32">TBM 장소</td>
                            <td className="border border-black bg-white font-bold">{minutes.location}</td>
                        </tr>
                        <tr className="h-10 text-center">
                            <td className="border border-black bg-gray-200 font-bold">공정명</td>
                            <td className="border border-black bg-white font-bold">{minutes.process_name}</td>
                            <td className="border border-black bg-gray-200 font-bold">작업명</td>
                            <td className="border border-black font-bold h-10">{minutes.work_name}</td>
                        </tr>
                        <tr>
                            <td className="border border-black bg-gray-200 font-bold text-center h-20">작업내용</td>
                            <td colSpan={3} className="border border-black p-3 align-top whitespace-pre-wrap font-medium">
                                {minutes.work_content}
                            </td>
                        </tr>
                        <tr className="h-12">
                            <td className="border border-black bg-gray-200 font-bold text-center">TBM 리더</td>
                            <td colSpan={3} className="border border-black bg-white font-bold p-0">
                                <div className="flex items-center w-full h-full">
                                    <div className="px-4 flex-1">직책 : {minutes.leader_title}</div>
                                    <div className="px-4 flex-1">성명 : {minutes.leader_name}</div>
                                    <div className="px-4 flex-[2] flex items-center gap-2">
                                        <span>(서명)</span>
                                        <div className="h-10 w-24 relative inline-block">
                                            {minutes.leader_signature && (
                                                <img src={minutes.leader_signature} className="absolute inset-0 w-full h-full object-contain mix-blend-multiply" alt="리더 서명" />
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </td>
                        </tr>

                        {/* 2. 위험성 평가 */}
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
                                    <td colSpan={2} className="border border-black p-2 align-top text-xs">
                                        □ {hazard?.factor}
                                    </td>
                                    <td className="border border-black p-2 text-center font-bold text-red-600">
                                        {hazard?.risk || '상/중/하'}
                                    </td>
                                    <td className="border border-black p-2 align-top text-xs">
                                        □ {hazard?.countermeasure}
                                    </td>
                                </tr>
                            );
                        })}

                        {/* 3. 확인사항 */}
                        <tr>
                            <td colSpan={4} className="border border-black border-t-2 p-2 font-bold text-sm">
                                ■ 작업 시작전 확인사항
                            </td>
                        </tr>
                        <tr className="h-10 text-center font-bold text-sm">
                            <td colSpan={2} className="border border-black bg-white text-left px-2">□ 개인별 건강상태 이상 유무</td>
                            <td colSpan={2} className="border border-black bg-white">{minutes.health_check}</td>
                        </tr>
                        <tr className="h-10 text-center font-bold text-sm">
                            <td colSpan={2} className="border border-black bg-white text-left px-2">□ 개인 보호구 착용 상태</td>
                            <td colSpan={2} className="border border-black bg-white">{minutes.ppe_check}</td>
                        </tr>
                        <tr className="h-10 text-center font-bold text-sm">
                            <td colSpan={2} className="border border-black text-left px-2">□ 안전구호 제창</td>
                            <td colSpan={2} className="border border-black tracking-widest text-blue-900">&quot;{minutes.safety_phrase || "안전, 안전, 안전"}&quot;</td>
                        </tr>

                        {/* 4. 지시사항 */}
                        <tr>
                            <td colSpan={4} className="border border-black p-2 font-bold text-sm border-t-2">
                                ■ 작업 시작전 협의 및 지시사항(작업전에 협의할 사항을 음성으로 녹음하세요)
                            </td>
                        </tr>
                        <tr>
                            <td colSpan={4} className="border border-black p-3 h-28 align-top whitespace-pre-wrap text-sm leading-relaxed">
                                {minutes.instructions}
                            </td>
                        </tr>

                        {/* 5. 참석자 확인 */}
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
                        
                        {/* 참석자 명단 행 (짝수로 묶어서 렌더링, A4 페이지에 맞게 10~15줄 조절) */}
                        {Array.from({ length: 15 }).map((_, i) => {
                            const p1 = participants[i];
                            const p2 = participants[i + 15];
                            return (
                                <tr key={i} className="h-10 text-center">
                                    <td colSpan={2} className="border border-black p-0">
                                        <div className="flex w-full h-full items-center">
                                            <div className="flex-1 border-r border-black h-full flex items-center justify-center font-bold text-sm truncate px-1">
                                                {p1?.name || ''}
                                            </div>
                                            <div className="flex-1 h-full relative">
                                                {p1?.signature && <img src={p1.signature} className="absolute inset-0 w-full h-full object-contain p-1 mix-blend-multiply" alt="서명" />}
                                            </div>
                                        </div>
                                    </td>
                                    <td colSpan={2} className="border border-black p-0">
                                        <div className="flex w-full h-full items-center">
                                            <div className="flex-1 border-r border-black h-full flex items-center justify-center font-bold text-sm truncate px-1">
                                                {p2?.name || ''}
                                            </div>
                                            <div className="flex-1 h-full relative">
                                                {p2?.signature && <img src={p2.signature} className="absolute inset-0 w-full h-full object-contain p-1 mix-blend-multiply" alt="서명" />}
                                            </div>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

        </div>
    )
}
