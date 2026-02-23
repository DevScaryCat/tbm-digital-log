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

      [중요] 반드시 아래의 **순수한 JSON 형식**으로만 응답하세요. 
      마크다운(backtick)이나 줄바꿈을 절대 섞지 말고, 모든 줄바꿈은 '\\n' 문자로 이스케이프 처리하세요.

      {
        "educationContent": "- 항목 1 (상세 내용)\\n- 항목 2 (상세 내용)\\n- 항목 3 (상세 내용)\\n- 항목 4 (상세 내용)",
        "remarks": "특이사항 내용 구체적 요약"
      }

      [작성 가이드]
      1. educationContent (교육 내용): 
         - 핵심 교육 내용을 개조식(- 기호)으로 정리하되, 반드시 명사형으로 종결하세요 (~함, ~실시, ~조치 등).
         - [분량 및 상세화 강화] 대화 내용을 단순히 압축하지 마세요. 현장에서 언급된 구체적인 '작업 구역', '사용 장비명', '위험 요소', '행동 수칙'을 빠짐없이 길고 상세하게 풀어쓰세요. (기존 대비 1.5배~2배 분량 확보)
         - 내용을 뭉뚱그리지 말고, 최소 4~6개의 구체적인 항목으로 세분화하여 풍부하게 작성하세요.
      
      2. remarks (특이사항): 
         - 작업자들의 건강 상태 확인, 날씨(폭염/혹한/우천 등)에 따른 주의사항, 개인 보호구 착용 검사 결과, 기타 행정 및 공지 지시사항을 구체적으로 요약하세요.
    `;

    const msg = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 1500,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: text }],
    });

    const contentBlock = msg.content[0];
    let rawResponse = contentBlock.type === "text" ? contentBlock.text : "{}";

    // 1. 마크다운 제거
    rawResponse = rawResponse
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    // 2. JSON 파싱 시도
    let result;
    try {
      result = JSON.parse(rawResponse);
    } catch (e) {
      console.error("JSON Parse Error. Raw output:", rawResponse);
      // 파싱 실패 시, 텍스트라도 살리기 위해 강제 할당
      result = {
        educationContent: rawResponse,
        remarks: "데이터 형식이 올바르지 않아 원본 텍스트를 표시합니다. (수기 정리 필요)",
      };
    }

    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Claude API Error:", error);
    return NextResponse.json({ error: "AI 처리 중 오류가 발생했습니다.", details: error.message }, { status: 500 });
  }
}
