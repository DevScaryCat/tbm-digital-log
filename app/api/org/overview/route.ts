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

  const today = kstToday();
  // 조회 대상 달 — ?month=YYYY-MM (기본: 이번 달). 통계 화면의 달 선택이 쓴다.
  const qMonth = new URL(request.url).searchParams.get("month") ?? "";
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(qMonth) ? qMonth : today.slice(0, 7);
  const isCurrentMonth = month === today.slice(0, 7);
  const monthStart = `${month}-01`;
  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, "0")}`;
  // 일별 차트 = 그 달의 날짜들. 이번 달이면 오늘까지만(빈 미래 막대는 기록이 없는 것처럼 읽힌다).
  const lastDay = isCurrentMonth ? Number(today.slice(8, 10)) : daysInMonth;
  const days: string[] = Array.from({ length: lastDay }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  const fetchStart = monthStart;
  const fetchEnd = monthEnd;

  // 활성 계정 id는 owner면 ctx(memberIds)만으로 확정된다 — 메타데이터 조회(listOrgMembers,
  // 현장 수만큼 admin API 호출)를 기다렸다가 데이터 쿼리를 시작하던 직렬 구조가 통계 화면
  // 4초 지연의 주범. id를 먼저 확정하고 [메타데이터 | 회의록/일지 | 누적 RPC]를 전부 병렬로.
  // member는 ctx에 명단이 없어 종전처럼 명단을 먼저 받는다 (UI 미사용 경로 — 속도보다 정합성).
  let preMembers: OrgMemberSummary[] | null = null;
  let activeIds: string[];
  if (ctx.kind === "member" && orgId) {
    preMembers = await listOrgMembers(orgId, admin);
    activeIds = ownerUserId
      ? [ownerUserId, ...preMembers.filter((m) => m.status === "active").map((m) => m.userId)]
      : [];
  } else {
    activeIds = ownerUserId ? [ownerUserId, ...(ctx.memberIds ?? [])] : [];
  }

  const [members, ownerMeta, minutesRes, logsRes, countsRes] = await Promise.all([
    preMembers ? Promise.resolve(preMembers) : orgId ? listOrgMembers(orgId, admin) : Promise.resolve([] as OrgMemberSummary[]),
    ownerUserId
      ? ownerUserId === user.id
        ? Promise.resolve((user.user_metadata ?? {}) as Record<string, any>)
        : admin.auth.admin
            .getUserById(ownerUserId)
            .then((r) => (r.data?.user?.user_metadata ?? {}) as Record<string, any>)
            .catch(() => ({} as Record<string, any>))
      : Promise.resolve({} as Record<string, any>),
    activeIds.length
      ? admin.from("tbm_minutes").select("id, user_id, date, hazards").in("user_id", activeIds).gte("date", fetchStart).lte("date", fetchEnd)
      : Promise.resolve({ data: [] as any[] }),
    activeIds.length
      ? admin.from("tbm_logs").select("user_id, date").in("user_id", activeIds).gte("date", fetchStart).lte("date", fetchEnd)
      : Promise.resolve({ data: [] as any[] }),
    // 누적 카운트 — 현장 수 × 3개의 head-count 대신 RPC 1회 (20260729010000)
    activeIds.length
      ? admin.rpc("org_doc_counts", { p_ids: activeIds })
      : Promise.resolve({ data: [] as any[] }),
  ]);

  // 감독자 본인도 하나의 현장 — 목록 맨 앞에 둔다.
  const roster: { userId: string; siteName: string; managerName: string; workerType: string; status: "active" | "detached"; isOwner: boolean }[] = [];
  if (ownerUserId) {
    roster.push({
      userId: ownerUserId,
      // solo의 company_name은 가입 위저드의 '현장명(회사명)' 입력값이라 그대로 현장명이다.
      // '본사 현장' 폴백은 진짜 회사를 소유한 owner에게만 적용한다.
      siteName: siteLabel(ownerMeta, ctx.kind === "owner"),
      managerName: String(ownerMeta.full_name ?? ""),
      workerType: String(ownerMeta.worker_type ?? ""),
      status: "active",
      isOwner: true,
    });
  }
  for (const m of members) {
    roster.push({ userId: m.userId, siteName: m.siteName || "현장명 미설정", managerName: m.managerName, workerType: m.workerType, status: m.status, isOwner: false });
  }

  // 위험요인 대시보드 — 감독자가 실제로 보고 싶은 건 "우리 현장들, 뭐가 위험한가"다.
  // 등급 분포(상/중/하)와 자주 등장한 키워드를 이번 달 회의록에서 뽑는다.
  // 통계 화면이 전체/현장별 같은 UI를 쓰므로 전체 합계와 현장별 집계를 같은 루프에서 만든다.
  const levelCounts = { high: 0, mid: 0, low: 0 };
  const kwCount = new Map<string, number>();
  // 키워드 드릴다운 근거 — count(발생 횟수)와 의미가 달라 별도 수집한다:
  // 한 문구에 같은 단어가 두 번 나와도 근거로는 1건이므로 (단어, 회의록, factor 문구) 단위로 dedup.
  type KwItem = { date: string; minuteId: string; siteId: string; factor: string };
  const kwItems = new Map<string, KwItem[]>();
  const kwSeen = new Set<string>();
  const riskByUser = new Map<string, { levels: { high: number; mid: number; low: number }; kw: Map<string, number>; kwItems: Map<string, KwItem[]> }>();
  for (const id of activeIds) riskByUser.set(id, { levels: { high: 0, mid: 0, low: 0 }, kw: new Map(), kwItems: new Map() });
  const KW_STOP = new Set(["위험", "및", "의한", "인한", "대한", "관련", "작업", "발생", "주변", "부위", "가능", "우려", "사고", "상태", "구간", "현장", "안전"]);
  for (const r of (minutesRes.data as any[]) || []) {
    if (r.date < monthStart || !Array.isArray(r.hazards)) continue;
    const mine = riskByUser.get(r.user_id);
    for (const h of r.hazards) {
      const lv = String(h?.level ?? "");
      if (lv === "상") { levelCounts.high++; if (mine) mine.levels.high++; }
      else if (lv === "하") { levelCounts.low++; if (mine) mine.levels.low++; }
      else { levelCounts.mid++; if (mine) mine.levels.mid++; }
      const factor = String(h?.factor ?? "");
      for (const tok of factor.split(/[\s·,()\-]+/)) {
        const w = tok.trim();
        if (w.length < 2 || KW_STOP.has(w) || /^\d+$/.test(w)) continue;
        kwCount.set(w, (kwCount.get(w) ?? 0) + 1);
        if (mine) mine.kw.set(w, (mine.kw.get(w) ?? 0) + 1);
        // 회의록 id는 현장(user)에 종속이라 전역 dedup 한 번이면 현장별 목록에도 충분하다
        const seenKey = `${w}\u0000${r.id}\u0000${factor}`;
        if (kwSeen.has(seenKey)) continue;
        kwSeen.add(seenKey);
        const item: KwItem = { date: String(r.date), minuteId: String(r.id), siteId: String(r.user_id), factor };
        if (!kwItems.has(w)) kwItems.set(w, []);
        kwItems.get(w)!.push(item);
        if (mine) {
          if (!mine.kwItems.has(w)) mine.kwItems.set(w, []);
          mine.kwItems.get(w)!.push(item);
        }
      }
    }
  }
  const topKeywords = (m: Map<string, number>, items: Map<string, KwItem[]>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([word, count]) => ({
      word,
      count,
      // 근거는 최신 기록부터 — 응답 비대 방지를 위해 20건에서 절단
      items: [...(items.get(word) ?? [])].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20),
    }));
  const keywords = topKeywords(kwCount, kwItems);

  const byUser = new Map<
    string,
    { minutesMonth: number; logsMonth: number; todayMinutes: number; todayLogs: number; lastDate: string | null }
  >();
  for (const id of activeIds) byUser.set(id, { minutesMonth: 0, logsMonth: 0, todayMinutes: 0, todayLogs: 0, lastDate: null });
  const dailyMap = new Map<string, { minutes: number; logs: number }>();
  for (const d of days) dailyMap.set(d, { minutes: 0, logs: 0 });
  // 현장별 7일 차트 — 전체와 같은 UI를 현장 단위로 그리기 위한 분해본
  const dailyByUser = new Map<string, Map<string, { minutes: number; logs: number }>>();
  for (const id of activeIds) {
    const m = new Map<string, { minutes: number; logs: number }>();
    for (const d of days) m.set(d, { minutes: 0, logs: 0 });
    dailyByUser.set(id, m);
  }
  for (const r of (minutesRes.data as any[]) || []) {
    const s = byUser.get(r.user_id); if (!s) continue;
    if (r.date >= monthStart) {
      s.minutesMonth++;
      if (!s.lastDate || r.date > s.lastDate) s.lastDate = r.date;
    }
    if (r.date === today) s.todayMinutes++;
    const day = dailyMap.get(r.date); if (day) day.minutes++;
    const mine = dailyByUser.get(r.user_id)?.get(r.date); if (mine) mine.minutes++;
  }
  for (const r of (logsRes.data as any[]) || []) {
    const s = byUser.get(r.user_id); if (!s) continue;
    if (r.date >= monthStart) {
      s.logsMonth++;
      if (!s.lastDate || r.date > s.lastDate) s.lastDate = r.date;
    }
    if (r.date === today) s.todayLogs++;
    const day = dailyMap.get(r.date); if (day) day.logs++;
    const mine = dailyByUser.get(r.user_id)?.get(r.date); if (mine) mine.logs++;
  }

  // 전체 기간 누적 건수 — RPC 1회 결과를 맵으로 (기존: 현장 수 × 3개의 head-count 쿼리)
  const totals = new Map<string, { minutes: number; logs: number; suggestions: number }>();
  if ((countsRes as any)?.error) console.error("org_doc_counts rpc error:", (countsRes as any).error);
  for (const r of (((countsRes as any)?.data as any[]) ?? [])) {
    totals.set(String(r.user_id), {
      minutes: Number(r.minutes) || 0,
      logs: Number(r.logs) || 0,
      suggestions: Number(r.suggestions) || 0,
    });
  }

  const sites = roster.map((m) => {
    const s = byUser.get(m.userId);
    const t = totals.get(m.userId);
    const r = riskByUser.get(m.userId);
    const d = dailyByUser.get(m.userId);
    return {
      userId: m.userId,
      siteName: m.siteName,
      managerName: m.managerName,
      // 교육 진행도 카드가 의무시간(6h/12h)을 가르는 키 — 별도 조회 없이 여기서 같이 내려준다
      workerType: m.workerType,
      status: m.status,
      isOwner: m.isOwner,
      isSelf: m.userId === user.id,
      todayDone: !!s && (s.todayMinutes > 0 || s.todayLogs > 0),
      // 지난 달을 볼 땐 '오늘'이 없다 — 그 달에 한 건이라도 쓴 현장인지로 대신 센다
      monthActive: !!s && (s.minutesMonth > 0 || s.logsMonth > 0),
      todayMinutes: s?.todayMinutes ?? 0,
      todayLogs: s?.todayLogs ?? 0,
      monthMinutes: s?.minutesMonth ?? 0,
      monthLogs: s?.logsMonth ?? 0,
      lastActivity: s?.lastDate ?? null,
      totalMinutes: t?.minutes ?? 0,
      totalLogs: t?.logs ?? 0,
      suggestions: t?.suggestions ?? 0,
      // 현장 선택 시 전체와 같은 UI로 그리기 위한 현장 단위 차트·위험요인
      daily: days.map((day) => ({ date: day, ...(d?.get(day) ?? { minutes: 0, logs: 0 }) })),
      risk: r ? { levels: r.levels, keywords: topKeywords(r.kw, r.kwItems) } : { levels: { high: 0, mid: 0, low: 0 }, keywords: [] },
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
    monthActiveCount: sites.filter((s) => s.status === "active" && s.monthActive).length,
    today,
    // 선택된 달과 그 달이 '이번 달'인지 — 화면이 '오늘 실시' 타일을 쓸지 결정한다
    month,
    isCurrentMonth,
    sites,
    // 최근 7일 활동 (전 현장 합) — 현장관리 대시보드 미니 차트용
    daily: days.map((d) => ({ date: d, ...dailyMap.get(d)! })),
    // 이번 달 위험요인 집계 — 등급 분포 + 자주 나온 키워드
    risk: { levels: levelCounts, keywords },
  });
}
