import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 실제 결제(카드 등록·정기결제·플랜 변경) 허용 여부.
 * 실연동 전까지 운영(prod)에서는 막고, 개발 모드에서만 테스트 가능.
 * 실연동 완료 후 Vercel에 NEXT_PUBLIC_PAYMENTS_ENABLED=true 설정하면 운영에서도 열림.
 */
export function paymentsEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_PAYMENTS_ENABLED === "true") return true
  return process.env.NODE_ENV === "development"
}

/**
 * ISO(YYYY-MM-DD) → 한글 표기("2026년 7월 1일").
 * 리포트/이메일/PDF의 날짜가 폰·브라우저의 자동 링크(파란 밑줄=날짜 데이터 감지)로 걸리는 걸 줄이고
 * 표기도 더 깔끔하게. (실제 조회용 from/to는 별도 인자로 넘기므로 이 값은 표시 전용)
 */
export function isoToKoreanDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso))
  if (!m) return String(iso)
  return `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일`
}

/** 기간 라벨: 같은 날이면 하루만, 다르면 "시작 ~ 끝" (둘 다 한글 표기). */
export function formatRangeLabelKo(from: string, to: string): string {
  return from === to ? isoToKoreanDate(from) : `${isoToKoreanDate(from)} ~ ${isoToKoreanDate(to)}`
}
