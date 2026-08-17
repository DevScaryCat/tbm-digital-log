// lib/myEmail.ts — 보고서를 받을 수 있는 "내 이메일" 판정 (클라·서버 겸용 순수 모듈)
// 아이디 가입 계정의 auth email은 가짜(아이디@tbm.com)라 인증된 real_email만 신뢰하고,
// 카카오 가입자는 카카오가 이미 검증한 주소라 별도 인증 없이 그대로 쓴다.

export interface MyEmailSource {
  email?: string | null // auth.users.email
  user_metadata?: Record<string, unknown> | null
  app_metadata?: Record<string, unknown> | null
  identities?: { provider: string }[] | null
}

// 소셜 계정 판정(카카오+애플, 2026-08-17 애플 로그인 도입) — 이름은 호환을 위해 유지.
// 둘 다 비밀번호가 없고 provider가 검증한 이메일이 auth email로 온다는 점에서 규칙이 같다.
// 애플 '이메일 가리기'의 @privaterelay.appleid.com 주소도 실수신 가능(발신 도메인을 애플
// 콘솔에 등록해야 함 — STORE_SUBMISSION §9).
export function isKakaoUser(u: MyEmailSource): boolean {
  return (
    ["kakao", "apple"].includes(String((u.app_metadata ?? {})["provider"])) ||
    (u.identities ?? []).some((i) => i.provider === "kakao" || i.provider === "apple")
  )
}

/**
 * 비밀번호를 잃었을 때 계정을 되찾을 수 있는가 — 등록 유도 화면의 단일 판정.
 *
 * 서버(lib/accountRecovery.ts)가 복구 메일을 보내는 조건과 같은 기준이어야 한다.
 * user_metadata.real_email_verified_at만 보면 안 된다 — 온보딩(app/api/onboarding)이
 * 링크 인증 없이도 그 시각을 찍기 때문에, 메타데이터만 믿으면 실제로는 복구 메일이
 * 안 나가는 계정을 '복구 가능'으로 표시하게 된다(잠긴 뒤에야 드러나는 거짓 안심).
 * 그래서 판정 근거는 서버가 내려주는 recoveryReady(GET /api/auth/email —
 * 재설정 메일 발송 조건인 hasLinkVerifiedRecoveryEmail과 동일 기준) 하나다.
 *
 * 카카오 계정은 비밀번호 자체가 없어(로그인=카카오) 잃을 것도 없다 → 조르지 않는다.
 * 판정 불가(u가 없음, recoveryReady 조회 전/실패=null·undefined)도 true —
 * 근거 없이 경고부터 띄우지 않는다.
 */
export function canRecoverAccount(
  u: MyEmailSource | null | undefined,
  recoveryReady: boolean | null | undefined,
): boolean {
  if (!u) return true
  if (isKakaoUser(u)) return true
  if (recoveryReady == null) return true
  return recoveryReady
}

/** 보고서를 받을 수 있는 "내 이메일". 인증된 real_email > 카카오 계정 이메일 > null */
export function resolveMyReportEmail(u: MyEmailSource | null | undefined): string | null {
  if (!u) return null

  const meta = u.user_metadata ?? {}
  const realEmail = meta["real_email"]
  // 인증 완료(real_email_verified_at 존재) 전의 real_email은 수신 보장이 없어 쓰지 않는다
  if (typeof realEmail === "string" && realEmail.trim() && meta["real_email_verified_at"]) {
    return realEmail.trim()
  }

  if (isKakaoUser(u) && typeof u.email === "string" && u.email.trim()) {
    const email = u.email.trim()
    // 카카오 계정이라도 가짜 도메인이 섞여 들어온 경우는 수신 불가로 본다
    if (email.toLowerCase().endsWith("@tbm.com")) return null
    return email
  }

  return null
}
