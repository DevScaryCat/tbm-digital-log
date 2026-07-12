// app/report/[id]/page.tsx
"use client"

import { useState, useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { resolveSignedMap, signed } from "@/lib/storageSign"
import { Button } from "@/components/ui/button"
import { Printer, ArrowLeft, Loader2, Home } from "lucide-react"

interface TbmLog {
    id: string;
    user_id: string;
    date: string;
    start_time: string;
    end_time: string;
    location: string;
    company_name: string;
    education_type: string;
    instructor_name: string;
    instructor_signature: string | null;
    education_content: string;
    remarks: string;
    photo_url: string | null;
    confirmation_signature: string | null;
    created_at: string;
}

interface Participant {
    id: string;
    log_id: string;
    name: string;
    gender: 'M' | 'F';
    signature: string | null;
    status: string;
    created_at: string;
}

export default function ReportPage() {
    const { id } = useParams()
    const router = useRouter()
    const [log, setLog] = useState<TbmLog | null>(null)
    const [participants, setParticipants] = useState<Participant[]>([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        const load = async () => {
            try {
                // 서로 독립적인 두 조회를 병렬로 (직렬 대기 왕복 1회 제거)
                const [{ data: logData, error: logError }, { data: partData }] = await Promise.all([
                    supabase.from('tbm_logs').select('*').eq('id', id).maybeSingle(),
                    supabase.from('tbm_participants').select('*').eq('log_id', id).order('id', { ascending: true }),
                ])

                if (logError) throw logError

                // 서명/사진: 저장된 public URL → signed URL (버킷 private 대응)
                const parts = partData || []
                const sig = await resolveSignedMap([
                    logData?.confirmation_signature, logData?.instructor_signature, logData?.photo_url,
                    ...parts.map((p: Participant) => p.signature),
                ])
                setLog(logData ? {
                    ...logData,
                    confirmation_signature: signed(sig, logData.confirmation_signature),
                    instructor_signature: signed(sig, logData.instructor_signature),
                    photo_url: signed(sig, logData.photo_url),
                } : null)
                setParticipants(parts.map((p: Participant) => ({ ...p, signature: signed(sig, p.signature) })))
            } catch (error) {
                console.error("데이터 로드 실패:", error)
                alert("일지 데이터를 불러오지 못했습니다.")
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [id])

    if (loading) {
        return <div className="min-h-screen flex items-center justify-center bg-gray-100"><Loader2 className="w-10 h-10 animate-spin text-cur-muted" /></div>
    }

    if (!log) return <div className="min-h-screen flex items-center justify-center bg-gray-100">데이터가 없습니다.</div>

    const maleCount = participants.filter(p => p.gender === 'M').length
    const femaleCount = participants.filter(p => p.gender === 'F').length
    const totalCount = participants.length

    return (
        <div className="min-h-screen bg-gray-100 p-8 print:p-0 print:bg-cur-card text-black font-sans">

            <div className="max-w-[210mm] mx-auto mb-4 flex justify-between print:hidden">
                <div className="flex gap-2">
                    <Button variant="outline" onClick={() => window.history.back()}><ArrowLeft className="mr-2 h-4 w-4" /> 뒤로가기</Button>
                    <Button variant="outline" onClick={() => router.push('/')}><Home className="mr-2 h-4 w-4" /> 홈으로</Button>
                </div>
                <Button onClick={() => window.print()} className="bg-blue-900 hover:bg-blue-800 text-cur-on-primary font-bold px-6">
                    <Printer className="mr-2 h-5 w-5" /> PDF 저장 / 인쇄
                </Button>
            </div>

            <div className="max-w-[210mm] mx-auto bg-cur-card p-[10mm] print:shadow-none print:w-full mb-8 print:mb-0 print:break-after-page min-h-[297mm] print:h-[297mm] relative box-border flex flex-col overflow-hidden">
                <h1 className="text-3xl font-bold text-center mb-8 tracking-[0.3em]">안 전 보 건 교 육 일 지</h1>

                <table className="w-full border-collapse border border-black text-sm">
                    <tbody>
                        <tr className="h-16">
                            <td className="border border-black bg-gray-100 text-center font-bold w-32">교육 명칭</td>
                            <td className="border border-black p-2" colSpan={5}>
                                <div className="grid grid-cols-2 gap-2 font-medium">
                                    <label className="flex items-center gap-1"><input type="checkbox" checked={log.education_type === '정기 안전교육'} readOnly className="w-4 h-4" /> 정기 안전교육</label>
                                    <label className="flex items-center gap-1"><input type="checkbox" checked={log.education_type === '특별안전보건교육'} readOnly className="w-4 h-4" /> 특별안전보건교육</label>
                                    <label className="flex items-center gap-1"><input type="checkbox" checked={log.education_type === '신규 채용시 교육'} readOnly className="w-4 h-4" /> 신규 채용시 교육</label>
                                    <label className="flex items-center gap-1"><input type="checkbox" checked={log.education_type === 'TBM'} readOnly className="w-4 h-4" /> TBM (작업 전 안전점검)</label>
                                    <label className="flex items-center gap-1"><input type="checkbox" checked={log.education_type === '작업내용 변경시 교육'} readOnly className="w-4 h-4" /> 작업내용 변경시 교육</label>
                                    <label className="flex items-center gap-1"><input type="checkbox" checked={!['정기 안전교육', '특별안전보건교육', '신규 채용시 교육', 'TBM', '작업내용 변경시 교육'].includes(log.education_type)} readOnly className="w-4 h-4" /> 기타</label>
                                </div>
                            </td>
                        </tr>

                        <tr className="h-24">
                            <td className="border border-black bg-gray-100 text-center font-bold">교육 인원</td>
                            <td className="border border-black p-0" colSpan={5}>
                                <table className="w-full h-full border-collapse">
                                    <thead>
                                        <tr className="h-8">
                                            <td className="border-r border-b border-black text-center bg-gray-50 font-bold">구분</td>
                                            <td className="border-r border-b border-black text-center bg-gray-50 font-bold">계</td>
                                            <td className="border-r border-b border-black text-center bg-gray-50 font-bold">남</td>
                                            <td className="border-r border-b border-black text-center bg-gray-50 font-bold">여</td>
                                            <td className="border-b border-black text-center bg-gray-50 font-bold">비고</td>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr className="h-8">
                                            <td className="border-r border-b border-black text-center font-bold">대상 인원</td>
                                            <td className="border-r border-b border-black text-center">{totalCount}</td>
                                            <td className="border-r border-b border-black text-center">{maleCount}</td>
                                            <td className="border-r border-b border-black text-center">{femaleCount}</td>
                                            <td className="border-b border-black text-center"></td>
                                        </tr>
                                        <tr className="h-8">
                                            <td className="border-r border-black text-center font-bold">참석 인원</td>
                                            <td className="border-r border-black text-center">{totalCount}</td>
                                            <td className="border-r border-black text-center">{maleCount}</td>
                                            <td className="border-r border-black text-center">{femaleCount}</td>
                                            <td className="text-center"></td>
                                        </tr>
                                    </tbody>
                                </table>
                            </td>
                        </tr>

                        <tr className="h-10">
                            <td className="border border-black bg-gray-100 text-center font-bold">교육 시간</td>
                            <td className="border border-black p-2 text-center" colSpan={5}>
                                {log.date?.split('-')[0]}년 {log.date?.split('-')[1]}월 {log.date?.split('-')[2]}일 &nbsp;&nbsp;
                                {log.start_time?.slice(0, 5)} ~ {log.end_time?.slice(0, 5)}
                            </td>
                        </tr>
                        <tr className="h-10">
                            <td className="border border-black bg-gray-100 text-center font-bold">교육 장소</td>
                            <td className="border border-black p-2 font-medium" colSpan={5}>{log.location}</td>
                        </tr>
                        <tr className="h-10">
                            <td className="border border-black bg-gray-100 text-center font-bold">교육 방법</td>
                            <td className="border border-black p-2" colSpan={5}>강의식 / 시청각 교육 / 현장 TBM</td>
                        </tr>

                        <tr>
                            <td className="border border-black bg-gray-100 text-center font-bold">교육 내용</td>
                            <td className="border border-black p-0 align-top" colSpan={5}>
                                <div className="min-h-[80mm] p-4 whitespace-pre-wrap leading-relaxed text-[13px] break-all">
                                    {log.education_content}
                                </div>
                            </td>
                        </tr>

                        <tr className="h-20">
                            <td className="border border-black bg-gray-100 text-center font-bold" rowSpan={3}>교육 실시자<br />(관리감독자)</td>
                            <td className="border border-black bg-gray-50 text-center h-8 font-bold" colSpan={2}>소속 및 직위</td>
                            <td className="border border-black bg-gray-50 text-center font-bold" colSpan={2}>성 명</td>
                            <td className="border border-black bg-gray-50 text-center font-bold">서 명</td>
                        </tr>
                        <tr className="h-16">
                            <td className="border border-black text-center" colSpan={2}>{log.company_name}</td>
                            <td className="border border-black text-center font-bold text-lg" colSpan={2}>{log.instructor_name}</td>
                            <td className="border border-black text-center p-1 relative h-16 w-32">
                                {log.confirmation_signature ? (
                                    <img src={log.confirmation_signature} className="absolute inset-0 w-full h-full object-contain p-1" />
                                ) : log.instructor_signature ? (
                                    <img src={log.instructor_signature} className="absolute inset-0 w-full h-full object-contain p-1" />
                                ) : (
                                    <span className="text-gray-300"></span>
                                )}
                            </td>
                        </tr>
                        <tr className="h-10">
                            <td className="border border-black p-2 text-[10px] text-gray-500 leading-tight" colSpan={5}>
                                본인은 일지의 내용을 정확하게 확인하였으며, 최종 검토 및 수정의 법적 책임이 본인에게 있음을 동의합니다.
                            </td>
                        </tr>

                        <tr>
                            <td className="border border-black bg-gray-100 text-center font-bold">특 이 사 항<br /><span className="font-normal text-xs">(기타 전달사항 등)</span></td>
                            <td className="border border-black p-0 align-top text-red-600 font-medium" colSpan={5}>
                                <div className="min-h-[24mm] p-4 break-all text-[13px]">
                                    {log.remarks}
                                </div>
                            </td>
                        </tr>
                    </tbody>
                </table>
                <div className="w-full text-center text-sm border-t border-black pt-2 mt-auto print:mt-auto font-bold">{log.company_name || "현장명"}</div>
            </div>

            {Array.from({ length: Math.max(1, Math.ceil(participants.length / 30)) }).map((_, pageIdx) => {
                const base = pageIdx * 30;
                const total = Math.max(1, Math.ceil(participants.length / 30));
                return (
                <div key={pageIdx} className="max-w-[210mm] mx-auto bg-cur-card p-[10mm] print:shadow-none print:w-full mb-8 print:mb-0 print:break-after-page min-h-[297mm] print:h-[297mm] relative box-border flex flex-col overflow-hidden">
                    <h1 className="text-3xl font-bold text-center mb-8 tracking-[0.3em]">교 육 참 석 자 명 단{total > 1 ? ` (${pageIdx + 1}/${total})` : ''}</h1>

                    <div className="flex justify-between mb-4 text-sm font-bold">
                        <div>일시: {log.date}</div>
                        <div>업체명: {log.company_name}</div>
                        <div>근무조: 주간/야간</div>
                    </div>

                    <table className="w-full border-collapse border border-black text-sm text-center">
                        <thead>
                            <tr className="h-10 bg-gray-100">
                                <th className="border border-black w-12 font-bold">순번</th>
                                <th className="border border-black w-32 font-bold">이 름</th>
                                <th className="border border-black font-bold">서 명</th>
                                <th className="border border-black w-12 font-bold">순번</th>
                                <th className="border border-black w-32 font-bold">이 름</th>
                                <th className="border border-black font-bold">서 명</th>
                            </tr>
                        </thead>
                        <tbody>
                            {Array.from({ length: 15 }).map((_, i) => {
                                const p1 = participants[base + i]
                                const p2 = participants[base + i + 15]
                                return (
                                    <tr key={i} className="h-14">
                                        <td className="border border-black">{base + i + 1}</td>
                                        <td className="border border-black font-bold text-lg">{p1?.name || ''}</td>
                                        <td className="border border-black relative">
                                            {p1?.signature && <img src={p1.signature} className="absolute inset-0 w-full h-full object-contain p-1" />}
                                        </td>
                                        <td className="border border-black">{base + i + 16}</td>
                                        <td className="border border-black font-bold text-lg">{p2?.name || ''}</td>
                                        <td className="border border-black relative">
                                            {p2?.signature && <img src={p2.signature} className="absolute inset-0 w-full h-full object-contain p-1" />}
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                    <div className="w-full text-center text-sm border-t border-black pt-2 mt-auto print:mt-auto font-bold">{log.company_name || "현장명"}</div>
                </div>
                );
            })}

            <div className="max-w-[210mm] mx-auto bg-cur-card p-[10mm] print:shadow-none print:w-full mb-8 print:mb-0 print:break-after-page min-h-[297mm] print:h-[297mm] relative box-border flex flex-col overflow-hidden">
                <h1 className="text-3xl font-bold text-center mb-8 tracking-[0.3em]">교 육 사 진</h1>

                <div className="w-full h-[200mm] border-2 border-black flex items-center justify-center p-2 bg-gray-50">
                    {log.photo_url ? (
                        <img src={log.photo_url} className="max-w-full max-h-full object-contain shadow-md" alt="교육 현장" />
                    ) : (
                        <span className="text-gray-400 font-bold text-lg">등록된 현장 사진이 없습니다.</span>
                    )}
                </div>
                <div className="w-full text-center text-sm border-t border-black pt-2 mt-auto print:mt-auto font-bold">{log.company_name || "현장명"}</div>
            </div>

        </div>
    )
}