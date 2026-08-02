// app/api/org/education/route.ts — 현장별 법정 정기교육 진행도 (현재 반기 인정 시간)
//
// /api/org/overview에서 일부러 분리했다: 이 조회는 반기 전체 구간이라 overview의 '이번 달'
// 조회보다 6배 크다. 통계 첫 화면(활동 기록·위험요인)의 응답을 늦추면 안 되므로,
// 화면 아래쪽 교육 카드가 마운트된 뒤 따로 불러간다.
//
// 인정 규칙은 홈·교육 진행도 화면과 같은 lib/educationHours를 그대로 쓴다 —
// 세 화면이 같은 데이터에서 다른 시간을 말하면 안 된다.
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { getOrgContext, listOrgMembers } from "@/lib/org";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { sessionSeconds, isRegularEducationType } from "@/lib/educationHours";

export const runtime = "nodejs";

interface LogRow { user_id: string; start_time: string | null; end_time: string | null; education_type: string | null }
interface MinRow { user_id: string; start_time: string | null; end_time: string | null }

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
  const orgId = ctx.org?.id ?? null;
  const ownerUserId = ctx.org?.ownerUserId ?? (ctx.kind === "solo" ? user.id : null);

  // 대상 현장 id — overview와 같은 규칙(감독자 본인 + 활성 소속 현장)
  let activeIds: string[];
  if (ctx.kind === "member" && orgId) {
    const members = await listOrgMembers(orgId, admin);
    activeIds = ownerUserId
      ? [ownerUserId, ...members.filter((m) => m.status === "active").map((m) => m.userId)]
      : [];
  } else {
    activeIds = ownerUserId ? [ownerUserId, ...(ctx.memberIds ?? [])] : [];
  }
  if (activeIds.length === 0) {
    return NextResponse.json({ half: "", halfStart: "", halfEnd: "", seconds: {} });
  }

  // 현재 반기(KST) — 교육 진행도 화면과 같은 경계
  const today = kstToday();
  const year = today.slice(0, 4);
  const isFirstHalf = Number(today.slice(5, 7)) <= 6;
  const halfStart = `${year}-${isFirstHalf ? "01" : "07"}-01`;
  const halfEnd = `${year}-${isFirstHalf ? "06-30" : "12-31"}`;

  // 반기 안에서도 현장이 늘면 1000행을 넘는다 — 페이지 순회로 조용한 절단을 막는다
  const [logs, mins] = await Promise.all([
    fetchAllRows<LogRow>((f, t) =>
      admin.from("tbm_logs")
        .select("user_id, start_time, end_time, education_type")
        .in("user_id", activeIds)
        .gte("date", halfStart).lte("date", halfEnd)
        .order("id").range(f, t)
    ),
    fetchAllRows<MinRow>((f, t) =>
      admin.from("tbm_minutes")
        .select("user_id, start_time, end_time")
        .in("user_id", activeIds)
        .gte("date", halfStart).lte("date", halfEnd)
        .order("id").range(f, t)
    ),
  ]);

  const seconds: Record<string, number> = {};
  for (const id of activeIds) seconds[id] = 0;
  // TBM 회의록은 전부 정기교육 인정, 교육일지는 정기 인정 유형만 (특별·신규채용·작업변경 제외)
  for (const r of mins) {
    if (seconds[r.user_id] === undefined) continue;
    seconds[r.user_id] += sessionSeconds(r.start_time, r.end_time);
  }
  for (const r of logs) {
    if (seconds[r.user_id] === undefined) continue;
    if (!isRegularEducationType(r.education_type)) continue;
    seconds[r.user_id] += sessionSeconds(r.start_time, r.end_time);
  }

  return NextResponse.json({
    half: `${year} ${isFirstHalf ? "상반기" : "하반기"}`,
    halfStart,
    halfEnd,
    seconds,
  });
}
