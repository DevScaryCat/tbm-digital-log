// lib/consent.ts — 두 종류의 "동의"가 한 파일에 산다. 이름이 같을 뿐 서로 무관하다.
//  (1) 보고서 수신자 승인 — 계정(현장)이 등록한 수신자가 승인해야 발송. 스푸핑/스팸 방지.
//  (2) 약관·개인정보처리방침 동의 — 파일 하단. 서비스 이용자 본인의 동의 증빙.
import { SupabaseClient } from "@supabase/supabase-js";
import { sendMail, mailerConfigured } from "@/lib/mailer";
import { escapeHtml } from "@/lib/htmlEscape";

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

function normEmail(e: string): string {
  return String(e).trim();
}

/** 승인 요청 메일 본문 */
function consentEmailHtml(site: string, link: string): string {
  return `
  <div style="max-width:520px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Malgun Gothic',sans-serif;color:#26251e;">
    <p style="font-size:13px;color:#f54e00;font-weight:700;margin:0 0 6px;">안톡</p>
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
 * baseUrl(요청 host에서 유도)로 링크 생성 — env 의존 제거. 메일 발송 성공 여부를 정직하게 반환.
 */
export async function requestConsent(
  admin: SupabaseClient,
  accountUserId: string,
  recipientEmail: string,
  companyName: string | null,
  baseUrl?: string
): Promise<{ ok: boolean; mailed: boolean; error?: string }> {
  const email = normEmail(recipientEmail);
  const { data: existing } = await admin
    .from("report_recipient_consents")
    .select("id, status, token")
    .eq("account_user_id", accountUserId)
    .eq("recipient_email", email)
    .maybeSingle();

  let token: string | undefined = existing?.token;
  if (existing) {
    // 승인됨이 아니면 다시 pending으로 되돌려 재요청 (거부했던 것도 재요청 가능)
    if (existing.status !== "approved") {
      await admin
        .from("report_recipient_consents")
        .update({ status: "pending", responded_at: null })
        .eq("id", existing.id);
    }
  } else {
    const { data: created, error } = await admin
      .from("report_recipient_consents")
      .insert({ account_user_id: accountUserId, recipient_email: email })
      .select("token")
      .single();
    if (error) return { ok: false, mailed: false, error: error.message };
    token = created?.token;
  }
  if (!token) return { ok: false, mailed: false, error: "수신처 저장에 실패했습니다." };

  // 메일 발송 (행은 이미 생성됨 — 메일 실패해도 재발송 가능)
  if (!mailerConfigured()) return { ok: true, mailed: false, error: "메일 설정(EMAIL_USER/PASS)이 서버에 없습니다." };
  const base = (baseUrl || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  if (!base) return { ok: true, mailed: false, error: "발신 링크 주소를 확인할 수 없습니다." };
  const link = `${base}/consent/${token}`;
  const site = companyName?.trim() || "안톡 이용 현장";
  const sent = await sendMail({
    to: email,
    subject: `[안톡] ${site}의 안전 보고서 수신 확인`,
    html: consentEmailHtml(site, link),
  });
  if (!sent.ok) return { ok: true, mailed: false, error: sent.error };

  // 재발송 쿨다운 기준 — 실제로 나간 메일만 기록한다 (발송 실패는 쿨다운을 소비하지 않음)
  await admin
    .from("report_recipient_consents")
    .update({ last_sent_at: new Date().toISOString() })
    .eq("account_user_id", accountUserId)
    .eq("recipient_email", email);
  return { ok: true, mailed: true };
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
  let site = "안톡 이용 현장";
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
/**
 * 내 이메일은 늘 수신처에 있어야 한다(Chris).
 * 인증까지 끝난 본인 주소는 "받겠다"를 이미 증명한 것이므로 승인 요청 메일 없이 approved로 넣는다.
 * (본인에게 "본인 주소로 보내도 되냐"고 다시 묻는 건 의미가 없고, 안 넣으면 내 정보에 이메일을
 *  적어놨는데 발송설정에는 받는 사람이 0명인 어긋난 화면이 된다.)
 * 이미 있으면 아무것도 하지 않는다 — 사용자가 '받지 않기'로 declined 해둔 것도 존중.
 */
export async function ensureSelfConsent(
  admin: SupabaseClient,
  accountUserId: string,
  selfEmail: string | null | undefined
): Promise<void> {
  const email = normEmail(selfEmail ?? "");
  if (!email) return;
  try {
    const { data: existing } = await admin
      .from("report_recipient_consents")
      .select("id")
      .eq("account_user_id", accountUserId)
      .ilike("recipient_email", email)
      .maybeSingle();
    if (existing) return;
    await admin.from("report_recipient_consents").insert({
      account_user_id: accountUserId,
      recipient_email: email,
      status: "approved",
      responded_at: new Date().toISOString(),
    });
  } catch (e) {
    // 실패해도 화면은 열려야 한다 — 다음 조회에서 다시 시도된다
    console.error("본인 수신처 등록 실패:", e);
  }
}

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

// ─────────────────────────────────────────────────────────────────────────────
// 약관·개인정보처리방침 동의 — 공용 계약의 진입점.
// 구현이 lib/consentTerms.ts에 따로 있는 이유: 이 파일은 최상단에서 nodemailer를
// 끌어오는 서버 전용 모듈이라, 클라이언트 컴포넌트(ConsentGate)가 여기서 import하면
// 노드 모듈이 브라우저 번들에 섞여 빌드가 깨진다(동적 import로도 그래프가 끊기지 않는다).
// 서버 코드는 계속 "@/lib/consent"에서 가져다 쓰면 된다.
// ─────────────────────────────────────────────────────────────────────────────
export {
  TERMS_VERSION,
  PRIVACY_VERSION,
  isConsentCurrent,
  consentMetaPatch,
  recordConsent,
} from "@/lib/consentTerms";
