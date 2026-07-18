// app/api/ai/suggestion-hazards/route.ts — 근로자 의견 → TBM 위험성평가 항목 변환
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getUserAndSubscription } from "@/lib/portone";
import { checkAndRecordAiUsage, AI_LIMIT_MESSAGE } from "@/lib/aiUsage";
import { MATRIX_DIMS, freqSevGrade, matrixPromptGuide, normMatrix, type MatrixScale } from "@/lib/riskMatrix";

export const runtime = "nodejs";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MAX_SUGGESTIONS = 30;
const MAX_SUGGESTION_LEN = 500;
// 근로자 의견 유래 항목임을 문서에서 구분하기 위한 서버 강제 프리픽스
const FACTOR_PREFIX = "[근로자 의견] ";

export async function POST(request: Request) {
  try {
    const { user, allowed, riskMethod, riskMatrix } = await getUserAndSubscription(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    if (!allowed) return NextResponse.json({ error: "구독이 필요합니다." }, { status: 402 });
    // 위험성평가 방법(서버 강제값): freq_sev면 빈도·강도, 아니면 상중하
    const freqSev = riskMethod === "freq_sev";
    const matrix: MatrixScale = normMatrix(riskMatrix);
    const { freqMax, sevMax } = MATRIX_DIMS[matrix];
    const { suggestions } = await request.json().catch(() => ({}));

    if (
      !Array.isArray(suggestions) ||
      suggestions.length === 0 ||
      suggestions.length > MAX_SUGGESTIONS ||
      suggestions.some(
        (s) => typeof s !== "string" || !s.trim() || s.length > MAX_SUGGESTION_LEN
      )
    ) {
      return NextResponse.json({ error: "의견 목록이 올바르지 않습니다." }, { status: 400 });
    }

    // 남용 방어(비용 보호): KST 일일 한도 — 검증 통과한 유효 요청만 카운트
    if (!(await checkAndRecordAiUsage(user.id, "suggestion-hazards"))) {
      return NextResponse.json({ error: AI_LIMIT_MESSAGE }, { status: 429 });
    }

    const systemPrompt = `
      당신은 건설/물류 분야의 "안전 보건 관리자"입니다.
      근로자가 현장에서 보낸 의견·제안 각각을 TBM 위험성평가 항목 1개로 변환하세요.
      반드시 format_suggestion_hazards 도구(tool)를 호출하여 결과를 전달하세요.

      [세부 가이드]
      1. factor: 의견을 안전 위험 관점으로 해석한 명사형 문구. (예: 의견 "선풍기 미흡 더움" → "더위로 인한 열사병 위험")
         - 순수 행정성 의견도 가능한 한 안전 관점으로 연결하고, 도저히 위험요인으로 해석 불가한 것만 제외하세요.
      ${freqSev
        ? `2. frequency, severity: ${matrixPromptGuide(matrix)} 위험이 클수록 높은 값을 부여.`
        : `2. level: "상", "중", "하" 중 하나.`}
      3. measure: 제거 → 대체 → 통제 순서를 고려한 대책. 명사형으로 마무리. (예: "그늘막·휴게시간 확보 및 수분 섭취 지시")

      [효율화] 각 항목은 핵심만 간결하게(최대 1~2줄) 작성하세요.
    `;

    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      temperature: 0.1,
      system: systemPrompt,
      tools: [
        {
          name: "format_suggestion_hazards",
          description: "근로자 의견에서 변환된 위험성평가 항목 목록을 구조화하여 저장합니다.",
          input_schema: {
            type: "object",
            properties: {
              hazards: {
                type: "array",
                description: "의견별 위험요인 및 대책 목록",
                items: {
                  type: "object",
                  properties: {
                    factor: { type: "string", description: "위험 요인 (의견의 안전 위험 관점 해석)" },
                    ...(freqSev
                      ? {
                          frequency: { type: "integer", description: `발생가능성 1~${freqMax}` },
                          severity: { type: "integer", description: `중대성 1~${sevMax}` },
                        }
                      : {
                          level: { type: "string", enum: ["상", "중", "하"], description: "위험 정도" },
                        }),
                    measure: { type: "string", description: "통제/제거 대책" },
                  },
                  required: freqSev
                    ? ["factor", "frequency", "severity", "measure"]
                    : ["factor", "level", "measure"],
                },
              },
            },
            required: ["hazards"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "format_suggestion_hazards" },
      messages: [
        {
          role: "user",
          content: suggestions.map((s: string, i: number) => `${i + 1}. ${s.trim()}`).join("\n"),
        },
      ],
    });

    // 출력이 토큰 한도에 잘리면 일부 의견이 조용히 누락된 채 성공 처리될 수 있다.
    // 500을 돌려 클라이언트가 processed로 마킹하지 않고 다음 진입 때 재시도하게 한다.
    if (msg.stop_reason === "max_tokens") {
      return NextResponse.json(
        { error: "AI 응답이 길이 한도에 잘렸습니다. 잠시 후 다시 시도해주세요." },
        { status: 500 }
      );
    }

    const toolUse = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    const input = (toolUse?.input ?? {}) as Record<string, unknown>;

    const str = (v: unknown, fallback = "") =>
      typeof v === "string" ? v : fallback;
    // 모델이 프리픽스를 흉내 낸 경우 중복 제거 후 서버에서 일괄 부여
    const prefixed = (factor: string) =>
      FACTOR_PREFIX + factor.replace(/^(\[근로자 의견\]\s*)+/, "");

    const hazards = Array.isArray(input.hazards)
      ? (input.hazards as unknown[])
          .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
          .map((h) => {
            const factor = prefixed(str(h.factor));
            const measure = str(h.measure);
            if (freqSev) {
              // 빈도·강도: AI가 준 정수를 클램프하고 위험도·등급을 서버에서 산정
              const f = Math.min(Math.max(1, Math.round(Number(h.frequency) || 1)), freqMax);
              const s = Math.min(Math.max(1, Math.round(Number(h.severity) || 1)), sevMax);
              const { score, level } = freqSevGrade(f, s, matrix);
              return { factor, frequency: f, severity: s, risk: score, level, measure };
            }
            return {
              factor,
              level: ["상", "중", "하"].includes(str(h.level)) ? str(h.level) : "중",
              measure,
            };
          })
      : [];

    return NextResponse.json({ hazards, riskMethod, riskMatrix: matrix });
  } catch (error: unknown) {
    console.error("Claude API Error:", error);
    const errorMessage = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: "AI 처리 중 오류가 발생했습니다.", details: errorMessage },
      { status: 500 }
    );
  }
}
