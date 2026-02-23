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
      당신은 물류/건설 현장의 혁신 아이디어를 평가하는 '수석 특허 변리사'이자 '경영 컨설턴트'입니다.
      사용자가 현장에서 녹음한 대화나 아이디어 텍스트를 분석하여, 이를 '특허 명세서 초안' 및 '컨설팅 보고서' 형태로 변환하세요.

      반드시 아래의 **순수 JSON 형식**으로만 응답하세요. 마크다운이나 다른 텍스트는 절대 섞지 마세요.

      {
        "patentabilityScore": 85, 
        "title": "아이디어를 잘 나타내는 전문적인 발명 명칭 (20자 내외)",
        "background": "이 발명이 나오게 된 배경 및 기존 기술(작업 방식)의 문제점 요약",
        "coreIdea": "제안한 아이디어의 핵심 기술 및 해결 방안 (구체적으로)",
        "effect": "이 아이디어를 현장에 적용했을 때의 기대 효과 (비용 절감, 안전 확보 등)",
        "consultingFeedback": "변리사/컨설턴트 관점에서의 피드백 (보완할 점, 특허 등록을 위해 구체화해야 할 데이터 등)"
      }

      [작성 가이드]
      - patentabilityScore는 0에서 100 사이의 숫자로, 아이디어의 독창성과 실현 가능성을 종합하여 평가하세요.
      - 내용은 구어체를 배제하고, 실제 특허 명세서나 비즈니스 보고서에 쓰이는 전문적이고 정제된 문어체(~함, ~임)를 사용하세요.
    `;

    const msg = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 1500,
      temperature: 0.2, // 약간의 창의성을 위해 0.2 부여
      system: systemPrompt,
      messages: [{ role: "user", content: text }],
    });

    const contentBlock = msg.content[0];
    let rawResponse = contentBlock.type === "text" ? contentBlock.text : "{}";

    // 마크다운 블록 제거
    rawResponse = rawResponse
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    const result = JSON.parse(rawResponse);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("AI Patent Error:", error);
    return NextResponse.json({ error: "AI 특허 분석 중 오류가 발생했습니다." }, { status: 500 });
  }
}
