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
      당신은 현장 안전 및 혁신 관리 AI입니다. 
      작업자의 음성(텍스트) 제안을 분석하여 3가지 타입 중 하나로 분류하고 요약하세요.

      [분류 기준]
      1. FACILITY (단순 민원): 화장실 고장, 청소 불량, 비품 부족 등 -> 담당: 시설팀
      2. SAFETY (위험 요소): 난간 파손, 붕괴 위험, 안전수칙 위반 등 -> 담당: 안전관리자 (긴급)
      3. INNOVATION (혁신 아이디어): 작업 공정 개선, 특허 가능성 있는 아이디어 -> 담당: 경영/특허팀

      반드시 아래의 순수 JSON 형식으로만 응답하세요. 마크다운이나 기타 텍스트는 절대 포함하지 마세요.
      {
        "category": "FACILITY | SAFETY | INNOVATION 중 택 1",
        "department": "시설팀 | 안전관리팀 | 경영/특허팀 중 택 1",
        "title": "제안의 핵심 제목 (15자 이내)",
        "summary": "제안 내용을 명확하고 전문적인 용어로 요약 (2문장 이내)"
      }
    `;

    const msg = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 800,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: text }],
    });

    const contentBlock = msg.content[0];
    let rawResponse = contentBlock.type === "text" ? contentBlock.text : "{}";

    // 혹시 모를 마크다운 찌꺼기 제거
    rawResponse = rawResponse
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    const result = JSON.parse(rawResponse);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("AI Classify Error:", error);
    return NextResponse.json({ error: "AI 분류 중 오류가 발생했습니다." }, { status: 500 });
  }
}
