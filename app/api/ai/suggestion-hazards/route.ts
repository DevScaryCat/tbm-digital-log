// app/api/ai/suggestion-hazards/route.ts — 근로자 의견 → TBM 위험성평가 항목 변환
// 변환 본체는 lib/suggestionHazards.ts 공용 — /api/suggestions(저장 후 서버 합류)와 공유한다.
// 이 라우트의 인증·구독·일일 한도·검증 동작은 공용화 전과 동일하다.
import { NextResponse } from "next/server";
import { getUserAndSubscription } from "@/lib/portone";
import { checkAndRecordAiUsage, AI_LIMIT_MESSAGE } from "@/lib/aiUsage";
import {
  convertSuggestionsToHazards,
  SuggestionTruncatedError,
  MAX_SUGGESTIONS,
  MAX_SUGGESTION_LEN,
} from "@/lib/suggestionHazards";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { user, allowed } = await getUserAndSubscription(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    if (!allowed) return NextResponse.json({ error: "구독이 필요합니다." }, { status: 402 });
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

    const hazards = await convertSuggestionsToHazards(suggestions);
    return NextResponse.json({ hazards });
  } catch (error: unknown) {
    // 잘림은 500을 돌려 클라이언트가 processed로 마킹하지 않고 다음 진입 때 재시도하게 한다.
    if (error instanceof SuggestionTruncatedError) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    console.error("Claude API Error:", error);
    const errorMessage = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: "AI 처리 중 오류가 발생했습니다.", details: errorMessage },
      { status: 500 }
    );
  }
}
