// app/api/ai/minutes/route.ts
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
      당신은 건설/물류 분야의 최고 등급 "안전 보건 관리자"입니다.
      입력된 TBM(작업 전 안전점검) 회의 녹음 내용을 분석하여, 'Tool Box Meeting 회의록' 양식에 맞게 정제된 JSON 데이터를 생성하세요.

      [🚨 핵심 준수 사항]
      - 녹음 내용에 없는 사실(작업 구역, 사용 장비명, 날씨, 지시사항 등)을 절대로 임의로 지어내지 마세요.
      - 잡담, 안부 인사, 헛소리, 업무와 무관한 이야기 등은 배제하세요.
      - 반드시 지정된 JSON 규격으로만 응답하며, 마크다운 코드 블록(\`\`\`json ...)이나 그 외 부연 설명을 붙이지 마세요.

      [요구되는 JSON 구조 및 가이드]
      아래 JSON 형식에 맞추어 키값들을 채워 넣으세요:

      {
        "processName": "공정(종)명 (예: 철근공사, 배관설비 등 건설/물류 현장의 표준 공종명 중 하나를 10자 이내로 도출)",
        "workName": "구체적인 작업명 (예: 철근 조립, 배관 용접 등 오늘 진행할 행동/작업을 10자 이내로 도출)",
        "workContent": "상세 작업 내용 요약",
        "hazards": [
          {
            "factor": "근로자가 직면한 잠재적 유해/위험 요인 (구체적으로 작성)",
            "level": "상", 
            "measure": "이 위험요인을 통제/제거하기 위해 지시된 내용이나 대책"
          }
        ],
        "instructions": "작업 시작 전 협의 및 지시사항 요약",
        "safetyPhrase": "오늘의 안전구호"
      }

      [세부 가이드]
      1. \`processName\` (공정명)
         - 녹음 내용에서 유추할 수 있는 현장의 대표적인 공정 종류를 짧은 명사형으로 도출하세요. (예: "철골 공사", "배관 설비", "토공사", "도장 작업", "물류 상하차")

      2. \`workName\` (작업명)
         - 도출한 공정 하위에서 오늘 수행할 구체적인 작업 명칭을 10자 내외의 명사형으로 도출하세요. (예: "철골 부재 인양", "용접 및 볼트 체결", "터파기 및 굴착", "내부 벽면 페인팅", "화물 하차 및 분류")

      3. \`workContent\` (작업내용)
         - 녹음 내용에서 오늘 수행할 구체적인 작업 내용을 도출하여 1~2문장으로 요약하세요.

      4. \`hazards\` (잠재 유해위험요인 및 대책)
         - 화상, 추락, 충돌, 질식 등 녹취에서 언급되거나 문맥상 파악되는 위험 상황을 추출하세요.
         - factor: 위험 요인을 명사형/개조식으로 간결하고 명확히 작성하세요. (예: "지게차 코너 충돌 위험", "작업 발판 위 추락 위험")
         - level: 해당 위험의 정도를 "상", "중", "하" 중 하나로 평가하여 작성하세요.
         - measure: 녹음에서 묘사된 예방 조치나 지시사항을 포함하여 현장에 맞는 대책을 작성하세요. 가급적 명사형으로 마무리하세요. (예: "코너에 반사경 설치 및 서행 지시")
         - 최소 2~3개의 위험성을 도출하되, 언급이 적다면 파생되는 예상 위험성을 추가하여라도 전문적인 표를 완성해주세요.

      5. \`instructions\` (작업 시작 전 협의 및 지시사항)
         - 리더가 팀원들에게 특별히 지시, 협의, 당부한 사항들을 텍스트로 요약하세요.
         - 항목을 나누고 싶을 때는 실제 줄바꿈 기호(엔터) 대신 '\\n' 문자열을 사용하여 표현하세요.
         - (예시) "- 화기 작업 시 소화기 비치 철저\\n- 작업 중 무리한 중량물 취급 금지"

      6. \`safetyPhrase\` (안전구호 제창)
         - 녹음 내용에 "안전구호 제창하겠습니다", "다같이 외칩시다" 등 안전구호와 관련된 발언이나 참가자들이 단체로 외치는 구호(예: "안전, 좋아, 좋아, 좋아", "무재해 가자!")가 포함되어 있다면, **절대 임의로 지어내지 말고 들린 그대로 100% 동일하게** 추출하여 기입하세요.
         - 만약 구호가 불렸는데 AI가 임의로 기본값("안전제일!" 등)으로 바꿔버리면 안 됩니다. 실제 외친 문장 전체를 그대로 추출하세요.
         - 따로 구호가 들리지 않은 경우에만 오늘 작업 내용에 맞는 짧고 강렬한 구호를 하나 무작위로 생성해 주세요.

      [비용 절감 및 효율화 규칙]
      - 모든 항목의 요약은 부가적인 설명 없이 가장 중요한 핵심 내용만 매우 간결하게(각 항목당 최대 1~2줄 이내) 작성하여 출력 데이터양을 최소화하세요.
    `;

    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      temperature: 0.1,
      system: systemPrompt,
      messages: [{ role: "user", content: text }],
    });

    const contentBlock = msg.content[0];
    let rawResponse = contentBlock.type === "text" ? contentBlock.text : "{}";

    rawResponse = rawResponse
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    let result;
    try {
      result = JSON.parse(rawResponse);
      
      if (!Array.isArray(result.hazards)) {
        result.hazards = [];
      }

      if (typeof result.instructions === 'string') {
        result.instructions = result.instructions.replace(/\\n/g, '\n');
      } else {
        result.instructions = "";
      }

      if (typeof result.safetyPhrase !== 'string') {
        result.safetyPhrase = "안전, 안전, 확인!";
      }

      if (typeof result.processName !== 'string') {
        result.processName = "";
      }

      if (typeof result.workName !== 'string') {
        result.workName = "";
      }

    } catch (e) {
      console.error("JSON Parse Error. Raw output:", rawResponse);
      result = {
        processName: "",
        workName: "",
        workContent: "",
        hazards: [],
        instructions: "데이터 형식이 올바르지 않아 지시사항을 가져올 수 없습니다.",
        safetyPhrase: "안전제일!",
      };
    }

    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("Claude API Error:", error);
    const errorMessage = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json({ error: "AI 처리 중 오류가 발생했습니다.", details: errorMessage }, { status: 500 });
  }
}
