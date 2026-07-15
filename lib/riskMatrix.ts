// lib/riskMatrix.ts — 위험성평가 방법(상중하 / 빈도강도)과 매트릭스 척도의 단일 소스.
// 회의록·위험성평가 생성 라우트와 렌더(HTML/xlsx/PDF)·설정 UI가 공통으로 참조한다.

export type RiskMethod = "level3" | "freq_sev" // level3=상중하, freq_sev=빈도강도
export type MatrixScale = "3x3" | "5x4" | "5x5"
export type RiskLevel = "상" | "중" | "하"

export const RISK_METHODS: RiskMethod[] = ["level3", "freq_sev"]
export const MATRIX_SCALES: MatrixScale[] = ["3x3", "5x4", "5x5"]

/** DB/입력값 정규화 (모르는 값이면 기본으로) */
export function normMethod(v: unknown): RiskMethod {
    return v === "freq_sev" ? "freq_sev" : "level3"
}
export function normMatrix(v: unknown): MatrixScale {
    return v === "5x4" || v === "5x5" ? v : "3x3"
}

/** 저장된 등급 문자열을 상/중/하로 정규화 (구데이터 4단계 매우높음/높음/보통/낮음 포함) */
export function normLevel(v: unknown): RiskLevel {
    const s = String(v ?? "").trim()
    if (s === "상" || s === "매우높음" || s === "높음") return "상"
    if (s === "중" || s === "보통") return "중"
    if (s === "하" || s === "낮음") return "하"
    return "중"
}

export const RISK_METHOD_LABEL: Record<RiskMethod, string> = {
    level3: "상중하법",
    freq_sev: "빈도·강도법",
}
export const MATRIX_LABEL: Record<MatrixScale, string> = {
    "3x3": "3×3 (가능성·중대성 3단계)",
    "5x4": "5×4 (빈도 5 · 강도 4)",
    "5x5": "5×5 (빈도 5 · 강도 5)",
}

/** 각 매트릭스의 빈도(발생가능성)·강도(중대성) 최대 단계 */
export const MATRIX_DIMS: Record<MatrixScale, { freqMax: number; sevMax: number }> = {
    "3x3": { freqMax: 3, sevMax: 3 },
    "5x4": { freqMax: 5, sevMax: 4 },
    "5x5": { freqMax: 5, sevMax: 5 },
}

/**
 * 위험도(빈도×강도) 점수와 상/중/하 등급.
 * 경계는 최대점수의 1/3·2/3 지점 — 매트릭스 크기와 무관하게 일관.
 * (예: 3x3 max9 → ≥6 상 / >3 중 / ≤3 하, 5x5 max25 → ≥17 상 / >8 중 / ≤8 하)
 */
export function freqSevGrade(
    freq: number,
    sev: number,
    scale: MatrixScale
): { score: number; level: RiskLevel } {
    const { freqMax, sevMax } = MATRIX_DIMS[scale]
    const f = Math.min(Math.max(1, Math.round(freq || 1)), freqMax)
    const s = Math.min(Math.max(1, Math.round(sev || 1)), sevMax)
    const score = f * s
    const max = freqMax * sevMax
    const level: RiskLevel = score >= max * (2 / 3) ? "상" : score > max * (1 / 3) ? "중" : "하"
    return { score, level }
}

/** AI 생성 프롬프트에 넣을 빈도강도 척도 설명 */
export function matrixPromptGuide(scale: MatrixScale): string {
    const { freqMax, sevMax } = MATRIX_DIMS[scale]
    return `빈도강도법 ${scale}: frequency(발생가능성) 1~${freqMax} 정수, severity(중대성) 1~${sevMax} 정수. 위험도 = frequency × severity. 값이 클수록 위험.`
}
