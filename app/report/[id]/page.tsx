"use client"

import { useState, useEffect } from "react"
import { useParams } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { Printer, ArrowLeft } from "lucide-react"

export default function ReportPage() {
    const { id } = useParams()
    const [log, setLog] = useState<any>(null)
    const [participants, setParticipants] = useState<any[]>([])

    useEffect(() => {
        const load = async () => {
            const { data: logData } = await supabase.from('tbm_logs').select('*').eq('id', id).single()
            const { data: partData } = await supabase.from('tbm_participants').select('*').eq('log_id', id)

            setLog(logData)
            setParticipants(partData || [])
        }
        load()
    }, [id])

    if (!log) return <div>Loading...</div>

    // 통계 계산
    const maleCount = participants.filter(p => p.gender === 'M').length
    const femaleCount = participants.filter(p => p.gender === 'F').length
    const totalCount = participants.length

    return (
        <div className="min-h-screen bg-gray-100 p-8 print:p-0 print:bg-white">

            {/* 인쇄 버튼 (화면에서만 보임) */}
            <div className="max-w-[210mm] mx-auto mb-4 flex justify-between print:hidden">
                <Button variant="outline" onClick={() => window.history.back()}><ArrowLeft className="mr-2" /> 뒤로가기</Button>
                <Button onClick={() => window.print()} className="bg-blue-900 text-white"><Printer className="mr-2" /> 인쇄 / PDF 저장</Button>
            </div>

            {/* --- PAGE 1: 교육일지 --- */}
            <div className="max-w-[210mm] mx-auto bg-white p-[10mm] shadow-lg print:shadow-none print:w-full mb-8 print:break-after-page h-[297mm] relative box-border">
                <h1 className="text-3xl font-bold text-center mb-8" style={{ fontFamily: "Batang, serif" }}>안 전 보 건 교 육 일 지</h1>

                <table className="w-full border-collapse border border-black text-sm" style={{ fontFamily: "Dotum, sans-serif" }}>
                    <tbody>
                        {/* 교육 명칭 */}
                        <tr className="h-16">
                            <td className="border border-black bg-gray-100 text-center font-bold w-32">교육 명칭</td>
                            <td className="border border-black p-2" colSpan={5}>
                                <div className="grid grid-cols-2 gap-2">
                                    <label><input type="checkbox" checked={log.education_type === '정기 안전교육'} readOnly /> 정기 안전교육</label>
                                    <label><input type="checkbox" checked={log.education_type === '특별안전보건교육'} readOnly /> 특별안전보건교육</label>
                                    <label><input type="checkbox" checked={log.education_type === '신규 채용시 교육'} readOnly /> 신규 채용시 교육</label>
                                    <label><input type="checkbox" checked={log.education_type === '관리 감독자 교육'} readOnly /> 관리 감독자 교육</label>
                                    <label><input type="checkbox" checked={log.education_type === '작업내용 변경시 교육'} readOnly /> 작업내용 변경시 교육</label>
                                    <label><input type="checkbox" checked={log.education_type.includes('기타')} readOnly /> 기타 ({log.remarks || '혹한기 예방'})</label>
                                </div>
                            </td>
                        </tr>

                        {/* 교육 인원 (표 안의 표) */}
                        <tr className="h-24">
                            <td className="border border-black bg-gray-100 text-center font-bold">교육 인원</td>
                            <td className="border border-black p-0" colSpan={5}>
                                <table className="w-full h-full border-collapse">
                                    <thead>
                                        <tr className="h-8">
                                            <td className="border-r border-b border-black text-center bg-gray-50">구분</td>
                                            <td className="border-r border-b border-black text-center bg-gray-50">계</td>
                                            <td className="border-r border-b border-black text-center bg-gray-50">남</td>
                                            <td className="border-r border-b border-black text-center bg-gray-50">여</td>
                                            <td className="border-b border-black text-center bg-gray-50">비고</td>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr className="h-8">
                                            <td className="border-r border-b border-black text-center">대상 인원</td>
                                            <td className="border-r border-b border-black text-center">{totalCount}</td>
                                            <td className="border-r border-b border-black text-center">{maleCount}</td>
                                            <td className="border-r border-b border-black text-center">{femaleCount}</td>
                                            <td className="border-b border-black text-center"></td>
                                        </tr>
                                        <tr className="h-8">
                                            <td className="border-r border-black text-center">참석 인원</td>
                                            <td className="border-r border-black text-center">{totalCount}</td>
                                            <td className="border-r border-black text-center">{maleCount}</td>
                                            <td className="border-r border-black text-center">{femaleCount}</td>
                                            <td className="text-center"></td>
                                        </tr>
                                    </tbody>
                                </table>
                            </td>
                        </tr>

                        {/* 교육 시간, 장소, 방법 */}
                        <tr className="h-10">
                            <td className="border border-black bg-gray-100 text-center font-bold">교육 시간</td>
                            <td className="border border-black p-2 text-center" colSpan={5}>
                                {log.date.split('-')[0]}년 {log.date.split('-')[1]}월 {log.date.split('-')[2]}일 &nbsp;&nbsp;
                                {log.start_time.slice(0, 5)} ~ {log.end_time.slice(0, 5)}
                            </td>
                        </tr>
                        <tr className="h-10">
                            <td className="border border-black bg-gray-100 text-center font-bold">교육 장소</td>
                            <td className="border border-black p-2" colSpan={5}>{log.location}</td>
                        </tr>
                        <tr className="h-10">
                            <td className="border border-black bg-gray-100 text-center font-bold">교육 방법</td>
                            <td className="border border-black p-2" colSpan={5}>강의식 / 시청각 교육</td>
                        </tr>

                        {/* 교육 내용 */}
                        <tr className="h-64">
                            <td className="border border-black bg-gray-100 text-center font-bold">교육 내용</td>
                            <td className="border border-black p-4 align-top whitespace-pre-wrap leading-relaxed" colSpan={5}>
                                {log.education_content}
                            </td>
                        </tr>

                        {/* 교육 실시자 (서명) */}
                        <tr className="h-20">
                            <td className="border border-black bg-gray-100 text-center font-bold" rowSpan={2}>교육 실시자<br />(관리감독자)</td>
                            <td className="border border-black bg-gray-50 text-center h-8" colSpan={2}>소속 및 직위</td>
                            <td className="border border-black bg-gray-50 text-center" colSpan={2}>성 명</td>
                            <td className="border border-black bg-gray-50 text-center">서 명</td>
                        </tr>
                        <tr className="h-16">
                            <td className="border border-black text-center" colSpan={2}>{log.company_name} / 안전관리자</td>
                            <td className="border border-black text-center" colSpan={2}>{log.instructor_name}</td>
                            <td className="border border-black text-center p-1">
                                {log.instructor_signature && <img src={log.instructor_signature} className="h-12 mx-auto object-contain" />}
                            </td>
                        </tr>

                        {/* 특이사항 */}
                        <tr className="h-24">
                            <td className="border border-black bg-gray-100 text-center font-bold">특 이 사 항<br /><span className="font-normal text-xs">(기타 전달사항 등)</span></td>
                            <td className="border border-black p-2 align-top" colSpan={5}>{log.remarks}</td>
                        </tr>
                    </tbody>
                </table>
                <div className="absolute bottom-10 left-0 w-full text-center text-sm border-t border-black pt-2">무신사로지스틱스</div>
            </div>

            {/* --- PAGE 2: 참석자 명단 --- */}
            <div className="max-w-[210mm] mx-auto bg-white p-[10mm] shadow-lg print:shadow-none print:w-full mb-8 print:break-after-page h-[297mm] relative box-border">
                <h1 className="text-3xl font-bold text-center mb-8" style={{ fontFamily: "Batang, serif" }}>교 육 참 석 자 명 단</h1>

                <div className="flex justify-between mb-4 text-sm font-bold">
                    <div>일시: {log.date}</div>
                    <div>업체명: {log.company_name}</div>
                    <div>근무조: 주간/석간</div>
                </div>

                <table className="w-full border-collapse border border-black text-sm text-center">
                    <thead>
                        <tr className="h-10 bg-gray-100">
                            <th className="border border-black w-12">순번</th>
                            <th className="border border-black w-32">이 름</th>
                            <th className="border border-black">서 명</th>
                            <th className="border border-black w-12">순번</th>
                            <th className="border border-black w-32">이 름</th>
                            <th className="border border-black">서 명</th>
                        </tr>
                    </thead>
                    <tbody>
                        {/* 30칸을 채우기 위한 로직 (2열 배치) */}
                        {Array.from({ length: 15 }).map((_, i) => {
                            const p1 = participants[i]
                            const p2 = participants[i + 15]
                            return (
                                <tr key={i} className="h-14">
                                    <td className="border border-black">{i + 1}</td>
                                    <td className="border border-black font-bold text-lg">{p1?.name || ''}</td>
                                    <td className="border border-black">
                                        {p1?.signature && <img src={p1.signature} className="h-10 mx-auto object-contain" />}
                                    </td>
                                    <td className="border border-black">{i + 16}</td>
                                    <td className="border border-black font-bold text-lg">{p2?.name || ''}</td>
                                    <td className="border border-black">
                                        {p2?.signature && <img src={p2.signature} className="h-10 mx-auto object-contain" />}
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
                <div className="absolute bottom-10 left-0 w-full text-center text-sm border-t border-black pt-2">무신사로지스틱스</div>
            </div>

            {/* --- PAGE 3: 교육 사진 --- */}
            <div className="max-w-[210mm] mx-auto bg-white p-[10mm] shadow-lg print:shadow-none print:w-full h-[297mm] relative box-border">
                <h1 className="text-3xl font-bold text-center mb-8" style={{ fontFamily: "Batang, serif" }}>교 육 사 진</h1>

                <div className="w-full h-[200mm] border border-black flex items-center justify-center p-2">
                    {log.photo_url ? (
                        <img src={log.photo_url} className="max-w-full max-h-full object-contain" alt="교육 현장" />
                    ) : (
                        <span className="text-gray-400">등록된 사진 없음</span>
                    )}
                </div>
                <div className="absolute bottom-10 left-0 w-full text-center text-sm border-t border-black pt-2">무신사로지스틱스</div>
            </div>

        </div>
    )
}