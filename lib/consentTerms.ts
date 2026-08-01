// lib/consentTerms.ts — 약관·개인정보처리방침 동의의 버전 상수와 판정·기록 헬퍼.
//
// lib/consent.ts가 이 모듈을 그대로 re-export한다(공용 계약의 import 경로는 "@/lib/consent").
// 굳이 파일을 나눈 이유: lib/consent.ts는 보고서 수신자 승인 메일 때문에 nodemailer를
// 최상단에서 끌어오는 서버 전용 모듈이고, 클라이언트 게이트가 거기서 import하면
// 노드 모듈이 브라우저 번들로 따라 들어와 빌드가 깨진다. 이 파일은 노드 의존이 없어
// 서버·클라이언트 양쪽에서 안전하다.
import type { SupabaseClient } from "@supabase/supabase-js";

/** 이용약관 시행일 */
export const TERMS_VERSION = "2026-03-06";
/** 개인정보처리방침 시행일 */
export const PRIVACY_VERSION = "2026-07-13";

/**
 * user_metadata에 현행 버전 동의 기록이 있는지 (게이트 판정용 캐시).
 * 두 문서 중 하나라도 개정되면 false가 되어 재동의를 받는다.
 */
export function isConsentCurrent(meta: Record<string, unknown> | null | undefined): boolean {
  if (!meta) return false;
  // unknown끼리 비교하지 않으려 문자열로 좁힌다 — 값이 없으면 어차피 버전과 불일치
  return (
    String(meta.terms_version ?? "") === TERMS_VERSION &&
    String(meta.privacy_version ?? "") === PRIVACY_VERSION
  );
}

/** 호출자가 자기 metadata patch에 합쳐 넣을 동의 캐시 키들 */
export function consentMetaPatch(): { terms_version: string; privacy_version: string; terms_agreed_at: string } {
  return {
    terms_version: TERMS_VERSION,
    privacy_version: PRIVACY_VERSION,
    terms_agreed_at: new Date().toISOString(),
  };
}

/**
 * 서버 전용 — consents 테이블에 terms/privacy 2행 append(증빙 원장, 갱신이 아니다).
 * metadata는 건드리지 않는다(호출자가 consentMetaPatch로 합침).
 *
 * throw하지 않고 **성공 여부를 반환**한다. 이유: 원장 실패를 삼킨 채 호출부가 metadata에
 * 동의 캐시를 심으면, 증빙 0건인데 게이트만 영구히 닫혀 소급 동의를 다시 받을 길이 없어진다.
 * 호출부는 이 반환값을 보고 캐시 커밋 여부(또는 사용자 재시도 유도)를 결정해야 한다.
 */
export async function recordConsent(
  admin: SupabaseClient,
  userId: string,
  opts: { source: string; ip?: string | null; userAgent?: string | null },
): Promise<boolean> {
  const agreedAt = new Date().toISOString();
  const base = {
    user_id: userId,
    agreed_at: agreedAt,
    source: opts.source,
    ip: opts.ip ?? null,
    user_agent: opts.userAgent ?? null,
  };
  try {
    const { error } = await admin.from("consents").insert([
      { ...base, doc: "terms", version: TERMS_VERSION },
      { ...base, doc: "privacy", version: PRIVACY_VERSION },
    ]);
    if (error) {
      console.error("recordConsent insert error:", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("recordConsent error:", e);
    return false;
  }
}
