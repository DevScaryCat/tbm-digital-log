// app/api/ai/minutes/route.ts
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getUserAndSubscription } from "@/lib/portone";
import { checkAndRecordAiUsage, AI_LIMIT_MESSAGE } from "@/lib/aiUsage";
import { aiInputHash, getAiCache, setAiCache } from "@/lib/aiCache";
import { STT_DOMAIN_HINT } from "@/lib/sttDomainHints";

export const runtime = "nodejs";

// 출력 규칙을 바꾸면 여기 버전을 올린다(캐시 무효화). v2: 안전구호·건강상태·보호구·대책에
// 원문 근거 대조를 적용해 근거 없으면 빈 칸으로 내보내기 시작.
const AI_CACHE_KIND = "minutes:v2";

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
    // 캐시 키에 규칙 버전을 박는다 — 캐시는 녹취 해시만 보므로, 근거 게이트를 바꿔도
    // 같은 녹음이면 **예전에 지어낸 결과**가 그대로 다시 나온다(v2 = 2026-08-22 근거 게이트).
    const cached = await getAiCache(user.id, AI_CACHE_KIND, inputHash);
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
         - measureQuote: measure를 적었다면 **그 대책이 언급된 원문 문구를 그대로 복사**해 넣으세요.
           measure가 빈 문자열이면 measureQuote도 빈 문자열("")입니다.
           근거를 못 대는 대책은 서버가 지웁니다(요인 행 자체는 남습니다).
         - quote: **그 위험이 언급된 녹음 원문 문구를 그대로 복사**해 넣으세요(10~40자).
           원문에 없는 말을 지어내면 서버 검증에서 그 행이 통째로 삭제됩니다. 요약·의역 금지 —
           반드시 원문에 있는 글자 그대로여야 합니다.
         - 개수 목표는 없습니다. 실제 언급된 만큼만 — 언급이 하나면 하나, 없으면 빈 배열.
           문맥상 예상되는 위험을 추가로 지어내지 마세요.
         - ⚠️ **같은 대상의 같은 위험을 표현만 바꿔 여러 줄로 쪼개지 마세요. 한 줄로 합치세요.**
           (예: "포름알데히드 흡입 노출"과 "포름알데히드 화학물질 노출"은 같은 위험입니다
            → "포름알데히드 노출" 한 줄. 대책이 여러 개면 그 한 줄의 measure에 함께 적으세요.)
           쪼개면 월간 보고서의 위험요인 표·기인물 통계가 같은 위험을 두 건으로 세어 부풀어집니다.
      5. instructions (작업 시작 전 협의·지시사항): 근로자와 리더가 실제로 주고받은 협의·질의응답·건의·현장 조율 내용만 기록하세요.
         - hazards에 이미 정리한 위험요인·대책을 여기서 다시 나열하지 마세요(중복 금지 — 이 칸의 목적이 다릅니다).
         - 예: 근로자가 자재 반입 시간을 물어 조정한 것, 특정 구역 작업 순서 협의, 근로자 건의에 대한 리더의 답변 등.
         - 그런 대화가 녹음에 없으면 빈 문자열("")로 두세요. 대부분의 TBM에서 비어 있는 것이 정상입니다.
         - 항목 구분은 줄바꿈으로.
      6. safetyPhrase (안전구호): 녹음에 안전구호(예: "무재해 가자!", "안전, 좋아, 좋아")가 있으면
         **들린 그대로 100% 동일하게** 추출하세요.
         - ⚠️ 없으면 **빈 문자열("")**. 구호를 지어내지 마세요. 작업에 어울리는 구호를 만들어 넣는 것도 금지입니다.
           빈 칸은 작성자가 직접 채웁니다 — '외치지 않은 구호'가 인쇄되는 것보다 빈 칸이 낫습니다.
      7. healthCheck (개인별 건강상태 이상 유무) + healthCheckQuote:
         - 건강 상태를 **실제로 확인하는 대화가 있었을 때만** 그 결과를 적으세요.
           예: "전원 이상 없음", "김씨 감기 기운 — 경작업 배치", "1명 허리 통증 호소"
         - healthCheckQuote: 그 판단의 **근거가 된 녹음 원문 문구를 그대로 복사**해 넣으세요.
         - 건강 이야기가 아예 없으면 **둘 다 빈 문자열("")**. ⚠️ 묻지도 않은 것을 "전원 이상 없음"으로
           적지 마세요 — '확인 안 함'과 '확인해서 이상 없음'은 다른 기록입니다.
      8. ppeCheck (개인 보호구 착용 상태) + ppeCheckQuote:
         - 녹음에서 **실제로 언급된 보호구만** 쉼표로 나열.
           예: "안전모, 안전대, 방진마스크", "안전모 미착용 1명 — 즉시 착용 지시"
         - ppeCheckQuote: 보호구가 언급된 **녹음 원문 문구를 그대로 복사**.
         - 보호구 언급이 없으면 **둘 다 빈 문자열("")**. 종류를 지어내지 마세요.

      ⚠️ 6·7·8과 위험요인 대책은 서버가 녹음 원문과 대조합니다. 원문에서 근거를 찾지 못하면
         그 칸은 **빈 칸으로 비워져 나갑니다.** 추측으로 채우면 결국 지워지니, 애초에 비워 두세요.

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
                    quote: {
                      type: "string",
                      description: "이 위험이 언급된 녹음 원문 문구를 그대로 복사(10~40자). 원문에 없으면 서버가 이 행을 삭제한다.",
                    },
                    measureQuote: {
                      type: "string",
                      description: "measure의 근거가 된 녹음 원문 문구를 그대로 복사. measure가 빈 문자열이면 이것도 빈 문자열. 근거가 원문에 없으면 서버가 measure를 지운다.",
                    },
                  },
                  required: ["factor", "level", "measure", "quote", "measureQuote"],
                },
              },
              instructions: {
                type: "string",
                description: "근로자와 실제 주고받은 협의·질의응답·건의만 (hazards 재나열 금지, 없으면 빈 문자열). 항목 구분은 줄바꿈.",
              },
              safetyPhrase: {
                type: "string",
                description: "녹음에서 들린 안전구호를 그대로. 없으면 빈 문자열 — 지어내지 말 것(서버가 원문과 대조해 지운다).",
              },
              healthCheck: { type: "string", description: "건강상태 확인 결과 (확인 대화가 없었으면 빈 문자열)" },
              healthCheckQuote: { type: "string", description: "healthCheck의 근거가 된 원문 문구 그대로. 없으면 빈 문자열." },
              ppeCheck: { type: "string", description: "언급된 보호구만 쉼표 나열 (언급 없으면 빈 문자열)" },
              ppeCheckQuote: { type: "string", description: "ppeCheck의 근거가 된 원문 문구 그대로. 없으면 빈 문자열." },
            },
            required: [
              "processName",
              "workName",
              "workContent",
              "hazards",
              "instructions",
              "safetyPhrase",
              "healthCheck",
              "healthCheckQuote",
              "ppeCheck",
              "ppeCheckQuote",
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

    // ── 원문 근거 게이트 (2026-08-21) ─────────────────────────────────────────────
    // 프롬프트로 "지어내지 마세요"라고 **말하는 것만으로는 안 막힌다.** 2026-08-16에 개수 하한
    // ("최소 2~3개 도출")을 없앴는데도 8/20 테스터 실기기에서 "함석 취급 중 눈 손상 / 보안경 착용"이
    // 나왔다 — 원문에 없는 말이었다. 법정 서식에 인쇄되는 문서라 '그럴듯한 추론'은 오염이다.
    // 그래서 모델에게 **원문 문구를 그대로 인용(quote)**하게 하고, 서버가 실제 원문과 대조한다.
    // 대조에 실패한 행은 삭제한다 — 놓친 위험은 작성자가 검토 화면에서 추가할 수 있지만,
    // 지어낸 위험은 사용자가 눈치채지 못한 채 서명·제출된다(비대칭 위험).
    const norm = (v: string) => v.replace(/[\s.,!?~·…"'"'()\[\]{}]/g, "").toLowerCase();
    const normText = norm(text);
    /**
     * 인용이 원문에 실제로 뿌리를 두고 있는가 — **글자 겹침 비율**로 본다.
     *
     * ⚠️ '연속 N글자 일치'로 판정하면 안 된다(2026-08-21 검증에서 실패 확인). 현장 녹음의 1/3은
     *    "추락 주의 낙하물 주의 지게차 후진" 같은 **키워드 낭독형**이라 긴 연속 구간 자체가 없고,
     *    모델이 조사 하나만 붙여도("낙하물 주의하세요") 연속 일치가 전멸해 **실제로 언급된 위험이
     *    통째로 삭제**됐다. 지어낸 것을 막으려다 진짜 기록을 지우면 더 나쁜 사고다.
     *    그래서 인용을 2글자 조각으로 쪼개 원문에 몇 %가 들어 있는지 본다:
     *      · "낙하물주의하세요" vs 원문 "…추락주의낙하물주의지게차…" → 낙하·하물·물주·주의 = 57% 통과
     *      · "함석취급중눈을다칠수있으니"(원문에 '눈' 없음) → 33% 탈락
     */
    const QUOTE_MIN_OVERLAP = 0.5;
    const quoteFound = (q: string) => {
      const nq = norm(q);
      if (nq.length < 3) return false; // 근거라 부를 수 없는 길이
      if (normText.includes(nq)) return true; // 그대로 인용한 정상 경로
      const grams: string[] = [];
      for (let i = 0; i + 2 <= nq.length; i++) grams.push(nq.slice(i, i + 2));
      if (grams.length === 0) return false;
      const hit = grams.filter((g) => normText.includes(g)).length;
      return hit / grams.length >= QUOTE_MIN_OVERLAP;
    };
    /**
     * 근거를 못 대면 칸을 비운다(2026-08-22 Chris 지시: "못찾거나 판독 못했으면 못했다고 해야해").
     * 값이 있는데 인용이 원문에 없으면 → 빈 문자열. 작성자가 검토 화면에서 직접 채운다.
     * 위험요인(행 삭제)과 달리 이 칸들은 **비우기**만 한다 — 행이 아니라 필드라 지울 게 없다.
     */
    const keepIfGrounded = (value: string, quote: string) =>
      value && quoteFound(quote) ? value : "";
    let droppedHazards = 0;
    let clearedFields = 0;

    const hazards = Array.isArray(input.hazards)
      ? (input.hazards as unknown[])
          .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
          .map((h) => ({
            factor: clean(h.factor),
            level: ["상", "중", "하"].includes(str(h.level)) ? str(h.level) : "중",
            // 대책은 실제 언급된 것만(2026-08-14 Chris 확정 — 할루시네이션 차단).
            // 2026-08-22: 프롬프트만으로는 계속 채워져 나와서 근거 인용 대조를 붙였다.
            // 비어 있으면 검토 화면에서 작성자가 채운다. AI의 개선 제안은 문서가 아니라
            // 저장 후 피드백(점수·총평) 화면으로 옮겨졌다.
            measure: keepIfGrounded(clean(h.measure), str(h.measureQuote)),
            quote: str(h.quote),
          }))
          .filter((h) => h.factor) // 요인 없는 행은 문서에 빈 줄만 만든다
          .filter((h) => {
            // 근거 없는 행은 버린다(위 게이트 주석). 인용이 아예 없어도 버린다 —
            // 스키마가 required라 빈 인용은 '근거를 못 댄다'는 뜻이다.
            const ok = quoteFound(h.quote);
            if (!ok) droppedHazards++;
            return ok;
          })
          .map(({ quote: _q, ...h }) => h) // quote는 문서에 안 나간다(검증용)
      : [];
    if (droppedHazards > 0) {
      console.log(`[minutes] 원문 근거 없는 위험요인 ${droppedHazards}건 제외`);
    }

    const result = {
      processName: clean(input.processName),
      workName: clean(input.workName),
      workContent: clean(input.workContent),
      hazards,
      instructions: clean(input.instructions),
      // ⚠️ 여기에 기본값을 넣지 말 것. 2026-08-22까지 `|| "안전제일!"`이 있었고, 그래서
      // 아무도 외치지 않은 구호가 법정 서식에 인쇄됐다. 구호 자체가 원문 인용이므로
      // 별도 quote 없이 값 자체를 원문과 대조한다.
      safetyPhrase: keepIfGrounded(clean(input.safetyPhrase), clean(input.safetyPhrase)),
      // 근거 인용이 원문에 없으면 빈 문자열로 내보낸다 — 앱은 빈 문자열을 그대로 반영해
      // 칸을 비운다. '확인 안 함'이 '이상 없음'으로 둔갑하는 경로를 서버에서 끊는다.
      healthCheck: keepIfGrounded(clean(input.healthCheck), str(input.healthCheckQuote)),
      ppeCheck: keepIfGrounded(clean(input.ppeCheck), str(input.ppeCheckQuote)),
    };
    for (const [k, v] of [
      ["safetyPhrase", input.safetyPhrase],
      ["healthCheck", input.healthCheck],
      ["ppeCheck", input.ppeCheck],
    ] as const) {
      if (clean(v) && !result[k]) clearedFields++;
    }
    if (clearedFields > 0) {
      console.log(`[minutes] 원문 근거 없는 항목 ${clearedFields}개 비움`);
    }

    // 빈 결과는 캐시하지 않는다 — 재시도 여지를 남긴다
    if (result.workContent || hazards.length > 0) {
      await setAiCache(user.id, AI_CACHE_KIND, inputHash, result);
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
