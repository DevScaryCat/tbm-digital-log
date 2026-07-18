// app/api/ai/minutes/route.ts
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getUserAndSubscription } from "@/lib/portone";
import { checkAndRecordAiUsage, AI_LIMIT_MESSAGE } from "@/lib/aiUsage";
import { MATRIX_DIMS, freqSevGrade, matrixPromptGuide, normMatrix, type MatrixScale } from "@/lib/riskMatrix";

export const runtime = "nodejs";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MAX_TEXT_LEN = 20000;

export async function POST(request: Request) {
  try {
    const { user, allowed, riskMethod, riskMatrix } = await getUserAndSubscription(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    if (!allowed) return NextResponse.json({ error: "구독이 필요합니다." }, { status: 402 });
    // 위험성평가 방법(서버 강제값): freq_sev면 빈도·강도, 아니면 상중하
    const freqSev = riskMethod === "freq_sev";
    const matrix: MatrixScale = normMatrix(riskMatrix);
    const { freqMax, sevMax } = MATRIX_DIMS[matrix];
    // 남용 방어(비용 보호): KST 일일 한도 — 정상 사용은 닿지 않는 상한
    if (!(await checkAndRecordAiUsage(user.id, "minutes"))) {
      return NextResponse.json({ error: AI_LIMIT_MESSAGE }, { status: 429 });
    }

    const { text } = await request.json();

    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "텍스트가 없습니다." }, { status: 400 });
    }
    if (text.length > MAX_TEXT_LEN) {
      return NextResponse.json({ error: "입력이 너무 깁니다." }, { status: 413 });
    }

    const systemPrompt = `
      당신은 건설/물류 분야의 최고 등급 "안전 보건 관리자"입니다.
      입력된 TBM(작업 전 안전점검) 회의 녹음 내용을 분석하여 'Tool Box Meeting 회의록' 양식에 맞게 정제하세요.
      반드시 format_tbm_minutes 도구(tool)를 호출하여 결과를 전달하세요.

      [🚨 핵심 준수 사항]
      - 녹음 내용에 없는 사실(작업 구역, 사용 장비명, 날씨, 지시사항 등)을 절대로 임의로 지어내지 마세요.
      - 잡담, 안부 인사, 헛소리, 업무와 무관한 이야기 등은 배제하세요.

      [세부 가이드]
      1. processName (공정명): 현장의 대표 공정 종류를 10자 이내 명사형으로. (예: "철골 공사", "배관 설비", "물류 상하차")
      2. workName (작업명): 오늘 수행할 구체적 작업명을 10자 내외 명사형으로. (예: "철골 부재 인양", "용접 및 볼트 체결")
      3. workContent (작업내용): 오늘 수행할 작업 내용을 1~2문장으로 요약.
      4. hazards (잠재 유해위험요인 및 대책): 추락/충돌/질식/화상 등 언급되거나 문맥상 파악되는 위험을 추출.
         - factor: 위험 요인을 명사형/개조식으로 간결히. (예: "작업 발판 위 추락 위험")
         ${freqSev
           ? `- frequency, severity: ${matrixPromptGuide(matrix)} 위험이 클수록 높은 값을 부여.`
           : `- level: "상", "중", "하" 중 하나.`}
         - measure: 예방 조치/지시사항. 명사형으로 마무리. (예: "코너에 반사경 설치 및 서행 지시")
         - 최소 2~3개 도출. 언급이 적으면 문맥상 파생되는 예상 위험을 추가하여 완성.
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
      system: systemPrompt,
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

    const hazards = Array.isArray(input.hazards)
      ? (input.hazards as unknown[])
          .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
          .map((h) => {
            const factor = str(h.factor);
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

    const result = {
      processName: str(input.processName),
      workName: str(input.workName),
      workContent: str(input.workContent),
      hazards,
      instructions: str(input.instructions),
      safetyPhrase: str(input.safetyPhrase, "안전제일!"),
      riskMethod, // 프론트가 hazard 편집 UI(상중하 select ↔ 빈도/강도)를 고르는 데 사용
      riskMatrix: matrix,
    };

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
