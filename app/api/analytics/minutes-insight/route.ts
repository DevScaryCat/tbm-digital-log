import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import { checkAndRecordAiUsage, AI_LIMIT_MESSAGE } from "@/lib/aiUsage";

export const runtime = "nodejs";

// TBM 회의록 월간 AI 총평 — Pro 전용.
// signature(집계 스냅샷)가 캐시와 같으면 AI 재호출 없이 캐시 반환.
// 회의록이 추가·수정되어 집계가 바뀌면 signature가 달라져 그때만 재생성한다.
export async function POST(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!isPro) return NextResponse.json({ error: "Pro 플랜 기능입니다." }, { status: 403 });

  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "잘못된 요청" }, { status: 400 }); }

  const year = Number(body?.year);
  const month = Number(body?.month);
  const signature = String(body?.signature ?? "");
  const facts = body?.facts ?? {};
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: "잘못된 기간" }, { status: 400 });
  }

  // 데이터 없으면 AI 호출 없이 빈 총평
  if (!facts || Number(facts.total) <= 0) return NextResponse.json({ summary: "", cached: false });

  const admin = getAdminClient();
  const { data: existing } = await admin
    .from("analysis_insights")
    .select("signature, content")
    .eq("user_id", user.id)
    .eq("scope", "minutes")
    .eq("period_year", year)
    .eq("period_month", month)
    .maybeSingle();

  if (existing && existing.signature === signature && existing.content) {
    return NextResponse.json({ summary: existing.content, cached: true });
  }

  // 남용 방어: 캐시 미스(실제 AI 호출)일 때만 일일 한도 소모
  if (!(await checkAndRecordAiUsage(user.id, "minutes-insight"))) {
    return NextResponse.json({ error: AI_LIMIT_MESSAGE }, { status: 429 });
  }

  const company = (user.user_metadata as any)?.company_name || "미상";
  const topHazards: { word: string; count: number }[] = Array.isArray(facts.topHazards) ? facts.topHazards : [];
  const summary = await generateSummary(company, year, month, facts, topHazards);

  await admin.from("analysis_insights").upsert(
    {
      user_id: user.id,
      scope: "minutes",
      period_year: year,
      period_month: month,
      signature,
      content: summary,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,scope,period_year,period_month" }
  );

  return NextResponse.json({ summary, cached: false });
}

async function generateSummary(
  company: string,
  year: number,
  month: number,
  facts: any,
  topHazards: { word: string; count: number }[]
): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return "";
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const text = [
      `현장/업체: ${company}`,
      `대상 기간: ${year}년 ${month}월 (TBM 회의록 기준)`,
      `회의록 ${facts.total}건, 위험요인 등급 상 ${facts.high}건 / 중 ${facts.mid}건`,
      `자주 논의된 위험요인: ${topHazards.map((h) => `${h.word}(${h.count})`).join(", ") || "없음"}`,
    ].join("\n");

    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      temperature: 0.3,
      system:
        "당신은 건설·물류 현장의 안전보건 관리자입니다. 아래 한 달간 TBM 회의록 위험요인 집계만 보고, 사업주가 한눈에 파악할 '월간 회의록 안전 총평'을 작성하세요. 3~4문장으로 ① 이번 달 회의록 활동 요약 ② 반복·고위험 위험요인 경향 ③ 다음 달 권고 순으로 간결하게. 수치를 지어내지 말고 주어진 집계만 사용하세요.",
      messages: [{ role: "user", content: text }],
    });
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  } catch (e) {
    console.error("minutes insight AI error:", e);
    return "";
  }
}
