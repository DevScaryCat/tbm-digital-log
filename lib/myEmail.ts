// lib/myEmail.ts — 보고서를 받을 수 있는 "내 이메일" 판정 (클라·서버 겸용 순수 모듈)
// 아이디 가입 계정의 auth email은 가짜(아이디@tbm.com)라 인증된 real_email만 신뢰하고,
// 카카오 가입자는 카카오가 이미 검증한 주소라 별도 인증 없이 그대로 쓴다.

export interface MyEmailSource {
  email?: string | null // auth.users.email
  user_metadata?: Record<string, unknown> | null
  app_metadata?: Record<string, unknown> | null
  identities?: { provider: string }[] | null
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

  const isKakao =
    (u.app_metadata ?? {})["provider"] === "kakao" ||
    (u.identities ?? []).some((i) => i.provider === "kakao")
  if (isKakao && typeof u.email === "string" && u.email.trim()) {
    const email = u.email.trim()
    // 카카오 계정이라도 가짜 도메인이 섞여 들어온 경우는 수신 불가로 본다
    if (email.toLowerCase().endsWith("@tbm.com")) return null
    return email
  }

  return null
}
