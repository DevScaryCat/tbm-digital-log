/**
 * 음성 원문(STT raw_transcript) 노출 스위치 — 2026-08-18 Chris:
 * "수집은 하는데 원문은 출력물이나 어디서나 보지 못하게 막아줘 일단".
 *
 * false면 사용자 노출만 막는다:
 *  · 출력 3종 빌더(exportDocx·exportXlsx·exportHwpx)의 '음성 원문' 장
 *  · 웹 문서 뷰어(report/[id]·report/minutes/[id])의 원문 섹션·포함 토글
 * 저장(raw_transcript 컬럼)·AI 입력(월간 총평 등)·STT 파이프라인은 그대로다.
 * (앱 쪽은 tbm-app src/lib/reportFlags.ts — 같은 값으로 유지할 것)
 *
 * 되살릴 땐 이 값 하나만 true로.
 */
export const TRANSCRIPT_VISIBLE = false;
