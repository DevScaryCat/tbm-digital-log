import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";

export const runtime = "nodejs";

// 안전교육일지 월간 분석 — Pro 전용.
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

  const insight = await generateInsight(dayBlocks);

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

async function generateInsight(dayBlocks: { date: string; content: string }[]): Promise<Insight> {
  const empty: Insight = { days: [], keywords: [] };
  if (!process.env.ANTHROPIC_API_KEY) return empty;
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const userText = dayBlocks
      .map((b) => `=== ${b.date} ===\n${b.content}`)
      .join("\n\n");

    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1800,
      temperature: 0.2,
      system: `당신은 건설·물류 현장의 안전보건 관리자입니다.
아래는 한 달간 날짜별 안전교육(TBM)일지 내용입니다. (각 날짜는 "=== YYYY-MM-DD ===" 로 구분)
반드시 format_education_summary 도구(tool)를 호출하여 결과를 전달하세요.

[작성 규칙]
- 각 날짜마다 그날 교육의 핵심을 '한 줄'로 통합 요약하세요. 하루에 여러 내용이 있어도 가장 핵심적인 2~3개 주제만 골라 1줄(공백 포함 30자 내외)로 묶습니다. 4개 이상 나열하지 마세요.
- 요약은 명사형 키워드 중심으로 간결하게. 예) "지게차 안전수칙·안전모 착용 점검", "고소작업 추락 예방·안전대 결속"
- 단, 날마다 똑같이 쓰지 말고 그날 내용에서 특징적인 주제를 우선 골라 날짜별로 변별되게 작성하세요.
- date 필드에는 입력에 주어진 날짜(YYYY-MM-DD)를 그대로 echo 하세요. 날짜를 새로 만들거나 빠뜨리지 마세요.
- keywords: 이 달 전체에서 자주 다룬 교육 주제를 빈도가 높은 순으로 5~8개 뽑으세요. (예: "안전모 착용", "스트레칭", "지게차 안전수칙")
- 입력에 없는 내용을 지어내지 마세요. 주어진 내용만 사용합니다.`,
      tools: [
        {
          name: "format_education_summary",
          description: "날짜별 교육 요약과 주제 키워드를 구조화하여 저장합니다.",
          input_schema: {
            type: "object",
            properties: {
              days: {
                type: "array",
                description: "날짜별 1줄 요약 목록",
                items: {
                  type: "object",
                  properties: {
                    date: { type: "string", description: "YYYY-MM-DD (입력 날짜 그대로)" },
                    summary: { type: "string", description: "그날 교육 핵심 1줄 요약" },
                  },
                  required: ["date", "summary"],
                },
              },
              keywords: {
                type: "array",
                description: "이 달 자주 다룬 교육 주제 (빈도순 5~8개)",
                items: { type: "string" },
              },
            },
            required: ["days", "keywords"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "format_education_summary" },
      messages: [{ role: "user", content: userText }],
    });

    const toolUse = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    const raw = (toolUse?.input ?? {}) as { days?: unknown; keywords?: unknown };

    const validDates = new Set(dayBlocks.map((b) => b.date));
    const days: DaySummary[] = (Array.isArray(raw.days) ? raw.days : [])
      .map((d: any) => ({
        date: String(d?.date ?? "").trim(),
        summary: String(d?.summary ?? "").trim(),
      }))
      .filter((d) => validDates.has(d.date) && d.summary);

    const keywords: string[] = (Array.isArray(raw.keywords) ? raw.keywords : [])
      .map((k: any) => String(k ?? "").trim())
      .filter(Boolean)
      .slice(0, 8);

    return { days, keywords };
  } catch (e) {
    console.error("education insight AI error:", e);
    return empty;
  }
}

// djb2 — 캐시 시그니처용 짧은 해시
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
