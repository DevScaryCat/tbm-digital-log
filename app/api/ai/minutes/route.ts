// app/api/ai/minutes/route.ts
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getUserAndSubscription } from "@/lib/portone";
import { checkAndRecordAiUsage, AI_LIMIT_MESSAGE } from "@/lib/aiUsage";
import { aiInputHash, getAiCache, setAiCache } from "@/lib/aiCache";
import { STT_DOMAIN_HINT } from "@/lib/sttDomainHints";

export const runtime = "nodejs";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MAX_TEXT_LEN = 20000;

export async function POST(request: Request) {
  try {
    const { user, allowed } = await getUserAndSubscription(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    if (!allowed) return NextResponse.json({ error: "구독이 필요합니다." }, { status: 402 });

    const { text } = await request.json();

    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "텍스트가 없습니다." }, { status: 400 });
    }
    if (text.length > MAX_TEXT_LEN) {
      return NextResponse.json({ error: "입력이 너무 깁니다." }, { status: 413 });
    }

    // 동일 원문 재요청은 캐시로 — 일일 한도도 소모하지 않는다 (한도 검사보다 먼저)
    const inputHash = aiInputHash(text);
    const cached = await getAiCache(user.id, "minutes", inputHash);
    if (cached) return NextResponse.json(cached);

    // 남용 방어(비용 보호): KST 일일 한도 — 정상 사용은 닿지 않는 상한
    if (!(await checkAndRecordAiUsage(user.id, "minutes"))) {
      return NextResponse.json({ error: AI_LIMIT_MESSAGE }, { status: 429 });
    }

    const systemPrompt = `
      당신은 건설/물류 분야의 최고 등급 "안전 보건 관리자"입니다.
      입력된 TBM(작업 전 안전점검) 회의 녹음 내용을 분석하여 'Tool Box Meeting 회의록' 양식에 맞게 정제하세요.
      반드시 format_tbm_minutes 도구(tool)를 호출하여 결과를 전달하세요.

      [🚨 핵심 준수 사항]
      - 녹음 내용에 없는 사실(작업 구역, 사용 장비명, 날씨, 지시사항 등)을 절대로 임의로 지어내지 마세요.
      - 잡담, 안부 인사, 헛소리, 업무와 무관한 이야기 등은 배제하세요.
      - 녹음에서 파악할 수 없는 항목은 빈 문자열("")로 두세요. "<UNKNOWN>", "알 수 없음", "N/A" 같은 자리표시 텍스트를 절대 쓰지 마세요 — 이 문서는 그대로 법정 서식에 인쇄됩니다.

      [세부 가이드]
      1. processName (공정명): 현장의 대표 공정 종류를 10자 이내 명사형으로. (예: "철골 공사", "배관 설비", "물류 상하차")
      2. workName (작업명): 오늘 수행할 구체적 작업명을 10자 내외 명사형으로. (예: "철골 부재 인양", "용접 및 볼트 체결")
      3. workContent (작업내용): 오늘 수행할 작업 내용을 1~2문장으로 요약.
      4. hazards (잠재 유해위험요인 및 대책): 녹음에서 **실제로 언급된** 위험만 추출.
         - factor: 위험 요인을 명사형/개조식으로 간결히. (예: "작업 발판 위 추락 위험")
         - level: "상", "중", "하" 중 하나.
         - measure: **말한 사람이 실제로 언급한** 예방 조치·지시만 다듬어서 명사형으로. (예: "코너에 반사경 설치 및 서행 지시")
           ⚠️ 대책이 언급되지 않은 요인은 measure를 빈 문자열("")로 두세요. 언급되지 않은
           대책을 만들어 채우지 마세요 — 이 문서는 "현장에서 실제로 논의한 기록"이며,
           작성자가 검토 화면에서 직접 채웁니다.
         - 개수 목표는 없습니다. 실제 언급된 만큼만 — 언급이 하나면 하나, 없으면 빈 배열.
           문맥상 예상되는 위험을 추가로 지어내지 마세요.
      5. instructions (작업 시작 전 협의·지시사항): 근로자와 리더가 실제로 주고받은 협의·질의응답·건의·현장 조율 내용만 기록하세요.
         - hazards에 이미 정리한 위험요인·대책을 여기서 다시 나열하지 마세요(중복 금지 — 이 칸의 목적이 다릅니다).
         - 예: 근로자가 자재 반입 시간을 물어 조정한 것, 특정 구역 작업 순서 협의, 근로자 건의에 대한 리더의 답변 등.
         - 그런 대화가 녹음에 없으면 빈 문자열("")로 두세요. 대부분의 TBM에서 비어 있는 것이 정상입니다.
         - 항목 구분은 줄바꿈으로.
      6. safetyPhrase (안전구호): 녹음에 안전구호(예: "무재해 가자!", "안전, 좋아, 좋아")가 있으면 **들린 그대로 100% 동일하게** 추출. 없을 때만 작업에 맞는 짧은 구호를 하나 생성.

      [효율화] 각 항목은 핵심만 간결하게(최대 1~2줄) 작성하세요.
    `;

    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      temperature: 0.1,
      // 현장 STT 오인식 교정 지침 — 원문은 그대로 두고 해석 단계에서 복원한다
      system: systemPrompt + STT_DOMAIN_HINT,
      tools: [
        {
          name: "format_tbm_minutes",
          description: "정제된 TBM 회의록 내용을 구조화하여 저장합니다.",
          input_schema: {
            type: "object",
            properties: {
              processName: { type: "string", description: "공정명 (10자 이내)" },
              workName: { type: "string", description: "작업명 (10자 내외)" },
              workContent: { type: "string", description: "상세 작업 내용 요약" },
              hazards: {
                type: "array",
                description: "잠재 유해위험요인 및 대책 목록",
                items: {
                  type: "object",
                  properties: {
                    factor: { type: "string", description: "위험 요인" },
                    level: { type: "string", enum: ["상", "중", "하"], description: "위험 정도" },
                    measure: { type: "string", description: "통제/제거 대책" },
                  },
                  required: ["factor", "level", "measure"],
                },
              },
              instructions: {
                type: "string",
                description: "근로자와 실제 주고받은 협의·질의응답·건의만 (hazards 재나열 금지, 없으면 빈 문자열). 항목 구분은 줄바꿈.",
              },
              safetyPhrase: { type: "string", description: "오늘의 안전구호" },
            },
            required: [
              "processName",
              "workName",
              "workContent",
              "hazards",
              "instructions",
              "safetyPhrase",
            ],
          },
        },
      ],
      tool_choice: { type: "tool", name: "format_tbm_minutes" },
      messages: [{ role: "user", content: text }],
    });

    const toolUse = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    const input = (toolUse?.input ?? {}) as Record<string, unknown>;

    const str = (v: unknown, fallback = "") =>
      typeof v === "string" ? v : fallback;
    // 모델이 파악 실패를 자리표시 텍스트로 채우는 경우가 있다("<UNKNOWN>" 실사례) —
    // 법정 서식에 그대로 인쇄되므로 서버에서 빈 값으로 소독한다
    const PLACEHOLDER_RE = /^[<([{\s]*(unknown|없음|알 수 없음|알수없음|파악 불가|파악불가|미상|해당 없음|해당없음|n\/?a|none|null|undefined)[>)\]}\s.]*$/i;
    const clean = (v: unknown, fallback = "") => {
      const s = str(v, fallback).trim();
      return PLACEHOLDER_RE.test(s) ? "" : s;
    };

    const hazards = Array.isArray(input.hazards)
      ? (input.hazards as unknown[])
          .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
          .map((h) => ({
            factor: clean(h.factor),
            level: ["상", "중", "하"].includes(str(h.level)) ? str(h.level) : "중",
            // 대책은 실제 언급된 것만(2026-08-14 Chris 확정 — 할루시네이션 차단).
            // 비어 있으면 검토 화면에서 작성자가 채운다. AI의 개선 제안은 문서가 아니라
            // 저장 후 피드백(점수·총평) 화면으로 옮겨졌다.
            measure: clean(h.measure),
          }))
          .filter((h) => h.factor) // 요인 없는 행은 문서에 빈 줄만 만든다
      : [];

    const result = {
      processName: clean(input.processName),
      workName: clean(input.workName),
      workContent: clean(input.workContent),
      hazards,
      instructions: clean(input.instructions),
      safetyPhrase: clean(input.safetyPhrase) || "안전제일!",
    };

    // 빈 결과는 캐시하지 않는다 — 재시도 여지를 남긴다
    if (result.workContent || hazards.length > 0) {
      await setAiCache(user.id, "minutes", inputHash, result);
    }

    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("Claude API Error:", error);
    const errorMessage = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: "AI 처리 중 오류가 발생했습니다.", details: errorMessage },
      { status: 500 }
    );
  }
}
