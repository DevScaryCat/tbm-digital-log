import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getAdminClient, subscriptionAllows, isProPlan } from "@/lib/portone";
import { buildMergedMinutesContent, renderReportHtml, buildReportAttachments } from "@/lib/monthlyReport";
import { buildMergedEducationContent, renderEducationReportHtml, buildEducationAttachments } from "@/lib/educationReport";
import { sendMail, mailerConfigured } from "@/lib/mailer";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 300;

// Vercel Cron(매일 00:00 UTC): 매월 1일(KST)에 지난달 종합 보고서 발송. 두 축(§7):
// ① 회사 경로: 감독자 본인 현장 + 소속 현장을 병합 → 앱 열람 저장 + 승인 수신처 발송,
//    각 소속 현장은 자기 현장분을 본인 인증 이메일로 수신 (kind='member_monthly_<id>').
// ② 단독 경로: 회사에 속하지 않은 계정의 기존 수신자 승인제.
//
// 두 경로는 반드시 서로소여야 한다. 예전에는 `plan === 'monthly_pro'` 필터가 org 계정을
// 우연히 배제해줬는데, 단일 요금제로 plan이 같아지면 그 우연이 깨져 같은 수신자가
// 병합본과 단독본을 각각 받게 된다. 그래서 이제 plan이 아니라 **소속(organizations/org_members)**
// 으로 배제한다 — orgLinked 참조.
export async function POST(request: Request) { return run(request); }
export async function GET(request: Request) { return run(request); }

type Account = { userId: string; siteName: string };
// org 경로는 단독 경로와 발신 주체가 달라 멱등 키(kind)를 분리한다 — 같은 수신 이메일이
// 양쪽에 걸치면 한쪽이 조용히 미발송되는 교차 누락 방지 (리뷰 G). member_monthly는
// 계정 id를 키에 포함 — 한 담당자가 두 현장의 실이메일이면 두 현장분 모두 받아야 한다 (리뷰 H).
// org_* 도 마찬가지로 소유자 id를 포함해야 한다: 회사가 둘 이상 생기면 같은 원청 이메일을
// 두 회사가 승인했을 때 먼저 보낸 쪽만 나가고 나머지는 조용히 '이미 보냄'이 된다.
type Kind = "minutes" | "education" | `org_${string}` | `member_monthly_${string}`;

async function alreadySent(admin: SupabaseClient, email: string, year: number, month: number, kind: Kind): Promise<boolean> {
  const { data } = await admin
    .from("consolidated_report_sends")
    .select("recipient_email")
    .eq("recipient_email", email).eq("period_year", year).eq("period_month", month).eq("kind", kind)
    .maybeSingle();
  return !!data;
}
async function recordSent(admin: SupabaseClient, email: string, year: number, month: number, kind: Kind, count: number) {
  await admin.from("consolidated_report_sends").insert({ recipient_email: email, period_year: year, period_month: month, kind, account_count: count });
}

async function run(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const provided = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!cronSecret || provided !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const admin = getAdminClient();
    const now = new Date();
    const force = new URL(request.url).searchParams.get("force") === "1"; // 테스트: 날짜 무관 실행

    const todayKST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const todayDay = Number(todayKST.slice(8, 10));
    if (!force && todayDay !== 1) {
      return NextResponse.json({ success: true, skipped: "매월 1일에만 발송", today: todayKST });
    }
    if (!mailerConfigured()) return NextResponse.json({ error: "메일 미설정" }, { status: 500 });

    // 지난 달 (KST 기준)
    const [ty, tm] = todayKST.split("-").map(Number);
    let year = ty, month = tm - 1;
    if (month === 0) { month = 12; year -= 1; }
    const date = todayKST;

    // ══ ① 회사 경로 ════════════════════════════════════════════════════
    // 단독 경로(②)에서 배제할 계정 — 감독자 본인과 소속 현장 전부.
    const orgLinked = new Set<string>();
    const orgResults = { orgs: 0, ownerSaved: 0, ownerSent: 0, memberSent: 0, memberSkipped: 0, failed: 0 };
    {
      const { data: orgs } = await admin
        .from("organizations")
        .select("id, name, owner_user_id")
        .limit(1000);
      for (const org of (orgs as any[]) || []) {
        // 감독자 구독 유효성 — plan 문자열이 아니라 "유료 자격이 살아있는가"로 판정한다.
        const { data: ownerSub } = await admin
          .from("subscriptions")
          .select("status, current_period_end, billing_key, plan")
          .eq("user_id", org.owner_user_id)
          .maybeSingle();

        const { data: memberRows } = await admin
          .from("org_members")
          .select("member_user_id")
          .eq("org_id", org.id)
          .eq("status", "active");
        const memberIds = ((memberRows as any[]) || []).map((m) => m.member_user_id as string);

        // 구독이 끊겼으면 회사 경로는 건너뛰되, 단독 경로가 대신 주워가지 않도록
        // 배제 집합에는 넣는다(끊긴 회사의 현장에 개별 발송이 나가면 더 이상하다).
        orgLinked.add(org.owner_user_id);
        for (const id of memberIds) orgLinked.add(id);
        if (!ownerSub || !subscriptionAllows(ownerSub) || !isProPlan(ownerSub.plan)) continue;
        orgResults.orgs++;

        // 현장명·실이메일 메타데이터.
        // 감독자 본인도 하나의 현장이다 — 빼면 본인이 쓴 회의록·일지가 병합본에서 통째로 사라진다.
        const accounts: Account[] = [];
        const memberEmail = new Map<string, string>(); // userId → 인증된 실이메일
        for (const id of [org.owner_user_id as string, ...memberIds]) {
          try {
            const { data: u } = await admin.auth.admin.getUserById(id);
            const meta = (u?.user?.user_metadata ?? {}) as Record<string, any>;
            // 감독자의 company_name은 '회사명'이라 현장명으로 쓰면 안 된다 — site_name을 우선한다.
            const label = String(meta.site_name ?? "").trim()
              || (id === org.owner_user_id ? "" : String(meta.company_name ?? "").trim());
            accounts.push({ userId: id, siteName: label || "현장" });
            if (meta.real_email && meta.real_email_verified_at) memberEmail.set(id, String(meta.real_email));
          } catch {
            accounts.push({ userId: id, siteName: "현장" });
          }
        }
        const allIds = accounts.map((a) => a.userId);

        // (a) 병합 보고서 → 안전관리자 웹 열람 저장 (monthly_reports, user_id=owner)
        try {
          const mergedContent = await buildMergedMinutesContent(admin, accounts, year, month, org.name);
          // 교육 종합은 회의록 유무와 독립 — 회의록 0건 달에도 교육 보고서는 나가야 한다 (리뷰 I).
          // 수신자 루프 밖에서 1회만 빌드 (AI 요약 중복 비용 방지).
          const mergedEdu = await buildMergedEducationContent(admin, allIds, year, month, org.name);

          if (mergedContent.stats.total > 0) {
            const { data: existing } = await admin
              .from("monthly_reports")
              .select("token")
              .eq("user_id", org.owner_user_id)
              .eq("period_year", year)
              .eq("period_month", month)
              .maybeSingle();
            const token = existing?.token || randomUUID();
            const { error: upErr } = await admin.from("monthly_reports").upsert(
              {
                user_id: org.owner_user_id,
                period_year: year,
                period_month: month,
                token,
                content: mergedContent as any,
                recipients: [],
                sent_at: new Date().toISOString(),
              },
              { onConflict: "user_id,period_year,period_month" }
            );
            if (!upErr) orgResults.ownerSaved++;
          }

          // (b) 상위 승인 수신처(외부·원청)로 병합본 발송 — 전용 멱등 kind(org_*)
          const { data: ownerConsents } = await admin
            .from("report_recipient_consents")
            .select("recipient_email")
            .eq("account_user_id", org.owner_user_id)
            .eq("status", "approved");
          const merged = accounts.length > 1;
          const tag = merged ? ` (전 ${accounts.length}현장 통합)` : "";
          // 멱등 키를 회사별로 분리 — 같은 원청 이메일을 여러 회사가 승인해도 각각 발송된다.
          const kMinutes: Kind = `org_minutes_${org.owner_user_id}`;
          const kEdu: Kind = `org_education_${org.owner_user_id}`;
          for (const c of (ownerConsents as any[]) || []) {
            const email = c.recipient_email as string;
            if (mergedContent.stats.total > 0 && !(await alreadySent(admin, email, year, month, kMinutes))) {
              const html = renderReportHtml(mergedContent);
              const docTitle = `${org.name} ${year}년 ${month}월 TBM 회의록 종합분석 결재 보고서`;
              const attachments = await buildReportAttachments(mergedContent, docTitle, date);
              const sent = await sendMail({
                to: email,
                subject: `[안톡] ${org.name} ${year}년 ${month}월 TBM 회의록 분석 보고서${tag}`,
                html,
                attachments,
              });
              if (sent.ok) { await recordSent(admin, email, year, month, kMinutes, accounts.length); orgResults.ownerSent++; }
              else orgResults.failed++;
            }
            if (mergedEdu && !(await alreadySent(admin, email, year, month, kEdu))) {
              const html = renderEducationReportHtml(mergedEdu);
              const attachments = await buildEducationAttachments(mergedEdu, `${org.name} 안전보건교육일지 종합 보고서`, date);
              const sent = await sendMail({
                to: email,
                subject: `[안톡] ${org.name} ${year}년 ${month}월 안전보건교육일지 종합${tag}`,
                html,
                attachments,
              });
              if (sent.ok) { await recordSent(admin, email, year, month, kEdu, accounts.length); orgResults.ownerSent++; }
              else orgResults.failed++;
            }
          }
        } catch (e) {
          console.error("org merged report error:", org.id, e);
          orgResults.failed++;
        }

        // (c) 소속 현장 개별: 자기 현장 1현장분 → 본인 인증 이메일.
        // 감독자 본인은 제외 — 병합본을 앱(회사관리 탭)에서 바로 보므로 같은 내용을 메일로 또 받을 이유가 없다.
        for (const acc of accounts) {
          if (acc.userId === org.owner_user_id) continue;
          const email = memberEmail.get(acc.userId);
          if (!email) { orgResults.memberSkipped++; continue; } // 미인증 — 홈 배너가 인증 유도
          // 멱등 키에 계정 id 포함 — 같은 담당자 이메일로 두 현장을 인증해도 각 현장분이 발송돼야 함
          const memberKind: Kind = `member_monthly_${acc.userId}`;
          if (await alreadySent(admin, email, year, month, memberKind)) { orgResults.memberSkipped++; continue; }
          try {
            const own = await buildMergedMinutesContent(admin, [acc], year, month, acc.siteName);
            let anySent = false;
            if (own.stats.total > 0) {
              const html = renderReportHtml(own);
              const docTitle = `${acc.siteName} ${year}년 ${month}월 TBM 회의록 종합분석 결재 보고서`;
              const attachments = await buildReportAttachments(own, docTitle, date);
              const sent = await sendMail({
                to: email,
                subject: `[안톡] ${acc.siteName} ${year}년 ${month}월 TBM 회의록 분석 보고서`,
                html,
                attachments,
              });
              if (sent.ok) anySent = true; else orgResults.failed++;
            }
            const edu = await buildMergedEducationContent(admin, [acc.userId], year, month, acc.siteName);
            if (edu) {
              const html = renderEducationReportHtml(edu);
              const attachments = await buildEducationAttachments(edu, `${acc.siteName} 안전보건교육일지 종합 보고서`, date);
              const sent = await sendMail({
                to: email,
                subject: `[안톡] ${acc.siteName} ${year}년 ${month}월 안전보건교육일지 종합`,
                html,
                attachments,
              });
              if (sent.ok) anySent = true; else orgResults.failed++;
            }
            if (anySent) { await recordSent(admin, email, year, month, memberKind, 1); orgResults.memberSent++; }
          } catch (e) {
            console.error("org member monthly error:", acc.userId, e);
            orgResults.failed++;
          }
        }
      }
    }

    // ══ ② 단독 경로 — 회사에 속하지 않은 계정의 수신자 승인제 ═══════════
    // 승인된 수신 동의
    const { data: consents } = await admin
      .from("report_recipient_consents")
      .select("recipient_email, account_user_id")
      .eq("status", "approved")
      .limit(3000);
    const rows = (consents as { recipient_email: string; account_user_id: string }[]) || [];
    if (rows.length === 0) return NextResponse.json({ success: true, recipients: 0, org: orgResults });

    // 유효한 Pro 계정만 (해지+기간만료 제외)
    const accountIds = [...new Set(rows.map((r) => r.account_user_id))];
    const { data: subs } = await admin
      .from("subscriptions")
      .select("user_id, plan, status, current_period_end")
      .in("user_id", accountIds);
    const nowMs = now.getTime();
    const validPro = new Set<string>();
    for (const s of (subs as any[]) || []) {
      // 회사에 속한 계정(감독자·소속 현장)은 경로 ①이 이미 처리했다. 여기서 또 보내면
      // 같은 수신자에게 병합본과 단독본이 각각 날아간다 — 멱등 kind가 달라 중복을 못 막는다.
      if (orgLinked.has(s.user_id)) continue;
      // 구 베이직·영구무료는 월간 보고서 대상이 아니다(DB 트리거의 80/10/0 집합과 동일 기준).
      if (!isProPlan(s.plan)) continue;
      const ok = ["active", "trialing", "past_due"].includes(s.status) ||
        (s.status === "canceled" && s.current_period_end && new Date(s.current_period_end).getTime() > nowMs);
      if (ok) validPro.add(s.user_id);
    }

    // 계정별 현장명(company_name)
    const siteName = new Map<string, string>();
    for (const id of accountIds) {
      if (!validPro.has(id)) continue;
      try {
        const { data: u } = await admin.auth.admin.getUserById(id);
        siteName.set(id, (u?.user?.user_metadata as any)?.company_name?.trim() || "현장");
      } catch { siteName.set(id, "현장"); }
    }

    // 수신자별로 묶기
    const byRecipient = new Map<string, Account[]>();
    for (const r of rows) {
      if (!validPro.has(r.account_user_id)) continue;
      const arr = byRecipient.get(r.recipient_email) || [];
      arr.push({ userId: r.account_user_id, siteName: siteName.get(r.account_user_id) || "현장" });
      byRecipient.set(r.recipient_email, arr);
    }

    const results = { recipients: byRecipient.size, minutesSent: 0, eduSent: 0, skipped: 0, failed: 0 };

    for (const [email, accounts] of byRecipient) {
      const company = accounts[0].siteName; // 한 회사 가정 — 첫 현장명 사용
      const merged = accounts.length > 1;
      const tag = merged ? ` (전 ${accounts.length}현장 통합)` : "";

      // ① 회의록 종합
      if (await alreadySent(admin, email, year, month, "minutes")) {
        results.skipped++;
      } else {
        const content = await buildMergedMinutesContent(admin, accounts, year, month, company);
        if (content.stats.total > 0) {
          const html = renderReportHtml(content);
          const docTitle = `${company} ${year}년 ${month}월 TBM 회의록 종합분석 결재 보고서`;
          const attachments = await buildReportAttachments(content, docTitle, date);
          const sent = await sendMail({
            to: email,
            subject: `[안톡] ${company} ${year}년 ${month}월 TBM 회의록 분석 보고서${tag}`,
            html,
            attachments,
          });
          if (sent.ok) { await recordSent(admin, email, year, month, "minutes", accounts.length); results.minutesSent++; }
          else results.failed++;
        }
      }

      // ② 안전보건교육일지 종합
      if (!(await alreadySent(admin, email, year, month, "education"))) {
        const edu = await buildMergedEducationContent(admin, accounts.map((a) => a.userId), year, month, company);
        if (edu) {
          const html = renderEducationReportHtml(edu);
          const docTitle = `${company} 안전보건교육일지 종합 보고서`;
          const attachments = await buildEducationAttachments(edu, docTitle, date);
          const sent = await sendMail({
            to: email,
            subject: `[안톡] ${company} ${year}년 ${month}월 안전보건교육일지 종합${tag}`,
            html,
            attachments,
          });
          if (sent.ok) { await recordSent(admin, email, year, month, "education", accounts.length); results.eduSent++; }
          else results.failed++;
        }
      }
    }

    return NextResponse.json({ success: true, period: { year, month }, today: todayKST, ...results, org: orgResults });
  } catch (e: any) {
    console.error("consolidated monthly-report cron error:", e);
    return NextResponse.json({ error: "서버 오류", detail: e?.message }, { status: 500 });
  }
}
