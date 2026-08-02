// lib/emailVerification.ts — 실이메일 인증 (org 소속 월간 보고서 발송 전제)
// 계정 이메일은 가상({id}@tbm.com)이라 실제 수신 가능한 이메일을 별도로 받아 인증한다.
// 토큰은 email_verifications 테이블 (만료 3일 — consent 토큰 무만료 전례 반복 금지).
import { SupabaseClient } from "@supabase/supabase-js";
import { sendMail, mailerConfigured } from "@/lib/mailer";
import { ensureSelfConsent } from "@/lib/consent";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

/** 인증 메일 발송 + user_metadata.real_email(미인증) 기록. 실패해도 가입은 진행(배너로 재시도 유도). */
export async function sendRealEmailVerification(
  admin: SupabaseClient,
  userId: string,
  email: string,
  baseUrl?: string
): Promise<{ ok: boolean; error?: string }> {
  if (!isValidEmail(email)) return { ok: false, error: "이메일 형식이 올바르지 않습니다." };

  // 메타데이터에 미인증 이메일 기록 (인증되면 real_email_verified_at 채움)
  try {
    const { data: u } = await admin.auth.admin.getUserById(userId);
    const meta = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
    await admin.auth.admin.updateUserById(userId, {
      user_metadata: {
        ...meta,
        real_email: email,
        // 이메일을 바꾸면 재인증 필요
        real_email_verified_at: meta.real_email === email ? meta.real_email_verified_at ?? null : null,
      },
    });
  } catch (e) {
    console.error("real_email metadata update 실패:", e);
  }

  const { data: row, error } = await admin
    .from("email_verifications")
    .insert({ user_id: userId, email })
    .select("id, token")
    .single();
  if (error || !row) {
    console.error("email_verifications insert 실패:", error);
    return { ok: false, error: "인증 토큰 생성 실패" };
  }

  if (!mailerConfigured()) return { ok: false, error: "메일 설정이 없습니다." };
  const base = (baseUrl || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  const link = `${base}/verify-email/${row.token}`;
  const r = await sendMail({
    to: email,
    subject: "[안톡] 이메일 인증을 완료해주세요",
    html: `
      <div style="max-width:520px;margin:0 auto;font-family:'Apple SD Gothic Neo',Arial,sans-serif;color:#26251e;">
        <h2 style="font-size:18px;">안톡 이메일 인증</h2>
        <p style="font-size:14px;line-height:1.7;color:#444;">
          아래 버튼을 누르면 인증이 완료됩니다. 인증된 이메일로 매달 1일 우리 현장 월간 보고서가 발송됩니다.
        </p>
        <a href="${link}" style="display:inline-block;background:#f54e00;color:#fff;font-weight:700;padding:12px 20px;border-radius:10px;text-decoration:none;font-size:14px;">이메일 인증하기</a>
        <p style="font-size:12px;color:#999;margin-top:16px;">링크는 3일간 유효합니다. 본인이 요청하지 않았다면 무시하세요.</p>
      </div>`,
  });

  // 이전 미인증 토큰 무효화는 '새 메일이 실제로 나간 뒤'에만 — 순서를 뒤집으면 발송 실패 시
  // 받은 편지함의 멀쩡한 링크까지 죽여 사용자가 쓸 수 있는 링크가 0개가 된다.
  // 삭제가 아니라 만료 처리인 이유: 행을 지우면 발송 라우트의 시간당/일일 카운트 증거가 사라져 상한이 무력화된다.
  if (r.ok) {
    await admin
      .from("email_verifications")
      .update({ expires_at: new Date().toISOString() })
      .eq("user_id", userId)
      .is("verified_at", null)
      .neq("id", row.id);
  }
  return r;
}

/** 토큰 검증 → user_metadata.real_email_verified_at 확정 */
export async function verifyRealEmailToken(
  admin: SupabaseClient,
  token: string
): Promise<{ ok: boolean; email?: string; error?: string }> {
  const { data: row } = await admin
    .from("email_verifications")
    .select("id, user_id, email, expires_at, verified_at")
    .eq("token", token)
    .maybeSingle();
  if (!row) return { ok: false, error: "유효하지 않은 인증 링크입니다." };
  if (row.verified_at) return { ok: true, email: row.email };
  if (new Date(row.expires_at) <= new Date()) {
    return { ok: false, error: "만료된 인증 링크입니다. 앱에서 인증 메일을 다시 요청해주세요." };
  }

  const now = new Date().toISOString();
  await admin.from("email_verifications").update({ verified_at: now }).eq("id", row.id);
  let prevEmail: string | null = null;
  try {
    const { data: u } = await admin.auth.admin.getUserById(row.user_id);
    const meta = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
    // 직전에 '인증까지 끝나 있던' 주소만 이관 대상 — 미인증 주소는 수신처였던 적이 없다
    if (meta.real_email_verified_at && typeof meta.real_email === "string") {
      prevEmail = meta.real_email.trim() || null;
    }
    await admin.auth.admin.updateUserById(row.user_id, {
      user_metadata: { ...meta, real_email: row.email, real_email_verified_at: now },
    });
  } catch (e) {
    console.error("real_email verify metadata update 실패:", e);
    return { ok: false, error: "인증 처리 중 오류가 발생했습니다." };
  }

  // 내 이메일을 바꿨으면 수신처도 따라간다 — 안 옮기면 보고서가 계속 옛 주소로 나가고
  // 새 주소는 승인 요청부터 다시 받아야 한다. 승인 상태를 유지하는 근거: 방금 그 사람이
  // 새 주소의 인증 링크를 눌러 수신 의사를 직접 증명했다(수신 동의의 실질과 같다).
  await migrateOwnConsent(admin, row.user_id, prevEmail, row.email);
  // 처음 인증한 경우엔 옮길 행이 없다 — 새로 만들어 넣는다
  await ensureSelfConsent(admin, row.user_id, row.email);

  return { ok: true, email: row.email };
}

async function migrateOwnConsent(
  admin: SupabaseClient,
  userId: string,
  prevEmail: string | null,
  nextEmail: string
): Promise<void> {
  if (!prevEmail || prevEmail.toLowerCase() === nextEmail.toLowerCase()) return;
  try {
    const { data: rows } = await admin
      .from("report_recipient_consents")
      .select("id, recipient_email")
      .eq("account_user_id", userId);
    const list = (rows ?? []) as { id: string; recipient_email: string }[];
    const old = list.find((r) => r.recipient_email.toLowerCase() === prevEmail.toLowerCase());
    if (!old) return;
    const dup = list.find((r) => r.recipient_email.toLowerCase() === nextEmail.toLowerCase());
    if (dup) {
      // 새 주소가 이미 수신처면 옛 행은 지운다 (같은 사람에게 두 통 가는 것 방지)
      await admin.from("report_recipient_consents").delete().eq("id", old.id);
      return;
    }
    await admin
      .from("report_recipient_consents")
      .update({ recipient_email: nextEmail, status: "approved", responded_at: new Date().toISOString() })
      .eq("id", old.id);
  } catch (e) {
    // 이관 실패가 인증 자체를 되돌릴 이유는 없다 — 화면에서 수동으로 다시 등록하면 된다
    console.error("수신처 이메일 이관 실패:", e);
  }
}
