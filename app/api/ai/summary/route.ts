import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function POST(request: Request) {
  try {
    const { text } = await request.json();

    if (!text) {
      return NextResponse.json({ error: "텍스트가 없습니다." }, { status: 400 });
    }

    const systemPrompt = `
      당신은 건설 및 물류 현장의 베테랑 '안전 보건 관리자'입니다.
      입력된 TBM(작업 전 안전점검) 녹음 내용을 '안전보건 교육일지' 공문서 양식에 맞춰 정제하세요.
      반드시 format_education_log 도구(tool)를 호출하여 결과를 전달하세요.

      [🚨 가장 중요한 규칙 : 환각(Hallucination) 및 잡담 배제]
      - 절대로 녹음 내용에 없는 사실(작업 구역, 사용 장비명, 날씨, 특정 지시사항 등)을 임의로 지어내거나 추가하지 마세요.
      - 오직 "사용자가 실제로 말한 내용" 안에서만 문장을 구성하세요. 원본에 없는 장비명, 구역명, 수치 등을 절대 생성하지 마세요.
      - "아침에 김치찜 나왔어?"와 같은 업무와 무관한 사적인 대화, 잡담, 헛소리는 요약에서 완전히 제외하세요.
      - 확인 체크: 작성한 모든 문장에 대해 "이 정보가 원본 녹음에 존재하는가?", "이 내용이 안전보건 교육과 관련이 있는가?" 자문하고, 둘 중 하나라도 아니면 삭제하세요.

      [작성 가이드]
      1. educationContent (교육 내용):
         - 교육 내용을 개조식(- 기호)으로 정리하되, 명사형으로 종결하세요 (~함, ~실시, ~조치 등).
         - 각 항목은 줄바꿈으로 구분하세요. (educationContent 문자열 안에서 항목마다 줄을 바꾸면 됩니다)
         - [핵심: 충분한 분량의 상세 서술]
           없는 내용을 지어내지 않되, 실제로 언급된 각 내용을 2~3문장 수준으로 상세하게 풀어쓰세요.
           각 항목마다 ① 배경/상황 → ② 구체적 지시·조치 → ③ 주의사항·기대효과 구조를 따르세요.
           (예시: 원본 "안전모 잘 쓰세요")
           → "- 작업 전 개인보호구 착용 상태 점검을 실시함. 특히 안전모 턱끈의 결속 상태를 확인하고, 느슨하거나 미착용 시 즉시 시정하도록 전 작업자에게 지시함. 올바른 보호구 착용은 낙하물로 인한 두부 부상을 예방하는 핵심 안전수칙임을 재교육함."
         - 원본 내용이 충분하다면 최소 5개 이상, 짧더라도 최소 2~3개 항목을 확보하되 없는 내용은 지어내지 마세요.

      2. remarks (특이사항):
         - 발언자가 확실하게 언급한 특이사항(작업자 건강 상태, 날씨 주의, 특별 전달·공지 등)만 발췌하여 구체적 문장형으로 작성하세요.
         - 특이사항으로 볼 만한 내용이 전혀 없다면 반드시 빈 문자열("")로 두세요. "특이사항 없음" 같은 문구도 쓰지 마세요.
    `;

    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      temperature: 0,
      system: systemPrompt,
      tools: [
        {
          name: "format_education_log",
          description: "정제된 안전보건 교육일지 내용을 구조화하여 저장합니다.",
          input_schema: {
            type: "object",
            properties: {
              educationContent: {
                type: "string",
                description:
                  "개조식(- 기호) 교육 내용. 각 항목은 줄바꿈으로 구분. 내용이 없으면 빈 문자열.",
              },
              remarks: {
                type: "string",
                description: "특이사항 요약. 없으면 반드시 빈 문자열.",
              },
            },
            required: ["educationContent", "remarks"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "format_education_log" },
      messages: [{ role: "user", content: text }],
    });

    // tool_use 블록에서 검증된 구조화 데이터 추출 (SDK가 이미 파싱 → JSON.parse 불필요)
    const toolUse = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    const input = (toolUse?.input ?? {}) as {
      educationContent?: unknown;
      remarks?: unknown;
    };

    let educationContent =
      typeof input.educationContent === "string" ? input.educationContent.trim() : "";
    let remarks = typeof input.remarks === "string" ? input.remarks.trim() : "";

    if (!educationContent) {
      remarks =
        remarks || "음성 내용이 충분하지 않아 요약이 생성되지 않았습니다. 직접 입력해주세요.";
    }

    return NextResponse.json({ educationContent, remarks });
  } catch (error: unknown) {
    console.error("Claude API Error:", error);
    const errorMessage = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: "AI 처리 중 오류가 발생했습니다.", details: errorMessage },
      { status: 500 }
    );
  }
}
