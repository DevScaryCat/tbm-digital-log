// app/api/ai/tbm-feedback/route.ts — 저장된 TBM에 대한 점수·총평·다음번 제안.
//
// 왜 이 라우트가 생겼나 (2026-08-14 Chris 확정): 실판매를 앞두고 AI의 "제안"을 문서에서
// 걷어냈다. 종전에는 말하지 않은 감소대책을 AI가 회의록에 채워 넣었는데, 법정 서식에
// 지어낸 내용이 인쇄되는 건 할루시네이션 문제이기 전에 기록 위조에 가깝다. 이제 문서는
// "실제로 말한 것"만 담고(minutes·risk-assessment 프롬프트 동시 수정), AI의 제안 능력은
// 저장 **후** 피드백 화면으로 옮긴다 — 잘한 TBM인지 점수와 총평을 주고, 다음번에 뭘
// 말하면 좋을지 제안한다. 제안이 문서 밖에 있으면 지어내도 기록이 오염되지 않는다.
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import { checkAndRecordAiUsage, AI_LIMIT_MESSAGE } from "@/lib/aiUsage";
import { aiInputHash, getAiCache, setAiCache } from "@/lib/aiCache";
import { STT_DOMAIN_HINT } from "@/lib/sttDomainHints";

export const runtime = "nodejs";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
  try {
    const { user, allowed } = await getUserAndSubscription(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    if (!allowed) return NextResponse.json({ error: "구독이 필요합니다." }, { status: 402 });

    const { minutesId } = await request.json().catch(() => ({}));
    if (!minutesId || typeof minutesId !== "string") {
      return NextResponse.json({ error: "minutesId가 없습니다." }, { status: 400 });
    }

    const admin = getAdminClient();
    const { data: m } = await admin
      .from("tbm_minutes")
      .select("id, user_id, work_name, work_content, instructions, safety_phrase, hazards, raw_transcript, start_time, end_time, health_check, ppe_check")
      .eq("id", minutesId)
      .eq("user_id", user.id) // 본인 문서만 — 타인 회의록 채점은 열지 않는다
      .maybeSingle();
    if (!m) return NextResponse.json({ error: "회의록을 찾을 수 없습니다." }, { status: 404 });

    const hazards = Array.isArray(m.hazards) ? (m.hazards as { factor?: string; level?: string; measure?: string }[]) : [];
    const source = [
      m.work_name ? `작업명: ${m.work_name}` : "",
      m.work_content ? `작업내용: ${m.work_content}` : "",
      hazards.length
        ? "위험요인:\n" + hazards.map((h) => `- ${h.factor ?? ""} (${h.level ?? "중"}) → 대책: ${h.measure || "(언급 없음)"}`).join("\n")
        : "위험요인: (없음)",
      m.instructions ? `협의·지시사항: ${m.instructions}` : "",
      // 시작 전 확인(건강상태·보호구)을 채점에 명시적으로 넣는다(2026-08-21 Chris 결정).
      // ⚠️ AI가 녹음에서 실제로 들었을 때만 값이 차 있다 — 하드코딩 기본값을 그대로 먹이면
      //    모든 문서가 같은 문장을 받아 채점이 무의미해진다(minutes 라우트의 healthCheck/ppeCheck 규칙).
      m.health_check ? `시작 전 건강상태 확인: ${m.health_check}` : "",
      m.ppe_check ? `시작 전 보호구 확인: ${m.ppe_check}` : "",
      m.raw_transcript ? `\n[음성 원문]\n${String(m.raw_transcript).slice(0, 12000)}` : "\n[음성 원문 없음 — 직접 입력으로 작성됨]",
    ].filter(Boolean).join("\n");

    // 같은 문서 재요청은 캐시로 — 피드백 화면 재진입마다 과금되지 않게
    const inputHash = aiInputHash(source);
    const cached = await getAiCache(user.id, "tbm_feedback", inputHash);
    if (cached) return NextResponse.json(cached);

    if (!(await checkAndRecordAiUsage(user.id, "tbm_feedback"))) {
      return NextResponse.json({ error: AI_LIMIT_MESSAGE }, { status: 429 });
    }

    const systemPrompt = `
      당신은 건설·물류 현장에서 20년 근무한 안전보건 관리 선배입니다. 방금 끝난 TBM(작업 전
      안전회의) 기록을 보고, 진행자에게 짧고 따뜻한 피드백을 줍니다. 반드시 rate_tbm 도구를
      호출하세요.

      [채점 기준 — 각 0~25점, 합계 100]
      ① 구체성: 오늘 작업·구역·장비가 구체적으로 언급됐는가 (일반론·훈시만 있으면 낮음)
      ② 위험요인-대책 짝: 위험을 짚고 그에 대한 행동 지시까지 이어졌는가
      ③ 근로자 참여: 질문·대답·건의 등 양방향 대화가 있었는가 (일방 훈시는 낮음)
      ④ 완결성: 인사→작업 공유→위험 짚기→구호 등 회의 흐름이 갖춰졌는가.
         **시작 전 확인(건강상태·보호구 착용)을 실제로 챙겼는지**를 이 항목에서 함께 봅니다 —
         위 기록에 '시작 전 건강상태 확인'·'시작 전 보호구 확인' 줄이 있으면 그만큼 가점,
         둘 다 없으면 흐름이 덜 갖춰진 것으로 봅니다(단, 없다고 0점은 아닙니다).

      [작성 규칙]
      - summary(총평): 2~3문장. 잘한 점을 먼저, 그다음 아쉬운 점 하나. 현장 사람에게 말하듯
        존댓말로. 점수를 문장에 반복하지 마세요.
      - tips(다음번 제안): 1~3개. "다음 TBM에서 이렇게 말해보세요" 수준의 실행 가능한 한 줄.
        이 TBM에서 실제로 빠졌던 것을 근거로 제안하세요. 일반론 금지.
      - 원문이 없거나 아주 짧으면 낮은 점수를 주되, 그 사실을 비난하지 말고 "녹음으로
        진행하면 더 정확한 피드백을 드릴 수 있어요"를 tips에 포함하세요.
      - 지어낸 사실로 칭찬하지 마세요 — 기록에 있는 것만 근거로.
    `;

    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700,
      temperature: 0.3,
      system: systemPrompt + STT_DOMAIN_HINT,
      tools: [
        {
          name: "rate_tbm",
          description: "TBM 품질 피드백을 구조화하여 전달합니다.",
          input_schema: {
            type: "object",
            properties: {
              score: { type: "number", description: "0~100 합계 점수" },
              summary: { type: "string", description: "총평 2~3문장" },
              tips: {
                type: "array",
                items: { type: "string" },
                description: "다음번 제안 1~3개, 각 한 줄",
              },
            },
            required: ["score", "summary", "tips"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "rate_tbm" },
      messages: [{ role: "user", content: source }],
    });

    const toolUse = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    const input = (toolUse?.input ?? {}) as Record<string, unknown>;
    const score = Math.max(0, Math.min(100, Math.round(Number(input.score) || 0)));
    // 등급 라벨은 서버가 확정한다 — 화면·보고서가 같은 기준을 쓰게 (문구 어긋남 방지)
    const grade = score >= 90 ? "훌륭한 TBM" : score >= 70 ? "좋은 TBM" : score >= 50 ? "보통 TBM" : "보완이 필요한 TBM";
    const tips = Array.isArray(input.tips)
      ? (input.tips as unknown[]).map((t) => String(t).trim()).filter(Boolean).slice(0, 3)
      : [];
    const result = {
      score,
      grade,
      summary: String(input.summary ?? "").trim(),
      tips,
    };

    if (result.summary) await setAiCache(user.id, "tbm_feedback", inputHash, result);
    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("tbm-feedback error:", error);
    return NextResponse.json({ error: "AI 처리 중 오류가 발생했습니다." }, { status: 500 });
  }
}
