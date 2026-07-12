import React from "react"

// TBM 회의록 문서 서식 (배치 인쇄용). report/minutes/[id] 단건 뷰와 동일 서식.
// 서명 이미지는 호출부에서 signed URL로 변환해 전달한다(버킷 private 대응).
export function MinutesView({ minutes, participants }: { minutes: any; participants: any[] }) {
    return (
        <div className="max-w-[210mm] mx-auto bg-cur-card print:shadow-none print:w-full min-h-[297mm] box-border pb-10 text-black break-after-page">
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
                                <td colSpan={2} className="border border-black p-2 align-top text-xs break-all">□ {hazard?.factor}</td>
                                <td className="border border-black p-2 text-center font-bold text-red-600">{hazard?.level || '상/중/하'}</td>
                                <td className="border border-black p-2 align-top text-xs break-all">□ {hazard?.measure}</td>
                            </tr>
                        );
                    })}

                    <tr>
                        <td colSpan={4} className="border border-black border-t-2 p-2 font-bold text-sm">■ 작업 시작전 확인사항</td>
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
                            <div className="flex w-full"><div className="flex-1 border-r border-black">이름</div><div className="flex-1">서명</div></div>
                        </td>
                        <td colSpan={2} className="border border-black !w-1/2">
                            <div className="flex w-full"><div className="flex-1 border-r border-black">이름</div><div className="flex-1">서명</div></div>
                        </td>
                    </tr>

                    {(() => {
                        // 참석자 전원 표시(2열). 31명 이상도 유실 없이 — 좌/우 열 분할점을 인원수에 맞춰 동적 산정(최소 15행).
                        const rows = Math.max(15, Math.ceil(participants.length / 2));
                        return Array.from({ length: rows }).map((_, i) => {
                            const p1 = participants[i];
                            const p2 = participants[i + rows];
                            return (
                                <tr key={i} className="h-10 text-center">
                                    <td colSpan={2} className="border border-black p-0 h-10">
                                        <div className="flex w-full h-10 items-center">
                                            <div className="flex-1 border-r border-black h-full flex items-center justify-center font-bold text-sm truncate px-1">{p1?.name || ''}</div>
                                            <div className="flex-1 h-full relative">
                                                {p1?.signature && <img src={p1.signature} className="absolute inset-0 w-full h-full object-contain p-1" alt="서명" />}
                                            </div>
                                        </div>
                                    </td>
                                    <td colSpan={2} className="border border-black p-0 h-10">
                                        <div className="flex w-full h-10 items-center">
                                            <div className="flex-1 border-r border-black h-full flex items-center justify-center font-bold text-sm truncate px-1">{p2?.name || ''}</div>
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
    )
}
