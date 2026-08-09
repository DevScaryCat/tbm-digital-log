// lib/myEmail.ts — 보고서를 받을 수 있는 "내 이메일" 판정 (클라·서버 겸용 순수 모듈)
// 아이디 가입 계정의 auth email은 가짜(아이디@tbm.com)라 인증된 real_email만 신뢰하고,
// 카카오 가입자는 카카오가 이미 검증한 주소라 별도 인증 없이 그대로 쓴다.

export interface MyEmailSource {
  email?: string | null // auth.users.email
  user_metadata?: Record<string, unknown> | null
  app_metadata?: Record<string, unknown> | null
  identities?: { provider: string }[] | null
}

function isKakaoUser(u: MyEmailSource): boolean {
  return (
    (u.app_metadata ?? {})["provider"] === "kakao" ||
    (u.identities ?? []).some((i) => i.provider === "kakao")
  )
}

/**
 * 비밀번호를 잃었을 때 계정을 되찾을 수 있는가 — 등록 유도 화면의 단일 판정.
 *
 * 서버(lib/accountRecovery.ts)가 복구 메일을 보내는 조건과 같은 기준이어야 한다:
 * 인증까지 끝난 real_email이 있을 때만 실제로 메일이 나간다. 미인증 주소는 "등록했다"고
 * 보면 안 된다 — 그 주소로는 아무것도 보내지 않기 때문이다.
 * (accountRecovery.ts는 node:crypto를 쓰는 서버 전용 모듈이라 클라이언트에서 import할 수 없다.
 *  판정만 이 순수 모듈에 둔다.)
 *
 * 카카오 계정은 비밀번호 자체가 없어(로그인=카카오) 잃을 것도 없다 → 조르지 않는다.
 * 판정 불가(u가 없음)도 true — 근거 없이 경고부터 띄우지 않는다.
 */
export function canRecoverAccount(u: MyEmailSource | null | undefined): boolean {
  if (!u) return true
  const meta = u.user_metadata ?? {}
  const realEmail = meta["real_email"]
  if (typeof realEmail === "string" && realEmail.trim() && meta["real_email_verified_at"]) return true
  return isKakaoUser(u)
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
