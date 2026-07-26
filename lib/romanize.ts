// 한글 → 로마자(개정 로마자 표기법 근사) — 현장 계정 아이디 시드 추천용.
// 음운 동화(연음 등)는 반영하지 않는다: 아이디 시드는 '읽을 수 있고 타이핑하기 쉬운'
// 정도면 충분하고, 규칙을 단순하게 유지해야 사용자가 결과를 예측할 수 있다.

const CHO = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"]
const JUNG = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"]
const JONG = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "p", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"]

/** 한글 음절을 로마자로. 한글 외 영문·숫자는 소문자로 통과, 나머지는 버린다. */
export function romanizeKorean(input: string): string {
    let out = ""
    for (const ch of input) {
        const code = ch.codePointAt(0) ?? 0
        if (code >= 0xac00 && code <= 0xd7a3) {
            const idx = code - 0xac00
            out += CHO[Math.floor(idx / 588)] + JUNG[Math.floor((idx % 588) / 28)] + JONG[idx % 28]
        } else if (/[a-zA-Z0-9_]/.test(ch)) {
            out += ch.toLowerCase()
        } else if (/\s/.test(ch)) {
            out += "_" // 띄어쓰기는 언더바로 — "하이 물류" → hai_mullyu
        }
        // 그 외 특수문자는 아이디에 못 들어가므로 버림
    }
    return out.replace(/_+/g, "_").replace(/^_+|_+$/g, "")
}

/** 사용자가 한글·띄어쓰기 섞어 입력해도 아이디 규칙에 맞는 시드로 정규화 */
export function sanitizeStem(input: string): string {
    return romanizeKorean(input).slice(0, 12)
}

/** 아이디 시드 규칙 — 영문/숫자 시작, 2~12자 (뒤에 연번 2자리가 붙는다) */
export const STEM_RE = /^[a-z0-9][a-z0-9_]{1,11}$/

/** 회사명에서 아이디 시드 후보를 만든다 — 전체 로마자, 짧은 버전, 범용 폴백 순 */
export function suggestIdStems(companyName: string): string[] {
    const full = romanizeKorean(companyName).slice(0, 10)
    const out: string[] = []
    const push = (v: string) => {
        if (STEM_RE.test(v) && !out.includes(v)) out.push(v)
    }
    push(full)
    push(full.slice(0, 4))
    push("site")
    return out
}

/** 읽어주기 쉬운 초기 비밀번호 — 담당자가 첫 로그인 때 반드시 새로 정한다 */
export function suggestInitialPassword(): string {
    const n = Math.floor(1000 + Math.random() * 9000)
    return `antok${n}!`
}
