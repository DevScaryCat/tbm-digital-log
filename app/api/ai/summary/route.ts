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

      [🚨 가장 중요한 규칙 : 환각(Hallucination) 및 잡담 배제]
      - 절대로 녹음 내용에 없는 사실(작업 구역, 사용 장비명, 날씨, 특정 지시사항 등)을 임의로 지어내거나 추가하지 마세요.
      - 오직 "사용자가 실제로 말한 내용" 안에서만 문장을 구성하세요. 원본에 없는 장비명, 구역명, 수치 등을 절대 생성하지 마세요.
      - "아침에 김치찜 나왔어?"와 같은 업무와 무관한 사적인 대화, 잡담, 헛소리는 요약에서 완전히 제외하세요.
      - 확인 체크: 작성한 모든 문장에 대해 "이 정보가 원본 녹음에 존재하는가?", "이 내용이 안전보건 교육과 관련이 있는가?" 자문하고, 둘 중 하나라도 아니면 삭제하세요.

      [중요] 반드시 아래의 **순수한 JSON 형식**으로만 응답하세요. 
      마크다운이나 줄바꿈을 섞지 않되, educationContent 내 항목을 구분할 때는 반드시 실제 줄바꿈(엔터) 대신 '\\n' 문자열을 사용하세요.
      결과물 내에서 항목 구분은 오직 '\\n'으로만 해야 하며, 화면에 '\\n' 글자가 보이지 않고 줄바꿈으로 인식되도록 올바른 이스케이프 처리를 하세요.

      {
        "educationContent": "- 항목 1\\n- 항목 2\\n- 항목 3",
        "remarks": "특이사항 요약"
      }

      [작성 가이드]
      1. educationContent (교육 내용): 
         - 교육 내용을 개조식(- 기호)으로 정리하되, 명사형으로 종결하세요 (~함, ~실시, ~조치 등).
         - 각 항목 사이에는 반드시 눈에 보이는 줄바꿈 기호 대신 '\\n'을 넣어서 하나의 문자열로 이어지도록 만드세요.
         
         - [핵심: 충분한 분량의 상세 서술]
           없는 내용을 지어내지 않되, 실제로 언급된 각 내용을 2~3문장 수준으로 상세하게 풀어쓰세요.
           각 항목마다 다음 구조를 따르세요:
           ① 해당 사항의 배경/상황 → ② 구체적 지시 또는 조치 내용 → ③ 주의사항 또는 기대 효과
           
           (예시: 원본이 "안전모 잘 쓰세요"인 경우)
           → "- 작업 전 개인보호구 착용 상태 점검을 실시함. 특히 안전모 턱끈의 결속 상태를 확인하고, 느슨하거나 미착용 시 즉시 시정하도록 전 작업자에게 지시사항을 전달함. 올바른 보호구 착용은 낙하물로 인한 두부 부상을 예방하는 핵심 안전수칙임을 재교육함."
           
           (예시: 원본이 "오늘 2층에서 작업한다"인 경우)
           → "- 금일 작업은 2층에서 진행될 예정임을 공유함. 2층 작업 시 추락 위험에 대비하여 안전난간 설치 여부 및 개구부 덮개 상태를 사전에 확인할 것을 당부함. 고소작업 시 안전대 착용을 필수화하고 작업 전 발판 상태 점검을 실시할 것을 지시함."
           
         - 원본 내용이 충분하다면 최소 5개 이상의 항목으로 정리하세요.
         - 원본이 매우 짧더라도 최소 2~3개 항목은 확보하되, 없는 내용을 지어내지는 마세요.
      
      2. remarks (특이사항): 
         - 대화 중에서 발언자가 확실하게 언급한 특이사항(작업자의 건강 상태, 날씨 주의사항, 특별한 전달/공지사항 등)만 발췌하여 요약하세요. 
         - 특이사항이 있을 경우, 단순 키워드가 아니라 구체적인 문장형으로 작성하세요.
         - 만약 원본에 특이사항이나 특별한 전달사항으로 보일 만한 내용이 전혀 없다면, 절대 지어내지 말고 무조건 공백("")으로 두세요. "특이사항 없음" 등의 문구도 쓰지 마세요.
    `;

    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2500,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: text }],
    });

    const contentBlock = msg.content[0];
    let rawResponse = contentBlock.type === "text" ? contentBlock.text : "{}";

    // 1. 마크다운 제거
    rawResponse = rawResponse
      .replace(/\`\`\`json/g, "")
      .replace(/\`\`\`/g, "")
      .trim();

    // 2. JSON 파싱 시도
    let result;
    try {
      result = JSON.parse(rawResponse);
      
      // AI가 간혹 educationContent 안에 JSON 객체를 문자열로 넣는 경우 대응
      // 예: educationContent = '{"educationContent": "...", "remarks": "..."}'
      if (typeof result.educationContent === 'string') {
        try {
          const nested = JSON.parse(result.educationContent);
          if (nested && typeof nested === 'object' && nested.educationContent !== undefined) {
            result.educationContent = nested.educationContent || "";
            if (nested.remarks) result.remarks = nested.remarks;
          }
        } catch {
          // nested JSON이 아닌 경우 무시 - 정상적인 문자열
        }
      }

      // educationContent가 객체(JSON)인 경우 문자열로 변환
      if (typeof result.educationContent === 'object' && result.educationContent !== null) {
        console.warn("educationContent is object, converting:", result.educationContent);
        // 내부에 educationContent 키가 있으면 그것을 사용
        if (result.educationContent.educationContent) {
          const inner = result.educationContent;
          result.educationContent = inner.educationContent || "";
          if (inner.remarks && !result.remarks) result.remarks = inner.remarks;
        } else {
          result.educationContent = "";
        }
      }

      // 혹시라도 이중 이스케이프되어 문자열에 그대로 노출된 "\\n"을 실제 줄바꿈 문자로 변환
      if (typeof result.educationContent === 'string') {
        result.educationContent = result.educationContent.replace(/\\n/g, '\n');
      }
      if (typeof result.remarks === 'string') {
        result.remarks = result.remarks.replace(/\\n/g, '\n');
      }

      // remarks가 객체인 경우 빈 문자열로 처리
      if (typeof result.remarks === 'object') {
        result.remarks = "";
      }

      // educationContent가 빈 문자열이면 안내 메시지
      if (!result.educationContent || result.educationContent.trim() === "") {
        result.educationContent = "";
        result.remarks = result.remarks || "음성 내용이 충분하지 않아 요약이 생성되지 않았습니다. 직접 입력해주세요.";
      }
    } catch (e) {
      console.error("JSON Parse Error. Raw output:", rawResponse);
      // 파싱 실패 시, 텍스트라도 살리기 위해 강제 할당
      result = {
        educationContent: rawResponse.replace(/\\n/g, '\n'),
        remarks: "데이터 형식이 올바르지 않아 원본 텍스트를 표시합니다. (수기 정리 필요)",
      };
    }

    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Claude API Error:", error);
    return NextResponse.json({ error: "AI 처리 중 오류가 발생했습니다.", details: error.message }, { status: 500 });
  }
}
