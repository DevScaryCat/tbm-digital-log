import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/portone";
import { chargeSubscription, SubscriptionRow } from "@/lib/billing";

export const runtime = "nodejs";
// 청구 건이 몰리는 날 기본 타임아웃에 걸려 뒤쪽 구독이 누락되지 않도록 명시(월간 보고서 cron과 동일).
export const maxDuration = 300;

// Vercel Cron(매일): 결제일이 도래한 구독을 빌링키로 자동 과금
export async function POST(request: Request) {
  return run(request);
}
// Vercel Cron은 GET으로 호출됨
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
    const nowIso = new Date().toISOString();

    // 청구 대상: 체험/활성 상태 + 결제일 도래
    const { data: due, error } = await admin
      .from("subscriptions")
      .select("id, user_id, plan, pending_plan, billing_key, billing_key_verified, amount, status, current_period_end, failed_attempts")
      .in("status", ["trialing", "active", "past_due"])
      .lte("current_period_end", nowIso)
      .not("billing_key", "is", null)
      .order("current_period_end", { ascending: true })
      .limit(200);

    if (error) {
      console.error("cron query error:", error);
      return NextResponse.json({ error: "조회 실패" }, { status: 500 });
    }

    const results = { processed: 0, paid: 0, failed: 0 };
    for (const sub of (due || []) as SubscriptionRow[]) {
      results.processed++;
      const r = await chargeSubscription(admin, sub);
      if (r.ok) results.paid++;
      else results.failed++;
    }

    return NextResponse.json({ success: true, ...results });
  } catch (e: any) {
    console.error("cron route error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
