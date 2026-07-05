import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/portone";
import { generateAndSendReport, generateAndSendRangeReport, previousMonth, ReportSubscription } from "@/lib/monthlyReport";
import { generateAndSendEducationReport } from "@/lib/educationReport";

export const runtime = "nodejs";
export const maxDuration = 300;

// Vercel Cron(매일 00:00 UTC): Pro 구독자에게 자동 보고서 발송
// - 월간(report_frequency='monthly'): 발송일(report_send_day)==오늘 → 지난달 종합
// - 주간(report_frequency='weekly'): 요일(report_weekday)==오늘 → 직전 7일 종합
// 회의록 종합 + 안전보건교육일지 종합, 메일 2개. report_last_sent_on으로 같은 날 중복 발송 방지.
export async function POST(request: Request) {
  return run(request);
}
export async function GET(request: Request) {
  return run(request);
}

const pad = (n: number) => String(n).padStart(2, "0");
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function addDaysStr(dateStr: string, delta: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function run(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization") || "";
  const provided = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!cronSecret || provided !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const admin = getAdminClient();
    const now = new Date();

    // 오늘(KST) 날짜·일·요일
    const todayKST = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(now); // "YYYY-MM-DD"
    const todayDay = Number(todayKST.slice(8, 10));
    const wkShort = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(now);
    const todayWeekday = WEEKDAY[wkShort] ?? 0;

    // 월간 대상 기간(지난 달)
    const { year, month } = previousMonth(now);
    const monthFrom = `${year}-${pad(month)}-01`;
    const monthTo = `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
    // 주간 대상 기간(직전 7일: 어제까지)
    const weekFrom = addDaysStr(todayKST, -7);
    const weekTo = addDaysStr(todayKST, -1);

    const { data: subs, error } = await admin
      .from("subscriptions")
      .select("id, user_id, plan, status, current_period_end, report_recipients, report_send_day, report_frequency, report_weekday, report_last_sent_on")
      .eq("plan", "monthly_pro")
      .in("status", ["active", "trialing", "past_due", "canceled"])
      .limit(500);
    if (error) {
      console.error("scheduled-report query error:", error);
      return NextResponse.json({ error: "조회 실패" }, { status: 500 });
    }

    const nowMs = Date.now();
    const results = { processed: 0, minutesSent: 0, eduSent: 0, skipped: 0, failed: 0, raCounted: 0 };

    for (const sub of (subs || []) as any[]) {
      const freq = sub.report_frequency === "weekly" ? "weekly" : "monthly";
      const shouldSend = freq === "weekly"
        ? todayWeekday === (sub.report_weekday ?? 1)
        : todayDay === (sub.report_send_day ?? 1);
      if (!shouldSend) continue;

      // 같은 날 이미 처리했으면 건너뜀(중복 발송 방지)
      if (sub.report_last_sent_on === todayKST) { results.skipped++; continue; }

      // 해지됐는데 기간도 지났으면 제외
      if (
        sub.status === "canceled" &&
        (!sub.current_period_end || new Date(sub.current_period_end).getTime() <= nowMs)
      ) {
        continue;
      }
      const recipients = (sub.report_recipients || []).filter((e: string) => e && e.includes("@"));
      if (recipients.length === 0) continue;

      results.processed++;

      // 회사명: auth user metadata
      let companyName: string | null = null;
      try {
        const { data: u } = await admin.auth.admin.getUserById(sub.user_id);
        companyName = (u?.user?.user_metadata as any)?.company_name ?? null;
      } catch {}

      const from = freq === "weekly" ? weekFrom : monthFrom;
      const to = freq === "weekly" ? weekTo : monthTo;

      // ① 회의록 종합
      const m = freq === "weekly"
        ? await generateAndSendRangeReport(admin, sub.user_id, recipients, companyName, from, to)
        : await generateAndSendReport(admin, sub as ReportSubscription, year, month, { companyName });
      if (m.status === "sent") results.minutesSent++;
      else if (m.status === "mail_failed") results.failed++;

      // ② 안전보건교육일지 종합
      const e = await generateAndSendEducationReport(admin, sub.user_id, recipients, companyName, from, to);
      if (e.status === "sent") results.eduSent++;
      else if (e.status === "mail_failed") results.failed++;

      // 자동 발송 1건 = AI 분석 보고서 월 한도에서 1회 차감 (실제로 발송된 경우만, 주기당 1회)
      if (m.status === "sent" || e.status === "sent") {
        const { error: raErr } = await admin.from("tbm_risk_assessments").insert({
          user_id: sub.user_id,
          date: todayKST,
          work_name: `${freq === "weekly" ? "주간" : "월간"} 보고서 자동발송`,
          items: [],
        });
        if (raErr) console.error("auto-report RA count insert error:", raErr);
        else results.raCounted++;
      }

      // 오늘 처리 표시(데이터 유무와 무관 — 같은 날 재시도 방지)
      await admin.from("subscriptions").update({ report_last_sent_on: todayKST }).eq("user_id", sub.user_id);
    }

    return NextResponse.json({
      success: true,
      today: { date: todayKST, day: todayDay, weekday: todayWeekday },
      monthly: { year, month },
      weekly: { from: weekFrom, to: weekTo },
      ...results,
    });
  } catch (e: any) {
    console.error("scheduled-report cron error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
