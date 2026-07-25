// lib/consentStorage.ts — 약관·개인정보처리방침 동의 기억(브라우저 로컬).
// 동의는 최초 1회 받으면 되는 것이라, 방문할 때마다 다시 체크하게 만들 이유가 없다.
// (서버 기록이 아니라 UI 편의용 — 실제 동의 증빙은 가입 시점 기록으로 남는다)

const KEY = "antok_terms_agreed_at"

/** 이전에 동의한 적이 있는지 */
export function hasAgreedTerms(): boolean {
    if (typeof window === "undefined") return false
    try {
        return !!localStorage.getItem(KEY)
    } catch {
        return false // 프라이빗 모드·스토리지 차단 환경
    }
}

/** 동의 상태 저장/해제 */
export function setAgreedTerms(agreed: boolean): void {
    if (typeof window === "undefined") return
    try {
        if (agreed) localStorage.setItem(KEY, new Date().toISOString())
        else localStorage.removeItem(KEY)
    } catch {
        /* 저장 실패해도 이번 세션 동의는 유효 */
    }
}
