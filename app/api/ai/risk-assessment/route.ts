import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getUserAndSubscription, getAdminClient } from "@/lib/portone";
import { resolveReportTarget } from "@/lib/org";
import { STT_DOMAIN_HINT } from "@/lib/sttDomainHints";

export const runtime = "nodejs";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MAX_TEXT_LEN = 12000;
const RA_MONTHLY_LIMIT = 20;

export async function POST(request: Request) {
  try {
    // 인증 + Pro 구독 확인 (AI 분석 보고서 생성은 Pro 전용)
    const { user, allowed, isPro } = await getUserAndSubscription(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    if (!allowed) return NextResponse.json({ error: "구독이 필요합니다." }, { status: 402 });
    if (!isPro)
      return NextResponse.json(
        { error: "AI 분석 보고서 생성은 Pro 플랜에서 이용할 수 있습니다." },
        { status: 403 }
      );

    const admin = getAdminClient();
    const body = await request.json();
    const { workName, workContent, targetUserId, from, to } = body ?? {};

    // 역할 게이트(§4-C): member 403 / owner는 대상 현장 지정 가능 / solo는 본인
    const tgt = await resolveReportTarget(user.id, targetUserId, admin);
    if (!tgt.ok) return NextResponse.json({ error: tgt.error }, { status: tgt.status });
    const targetId = tgt.targetId;

    // 이번 달 AI 분석 생성 횟수 확인 (월 20회 한도) — 대상 '현장' 기준 카운트 (결정 6).
    // 안전관리자가 여러 현장을 돌려도 현장당 20회가 각자 차감된다.
    // 월 경계는 사용자 기준(KST)으로 계산한다. 서버(UTC) startOfMonth를 쓰면 매월 말/초 ~9시간
    // 동안 전월 사용량이 섞이거나 한도가 조기 초기화되는 오차가 생긴다.
    const kstYmd = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date()); // "YYYY-MM-DD"
    const startISO = new Date(`${kstYmd.slice(0, 7)}-01T00:00:00+09:00`).toISOString();
    const { count } = await admin
      .from("tbm_risk_assessments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", targetId)
      .gte("created_at", startISO);
    if ((count ?? 0) >= RA_MONTHLY_LIMIT)
      return NextResponse.json(
        { error: `이번 달 AI 분석 보고서 생성 한도(현장당 월 ${RA_MONTHLY_LIMIT}회)를 초과했습니다.` },
        { status: 429 }
      );

    // 컨텍스트: 안전관리자(대상 현장 지정)는 서버가 admin으로 직접 빌드 —
    // 클라이언트 RLS로는 남의 현장 회의록을 읽을 수 없다. solo는 기존대로 클라이언트 텍스트.
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    let work = "";
    let eduSessions = 0;
    let builtLabel = "";
    // owner는 대상이 본인이어도 서버가 회의록을 직접 읽어 컨텍스트를 빌드한다 —
    // 클라이언트 텍스트 경로(solo)로 흘리면 실제 기록 없이 라벨만으로 분석하게 된다.
    if (tgt.kind === "owner") {
      if (!DATE_RE.test(String(from)) ) {
        return NextResponse.json({ error: "기간이 올바르지 않습니다." }, { status: 400 });
      }
      const fromS = String(from);
      const toS = DATE_RE.test(String(to)) ? String(to) : fromS;
      const { data: minutes } = await admin
        .from("tbm_minutes")
        .select("date, process_name, work_name, work_content, hazards, instructions, safety_phrase, ppe_check")
        .eq("user_id", targetId)
        .gte("date", fromS)
        .lte("date", toS)
        .order("date");
      const blocks: string[] = [];
      for (const m of (minutes as any[]) || []) {
        const hz = Array.isArray(m.hazards) ? m.hazards : [];
        const hzText = hz
          .map((h: any) => `- ${h?.factor ?? ""}${h?.level ? ` (위험도: ${h.level})` : ""}${h?.measure ? ` → 대책: ${h.measure}` : ""}`)
          .filter((s: string) => s.trim() !== "-")
          .join("\n");
        blocks.push(
          `=== TBM (${m.date}, 회의록) ===\n` +
            [
              m.process_name && `공정: ${m.process_name}`,
              m.work_name && `작업명: ${m.work_name}`,
              m.work_content && `작업내용: ${m.work_content}`,
              m.ppe_check && `보호구: ${m.ppe_check}`,
              hzText && `논의된 위험요인:\n${hzText}`,
              m.instructions && `지시사항: ${m.instructions}`,
            ]
              .filter(Boolean)
              .join("\n")
        );
      }
      work = blocks.join("\n\n");
      if (work.length > 11000) work = work.slice(0, 11000);
      builtLabel = `${fromS} ~ ${toS}`;
      const { count: eduCount } = await admin
        .from("tbm_logs")
        .select("id", { count: "exact", head: true })
        .eq("user_id", targetId)
        .gte("date", fromS)
        .lte("date", toS);
      eduSessions = eduCount ?? 0;
      if (!work.trim()) {
        return NextResponse.json({ error: "선택한 기간에 작성된 TBM이 없습니다." }, { status: 400 });
      }
    } else {
      work = [workName ? `작업: ${workName}` : "", workContent].filter(Boolean).join("\n").trim();
    }

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
      이 기간의 TBM 전체를 종합하여 '위험요인 분석' 자료를 작성하세요.
      이 자료는 법정 위험성평가가 아니라, 현장에서 실제 언급·관찰된 위험요인을 정리한 참고용 기록입니다.
      등급·점수 산정은 하지 마세요. 반드시 format_risk_assessment 도구(tool)를 호출하여 결과를 전달하세요.

      [작성 규칙]
      - 여러 TBM에 흩어져 있는 위험요인을 분석하되, 같거나 유사한 위험요인은 반드시 '하나의 항목'으로 통합하세요. 중복으로 나열하지 마세요.
      - 두 건 이상의 TBM에서 반복적으로 등장하는 위험요인은 recurring=true 로 표시하세요. (반복될수록 현장에 상존하는 핵심 위험이므로 우선 관리 대상)
      - **입력된 TBM에서 실제로 언급·관찰된 위험요인만** 정리하세요. 해당 공정에서 일반적으로
        발생 가능하다는 이유로 언급되지 않은 요인을 추가하지 마세요 — 이 문서의 가치는
        "근로자들이 실제로 참여해 말한 기록"이라는 데 있고, 지어낸 항목이 섞이면 그 근거가
        무너집니다. 개수 목표도 없습니다. 실제 언급된 만큼만.
      - 각 요인마다 다음을 작성합니다.
        1) hazard: 유해·위험요인 (예: "고소작업 중 추락", "중량물 취급 중 협착")
        2) cause: 발생 원인/상황 — TBM에서 말한 상황 그대로, 구체적으로
        3) measures: 감소대책 — TBM에서 실제 언급된 조치만 개조식으로 다듬어서.
           언급된 대책이 없으면 빈 문자열("")로 두세요. 만들어 채우지 마세요.
        4) recurring: 여러 TBM에서 반복 등장하면 true, 아니면 false
      - 일반론이 아니라 입력된 TBM 내용에 특화된 내용으로 작성하세요.
    `;

    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2500,
      temperature: 0.2,
      // 현장 STT 오인식 교정 지침 — 원문은 그대로 두고 해석 단계에서 복원한다
      system: systemPrompt + STT_DOMAIN_HINT,
      tools: [
        {
          name: "format_risk_assessment",
          description: "도출된 위험요인 분석 항목들을 구조화하여 저장합니다.",
          input_schema: {
            type: "object",
            properties: {
              items: {
                type: "array",
                description: "위험요인 분석 항목 목록",
                items: {
                  type: "object",
                  properties: {
                    hazard: { type: "string", description: "유해·위험요인" },
                    cause: { type: "string", description: "발생 원인/상황" },
                    measures: { type: "string", description: "감소대책" },
                    recurring: { type: "boolean", description: "여러 TBM에서 반복 등장하면 true" },
                  },
                  required: ["hazard", "cause", "measures"],
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

    // 등급 산정 없이 정보성 항목만 정규화. 반복(현장 상존) 위험요인을 앞으로.
    const items = rawItems
      .map((it: any) => ({
        hazard: String(it?.hazard ?? "").trim(),
        cause: String(it?.cause ?? "").trim(),
        measures: String(it?.measures ?? "").trim(),
        recurring: it?.recurring === true,
      }))
      .filter((it) => it.hazard)
      .sort((a, b) => Number(b.recurring) - Number(a.recurring));

    if (items.length === 0) {
      return NextResponse.json(
        { error: "AI 분석 보고서를 생성하지 못했습니다. 작업 내용을 더 구체적으로 입력해주세요." },
        { status: 422 }
      );
    }

    // 생성 1건 = 월 한도 카운트 (별도 '앱에 저장' 버튼 대체 — 저장 조회 화면은 없고 카운팅·사용량 표시용)
    // 한도 카운트는 대상 현장 소유로 기록 — 트리거 enforce_tbm_monthly_limit도 이 user_id 기준.
    // 기록 실패(트리거 한도 포함)면 결과를 반환하지 않는다 — 카운트 없이 결과만 나가면
    // 월 한도가 영원히 0으로 남아 무제한 호출이 가능해진다 (리뷰 J)
    const { error: countErr } = await admin.from("tbm_risk_assessments").insert({
      user_id: targetId,
      date: new Date().toISOString().slice(0, 10),
      work_name: `${workName || builtLabel || "기간"} 위험요인 분석`,
      items,
    });
    if (countErr) {
      console.error("RA count insert error:", countErr);
      const code = String((countErr as any)?.code);
      const limitHit = code === "P0001";
      // P0002 = 대상 현장의 구독이 무효(회사 유예로 좌석이 접힘 등). 한도 초과와 **다른 사실**이라
      // 다른 말을 해야 한다 — 감독자가 "한도를 다 썼다"고 읽으면 다음 달을 기다린다.
      const subBlocked = code === "P0002";
      return NextResponse.json(
        {
          error: limitHit
            ? `이번 달 AI 분석 보고서 생성 한도(현장당 월 ${RA_MONTHLY_LIMIT}회)를 초과했습니다.`
            : subBlocked
              ? "이 현장 계정의 이용 권한이 연결되지 않아 분석을 기록할 수 없습니다. 결제수단·요금제를 확인해 주세요."
              : "분석 결과 기록에 실패했습니다. 잠시 후 다시 시도해주세요.",
        },
        { status: limitHit || subBlocked ? 429 : 500 }
      );
    }

    return NextResponse.json({ items, eduSessions });
  } catch (error: unknown) {
    console.error("Risk Assessment AI Error:", error);
    const errorMessage = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: "AI 처리 중 오류가 발생했습니다.", details: errorMessage },
      { status: 500 }
    );
  }
}
