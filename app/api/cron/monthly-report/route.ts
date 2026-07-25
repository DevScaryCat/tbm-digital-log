import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getAdminClient, subscriptionAllows } from "@/lib/portone";
import { buildMergedMinutesContent, renderReportHtml, buildReportAttachments } from "@/lib/monthlyReport";
import { buildMergedEducationContent, renderEducationReportHtml, buildEducationAttachments } from "@/lib/educationReport";
import { sendMail, mailerConfigured } from "@/lib/mailer";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 300;

// Vercel Cron(매일 00:00 UTC): 매월 1일(KST)에 지난달 종합 보고서 발송. 두 축(§7):
// ① 조직(org): 하위 현장 병합 → 안전관리자 웹 열람 저장 + 상위 승인 수신처 발송,
//    각 하위는 자기 현장분을 본인 인증 이메일로 수신 (kind='member_monthly').
// ② 시나리오 2(단독): 기존 수신자 승인제 그대로 — plan 필터(monthly_pro)가 org 계정을
//    자연 배제하므로 org_seat를 이 필터에 추가하면 안 된다(이중 발송, 검증 §7).
export async function POST(request: Request) { return run(request); }
export async function GET(request: Request) { return run(request); }

type Account = { userId: string; siteName: string };
// org 경로는 시나리오 2와 발신 주체가 달라 멱등 키(kind)를 분리한다 — 같은 수신 이메일이
// 양쪽에 걸치면 한쪽이 조용히 미발송되는 교차 누락 방지 (리뷰 G). member_monthly는
// 계정 id를 키에 포함 — 한 담당자가 두 현장의 실이메일이면 두 현장분 모두 받아야 한다 (리뷰 H).
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

    // ══ ① 조직(org) 경로 ═══════════════════════════════════════════════
    const orgResults = { orgs: 0, ownerSaved: 0, ownerSent: 0, memberSent: 0, memberSkipped: 0, failed: 0 };
    {
      const { data: orgs } = await admin
        .from("organizations")
        .select("id, name, owner_user_id")
        .limit(1000);
      for (const org of (orgs as any[]) || []) {
        // 상위 구독 유효성
        const { data: ownerSub } = await admin
          .from("subscriptions")
          .select("status, current_period_end, billing_key, plan")
          .eq("user_id", org.owner_user_id)
          .maybeSingle();
        if (!ownerSub || ownerSub.plan !== "org" || !subscriptionAllows(ownerSub)) continue;

        const { data: memberRows } = await admin
          .from("org_members")
          .select("member_user_id")
          .eq("org_id", org.id)
          .eq("status", "active");
        const memberIds = ((memberRows as any[]) || []).map((m) => m.member_user_id as string);
        if (memberIds.length === 0) continue;
        orgResults.orgs++;

        // 현장명·실이메일 메타데이터
        const accounts: Account[] = [];
        const memberEmail = new Map<string, string>(); // userId → 인증된 실이메일
        for (const id of memberIds) {
          try {
            const { data: u } = await admin.auth.admin.getUserById(id);
            const meta = (u?.user?.user_metadata ?? {}) as Record<string, any>;
            accounts.push({ userId: id, siteName: String(meta.company_name ?? "").trim() || "현장" });
            if (meta.real_email && meta.real_email_verified_at) memberEmail.set(id, String(meta.real_email));
          } catch {
            accounts.push({ userId: id, siteName: "현장" });
          }
        }

        // (a) 병합 보고서 → 안전관리자 웹 열람 저장 (monthly_reports, user_id=owner)
        try {
          const mergedContent = await buildMergedMinutesContent(admin, accounts, year, month, org.name);
          // 교육 종합은 회의록 유무와 독립 — 회의록 0건 달에도 교육 보고서는 나가야 한다 (리뷰 I).
          // 수신자 루프 밖에서 1회만 빌드 (AI 요약 중복 비용 방지).
          const mergedEdu = await buildMergedEducationContent(admin, memberIds, year, month, org.name);

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
          for (const c of (ownerConsents as any[]) || []) {
            const email = c.recipient_email as string;
            if (mergedContent.stats.total > 0 && !(await alreadySent(admin, email, year, month, "org_minutes"))) {
              const html = renderReportHtml(mergedContent);
              const docTitle = `${org.name} ${year}년 ${month}월 TBM 회의록 종합분석 결재 보고서`;
              const attachments = await buildReportAttachments(mergedContent, docTitle, date);
              const sent = await sendMail({
                to: email,
                subject: `[안톡] ${org.name} ${year}년 ${month}월 TBM 회의록 분석 보고서${tag}`,
                html,
                attachments,
              });
              if (sent.ok) { await recordSent(admin, email, year, month, "org_minutes", accounts.length); orgResults.ownerSent++; }
              else orgResults.failed++;
            }
            if (mergedEdu && !(await alreadySent(admin, email, year, month, "org_education"))) {
              const html = renderEducationReportHtml(mergedEdu);
              const attachments = await buildEducationAttachments(mergedEdu, `${org.name} 안전보건교육일지 종합 보고서`, date);
              const sent = await sendMail({
                to: email,
                subject: `[안톡] ${org.name} ${year}년 ${month}월 안전보건교육일지 종합${tag}`,
                html,
                attachments,
              });
              if (sent.ok) { await recordSent(admin, email, year, month, "org_education", accounts.length); orgResults.ownerSent++; }
              else orgResults.failed++;
            }
          }
        } catch (e) {
          console.error("org merged report error:", org.id, e);
          orgResults.failed++;
        }

        // (c) 하위 개별: 자기 현장 1현장분 → 본인 인증 이메일 (결정 4: 앱 내 화면 없음, 이메일로만)
        for (const acc of accounts) {
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

    // ══ ② 시나리오 2(단독) — 기존 수신자 승인제 경로 (현행 유지) ═══════
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
      if (s.plan !== "monthly_pro") continue;
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
