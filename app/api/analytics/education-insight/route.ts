import { NextResponse } from "next/server";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import { checkAndRecordAiUsage, AI_LIMIT_MESSAGE } from "@/lib/aiUsage";
import { generateEducationInsight } from "@/lib/educationReport";

export const runtime = "nodejs";

// 안전보건교육일지 월간 분석 — Pro 전용.
// 날짜별로 그날 교육 내용을 한 줄로 통합 요약 + 자주 다룬 주제 키워드를 생성한다.
// signature(해당 월 일지 스냅샷)가 캐시와 같으면 AI 재호출 없이 캐시 반환.
// 일지가 추가·수정되면 signature가 달라져 그때만 재생성한다.

type DaySummary = { date: string; summary: string };
type Insight = { days: DaySummary[]; keywords: string[] };

const MAX_CONTENT_PER_DAY = 800; // 하루 병합 내용 토큰 상한
const MAX_DAYS = 40; // 한 달 교육 일수 상한(방어)

export async function POST(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!isPro) return NextResponse.json({ error: "Pro 플랜 기능입니다." }, { status: 403 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청" }, { status: 400 });
  }

  const year = Number(body?.year);
  const month = Number(body?.month);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: "잘못된 기간" }, { status: 400 });
  }

  const admin = getAdminClient();

  // 해당 월의 일지를 서버에서 직접 조회(클라이언트 입력 신뢰 X)
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const end = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  const { data: rows } = await admin
    .from("tbm_logs")
    .select("id, date, education_content")
    .eq("user_id", user.id)
    .gte("date", start)
    .lt("date", end)
    .order("date", { ascending: true });

  const logs = (rows ?? []).filter((r) => (r.education_content ?? "").trim());
  if (logs.length === 0) {
    return NextResponse.json({ days: [], keywords: [], cached: false } satisfies Insight & { cached: boolean });
  }

  // 날짜별로 내용 병합 (하루 복수 세션 → 한 줄 통합 요약)
  const byDate = new Map<string, string[]>();
  for (const l of logs) {
    const d = String(l.date);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(String(l.education_content ?? "").trim());
  }
  const dayBlocks = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_DAYS)
    .map(([date, contents]) => ({
      date,
      content: contents.join("\n").slice(0, MAX_CONTENT_PER_DAY),
    }));

  // 캐시 시그니처: 날짜 + 병합 내용 길이 (내용이 바뀌면 달라짐)
  const signature = hash(dayBlocks.map((b) => `${b.date}:${b.content.length}`).join("|"));

  const { data: existing } = await admin
    .from("analysis_insights")
    .select("signature, content")
    .eq("user_id", user.id)
    .eq("scope", "education")
    .eq("period_year", year)
    .eq("period_month", month)
    .maybeSingle();

  if (existing && existing.signature === signature && existing.content) {
    try {
      const cached = JSON.parse(existing.content) as Insight;
      return NextResponse.json({ ...cached, cached: true });
    } catch {
      /* 캐시 파싱 실패 시 재생성 */
    }
  }

  // 남용 방어: 캐시 미스(실제 AI 호출)일 때만 일일 한도 소모
  if (!(await checkAndRecordAiUsage(user.id, "education-insight"))) {
    return NextResponse.json({ error: AI_LIMIT_MESSAGE }, { status: 429 });
  }

  const insight = await generateEducationInsight(dayBlocks);

  await admin.from("analysis_insights").upsert(
    {
      user_id: user.id,
      scope: "education",
      period_year: year,
      period_month: month,
      signature,
      content: JSON.stringify(insight),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,scope,period_year,period_month" }
  );

  return NextResponse.json({ ...insight, cached: false });
}

// djb2 — 캐시 시그니처용 짧은 해시
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
