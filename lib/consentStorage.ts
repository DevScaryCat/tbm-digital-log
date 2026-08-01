// lib/consentStorage.ts — 약관·개인정보처리방침 동의의 브라우저 로컬 기억.
//
// @deprecated 쓰지 마라. 동의 판정은 서버(consents 테이블 + user_metadata 버전)가 하고,
// 화면 게이트는 components/ConsentGate.tsx가 담당한다.
// 이 값은 동의 증빙이 아니다 — 한때 주석이 "실제 동의 증빙은 가입 시점 기록으로 남는다"고
// 단언했지만 그런 기록은 없었고, 운영 계정 다수가 증빙 0건인 채로 남았다.
// 체크박스 프리체크에도 쓰지 않는다: 공용 PC에서 다음 사람이 약관을 안 보고 동의하게 된다.
// 호출부는 제거 중이며, 남은 함수는 그 작업이 끝나면 삭제 대상이다.

const KEY = "antok_terms_agreed_at"

/** @deprecated 동의 여부의 근거가 아니다. lib/consent.ts의 isConsentCurrent를 써라. */
export function hasAgreedTerms(): boolean {
    if (typeof window === "undefined") return false
    try {
        return !!localStorage.getItem(KEY)
    } catch {
        return false // 프라이빗 모드·스토리지 차단 환경
    }
}

/** @deprecated 증빙으로 남지 않는다. 서버 기록은 /api/consent가 한다. */
export function setAgreedTerms(agreed: boolean): void {
    if (typeof window === "undefined") return
    try {
        if (agreed) localStorage.setItem(KEY, new Date().toISOString())
        else localStorage.removeItem(KEY)
    } catch {
        /* 저장 실패해도 이번 세션 동의는 유효 */
    }
}
