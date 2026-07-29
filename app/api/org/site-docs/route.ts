// app/api/org/site-docs/route.ts — 보고서(달력) 화면의 감독자용 다현장 문서 조회
// 감독자가 고른 현장(최대 3곳, 본인 포함 가능)의 문서를 서버 경유로 내려준다 (§4-A — RLS는 열지 않는다).
// ?ids=a,b,c            → 달력 점·기간 카운트용 id/date/type 목록 (+현장명)
// ?ids=...&day=YYYY-MM-DD → 그 날짜 상세 (드로어용)
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { assertOwnerOfMember } from "@/lib/org";

export const runtime = "nodejs";

const MAX_SITES = 3; // 현장을 너무 많이 고르면 로드가 길어진다 — 화면과 같은 상한

export async function GET(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const ids = (searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const day = searchParams.get("day");
  if (ids.length === 0) return NextResponse.json({ error: "현장을 선택해주세요." }, { status: 400 });
  if (ids.length > MAX_SITES) {
    return NextResponse.json({ error: `현장은 최대 ${MAX_SITES}곳까지 선택할 수 있어요.` }, { status: 400 });
  }

  const admin = getAdminClient();
  // 전부 우리 조직 현장(또는 본인)인지 — 하나라도 아니면 거절
  for (const id of ids) {
    if (!(await assertOwnerOfMember(user.id, id, admin))) {
      return NextResponse.json({ error: "우리 조직의 현장 계정이 아닙니다." }, { status: 403 });
    }
  }

  // 현장명 (드로어 뱃지·범례용)
  const names = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const { data: u } = await admin.auth.admin.getUserById(id);
        const meta = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
        const label = String(meta.site_name ?? "").trim()
          || (id === user.id ? "내 현장" : String(meta.company_name ?? "").trim());
        names.set(id, label || "현장");
      } catch {
        names.set(id, "현장");
      }
    })
  );
  const sites = ids.map((id) => ({ userId: id, siteName: names.get(id) ?? "현장" }));

  if (day) {
    // 하루 상세 — 드로어용 컬럼까지
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return NextResponse.json({ error: "잘못된 날짜입니다." }, { status: 400 });
    const [logsRes, minutesRes] = await Promise.all([
      admin.from("tbm_logs").select("id, user_id, date, education_type, start_time, end_time, location, instructor_name").in("user_id", ids).eq("date", day),
      admin.from("tbm_minutes").select("id, user_id, date, start_time, end_time, location, leader_name").in("user_id", ids).eq("date", day),
    ]);
    const details = [
      ...(((logsRes.data as any[]) ?? []).map((l) => ({ ...l, type: "log", siteId: l.user_id, siteName: names.get(l.user_id) ?? "현장" }))),
      ...(((minutesRes.data as any[]) ?? []).map((m) => ({
        id: m.id, date: m.date, education_type: "TBM 회의록", start_time: m.start_time, end_time: m.end_time,
        location: m.location, instructor_name: m.leader_name, type: "minute", siteId: m.user_id, siteName: names.get(m.user_id) ?? "현장",
      }))),
    ];
    return NextResponse.json({ sites, details });
  }

  // 목록 — 달력 점·기간 카운트용 (id/date/siteId만).
  // PostgREST는 limit을 크게 줘도 1000행에서 침묵 절단한다(max-rows) — range 페이징으로 전량 수집.
  const fetchAll = async (table: "tbm_logs" | "tbm_minutes") => {
    const out: { id: string; user_id: string; date: string }[] = [];
    const STEP = 1000;
    for (let fromIdx = 0; ; fromIdx += STEP) {
      const { data } = await admin
        .from(table)
        .select("id, user_id, date")
        .in("user_id", ids)
        .order("id")
        .range(fromIdx, fromIdx + STEP - 1);
      const rows = ((data as any[]) ?? []) as { id: string; user_id: string; date: string }[];
      out.push(...rows);
      if (rows.length < STEP) break;
    }
    return out;
  };
  const [logRows, minuteRows] = await Promise.all([fetchAll("tbm_logs"), fetchAll("tbm_minutes")]);
  const docs = [
    ...logRows.map((l) => ({ id: l.id, date: l.date, type: "log", siteId: l.user_id })),
    ...minuteRows.map((m) => ({ id: m.id, date: m.date, type: "minute", siteId: m.user_id })),
  ];
  return NextResponse.json({ sites, docs });
}
