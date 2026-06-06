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
