// 공지사항 — 새 공지는 이 배열 맨 위에 추가하면 됩니다. (최신이 위)
export interface Notice {
    id: string // 고유값 (닫음 상태 저장에 사용 — 새 공지는 새 id)
    date: string // 표시용 날짜
    title: string
    body: string
}

export const NOTICES: Notice[] = [
    // 2026-07-26 "기존 가입자 요금제 안내" 공지 내림 (Chris 지시)
]
