// app/api/reports/schedule/route.ts — 보고서 발송 주기 (월간·주간 동시 선택, 감독자/단독 전용)
// GET  : { monthly, weekly, weekday }
// POST : { monthly?, weekly?, weekday? } 부분 갱신
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { getOrgContext } from "@/lib/org";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const admin = getAdminClient();
  const ctx = await getOrgContext(user.id, admin);
  if (ctx.kind === "member") {
    return NextResponse.json({ error: "조직 소속 계정입니다. 보고서 설정은 회사 안전관리자가 관리합니다." }, { status: 403 });
  }
  const { data } = await admin
    .from("subscriptions")
    .select("report_send_monthly, report_send_weekly, report_weekday")
    .eq("user_id", user.id)
    .maybeSingle();
  return NextResponse.json({
    monthly: data?.report_send_monthly ?? true,
    weekly: data?.report_send_weekly ?? false,
    weekday: data?.report_weekday ?? 1,
  });
}

export async function POST(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const admin = getAdminClient();
  const ctx = await getOrgContext(user.id, admin);
  if (ctx.kind === "member") {
    return NextResponse.json({ error: "조직 소속 계정입니다. 보고서 설정은 회사 안전관리자가 관리합니다." }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (typeof body.monthly === "boolean") patch.report_send_monthly = body.monthly;
  if (typeof body.weekly === "boolean") patch.report_send_weekly = body.weekly;
  if (Number.isInteger(body.weekday) && body.weekday >= 0 && body.weekday <= 6) patch.report_weekday = body.weekday;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "변경할 항목이 없습니다." }, { status: 400 });
  }

  // 현재 값과 부분 패치를 합친 결과가 '월간·주간 둘 다 off'면 거부 — 그러면 보고서가 아예 안 나간다.
  // (클라이언트 가드만으론 직접 POST로 뚫린다)
  const { data: cur } = await admin
    .from("subscriptions")
    .select("report_send_monthly, report_send_weekly")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!cur) {
    return NextResponse.json({ error: "구독 정보를 찾을 수 없습니다." }, { status: 404 });
  }
  const nextMonthly = "report_send_monthly" in patch ? (patch.report_send_monthly as boolean) : (cur.report_send_monthly ?? true);
  const nextWeekly = "report_send_weekly" in patch ? (patch.report_send_weekly as boolean) : (cur.report_send_weekly ?? false);
  if (!nextMonthly && !nextWeekly) {
    return NextResponse.json({ error: "월간·주간 중 최소 하나는 켜두세요." }, { status: 400 });
  }

  const { error } = await admin.from("subscriptions").update(patch).eq("user_id", user.id);
  if (error) {
    console.error("report schedule update error:", error);
    return NextResponse.json({ error: "저장에 실패했습니다." }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
