// lib/consent.ts — 보고서 수신자 승인(consent) 생성·확인메일·응답 처리
// 계정(현장)이 수신자를 등록하면 수신자가 승인해야 발송. 스푸핑/스팸 방지.
import { SupabaseClient } from "@supabase/supabase-js";
import { sendMail, mailerConfigured } from "@/lib/mailer";
import { escapeHtml } from "@/lib/monthlyReport";

export type ConsentStatus = "pending" | "approved" | "declined";

export interface ConsentRow {
  id: string;
  account_user_id: string;
  recipient_email: string;
  status: ConsentStatus;
  token: string;
  created_at?: string;
  responded_at?: string | null;
}

function baseUrl(): string | null {
  const b = process.env.NEXT_PUBLIC_APP_URL;
  return b ? b.replace(/\/$/, "") : null;
}

function normEmail(e: string): string {
  return String(e).trim();
}

/** 승인 요청 메일 본문 */
function consentEmailHtml(site: string, link: string): string {
  return `
  <div style="max-width:520px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Malgun Gothic',sans-serif;color:#26251e;">
    <p style="font-size:13px;color:#f54e00;font-weight:700;margin:0 0 6px;">안전톡톡e</p>
    <p style="font-size:16px;font-weight:700;margin:0 0 14px;">안전 보고서 수신 확인</p>
    <p style="font-size:14px;line-height:1.7;color:#444;margin:0 0 8px;">
      <b>${escapeHtml(site)}</b>에서 매월 안전활동(TBM 회의록·안전보건교육일지) 종합 보고서를
      이 이메일로 보내려고 합니다.
    </p>
    <p style="font-size:14px;line-height:1.7;color:#444;margin:0 0 18px;">
      받아보시겠어요? 여러 현장이 같은 이메일로 등록하면 <b>한 통으로 합쳐서</b> 보내드립니다.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="padding-right:8px;">
        <a href="${link}?a=approve" style="display:inline-block;background:#f54e00;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;">받기(승인)</a>
      </td>
      <td>
        <a href="${link}?a=decline" style="display:inline-block;background:#efeee8;color:#807d72;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;">받지 않기</a>
      </td>
    </tr></table>
    <p style="font-size:12px;color:#a09c92;line-height:1.6;margin:18px 0 0;">
      본인이 요청하지 않았다면 <b>받지 않기</b>를 누르시면 앞으로 이 현장에서 오는 보고서가 발송되지 않습니다. 무시하셔도 발송되지 않습니다.
    </p>
  </div>`;
}

/**
 * 계정이 수신자를 등록/재요청 → pending consent upsert + 확인 메일.
 * 이미 approved면 메일 안 보냄. 메일 미설정(로컬) 시 링크만 생성.
 */
export async function requestConsent(
  admin: SupabaseClient,
  accountUserId: string,
  recipientEmail: string,
  companyName: string | null
): Promise<{ status: "created" | "resent" | "already_approved" | "mail_failed"; error?: string }> {
  const email = normEmail(recipientEmail);
  const { data: existing } = await admin
    .from("report_recipient_consents")
    .select("id, status, token")
    .eq("account_user_id", accountUserId)
    .eq("recipient_email", email)
    .maybeSingle();

  if (existing?.status === "approved") return { status: "already_approved" };

  let token: string | undefined = existing?.token;
  if (existing) {
    await admin
      .from("report_recipient_consents")
      .update({ status: "pending", responded_at: null })
      .eq("id", existing.id);
  } else {
    const { data: created, error } = await admin
      .from("report_recipient_consents")
      .insert({ account_user_id: accountUserId, recipient_email: email })
      .select("token")
      .single();
    if (error) return { status: "mail_failed", error: error.message };
    token = created?.token;
  }
  if (!token) return { status: "mail_failed", error: "consent 생성 실패" };

  const base = baseUrl();
  const wasExisting = !!existing;
  if (!mailerConfigured() || !base) {
    // 로컬/메일 미설정: consent 행만 만들어 두고 메일은 스킵 (승인 페이지로 수동 접근 가능)
    return { status: wasExisting ? "resent" : "created" };
  }
  const link = `${base}/consent/${token}`;
  const site = companyName?.trim() || "안전톡톡e 이용 현장";
  const sent = await sendMail({
    to: email,
    subject: `[안전톡톡e] ${site}의 안전 보고서 수신 확인`,
    html: consentEmailHtml(site, link),
  });
  if (!sent.ok) return { status: "mail_failed", error: sent.error };
  return { status: wasExisting ? "resent" : "created" };
}

/** 토큰으로 consent 조회 (승인 페이지용) */
export async function getConsentByToken(
  admin: SupabaseClient,
  token: string
): Promise<{ consent: ConsentRow; site: string } | null> {
  const { data } = await admin
    .from("report_recipient_consents")
    .select("id, account_user_id, recipient_email, status, token")
    .eq("token", token)
    .maybeSingle();
  if (!data) return null;
  let site = "안전톡톡e 이용 현장";
  try {
    const { data: u } = await admin.auth.admin.getUserById((data as ConsentRow).account_user_id);
    site = (u?.user?.user_metadata as any)?.company_name?.trim() || site;
  } catch {}
  return { consent: data as ConsentRow, site };
}

/** 수신자 응답(승인/거부) */
export async function respondConsent(
  admin: SupabaseClient,
  token: string,
  approve: boolean
): Promise<{ ok: boolean; status?: ConsentStatus }> {
  const status: ConsentStatus = approve ? "approved" : "declined";
  const { data, error } = await admin
    .from("report_recipient_consents")
    .update({ status, responded_at: new Date().toISOString() })
    .eq("token", token)
    .select("status")
    .maybeSingle();
  if (error || !data) return { ok: false };
  return { ok: true, status: data.status as ConsentStatus };
}

/** 한 계정의 수신자 목록 + 상태 (설정 화면용) */
export async function listAccountConsents(
  admin: SupabaseClient,
  accountUserId: string
): Promise<{ email: string; status: ConsentStatus }[]> {
  const { data } = await admin
    .from("report_recipient_consents")
    .select("recipient_email, status")
    .eq("account_user_id", accountUserId)
    .order("created_at", { ascending: true });
  return (data || []).map((r: any) => ({ email: r.recipient_email, status: r.status }));
}
