// app/api/org/overview/route.ts — 관제 대시보드 데이터 (안전관리자 전용)
// 하위 현장별: 오늘 TBM 실시 여부(회의록·일지), 이번 달 건수, 최근 활동일.
// RLS는 열지 않는다 — service role + 멤버십 검증(§4-A 서버 경유 원칙).
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { getOrgContext, listOrgMembers } from "@/lib/org";

export const runtime = "nodejs";

function kstToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export async function GET(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const admin = getAdminClient();
  const ctx = await getOrgContext(user.id, admin);
  if (ctx.kind !== "owner" || !ctx.org) {
    return NextResponse.json({ error: "안전관리자 계정만 접근할 수 있습니다." }, { status: 403 });
  }

  const members = await listOrgMembers(ctx.org.id, admin);
  const activeIds = members.filter((m) => m.status === "active").map((m) => m.userId);

  const today = kstToday();
  const monthStart = `${today.slice(0, 7)}-01`;

  // 이번 달 회의록/일지 날짜를 한 번에 긁어 현장별 집계 (현장 수 규모에서 충분)
  const [minutesRes, logsRes] = activeIds.length
    ? await Promise.all([
        admin.from("tbm_minutes").select("user_id, date").in("user_id", activeIds).gte("date", monthStart),
        admin.from("tbm_logs").select("user_id, date").in("user_id", activeIds).gte("date", monthStart),
      ])
    : [{ data: [] }, { data: [] }];

  const byUser = new Map<
    string,
    { minutesMonth: number; logsMonth: number; todayMinutes: number; todayLogs: number; lastDate: string | null }
  >();
  for (const id of activeIds) byUser.set(id, { minutesMonth: 0, logsMonth: 0, todayMinutes: 0, todayLogs: 0, lastDate: null });
  for (const r of (minutesRes.data as any[]) || []) {
    const s = byUser.get(r.user_id); if (!s) continue;
    s.minutesMonth++;
    if (r.date === today) s.todayMinutes++;
    if (!s.lastDate || r.date > s.lastDate) s.lastDate = r.date;
  }
  for (const r of (logsRes.data as any[]) || []) {
    const s = byUser.get(r.user_id); if (!s) continue;
    s.logsMonth++;
    if (r.date === today) s.todayLogs++;
    if (!s.lastDate || r.date > s.lastDate) s.lastDate = r.date;
  }

  const sites = members.map((m) => {
    const s = byUser.get(m.userId);
    return {
      userId: m.userId,
      siteName: m.siteName || "현장명 미설정",
      managerName: m.managerName,
      status: m.status,
      todayDone: !!s && (s.todayMinutes > 0 || s.todayLogs > 0),
      todayMinutes: s?.todayMinutes ?? 0,
      todayLogs: s?.todayLogs ?? 0,
      monthMinutes: s?.minutesMonth ?? 0,
      monthLogs: s?.logsMonth ?? 0,
      lastActivity: s?.lastDate ?? null,
    };
  });

  return NextResponse.json({
    orgName: ctx.org.name,
    seatCount: ctx.org.seatCount,
    pendingSeatCount: ctx.org.pendingSeatCount,
    activeCount: activeIds.length,
    todayDoneCount: sites.filter((s) => s.status === "active" && s.todayDone).length,
    today,
    sites,
  });
}
