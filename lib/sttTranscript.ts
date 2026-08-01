// 브라우저 STT 확정(final) 청크 누적기 — iOS Safari(WebKit) 중복 팽창 보정.
//
// iOS Safari의 SpeechRecognition은 스펙과 달리 확정 결과를 '누적 형태'로 반복 반환한다:
// "집에서" → "집에서 살" → "집에서 살 때" 가 각각 final로 도착해, 단순 append하면
// 같은 문장의 성장 과정이 통째로 저장된다(실데이터: 발화 4문장이 9,605자로 팽창).
// 새 청크가 기존 누적본(또는 그 끝부분)의 연장이면 대체하고, 아니면 이어붙인다.
// 표준 동작 브라우저(청크=완결 발화, 겹침 없음)에서는 기존 append와 동일하게 동작한다.

/** 확정 청크 1개를 누적본에 반영한 결과를 반환 (누적본은 항상 단일 공백·후행 공백 1개 규약) */
export function appendSttFinal(prev: string, rawChunk: string): string {
    const chunk = rawChunk.replace(/\s+/g, " ").trim()
    if (!chunk) return prev
    const base = prev.replace(/\s+$/, "")
    if (!base) return chunk + " "

    // ① 세션 전체의 연장(iOS 최악 케이스: 매번 처음부터 전체 재전송) — 통째로 대체
    if (chunk.startsWith(base)) return chunk + " "

    // ② 동일 내용 재전송 — 무시. 짧은 청크는 실제 반복 발화("안전, 안전")일 수 있어 제외
    if (chunk.length >= 10 && base.endsWith(chunk)) return prev

    // ③ 마지막 구간의 연장(구간 단위 누적) — 겹치는 접미사를 새 청크로 대체.
    //    비교 창은 청크 길이만큼이면 충분하고, 병리적 장문 대비 2,000자로 상한.
    const win = Math.min(chunk.length - 1, base.length, 2000)
    const tail = base.slice(base.length - win)
    for (let k = win; k >= 2; k--) {
        let match = true
        for (let j = 0; j < k; j++) {
            if (tail[tail.length - k + j] !== chunk[j]) { match = false; break }
        }
        if (match) return base.slice(0, base.length - k) + chunk + " "
    }

    return base + " " + chunk + " "
}

/** onresult 이벤트에서 뽑은 확정 청크들을 순서대로 누적본에 반영 */
export function appendSttFinals(prev: string, chunks: string[]): string {
    let acc = prev
    for (const c of chunks) acc = appendSttFinal(acc, c)
    return acc
}
