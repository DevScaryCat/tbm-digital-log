import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/portone";
import { buildMergedMinutesContent, renderReportHtml, buildReportAttachments } from "@/lib/monthlyReport";
import { buildMergedEducationContent, renderEducationReportHtml, buildEducationAttachments } from "@/lib/educationReport";
import { sendMail, mailerConfigured } from "@/lib/mailer";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 300;

// Vercel Cron(매일 00:00 UTC): 매월 1일(KST)에 지난달 종합 보고서를 '승인한 수신자'별로 발송.
// 한 수신자가 여러 현장(계정)을 승인했으면 데이터를 합쳐 통합 1벌로. 1곳이면 그 현장만.
export async function POST(request: Request) { return run(request); }
export async function GET(request: Request) { return run(request); }

type Account = { userId: string; siteName: string };
type Kind = "minutes" | "education";

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

    // 승인된 수신 동의
    const { data: consents } = await admin
      .from("report_recipient_consents")
      .select("recipient_email, account_user_id")
      .eq("status", "approved")
      .limit(3000);
    const rows = (consents as { recipient_email: string; account_user_id: string }[]) || [];
    if (rows.length === 0) return NextResponse.json({ success: true, recipients: 0 });

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
    const date = todayKST;

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

    return NextResponse.json({ success: true, period: { year, month }, today: todayKST, ...results });
  } catch (e: any) {
    console.error("consolidated monthly-report cron error:", e);
    return NextResponse.json({ error: "서버 오류", detail: e?.message }, { status: 500 });
  }
}
