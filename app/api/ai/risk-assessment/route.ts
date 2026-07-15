import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getUserAndSubscription, getAdminClient } from "@/lib/portone";
import { MATRIX_DIMS, freqSevGrade, matrixPromptGuide, normMatrix, type MatrixScale } from "@/lib/riskMatrix";

export const runtime = "nodejs";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MAX_TEXT_LEN = 12000;
const RA_MONTHLY_LIMIT = 20;

export async function POST(request: Request) {
  try {
    // 인증 + Pro 구독 확인 (위험성평가 생성은 Pro 전용)
    const { user, allowed, isPro, riskMethod, riskMatrix } = await getUserAndSubscription(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    if (!allowed) return NextResponse.json({ error: "구독이 필요합니다." }, { status: 402 });
    if (!isPro)
      return NextResponse.json(
        { error: "AI 분석 보고서 생성은 Pro 플랜에서 이용할 수 있습니다." },
        { status: 403 }
      );
    // 위험성평가 방법(서버 강제값). 기본 level3(상중하), freq_sev면 선택 매트릭스로 빈도강도.
    const freqSev = riskMethod === "freq_sev";
    const matrix: MatrixScale = normMatrix(riskMatrix);
    const { freqMax, sevMax } = MATRIX_DIMS[matrix];

    // 이번 달 위험성평가 생성 횟수 확인 (월 20회 한도)
    // 월 경계는 사용자 기준(KST)으로 계산한다. 서버(UTC) startOfMonth를 쓰면 매월 말/초 ~9시간
    // 동안 전월 사용량이 섞이거나 한도가 조기 초기화되는 오차가 생긴다.
    const admin = getAdminClient();
    const kstYmd = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date()); // "YYYY-MM-DD"
    const startISO = new Date(`${kstYmd.slice(0, 7)}-01T00:00:00+09:00`).toISOString();
    const { count } = await admin
      .from("tbm_risk_assessments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("created_at", startISO);
    if ((count ?? 0) >= RA_MONTHLY_LIMIT)
      return NextResponse.json(
        { error: `이번 달 AI 분석 보고서 생성 한도(월 ${RA_MONTHLY_LIMIT}회)를 초과했습니다.` },
        { status: 429 }
      );

    const { workName, workContent } = await request.json();
    const work = [workName ? `작업: ${workName}` : "", workContent]
      .filter(Boolean)
      .join("\n")
      .trim();

    if (!work) {
      return NextResponse.json({ error: "분석할 TBM 내용이 없습니다." }, { status: 400 });
    }
    if (work.length > MAX_TEXT_LEN) {
      return NextResponse.json({ error: "입력이 너무 깁니다." }, { status: 413 });
    }

    const systemPrompt = `
      당신은 건설 및 물류 현장의 베테랑 '안전 보건 관리자'입니다.
      아래 입력은 특정 기간 동안 작성된 여러 건의 TBM(작업 전 안전점검) 교육일지·회의록 내용입니다.
      (각 건은 "=== TBM ... ===" 구분선으로 나뉩니다.)
      이 기간의 TBM 전체를 종합 분석하여 하나의 산업안전보건법상 '위험성평가표'를 작성하세요.
      반드시 format_risk_assessment 도구(tool)를 호출하여 결과를 전달하세요.

      [작성 규칙]
      - 여러 TBM에 흩어져 있는 위험요인을 분석하되, 같거나 유사한 위험요인은 반드시 '하나의 항목'으로 통합하세요. 중복으로 나열하지 마세요.
      - 두 건 이상의 TBM에서 반복적으로 등장하는 위험요인은 recurring=true 로 표시하세요. (반복될수록 현장에 상존하는 핵심 위험이므로 우선 관리 대상)
      - 명시적으로 언급된 위험요인은 물론, 해당 작업·공정에서 실제로 발생 가능한 핵심 유해·위험요인까지 종합하여 총 6~10개로 정리하세요.
      - 각 요인마다 다음을 작성합니다.
        1) hazard: 유해·위험요인 (예: "고소작업 중 추락", "중량물 취급 중 협착")
        2) cause: 발생 원인/상황 (구체적으로)
${freqSev
  ? `        3) frequency: 발생 가능성 1~${freqMax} 정수 (클수록 자주 발생)
        4) severity: 중대성(피해 크기) 1~${sevMax} 정수 (클수록 피해가 큼)
        5) measures: 위험성 감소대책 (구체적 안전조치, 개조식)
        6) recurring: 여러 TBM에서 반복 등장하면 true, 아니면 false
      - frequency와 severity는 작업 특성에 맞게 현실적으로 평가하세요. 모두 같은 값으로 두지 마세요. (${matrixPromptGuide(matrix)})`
  : `        3) level: 위험성 등급 "상"·"중"·"하" 중 하나 (상=중대/우선관리, 중=관리필요, 하=경미)
        4) measures: 위험성 감소대책 (구체적 안전조치, 개조식)
        5) recurring: 여러 TBM에서 반복 등장하면 true, 아니면 false
      - level은 작업 특성에 맞게 현실적으로 평가하세요. 모두 같은 값으로 두지 마세요.`}
      - 일반론이 아니라 입력된 TBM 내용에 특화된 내용으로 작성하세요.
    `;

    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2500,
      temperature: 0.2,
      system: systemPrompt,
      tools: [
        {
          name: "format_risk_assessment",
          description: "도출된 위험성평가 항목들을 구조화하여 저장합니다.",
          input_schema: {
            type: "object",
            properties: {
              items: {
                type: "array",
                description: "위험성평가 항목 목록",
                items: {
                  type: "object",
                  properties: {
                    hazard: { type: "string", description: "유해·위험요인" },
                    cause: { type: "string", description: "발생 원인/상황" },
                    ...(freqSev
                      ? {
                          frequency: { type: "integer", description: `발생 가능성 1~${freqMax}`, minimum: 1, maximum: freqMax },
                          severity: { type: "integer", description: `중대성 1~${sevMax}`, minimum: 1, maximum: sevMax },
                        }
                      : {
                          level: { type: "string", enum: ["상", "중", "하"], description: "위험성 등급" },
                        }),
                    measures: { type: "string", description: "위험성 감소대책" },
                    recurring: { type: "boolean", description: "여러 TBM에서 반복 등장하면 true" },
                  },
                  required: freqSev
                    ? ["hazard", "cause", "frequency", "severity", "measures"]
                    : ["hazard", "cause", "level", "measures"],
                },
              },
            },
            required: ["items"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "format_risk_assessment" },
      messages: [{ role: "user", content: work }],
    });

    const toolUse = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    const raw = (toolUse?.input ?? {}) as { items?: unknown };
    const rawItems = Array.isArray(raw.items) ? raw.items : [];

    const lvlRank = (l: string) => (l === "상" ? 3 : l === "중" ? 2 : 1);
    // 방법별 항목 정규화: freq_sev는 빈도×강도로 위험도·등급 산정, level3는 AI가 준 상/중/하 사용
    const items = rawItems
      .map((it: any) => {
        const base = {
          hazard: String(it?.hazard ?? "").trim(),
          cause: String(it?.cause ?? "").trim(),
          measures: String(it?.measures ?? "").trim(),
          recurring: it?.recurring === true,
        };
        if (freqSev) {
          const frequency = clamp(Number(it?.frequency), 1, freqMax);
          const severity = clamp(Number(it?.severity), 1, sevMax);
          const { score, level } = freqSevGrade(frequency, severity, matrix);
          return { ...base, frequency, severity, risk: score, level };
        }
        const level = ["상", "중", "하"].includes(String(it?.level)) ? String(it?.level) : "중";
        return { ...base, level };
      })
      .filter((it) => it.hazard)
      // 반복 위험요인을 앞으로, 그 다음 위험 높은 순 (freq_sev=위험도점수, level3=상>중>하)
      .sort(
        (a: any, b: any) =>
          Number(b.recurring) - Number(a.recurring) ||
          (b.risk ?? lvlRank(b.level)) - (a.risk ?? lvlRank(a.level))
      );

    if (items.length === 0) {
      return NextResponse.json(
        { error: "AI 분석 보고서를 생성하지 못했습니다. 작업 내용을 더 구체적으로 입력해주세요." },
        { status: 422 }
      );
    }

    // 생성 1건 = 월 한도 카운트 (별도 '앱에 저장' 버튼 대체 — 저장 조회 화면은 없고 카운팅·사용량 표시용)
    const { error: countErr } = await admin.from("tbm_risk_assessments").insert({
      user_id: user.id,
      date: new Date().toISOString().slice(0, 10),
      work_name: `${workName || "기간"} 위험성평가`,
      items,
    });
    if (countErr) console.error("RA count insert error:", countErr);

    return NextResponse.json({ items, riskMethod, riskMatrix: matrix });
  } catch (error: unknown) {
    console.error("Risk Assessment AI Error:", error);
    const errorMessage = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: "AI 처리 중 오류가 발생했습니다.", details: errorMessage },
      { status: 500 }
    );
  }
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}
