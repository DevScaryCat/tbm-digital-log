// lib/suggestionHazards.ts — 근로자 의견 → TBM 위험요인 항목 변환 (서버 공용)
//
// 사용처가 둘이다:
//  1) /api/ai/suggestion-hazards — 감독자 검토 화면(step 4)의 폴링·저장 직전 스윕
//  2) /api/suggestions — 근로자 의견 접수(무인증) 후 "이미 저장된 회의록"에의 서버 합류
// 인증·요금·사용량 게이트는 각 라우트가 책임진다. 이 모듈은 변환만 한다.
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export const MAX_SUGGESTIONS = 30;
export const MAX_SUGGESTION_LEN = 500;
// 근로자 의견 유래 항목임을 문서에서 구분하기 위한 서버 강제 프리픽스
export const FACTOR_PREFIX = "[근로자 의견] ";

export interface SuggestionHazard {
  factor: string;
  level: string;
  measure: string;
}

/** AI 출력이 max_tokens에 잘려 일부 의견이 조용히 누락될 수 있는 상태 — 호출부가 재시도/폴백을 결정한다 */
export class SuggestionTruncatedError extends Error {
  constructor() {
    super("AI 응답이 길이 한도에 잘렸습니다. 잠시 후 다시 시도해주세요.");
    this.name = "SuggestionTruncatedError";
  }
}

/** 변환 실패(AI 오류·한도) 시 원문 보존 폴백 — 원문이 증거이므로 의견을 버리지 않는다 */
export function rawSuggestionHazard(content: string): SuggestionHazard {
  return {
    factor: FACTOR_PREFIX + content.slice(0, MAX_SUGGESTION_LEN),
    level: "",
    measure: "",
  };
}

/**
 * 의견 목록을 위험요인 항목으로 변환한다. factor에는 FACTOR_PREFIX가 서버에서 강제 부여된다.
 * 모델이 위험요인으로 해석 불가한 의견은 결과에서 빠질 수 있다(항목 수 ≤ 의견 수).
 * @throws SuggestionTruncatedError 출력이 토큰 한도에 잘린 경우(일부 의견이 조용히 누락될 수 있음)
 */
export async function convertSuggestionsToHazards(
  suggestions: string[],
): Promise<SuggestionHazard[]> {
  const systemPrompt = `
      당신은 건설/물류 분야의 "안전 보건 관리자"입니다.
      근로자가 현장에서 보낸 의견·제안 각각을 TBM 위험요인 항목 1개로 변환하세요.
      반드시 format_suggestion_hazards 도구(tool)를 호출하여 결과를 전달하세요.

      [세부 가이드]
      1. factor: 의견을 안전 위험 관점으로 해석한 명사형 문구. (예: 의견 "선풍기 미흡 더움" → "더위로 인한 열사병 위험")
         - 순수 행정성 의견도 가능한 한 안전 관점으로 연결하고, 도저히 위험요인으로 해석 불가한 것만 제외하세요.
      2. level: "상", "중", "하" 중 하나.
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
        description: "근로자 의견에서 변환된 위험요인 항목 목록을 구조화하여 저장합니다.",
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
                  level: { type: "string", enum: ["상", "중", "하"], description: "위험 정도" },
                  measure: { type: "string", description: "통제/제거 대책" },
                },
                required: ["factor", "level", "measure"],
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
        content: suggestions.map((s, i) => `${i + 1}. ${s.trim()}`).join("\n"),
      },
    ],
  });

  // 출력이 토큰 한도에 잘리면 일부 의견이 조용히 누락된 채 성공 처리될 수 있다.
  if (msg.stop_reason === "max_tokens") {
    throw new SuggestionTruncatedError();
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

  return Array.isArray(input.hazards)
    ? (input.hazards as unknown[])
        .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
        .map((h) => ({
          factor: prefixed(str(h.factor)),
          level: ["상", "중", "하"].includes(str(h.level)) ? str(h.level) : "중",
          measure: str(h.measure),
        }))
    : [];
}
