// lib/withdrawal.ts — 회원탈퇴 부정이용 방지 표식 (2026-08-14 Chris 승인 설계)
//
// 탈퇴 시 개인 데이터는 파기(개인정보보호법)하되, 같은 번호·카카오·이메일로 재가입해
// 무료체험을 다시 받는 것을 막기 위한 **복원 불가능한 해시**만 withdrawn_users에 남긴다.
// 보관 1년 — 조회 시 withdrawn_at 조건으로 걸러 읽는다(지난 표식은 자연 무효).
// 처리방침 근거 조항은 다음 개정 때 함께 나간다(부정이용 방지 목적·해시·보관 기간).
import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// 위협 모델은 '체험 재수령'이지 비밀 유출이 아니다 — 솔트는 무지개표 차단용 고정 문자열이면
// 충분하고, env로 빼면 환경마다 값이 갈라져 표식 대조가 조용히 깨진다.
const SALT = "antok-withdrawal-mark-v1";
export const MARK_TTL_DAYS = 365;

export function markHash(value: string): string {
  return createHash("sha256").update(`${SALT}:${value.trim().toLowerCase()}`).digest("hex");
}

export interface WithdrawalMarks {
  phoneHash: string | null;
  kakaoHash: string | null;
  /** auth 이메일(아이디 가입은 합성 `id@tbm.com`) + real_email — 있는 것 전부 (2026-08-16 QA:
   *  auth 이메일만 남기면 signup 대조(realEmail)와 교집합이 공집합이라 차단이 무동작이었다) */
  emailHashes: string[];
}

/** 탈퇴하는 사용자에게서 표식 재료를 뽑는다 — 있는 것만 해시한다 */
export function extractMarks(user: {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
  identities?: { provider: string; id?: string; identity_data?: Record<string, unknown> | null }[] | null;
}): WithdrawalMarks {
  const phone = String(user.user_metadata?.phone ?? "").replace(/\D/g, "");
  const kakao = (user.identities ?? []).find((i) => i.provider === "kakao");
  // 카카오 식별자는 provider user id — identity_data.sub 또는 provider_id에 있다
  const kakaoId = String(kakao?.identity_data?.sub ?? kakao?.identity_data?.provider_id ?? kakao?.id ?? "");
  const emails = [String(user.email ?? ""), String(user.user_metadata?.real_email ?? "")]
    .map((e) => e.trim())
    .filter(Boolean);
  return {
    phoneHash: phone ? markHash(phone) : null,
    kakaoHash: kakao && kakaoId ? markHash(kakaoId) : null,
    emailHashes: [...new Set(emails.map(markHash))],
  };
}

/** 표식 기록 — 실패해도 throw하지 않는다(탈퇴 자체를 막으면 안 된다). 성공 여부 반환 */
export async function recordWithdrawalMarks(
  admin: SupabaseClient,
  marks: WithdrawalMarks,
  trialUsed: boolean,
): Promise<boolean> {
  const emails = marks.emailHashes.length ? marks.emailHashes : [null];
  if (!marks.phoneHash && !marks.kakaoHash && !emails[0]) return true;
  // 이메일이 여럿(로그인용 합성 + 실이메일)이면 행을 나눠 각각 대조 가능하게 남긴다
  const rows = emails.map((e, i) => ({
    phone_hash: i === 0 ? marks.phoneHash : null,
    kakao_hash: i === 0 ? marks.kakaoHash : null,
    email_hash: e,
    trial_used: trialUsed,
  }));
  const { error } = await admin.from("withdrawn_users").insert(rows);
  if (error) console.error("withdrawal mark insert error:", error);
  return !error;
}

/** 재가입자가 이전 탈퇴 계정에서 체험을 이미 썼는가 — 1년 지난 표식은 무시 */
export async function usedTrialBeforeWithdrawal(
  admin: SupabaseClient,
  marks: { phoneHash?: string | null; kakaoHash?: string | null; emailHashes?: (string | null)[] },
): Promise<boolean> {
  const ors: string[] = [];
  if (marks.phoneHash) ors.push(`phone_hash.eq.${marks.phoneHash}`);
  if (marks.kakaoHash) ors.push(`kakao_hash.eq.${marks.kakaoHash}`);
  for (const e of marks.emailHashes ?? []) if (e) ors.push(`email_hash.eq.${e}`);
  if (!ors.length) return false;
  const since = new Date(Date.now() - MARK_TTL_DAYS * 86_400_000).toISOString();
  const { data, error } = await admin
    .from("withdrawn_users")
    .select("id")
    .or(ors.join(","))
    .eq("trial_used", true)
    .gte("withdrawn_at", since)
    .limit(1);
  // 조회 실패는 통과시킨다 — 어뷰즈 방지가 정상 가입을 막는 쪽으로 실패하면 안 된다
  if (error) {
    console.error("withdrawal mark lookup error:", error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}
