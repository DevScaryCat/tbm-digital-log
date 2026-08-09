// lib/accountRecovery.ts — 아이디 찾기 / 비밀번호 재설정 (복구 이메일 기반)
//
// 전제: 안톡의 주력은 아이디 계정이고 로그인 이메일은 가짜({아이디}@tbm.com)다.
// 실제로 닿는 주소는 인증까지 끝난 user_metadata.real_email 하나뿐 — 그 주소로만 복구를 보낸다.
// 미인증 주소로 보내면 "내 이메일" 칸에 남의 주소를 적어둔 계정이 그대로 탈취된다.
//
// 새 이메일 필드를 만들지 않는다: 월간 보고서 수신용으로 이미 인증해둔 real_email을 그대로 복구 채널로 쓴다
// (lib/emailVerification.ts).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMail, mailerConfigured } from "@/lib/mailer";

/** 가입 화면(app/signup)과 같은 규칙 — 여기서 따로 정하지 않는다 */
export const PASSWORD_MIN_LENGTH = 8;

/** 재설정 링크 수명. 이메일 인증 토큰(3일)과 혼동 금지 — 이건 계정을 여는 열쇠다 */
const RESET_TTL_MS = 30 * 60 * 1000;
export const RESET_TTL_LABEL = "30분";

/**
 * 계정 존재 여부를 절대 노출하지 않기 위한 단일 응답 문구.
 * 아이디가 있든 없든, 복구 이메일이 등록됐든 아니든 화면은 항상 이 문장만 본다.
 * (실제 발송 여부는 서버 안에서만 갈린다)
 */
export const RECOVERY_GENERIC_MESSAGE =
  "등록된 복구 이메일로 안내를 보냈어요. 메일함을 확인해주세요.";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 가입 규칙(^[a-z0-9_]{3,20}$)보다 느슨하게 받는다 — 실계정 중에 규칙 밖 아이디(점 포함)가 이미 있고,
// 나중에 조인 규칙이 조여졌다는 이유로 옛 사용자가 복구에서 잠기면 안 된다. 조회는 파라미터 바인딩 RPC라
// 형식 검사는 "명백한 쓰레기 차단"까지만 한다.
const LOGIN_ID_RE = /^[^\s@]{2,64}$/;

export function isValidRecoveryEmail(email: string): boolean {
  // @tbm.com은 발급 계정의 가짜 도메인 — 어떤 메일도 도착하지 않는다
  return EMAIL_RE.test(email) && !email.toLowerCase().endsWith("@tbm.com");
}

export function normalizeLoginId(raw: unknown): string | null {
  const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return LOGIN_ID_RE.test(id) ? id : null;
}

/** {아이디}@tbm.com → 아이디. 카카오 계정(진짜 이메일)은 아이디가 없으므로 null */
export function loginIdFromEmail(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  if (!e.endsWith("@tbm.com")) return null;
  return e.slice(0, -"@tbm.com".length) || null;
}

/** 요청 IP (Vercel은 x-forwarded-for에 클라이언트 IP를 맨 앞에 싣는다) */
export function requestIp(request: Request): string | null {
  const fwd = request.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0]!.trim() || null : null;
}

export function baseUrlFrom(request: Request): string {
  const proto = request.headers.get("x-forwarded-proto") || "https";
  const host = request.headers.get("host");
  const base = host ? `${proto}://${host}` : process.env.NEXT_PUBLIC_APP_URL || "https://www.safetalk.kr";
  return base.replace(/\/$/, "");
}

/** DB에는 해시만 남긴다 — 원문 토큰은 메일 안에만 존재한다 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * 발송 폭주 제한 — 같은 계정에 대해 ① 60초 쿨다운 ② 시간당 5회 ③ 일 10회.
 * app/api/auth/email(실이메일 인증)과 같은 DB-count 패턴이고, 한 번의 조회로 세 창을 모두 판정한다.
 *
 * 막혔을 때 429를 돌려주지 않는 이유: "너무 자주 요청했다"는 응답 자체가 '그 계정이 존재한다'는
 * 신호가 된다. 호출부는 조용히 발송만 건너뛰고 항상 같은 성공 문구를 돌려준다.
 */
export async function recoverySendThrottled(
  admin: SupabaseClient,
  userIds: string[]
): Promise<boolean> {
  if (userIds.length === 0) return true;
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("password_reset_tokens")
    .select("created_at")
    .in("user_id", userIds)
    .gte("created_at", dayAgo);
  // 조회가 실패하면 제한을 못 세운다 — 열어두면 메일 폭탄 경로가 되므로 막는 쪽으로 닫는다
  if (error) {
    console.error("recovery throttle 조회 실패:", error);
    return true;
  }
  const stamps = (data ?? []).map((r) => new Date(r.created_at as string).getTime());
  if (stamps.some((t) => now - t < 60 * 1000)) return true;
  if (stamps.filter((t) => t >= now - 60 * 60 * 1000).length >= 5) return true;
  return stamps.length >= 10;
}

/** 아이디 찾기 발송 이력만 남긴다 (링크가 없으니 토큰도 없다 — 폭주 제한의 근거용) */
export async function logFindIdSend(
  admin: SupabaseClient,
  userIds: string[],
  ip: string | null
): Promise<void> {
  if (userIds.length === 0) return;
  const { error } = await admin.from("password_reset_tokens").insert(
    userIds.map((user_id) => ({
      user_id,
      purpose: "find_id",
      token_hash: null,
      // 아이디 찾기 행은 열쇠가 아니라 이력이다 — 만료 시각에 의미가 없으니 즉시 만료로 둔다
      expires_at: new Date().toISOString(),
      requested_ip: ip,
    }))
  );
  if (error) console.error("find_id 이력 기록 실패:", error);
}

/** 재설정 토큰 발급 → 원문 토큰(메일에만 실린다) 반환 */
async function issueResetToken(
  admin: SupabaseClient,
  userId: string,
  ip: string | null
): Promise<string | null> {
  const token = randomBytes(32).toString("base64url");
  const { error } = await admin.from("password_reset_tokens").insert({
    user_id: userId,
    purpose: "reset",
    token_hash: hashToken(token),
    expires_at: new Date(Date.now() + RESET_TTL_MS).toISOString(),
    requested_ip: ip,
  });
  if (error) {
    console.error("재설정 토큰 발급 실패:", error);
    return null;
  }
  return token;
}

const MAIL_WRAP = (inner: string) =>
  `<div style="max-width:520px;margin:0 auto;font-family:'Apple SD Gothic Neo',Arial,sans-serif;color:#26251e;">${inner}</div>`;

/** 아이디 찾기 안내 메일. 아이디는 메일에만 싣는다 — 응답 본문에 절대 담지 않는다 */
export async function sendFindIdMail(params: {
  to: string;
  loginIds: string[];
  hasKakao: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  if (!mailerConfigured()) return { ok: false, error: "메일 설정이 없습니다." };
  const list = params.loginIds
    .map(
      (id) =>
        `<div style="background:#f6f5f2;border-radius:10px;padding:12px 16px;margin:6px 0;font-size:16px;font-weight:700;">${id}</div>`
    )
    .join("");
  const kakaoNote = params.hasKakao
    ? `<p style="font-size:14px;line-height:1.7;color:#444;">카카오로 가입한 계정도 이 주소로 등록돼 있어요. 카카오 계정은 아이디·비밀번호가 없으니 로그인 화면에서 <b>카카오로 계속하기</b>를 눌러주세요.</p>`
    : "";
  return sendMail({
    to: params.to,
    subject: "[안톡] 회원님의 아이디 안내",
    html: MAIL_WRAP(`
        <h2 style="font-size:18px;">안톡 아이디 안내</h2>
        ${params.loginIds.length > 0 ? `<p style="font-size:14px;line-height:1.7;color:#444;">이 이메일로 등록된 아이디입니다.</p>${list}` : ""}
        ${kakaoNote}
        <a href="https://www.safetalk.kr/login" style="display:inline-block;background:#f54e00;color:#fff;font-weight:700;padding:12px 20px;border-radius:10px;text-decoration:none;font-size:14px;margin-top:12px;">로그인하러 가기</a>
        <p style="font-size:12px;color:#999;margin-top:16px;">본인이 요청하지 않았다면 이 메일을 무시하세요. 비밀번호는 바뀌지 않았습니다.</p>
      `),
  });
}

/**
 * 비밀번호 재설정 메일 발송 (토큰 발급 포함).
 * 발급이 되고 메일까지 나갔을 때만 true — 중간에 실패하면 호출부는 그래도 같은 문구를 돌려준다.
 */
export async function sendResetMail(
  admin: SupabaseClient,
  params: { userId: string; to: string; loginId: string | null; baseUrl: string; ip: string | null }
): Promise<boolean> {
  if (!mailerConfigured()) {
    console.error("재설정 메일 발송 불가: 메일 설정 없음");
    return false;
  }
  const token = await issueResetToken(admin, params.userId, params.ip);
  if (!token) return false;
  const link = `${params.baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
  const r = await sendMail({
    to: params.to,
    subject: "[안톡] 비밀번호 재설정 안내",
    html: MAIL_WRAP(`
        <h2 style="font-size:18px;">비밀번호 재설정</h2>
        <p style="font-size:14px;line-height:1.7;color:#444;">
          ${params.loginId ? `아이디 <b>${params.loginId}</b>의 ` : ""}비밀번호를 새로 정하시려면 아래 버튼을 눌러주세요.
        </p>
        <a href="${link}" style="display:inline-block;background:#f54e00;color:#fff;font-weight:700;padding:12px 20px;border-radius:10px;text-decoration:none;font-size:14px;">비밀번호 새로 정하기</a>
        <p style="font-size:12px;color:#999;margin-top:16px;">
          링크는 ${RESET_TTL_LABEL} 동안만 유효하고, 한 번 쓰면 사라집니다.<br />
          본인이 요청하지 않았다면 이 메일을 무시하세요. 비밀번호는 바뀌지 않습니다.
        </p>
      `),
  });
  if (!r.ok) console.error("재설정 메일 발송 실패:", r.error);
  return r.ok;
}

/**
 * 토큰 소진 — 해시 대조·만료·1회용을 한 번에 확정한다.
 * used_at 갱신을 "아직 안 쓴 행"에만 걸어(조건부 update) 동시 요청 두 개가 같은 토큰을 쓰는 경우를 막는다.
 */
export async function consumeResetToken(
  admin: SupabaseClient,
  token: string
): Promise<{ userId: string } | { error: string }> {
  const expired = "링크가 만료되었거나 이미 사용되었습니다. 비밀번호 찾기를 다시 요청해주세요.";
  if (!token || token.length < 20) return { error: expired };

  const { data: row } = await admin
    .from("password_reset_tokens")
    .select("id, user_id, token_hash, expires_at, used_at")
    .eq("token_hash", hashToken(token))
    .eq("purpose", "reset")
    .maybeSingle();
  if (!row) return { error: expired };

  // 해시는 인덱스로 이미 찾았지만, 대조 자체는 상수 시간으로 한 번 더 (타이밍 관찰 차단)
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(String(row.token_hash), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { error: expired };

  if (row.used_at) return { error: expired };
  if (new Date(row.expires_at as string) <= new Date()) return { error: expired };

  const { data: claimed } = await admin
    .from("password_reset_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("id", row.id)
    .is("used_at", null)
    .select("id")
    .maybeSingle();
  if (!claimed) return { error: expired }; // 경쟁에서 졌다 = 이미 소진된 링크

  return { userId: row.user_id as string };
}

/** 재설정 성공 후 남은 재설정 링크를 전부 죽인다 (메일함에 여러 통이 있어도 하나만 유효) */
export async function invalidateOtherResetTokens(
  admin: SupabaseClient,
  userId: string
): Promise<void> {
  const now = new Date().toISOString();
  await admin
    .from("password_reset_tokens")
    .update({ used_at: now })
    .eq("user_id", userId)
    .eq("purpose", "reset")
    .is("used_at", null);
}
