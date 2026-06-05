import { NextResponse } from "next/server";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import {
  generateAndSendReport,
  previousMonth,
  ReportSubscription,
} from "@/lib/monthlyReport";

export const runtime = "nodejs";
export const maxDuration = 120;

// 사용자가 직접 월간 보고서를 지금 발송 (Pro 전용, 테스트/즉시 발송용)
export async function POST(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!isPro)
    return NextResponse.json({ error: "월간 보고서는 Pro 플랜 기능입니다." }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const which: "prev" | "current" = body?.which === "current" ? "current" : "prev";

  const now = new Date();
  const { year, month } =
    which === "current"
      ? { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }
      : previousMonth(now);

  const admin = getAdminClient();
  const { data: sub, error } = await admin
    .from("subscriptions")
    .select("id, user_id, plan, report_recipients")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error || !sub) {
    return NextResponse.json({ error: "구독을 찾을 수 없습니다." }, { status: 404 });
  }

  const companyName = (user.user_metadata as any)?.company_name ?? null;

  const r = await generateAndSendReport(admin, sub as ReportSubscription, year, month, {
    companyName,
    force: true, // 수동 발송은 항상 재발송 허용
  });

  if (r.status === "no_recipients") {
    return NextResponse.json({ error: "먼저 수신처(이메일)를 등록해주세요." }, { status: 400 });
  }
  if (r.status === "no_data") {
    return NextResponse.json(
      { error: `${year}년 ${month}월에 작성된 기록이 없어 보고서를 만들 수 없습니다.` },
      { status: 400 }
    );
  }
  if (r.status === "mail_failed") {
    return NextResponse.json({ error: "메일 발송 실패: " + (r.detail ?? "") }, { status: 502 });
  }

  return NextResponse.json({ success: true, period: { year, month }, token: r.token });
}
