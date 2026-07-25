// app/api/org/site-stats/route.ts — 현장 분석 (안전관리자 전용, 대상 현장 1곳)
// 이번 달 통계 + 최근 문서 목록 + 회의록 작성일(달력·AI 분석 기간 참고용)
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { assertOwnerOfMember } from "@/lib/org";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const target = searchParams.get("userId") || "";
  const admin = getAdminClient();
  if (!target || !(await assertOwnerOfMember(user.id, target, admin))) {
    return NextResponse.json({ error: "우리 조직의 현장 계정이 아닙니다." }, { status: 403 });
  }

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const monthStart = `${today.slice(0, 7)}-01`;

  const [meta, minutesMonth, logsMonth, recentMinutes, recentLogs, minuteDates] = await Promise.all([
    admin.auth.admin.getUserById(target),
    admin.from("tbm_minutes").select("id", { count: "exact", head: true }).eq("user_id", target).gte("date", monthStart),
    admin.from("tbm_logs").select("id", { count: "exact", head: true }).eq("user_id", target).gte("date", monthStart),
    admin.from("tbm_minutes").select("id, date, work_name, process_name").eq("user_id", target).order("date", { ascending: false }).limit(10),
    admin.from("tbm_logs").select("id, date, education_type").eq("user_id", target).order("date", { ascending: false }).limit(10),
    admin.from("tbm_minutes").select("date").eq("user_id", target).order("date", { ascending: false }).limit(300),
  ]);

  const md = (meta?.data?.user?.user_metadata ?? {}) as Record<string, unknown>;
  return NextResponse.json({
    siteName: String(md.company_name ?? "") || "현장명 미설정",
    managerName: String(md.full_name ?? ""),
    month: today.slice(0, 7),
    monthMinutes: minutesMonth.count ?? 0,
    monthLogs: logsMonth.count ?? 0,
    recentMinutes: recentMinutes.data ?? [],
    recentLogs: recentLogs.data ?? [],
    minuteDates: [...new Set(((minuteDates.data as any[]) || []).map((r) => r.date).filter(Boolean))],
  });
}
