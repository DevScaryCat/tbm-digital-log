import React from "react"

interface ReportViewProps {
    log: any;
    participants: any[];
}

export const ReportView: React.FC<ReportViewProps> = ({ log, participants }) => {
    if (!log) return null;

    const maleCount = participants.filter(p => p.gender === 'M').length;
    const femaleCount = participants.filter(p => p.gender === 'F').length;
    const totalCount = participants.length;

    return (
        <div className="report-container bg-white text-black">

            {/* --- PAGE 1: 교육일지 --- */}
            <div className="w-[210mm] h-[297mm] p-[15mm] relative box-border mx-auto bg-white shadow-lg print:shadow-none print:break-after-page">
                <h1 className="text-3xl font-bold text-center mb-8" style={{ fontFamily: "Batang, serif" }}>안 전 보 건 교 육 일 지</h1>

                <table className="w-full border-collapse border border-black text-sm" style={{ fontFamily: "Dotum, sans-serif", tableLayout: "fixed" }}>
                    <colgroup>
                        <col style={{ width: "15%" }} />
                        <col style={{ width: "17%" }} />
                        <col style={{ width: "17%" }} />
                        <col style={{ width: "17%" }} />
                        <col style={{ width: "17%" }} />
                        <col style={{ width: "17%" }} />
                    </colgroup>
                    <tbody>
                        <tr className="h-16">
                            <td className="border border-black bg-gray-100 text-center font-bold">교육 명칭</td>
                            <td className="border border-black p-2" colSpan={5}>
                                <div className="grid grid-cols-2 gap-y-1 gap-x-2 text-xs">
                                    <label className="flex items-center"><input type="checkbox" checked={log.education_type === '정기 안전교육'} readOnly className="mr-1" /> 정기 안전교육</label>
                                    <label className="flex items-center"><input type="checkbox" checked={log.education_type === '특별안전보건교육'} readOnly className="mr-1" /> 특별안전보건교육</label>
                                    <label className="flex items-center"><input type="checkbox" checked={log.education_type === '신규 채용시 교육'} readOnly className="mr-1" /> 신규 채용시 교육</label>
                                    <label className="flex items-center"><input type="checkbox" checked={log.education_type === '관리 감독자 교육'} readOnly className="mr-1" /> 관리 감독자 교육</label>
                                    <label className="flex items-center"><input type="checkbox" checked={log.education_type === '작업내용 변경시 교육'} readOnly className="mr-1" /> 작업내용 변경시 교육</label>
                                    <label className="flex items-center"><input type="checkbox" checked={log.education_type.includes('기타')} readOnly className="mr-1" /> 기타</label>
                                </div>
                            </td>
                        </tr>
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
                        <tr className="h-10">
                            <td className="border border-black bg-gray-100 text-center font-bold">교육 시간</td>
                            <td className="border border-black p-2 text-center" colSpan={5}>
                                {log.date} &nbsp; {log.start_time?.slice(0, 5)} ~ {log.end_time?.slice(0, 5)}
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
                        <tr className="h-[80mm]"> {/* 높이 강제 고정 */}
                            <td className="border border-black bg-gray-100 text-center font-bold">교육 내용</td>
                            <td className="border border-black p-4 align-top whitespace-pre-wrap leading-relaxed overflow-hidden text-xs" colSpan={5}>
                                {log.education_content}
                            </td>
                        </tr>
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
                                {log.instructor_signature && <img src={log.instructor_signature} className="h-12 mx-auto object-contain" alt="서명" />}
                            </td>
                        </tr>
                        <tr className="h-24">
                            <td className="border border-black bg-gray-100 text-center font-bold">특 이 사 항</td>
                            <td className="border border-black p-2 align-top text-xs" colSpan={5}>{log.remarks}</td>
                        </tr>
                    </tbody>
                </table>
                <div className="absolute bottom-10 left-0 w-full text-center text-sm border-t border-black pt-2">무신사로지스틱스</div>
            </div>

            {/* --- PAGE 2: 참석자 명단 --- */}
            <div className="w-[210mm] h-[297mm] p-[15mm] relative box-border mx-auto bg-white shadow-lg print:shadow-none print:break-after-page flex flex-col">
                <h1 className="text-3xl font-bold text-center mb-8 mt-4" style={{ fontFamily: "Batang, serif" }}>교 육 참 석 자 명 단</h1>
                <div className="flex justify-between mb-4 text-sm font-bold">
                    <div>일시: {log.date}</div>
                    <div>업체명: {log.company_name}</div>
                </div>
                <table className="w-full border-collapse border border-black text-sm text-center" style={{ tableLayout: "fixed" }}>
                    <colgroup>
                        <col style={{ width: "10%" }} />
                        <col style={{ width: "25%" }} />
                        <col style={{ width: "15%" }} />
                        <col style={{ width: "10%" }} />
                        <col style={{ width: "25%" }} />
                        <col style={{ width: "15%" }} />
                    </colgroup>
                    <thead>
                        <tr className="h-10 bg-gray-100">
                            <th className="border border-black">순번</th>
                            <th className="border border-black">이 름</th>
                            <th className="border border-black">서 명</th>
                            <th className="border border-black">순번</th>
                            <th className="border border-black">이 름</th>
                            <th className="border border-black">서 명</th>
                        </tr>
                    </thead>
                    <tbody>
                        {Array.from({ length: 15 }).map((_, i) => {
                            const p1 = participants[i];
                            const p2 = participants[i + 15];
                            return (
                                <tr key={i} className="h-14">
                                    <td className="border border-black">{i + 1}</td>
                                    <td className="border border-black font-bold text-lg">{p1?.name || ''}</td>
                                    <td className="border border-black p-1">
                                        {p1?.signature && <img src={p1.signature} className="h-full max-h-12 mx-auto object-contain" alt="서명" />}
                                    </td>
                                    <td className="border border-black">{i + 16}</td>
                                    <td className="border border-black font-bold text-lg">{p2?.name || ''}</td>
                                    <td className="border border-black p-1">
                                        {p2?.signature && <img src={p2.signature} className="h-full max-h-12 mx-auto object-contain" alt="서명" />}
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
                <div className="absolute bottom-10 left-0 w-full text-center text-sm border-t border-black pt-2">무신사로지스틱스</div>
            </div>

            {/* --- PAGE 3: 사진 (레이아웃 고정) --- */}
            <div className="w-[210mm] h-[297mm] p-[15mm] relative box-border mx-auto bg-white shadow-lg print:shadow-none print:break-after-page flex flex-col">
                <h1 className="text-3xl font-bold text-center mb-8 mt-4" style={{ fontFamily: "Batang, serif" }}>교 육 사 진</h1>

                {/* 사진 영역 고정 (높이 강제) */}
                <div className="w-full h-[200mm] border border-black flex items-center justify-center p-2 mb-4">
                    {log.photo_url ? (
                        <img src={log.photo_url} className="max-w-full max-h-full object-contain" alt="교육 현장" />
                    ) : (
                        <span className="text-gray-400">등록된 사진 없음</span>
                    )}
                </div>

                <div className="absolute bottom-10 left-0 w-full text-center text-sm border-t border-black pt-2">무신사로지스틱스</div>
            </div>
        </div>
    );
};