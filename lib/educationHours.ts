// lib/educationHours.ts
// 교육/TBM 세션의 소요시간 계산·표기 공용 유틸.
// 홈(app/page.tsx)과 교육 진행도(app/education-progress) 두 화면이 동일 규칙을 쓰도록 한 곳에 모음.
//
// start_time/end_time은 "HH:MM" 또는 "HH:MM:SS" 문자열.
// 저장 시 초까지 기록하면(HH:MM:SS) 1분 미만 세션도 잘리지 않고 초 단위로 그대로 반영된다.
// (예전에는 저장·집계가 분 단위라 30초짜리가 0이 됐음 — 표준값/최소값 없이 '실제 걸린 시간'만 센다.)

export interface TimeRow {
  start_time: string | null
  end_time: string | null
}

function toSeconds(t: string): number {
  const [h = 0, m = 0, s = 0] = t.split(":").map(Number)
  return h * 3600 + m * 60 + s
}

/** 한 세션의 소요시간(초). 시작·종료가 같은 '분' 안이어도 초 단위로 정확히 집계. */
export function sessionSeconds(start: string | null, end: string | null): number {
  if (!start || !end) return 0
  let diff = toSeconds(end) - toSeconds(start)
  if (diff < 0) diff += 86400 // 자정을 넘긴 경우(예: 23:59:30 ~ 00:00:10)
  return diff > 0 ? diff : 0
}

/** 여러 세션 소요시간 합계(초). */
export function totalSeconds(rows: TimeRow[]): number {
  let sec = 0
  for (const r of rows) sec += sessionSeconds(r.start_time, r.end_time)
  return sec
}

/**
 * 초 → 시간(소수). 반기 의무시간(12h/6h) 대비 %·이수 판정용.
 * 표기(formatDuration)와 같은 0.1시간 단위로 반올림한다 — 화면에 "12.0시간 / 12시간"이
 * 떠 있는데 판정은 99%·미이수가 되는 모순 방지(홈·교육 진행도 공통 규칙).
 */
export function secondsToHours(seconds: number): number {
  return Math.round((seconds / 3600) * 10) / 10
}

/**
 * 사람이 읽는 소요시간 표기. 실제 걸린 만큼 그대로 보여준다(표준값·최소값 없음).
 *  - 1분 미만  → "N초"
 *  - 1시간 미만 → "N분"
 *  - 그 이상   → "N.N시간"
 */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  if (s <= 0) return "0분"
  if (s < 60) return `${s}초`
  if (s < 3600) return `${Math.round(s / 60)}분`
  return `${(s / 3600).toFixed(1)}시간`
}
