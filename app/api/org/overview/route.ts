// app/api/org/overview/route.ts — 회사관리 탭 데이터
// 현장별(감독자 본인 포함): 오늘 TBM 실시 여부(회의록·일지), 이번 달 건수, 최근 활동일.
// RLS는 열지 않는다 — service role + 멤버십 검증(§4-A 서버 경유 원칙).
//
// 통합 모델에서 이 라우트는 세 역할 전부에 응답한다:
//   owner  — 본인 현장 + 소속 현장 전부
//   solo   — 아직 회사가 없는 계정. 본인 현장 1곳만, canManage=true (첫 현장을 추가하면 회사가 생긴다)
//   member — 소속 현장. 소속 회사의 전체 현황을 같은 모양으로 보되 canManage=false (읽기 전용)
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { getOrgContext, listOrgMembers, type OrgMemberSummary } from "@/lib/org";

export const runtime = "nodejs";

function kstToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** user_metadata에서 현장 표시명을 뽑는다. 감독자의 company_name은 '회사명'이라 현장명으로 쓰면 안 된다. */
function siteLabel(meta: Record<string, any>, isOwner: boolean): string {
  const explicit = String(meta.site_name ?? "").trim();
  if (explicit) return explicit;
  if (isOwner) return "본사 현장";
  return String(meta.company_name ?? "").trim() || "현장명 미설정";
}

export async function GET(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const admin = getAdminClient();
  const ctx = await getOrgContext(user.id, admin);

  // 소속 현장(member)은 자기 회사의 감독자 시점 데이터를 읽기 전용으로 본다.
  const orgId = ctx.org?.id ?? null;
  const ownerUserId = ctx.org?.ownerUserId ?? (ctx.kind === "solo" ? user.id : null);
  const canManage = ctx.kind === "owner" || ctx.kind === "solo";

  let members: OrgMemberSummary[] = [];
  if (orgId) members = await listOrgMembers(orgId, admin);

  // 감독자 본인도 하나의 현장 — 목록 맨 앞에 둔다.
  const ownerMeta = ownerUserId
    ? ownerUserId === user.id
      ? ((user.user_metadata ?? {}) as Record<string, any>)
      : await admin.auth.admin
          .getUserById(ownerUserId)
          .then((r) => (r.data?.user?.user_metadata ?? {}) as Record<string, any>)
          .catch(() => ({} as Record<string, any>))
    : ({} as Record<string, any>);

  const roster: { userId: string; siteName: string; managerName: string; status: "active" | "detached"; isOwner: boolean }[] = [];
  if (ownerUserId) {
    roster.push({
      userId: ownerUserId,
      // solo의 company_name은 가입 위저드의 '현장명(회사명)' 입력값이라 그대로 현장명이다.
      // '본사 현장' 폴백은 진짜 회사를 소유한 owner에게만 적용한다.
      siteName: siteLabel(ownerMeta, ctx.kind === "owner"),
      managerName: String(ownerMeta.full_name ?? ""),
      status: "active",
      isOwner: true,
    });
  }
  for (const m of members) {
    roster.push({ userId: m.userId, siteName: m.siteName || "현장명 미설정", managerName: m.managerName, status: m.status, isOwner: false });
  }

  const activeIds = roster.filter((r) => r.status === "active").map((r) => r.userId);
  const today = kstToday();
  const monthStart = `${today.slice(0, 7)}-01`;
  // 대시보드 미니 차트용 최근 7일 (월 경계를 넘을 수 있어 조회 시작은 둘 중 이른 날짜)
  const last7: string[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${today}T00:00:00+09:00`);
    d.setDate(d.getDate() - (6 - i));
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  });
  const fetchStart = last7[0] < monthStart ? last7[0] : monthStart;

  // 이번 달+최근 7일 회의록/일지 날짜를 한 번에 긁어 현장별·일별 집계 (현장 수 규모에서 충분)
  const [minutesRes, logsRes] = activeIds.length
    ? await Promise.all([
        admin.from("tbm_minutes").select("user_id, date").in("user_id", activeIds).gte("date", fetchStart),
        admin.from("tbm_logs").select("user_id, date").in("user_id", activeIds).gte("date", fetchStart),
      ])
    : [{ data: [] }, { data: [] }];

  const byUser = new Map<
    string,
    { minutesMonth: number; logsMonth: number; todayMinutes: number; todayLogs: number; lastDate: string | null }
  >();
  for (const id of activeIds) byUser.set(id, { minutesMonth: 0, logsMonth: 0, todayMinutes: 0, todayLogs: 0, lastDate: null });
  const dailyMap = new Map<string, { minutes: number; logs: number }>();
  for (const d of last7) dailyMap.set(d, { minutes: 0, logs: 0 });
  for (const r of (minutesRes.data as any[]) || []) {
    const s = byUser.get(r.user_id); if (!s) continue;
    if (r.date >= monthStart) {
      s.minutesMonth++;
      if (!s.lastDate || r.date > s.lastDate) s.lastDate = r.date;
    }
    if (r.date === today) s.todayMinutes++;
    const day = dailyMap.get(r.date); if (day) day.minutes++;
  }
  for (const r of (logsRes.data as any[]) || []) {
    const s = byUser.get(r.user_id); if (!s) continue;
    if (r.date >= monthStart) {
      s.logsMonth++;
      if (!s.lastDate || r.date > s.lastDate) s.lastDate = r.date;
    }
    if (r.date === today) s.todayLogs++;
    const day = dailyMap.get(r.date); if (day) day.logs++;
  }

  const sites = roster.map((m) => {
    const s = byUser.get(m.userId);
    return {
      userId: m.userId,
      siteName: m.siteName,
      managerName: m.managerName,
      status: m.status,
      isOwner: m.isOwner,
      isSelf: m.userId === user.id,
      todayDone: !!s && (s.todayMinutes > 0 || s.todayLogs > 0),
      todayMinutes: s?.todayMinutes ?? 0,
      todayLogs: s?.todayLogs ?? 0,
      monthMinutes: s?.minutesMonth ?? 0,
      monthLogs: s?.logsMonth ?? 0,
      lastActivity: s?.lastDate ?? null,
    };
  });

  return NextResponse.json({
    kind: ctx.kind,
    canManage,
    orgName: ctx.org?.name ?? "",
    // 과금 계정 수 = 감독자 본인 + 활성 소속 현장
    accountCount: activeIds.length,
    // 소속 현장만의 수 (감독자 본인 제외) — "아직 현장이 없어요" 판정용
    memberCount: Math.max(0, activeIds.length - (ownerUserId ? 1 : 0)),
    todayDoneCount: sites.filter((s) => s.status === "active" && s.todayDone).length,
    today,
    sites,
    // 최근 7일 활동 (전 현장 합) — 현장관리 대시보드 미니 차트용
    daily: last7.map((d) => ({ date: d, ...dailyMap.get(d)! })),
  });
}
