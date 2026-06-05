import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/portone";
import { generateAndSendReport, previousMonth, ReportSubscription } from "@/lib/monthlyReport";

export const runtime = "nodejs";
export const maxDuration = 300;

// Vercel Cron(매월 1일): 직전 월 안전 보고서를 Pro 구독자의 수신처로 자동 발송
export async function POST(request: Request) {
  return run(request);
}
export async function GET(request: Request) {
  return run(request);
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
    const { year, month } = previousMonth(new Date());

    // 오늘(KST) 며칠인지 — 이 날짜를 발송일로 설정한 구독만 발송
    const todayDay = Number(
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", day: "numeric" }).format(new Date())
    );

    // Pro + 사용 가능 상태인 구독만 (수신처·발송일은 JS에서 필터)
    const { data: subs, error } = await admin
      .from("subscriptions")
      .select("id, user_id, plan, status, current_period_end, report_recipients, report_send_day")
      .eq("plan", "monthly_pro")
      .in("status", ["active", "trialing", "past_due", "canceled"])
      .limit(500);
    if (error) {
      console.error("monthly-report query error:", error);
      return NextResponse.json({ error: "조회 실패" }, { status: 500 });
    }

    const nowMs = Date.now();
    const results = { processed: 0, sent: 0, skipped: 0, no_data: 0, no_recipients: 0, failed: 0 };

    for (const sub of (subs || []) as any[]) {
      // 발송일이 오늘이 아니면 건너뜀
      if ((sub.report_send_day ?? 1) !== todayDay) continue;
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

      const r = await generateAndSendReport(admin, sub as ReportSubscription, year, month, { companyName });
      if (r.status === "sent") results.sent++;
      else if (r.status === "skipped") results.skipped++;
      else if (r.status === "no_data") results.no_data++;
      else if (r.status === "no_recipients") results.no_recipients++;
      else results.failed++;
    }

    return NextResponse.json({ success: true, period: { year, month }, ...results });
  } catch (e: any) {
    console.error("monthly-report cron error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
