import { createHmac } from "crypto"
import { SolapiMessageService } from "solapi"

// 휴대폰인증(솔라피 SMS OTP) — 카드 없는 Pro 무료체험(lib/billing TRIAL_DAYS일) 게이트.
//
// 활성화 규칙: SOLAPI_API_KEY/SECRET/SENDER 3개가 모두 있으면 실발송으로 켜진다.
// 프로덕션에 키가 없으면 기능 자체가 꺼져 기존(카드 우선) 가입 흐름이 그대로 유지된다 —
// 환경변수를 넣는 순간부터 신규 가입에만 적용되는 안전한 롤아웃.
// 로컬 개발(NODE_ENV!=='production')에서는 키가 없어도 켜지되, 발송 대신 서버 콘솔에 코드를 찍는다.

export function phoneAuthLive(): boolean {
  return !!(process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET && process.env.SOLAPI_SENDER)
}

export function phoneAuthEnabled(): boolean {
  return phoneAuthLive() || process.env.NODE_ENV !== "production"
}

/** 휴대폰 번호 정규화: 숫자만 남겨 010XXXXXXXX 형태 검증. 실패 시 null */
export function normalizePhone(input: unknown): string | null {
  if (typeof input !== "string") return null
  const digits = input.replace(/\D/g, "")
  return /^010\d{8}$/.test(digits) ? digits : null
}

/**
 * 개발자 테스트 번호 — 무료체험 1회 제한(trial_redemptions)과 탈퇴 표식(withdrawn_users)
 * 검사·기록을 전부 우회한다. 같은 번호로 가입→탈퇴→재가입 반복 테스트가 영구히 가능.
 * TRIAL_TEST_PHONES 환경변수(쉼표 구분)는 이 기본값을 **대체**한다(추가 아님) —
 * env를 쓸 때는 기존 번호까지 전부 나열할 것.
 * 2026-08-17: 01022521071 테스터 추가(Chris). 01063522968은 8/16 탈퇴 표식에 걸려
 * 무제한이 깨져 있었음 → 탈퇴 표식 우회도 이날 함께 추가.
 */
export function isTrialTestPhone(phone: string | null): boolean {
  if (!phone) return false
  return (process.env.TRIAL_TEST_PHONES ?? "01063522968,01022521071")
    .split(",")
    .map((p) => p.replace(/\D/g, ""))
    .includes(phone)
}

/** OTP 해시 — 평문 코드는 저장하지 않는다 */
export function hashOtp(phone: string, code: string): string {
  const secret = process.env.SOLAPI_API_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  return createHmac("sha256", secret).update(`${phone}:${code}`).digest("hex")
}

export function generateOtpCode(): string {
  // crypto 기반 6자리 (Math.random 지양)
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return String(buf[0] % 1000000).padStart(6, "0")
}

/** 인증번호 SMS 발송. 라이브 키가 없으면(개발) 서버 콘솔에 출력만 한다. */
export async function sendOtpSms(phone: string, code: string): Promise<void> {
  if (!phoneAuthLive()) {
    console.log(`[phone-auth DEV] ${phone} 인증번호: ${code}`)
    return
  }
  const service = new SolapiMessageService(process.env.SOLAPI_API_KEY!, process.env.SOLAPI_API_SECRET!)
  // 발신번호는 하이픈이 섞여 있어도(예: 010-6352-2968) 숫자만 사용 — env 실수 방지
  const from = (process.env.SOLAPI_SENDER || "").replace(/\D/g, "")
  await service.send({
    to: phone,
    from,
    text: `[안톡] 인증번호 [${code}]를 입력해주세요. 타인에게 알려주지 마세요.`,
  })
}
