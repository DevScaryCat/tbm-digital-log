// lib/riskMatrix.ts — 위험 정도(상/중/하) 정규화 헬퍼.
// 2026-07 결정: "위험성 평가 방법" 선택(상중하법/빈도·강도법 + 매트릭스)은 제품에서 제거됨.
//  - TBM 회의록의 위험요인별 '위험 정도(상/중/하)'는 회의록 양식의 일부로 유지.
//  - AI 분석 보고서(구 위험성평가)는 등급 산정 없이 정보성 기록만 생성.
//  - 아래 normLevel은 기존 저장 데이터(freq_sev 시절 등급 포함) 표시용으로만 남긴다.

export type RiskLevel = "상" | "중" | "하"

/** 저장된 등급 문자열을 상/중/하로 정규화 (구데이터 4단계 매우높음/높음/보통/낮음 포함) */
export function normLevel(v: unknown): RiskLevel {
    const s = String(v ?? "").trim()
    if (s === "상" || s === "매우높음" || s === "높음") return "상"
    if (s === "중" || s === "보통") return "중"
    if (s === "하" || s === "낮음") return "하"
    return "중"
}
