// lib/orgNotices.ts — 감독자 알림의 **유일한 발송 접점**.
//
// 크론(유예 스윕·결제 실패)과 두 라우트(ping-owner·leave)가 notify() 하나만 부른다.
// 채널을 늘릴 자리도 여기 한 곳이다 — 카카오 알림톡은 템플릿 심사가 끝나면 이 함수 안에
// 채널을 하나 더 붙이면 되고, 호출부는 한 줄도 고치지 않는다.
//
// 로컬 import는 순수 모듈 둘뿐이다(mailer·myEmail) — lib/org.ts·lib/billing.ts를 부르지 않아
// 순환이 구조적으로 불가능하다(lib/orgSeats.ts·lib/orgGrace.ts와 같은 규율).
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMail } from "./mailer";
import { resolveMyReportEmail } from "./myEmail";
// 사용자 값은 전부 이스케이프한다 — lib/consent.ts와 같은 출처·같은 함수(문구 사본 금지).
import { escapeHtml } from "./htmlEscape";

export type OrgNoticeKind =
  | "charge_failed"
  | "lapse_d0"
  | "lapse_d3"
  | "lapse_d6"
  | "seat_locked"
  | "member_ping"
  | "member_left";

export interface OrgNoticeRow {
  id: string;
  org_id: string;
  owner_user_id: string;
  kind: OrgNoticeKind;
  actor_user_id: string | null;
  lapsed_at: string | null;
  dedupe_key: string;
  email_status: "sent" | "failed" | "skipped" | null;
  email_retries: number;
  read_at: string | null;
  created_at: string;
}

export interface NotifyParams {
  admin: SupabaseClient;
  orgId: string;
  ownerUserId: string;
  kind: OrgNoticeKind;
  /** unique 인덱스가 걸린 멱등 키. 이 값이 곧 "이미 보냈는가"의 판정이다. */
  dedupeKey: string;
  actorUserId?: string | null;
  lapsedAt?: string | null;
  /** 없으면 인앱만 남긴다(이메일 발송 없음) */
  mail?: { subject: string; html: string } | null;
}

/**
 * 세 상태를 **구분해서** 돌려준다. 종전에는 23505(중복)와 그 밖의 모든 insert 오류를 똑같이
 * `{created:false}`로 접어, 알림이 한 줄도 기록되지 않고 이메일도 안 나간 상황에서 현장 계정이
 * "오늘은 이미 감독자에게 전달됐어요"를 봤다 — 유예 7일 동안 사용자가 할 수 있는 유일한 행동이
 * 그 하나인데, 실패했을 때 실패했다고 말하지 않았다(2026-08-13 검수).
 */
export interface NotifyResult {
  /** 이번 호출이 알림을 새로 만들었는가 */
  created: boolean;
  /** 같은 dedupe_key가 이미 있었다(정상 경로) */
  duplicate: boolean;
  /** 중복이 아닌 실패. 값이 있으면 **아무것도 기록되지 않았다** */
  error: string | null;
  emailStatus: "sent" | "failed" | "skipped" | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EMAIL_RETRIES = 3;

/** YYYY-MM-DD (KST) — 하루 1회 제한 dedupe 키의 날짜 조각. 서버 TZ가 UTC라도 사용자의 '오늘'과 맞춘다. */
export function kstDay(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * 알림 한 건. **먼저 insert하고 23505면 이미 보낸 것**으로 판정한다(원자적).
 *
 * "조회 → 없으면 발송 → 기록"으로 쓰면 크론이 겹치거나 재시도될 때 반드시 두 번 보낸다.
 * 발송 실패는 행을 지우지 않고 email_status='failed'로 남긴다 — 다음 스윕이 같은 dedupe_key로
 * 재시도하므로(retryFailedEmails) 중복 발송이 구조적으로 불가능하다.
 */
export async function notify(params: NotifyParams): Promise<NotifyResult> {
  const { admin, orgId, ownerUserId, kind, dedupeKey } = params;

  const { data: inserted, error } = await admin
    .from("org_notices")
    .insert({
      org_id: orgId,
      owner_user_id: ownerUserId,
      kind,
      actor_user_id: params.actorUserId ?? null,
      lapsed_at: params.lapsedAt ?? null,
      dedupe_key: dedupeKey,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // 23505 = unique violation → 같은 회차·같은 날의 알림이 이미 있다. 정상 경로다.
    if ((error as { code?: string }).code === "23505") {
      return { created: false, duplicate: true, error: null, emailStatus: null };
    }
    console.error("org notice insert 실패", { kind, dedupeKey, error });
    return {
      created: false,
      duplicate: false,
      error: (error as { message?: string }).message || "알림 기록 실패",
      emailStatus: null,
    };
  }

  const noticeId = (inserted as { id: string } | null)?.id;
  if (!noticeId) return { created: true, duplicate: false, error: null, emailStatus: null };
  if (!params.mail) return { created: true, duplicate: false, error: null, emailStatus: null };

  const emailStatus = await deliverEmail(admin, {
    noticeId,
    orgId,
    ownerUserId,
    kind,
    mail: params.mail,
    retries: 0,
  });
  return { created: true, duplicate: false, error: null, emailStatus };
}

/**
 * 이메일 한 통 + 결과 기록. 발송 접점은 여기 하나다.
 *
 * 수신 주소는 resolveMyReportEmail — 아이디 가입 감독자의 auth email은 @tbm.com 가짜
 * 도메인이라 그리로 보내면 조용히 증발한다. 주소가 없으면 'skipped'로 남기고 인앱만 남는다.
 */
async function deliverEmail(
  admin: SupabaseClient,
  args: {
    noticeId: string;
    orgId: string;
    ownerUserId: string;
    kind: OrgNoticeKind;
    mail: { subject: string; html: string };
    retries: number;
  }
): Promise<"sent" | "failed" | "skipped"> {
  const finish = async (status: "sent" | "failed" | "skipped", err?: string) => {
    await admin
      .from("org_notices")
      .update({
        email_status: status,
        email_error: err ?? null,
        email_retries: status === "failed" ? args.retries + 1 : args.retries,
      })
      .eq("id", args.noticeId);
    return status;
  };

  // 24h 스팸 하한: 같은 org에 같은 kind 메일이 최근 24시간 안에 나갔으면 **이메일만** 생략한다.
  // (끊김-회복을 하루에 여러 번 반복하는 비정상 계정, 현장 20곳이 같은 날 '알리기'를 누르는 경우.)
  // 인앱 행은 이미 만들어졌으므로 감독자가 사실을 놓치지는 않는다.
  const { data: recent } = await admin
    .from("org_notices")
    .select("id")
    .eq("org_id", args.orgId)
    .eq("kind", args.kind)
    .eq("email_status", "sent")
    .gte("created_at", new Date(Date.now() - DAY_MS).toISOString())
    .neq("id", args.noticeId)
    .limit(1);
  if ((recent ?? []).length > 0) {
    return finish("skipped", "24h 내 같은 종류 메일 발송됨");
  }

  let to: string | null = null;
  try {
    const { data } = await admin.auth.admin.getUserById(args.ownerUserId);
    to = resolveMyReportEmail(data?.user ?? null);
  } catch (e) {
    console.error("org notice: 감독자 조회 실패", { ownerUserId: args.ownerUserId, error: e });
  }
  if (!to) {
    // 감독자 화면이 "결제 알림을 받을 이메일이 없어요 → 내 정보 수정" 배너를 함께 띄운다
    // (/api/org/notices GET이 emailMissing으로 내려준다).
    return finish("skipped", "수신 가능한 이메일 없음");
  }

  const res = await sendMail({ to, subject: args.mail.subject, html: args.mail.html });
  return res.ok ? finish("sent") : finish("failed", res.error ?? "발송 실패");
}

/**
 * 실패한 이메일 재시도(크론 스윕 말미). 같은 행을 다시 쓰므로 중복 발송이 불가능하다.
 * 본문을 저장하지 않기 때문에 호출부가 kind로 본문을 다시 만들어 준다 — 저장하지 않는 이유는
 * 알림 원장에 개인정보(회사명·이름)를 눕혀두지 않기 위해서다.
 */
export async function retryFailedEmails(
  admin: SupabaseClient,
  build: (row: OrgNoticeRow) => { subject: string; html: string } | null,
  limit = 30
): Promise<{ sent: number; failed: number }> {
  const { data } = await admin
    .from("org_notices")
    .select("id, org_id, owner_user_id, kind, actor_user_id, lapsed_at, dedupe_key, email_status, email_retries, read_at, created_at")
    .eq("email_status", "failed")
    .lt("email_retries", MAX_EMAIL_RETRIES)
    .order("created_at", { ascending: true })
    .limit(limit);

  let sent = 0;
  let failed = 0;
  for (const row of ((data ?? []) as OrgNoticeRow[])) {
    const mail = build(row);
    if (!mail) continue;
    const status = await deliverEmail(admin, {
      noticeId: row.id,
      orgId: row.org_id,
      ownerUserId: row.owner_user_id,
      kind: row.kind,
      mail,
      retries: row.email_retries ?? 0,
    });
    if (status === "sent") sent++;
    else if (status === "failed") failed++;
  }
  return { sent, failed };
}

// ── 본문 ──────────────────────────────────────────────────────────────────
// 문구는 한 곳에 모은다. 크론과 라우트가 같은 사건에 다른 말을 하면 감독자는 두 가지 일이
// 벌어진 줄 안다.

// lib/accountRecovery.ts CANONICAL_ORIGIN과 같은 정식 주소. 요청 Host는 쓰지 않는다
// (크론에는 요청 Host가 없고, 있어도 헤더를 믿으면 링크가 오염된다).
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://www.safetalk.kr").replace(/\/$/, "");

function wrap(title: string, body: string, cta = "안톡에서 확인하기"): string {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a">
  <h1 style="font-size:18px;font-weight:700;margin:0 0 12px">${title}</h1>
  <div style="font-size:14px;line-height:1.7;color:#444">${body}</div>
  <p style="margin:24px 0 0"><a href="${APP_URL}/account" style="display:inline-block;background:#0f6fff;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:12px 20px;border-radius:8px">${cta}</a></p>
  <p style="margin:20px 0 0;font-size:12px;color:#999">안톡 · 안전톡톡</p>
</div>`;
}

export interface NoticeMailContext {
  orgName: string;
  /** 유예 종료일 표기 (M월 D일). 없으면 문장에서 생략한다. */
  graceEndsLabel?: string | null;
  memberCount?: number;
  siteName?: string | null;
}

/**
 * 사용자가 쓴 값을 메일 본문에 넣기 전에 반드시 통과시킨다.
 *
 * ⚠️ siteName은 user_metadata.company_name이고, user_metadata는 클라이언트가
 * supabase.auth.updateUser({data})로 **직접 쓸 수 있다**(lib/org.ts:315에 같은 경고가 있다).
 * 현장 계정이 자기 현장명에 <a href="…">를 심으면 감독자의 '[안톡] 현장에서 결제를 요청했어요'
 * 메일 안에 임의 링크·마크업이 들어간다 — 결제 관련 메일이라 피싱 가치가 크다.
 * 길이 캡은 제목 줄이 깨지는 것을 막는다(이스케이프 **전** 원문 기준으로 자른다 —
 * 이스케이프 후에 자르면 `&amp;` 같은 엔티티가 반토막 난다).
 */
function safeText(v: string | null | undefined, max = 60): string {
  const raw = String(v ?? "").trim();
  const cut = raw.length > max ? `${raw.slice(0, max)}…` : raw;
  return escapeHtml(cut);
}

/** kind → 메일 본문. 크론·라우트·재시도가 전부 이 함수를 쓴다(문구 사본 금지). */
export function buildNoticeMail(
  kind: OrgNoticeKind,
  ctx: NoticeMailContext
): { subject: string; html: string } | null {
  const org = safeText(ctx.orgName) || "회사";
  const siteName = safeText(ctx.siteName);
  // graceEndsLabel(유예 종료일)은 2026-08-11부터 어떤 메일에도 쓰지 않는다 — 그 날짜에는
  // 아무 일도 일어나지 않으므로 마감처럼 보이는 순간 거짓말이 된다(lapse_d0 위 주석).
  // 호출부 시그니처(NoticeMailContext)는 그대로 둔다: 크론이 이미 넘기고 있고, 지우면
  // 타입 변경이 세 파일로 번진다. 여기서 안 읽는 것으로 충분하다.
  // memberCount는 서버 계산값이지만 문자열 보간이므로 정수로 못박는다
  const count = Number.isFinite(Number(ctx.memberCount)) ? Math.max(0, Math.trunc(Number(ctx.memberCount))) : 0;
  const sites = count > 0 ? `현장 계정 ${count}곳` : "현장 계정";

  switch (kind) {
    case "charge_failed":
      return {
        subject: "[안톡] 결제가 실패했어요",
        html: wrap(
          "결제가 실패했어요",
          `${org}의 이번 달 결제가 처리되지 않았어요.<br/>
           결제수단을 확인해 주세요. 결제가 끝내 되살아나지 않으면 ${sites}의
           새 기록 작성과 AI 분석이 잠깁니다.<br/><br/>
           <b>이미 만든 기록은 그대로 보고 출력할 수 있어요.</b>`,
          "결제수단 확인하기"
        ),
      };
    // ⚠️ D0·D3·D6에 **마감 날짜를 쓰지 않는다**(2026-08-11 정정). 종전에는 "8월 18일까지
    //    결제를 되살리면"처럼 유예 종료일을 마감으로 걸었는데, 개인 결제 전환이 폐지된 지금
    //    그 날짜에는 아무 일도 일어나지 않는다 — 지나도 결제하면 그대로 열리고, 안 하면 그대로
    //    잠겨 있다. 없는 마감을 걸면 감독자는 날짜가 지난 뒤 "이미 늦었다"고 읽고 포기한다.
    //    7일이 실제로 정하는 것은 **이 메일이 나가는 기간**뿐이다(D6 이후 재촉 중단).
    case "lapse_d0":
      return {
        subject: "[안톡] 현장 계정 이용이 잠겼어요",
        html: wrap(
          "현장 계정 이용이 잠겼어요",
          `${org}의 결제가 확인되지 않아 ${sites}의 새 기록 작성과 AI 분석이 잠겼어요.<br/>
           결제를 되살리면 그대로 이어서 쓸 수 있어요.<br/><br/>
           <b>지금까지 만든 기록은 계속 보고 출력할 수 있어요.</b>`,
          "결제 되살리기"
        ),
      };
    case "lapse_d3":
      return {
        subject: "[안톡] 현장 계정이 잠긴 지 3일째예요",
        html: wrap(
          "현장 계정이 잠긴 지 3일째예요",
          `${org}의 ${sites}이 아직 새 기록을 만들지 못하고 있어요.<br/>
           결제를 되살리면 그대로 이어집니다.`,
          "결제 되살리기"
        ),
      };
    case "lapse_d6":
      // ⚠️ 제목이 '연결이 정리돼요'였다가 '내일부터 직접 구독해야 해요'였다. **둘 다 일어나지
      // 않는 일이다.** 유예 종료 시 org_members를 정리하는 코드는 어디에도 없고(해제는 감독자
      // 수동 해제와 자가결제자의 /api/org/leave뿐), 현장 계정에게 개인 결제를 여는 경로도
      // 폐지됐다(Chris 2026-08-11). 이 메일이 말할 수 있는 사실은 하나다 — 결제하기 전까지
      // 계속 잠겨 있고, 결제하면 즉시 열린다. 이것이 마지막 재촉이다.
      return {
        subject: "[안톡] 현장 계정이 계속 잠겨 있어요",
        html: wrap(
          "현장 계정이 계속 잠겨 있어요",
          `${org}의 결제가 아직 확인되지 않았어요.<br/>
           결제하기 전까지 ${sites}은 새 기록을 만들 수 없어요.
           <b>회사 연결과 기록은 그대로 남아 있고, 결제하면 바로 다시 열립니다.</b><br/><br/>
           이 안내는 오늘이 마지막이에요.`,
          "결제 되살리기"
        ),
      };
    case "seat_locked":
      return {
        subject: "[안톡] 일부 현장 계정이 열리지 않고 있어요",
        html: wrap(
          "일부 현장 계정이 열리지 않고 있어요",
          `${org}의 구독은 확인됐는데 ${sites}의 이용 권한이 연결되지 않았어요.<br/>
           현장 계정 청구용 카드가 결제되지 않았거나, 요금제 정원이 모자란 경우예요.<br/>
           <b>현장 계정 관리</b>에서 상태를 확인해 주세요.`,
          "현장 계정 관리 열기"
        ),
      };
    case "member_ping":
      return {
        subject: "[안톡] 현장에서 결제를 요청했어요",
        html: wrap(
          "현장에서 결제를 요청했어요",
          `${siteName ? `<b>${siteName}</b>` : "현장 계정"}에서 ${org}의 결제를 되살려 달라고 요청했어요.<br/>
           결제가 확인되면 잠긴 기능이 바로 열립니다.`,
          "결제 확인하기"
        ),
      };
    case "member_left":
      // 인앱만 — 이메일 없음(설계: leave는 인앱 알림만)
      return null;
    default:
      return null;
  }
}
