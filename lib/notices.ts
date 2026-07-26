// 공지사항 — 새 공지는 이 배열 맨 위에 추가하면 됩니다. (최신이 위)
export interface Notice {
    id: string // 고유값 (닫음 상태 저장에 사용 — 새 공지는 새 id)
    date: string // 표시용 날짜
    title: string
    body: string
}

export const NOTICES: Notice[] = [
    {
        id: "2025-06-grandfather-basic",
        date: "2025.06.06",
        title: "기존 가입자 요금제 안내",
        body: "2025년 6월 6일 이전에 가입하신 분들은 정책 변경 전까지 무료로 계속 이용하실 수 있습니다. AI 분석 보고서·월간 보고서를 쓰시려면 카드를 등록해 주세요 (계정 1개당 월 3,900원).",
    },
]
