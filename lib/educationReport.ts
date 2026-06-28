// lib/educationReport.ts — 안전교육일지 기간 종합 보고서 (회의록 보고서와 별개)
// tbm_logs(교육일지)를 기간 집계 + 날짜별 AI 1줄 요약 + 주제 키워드. 위험성평가는 하지 않는다(교육 실시 기록).
import { SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export interface EducationDay {
  date: string;
  sessions: number; // 그날 교육 횟수
  summary: string; // 날짜별 1줄 통합 요약 (AI)
}

export interface EducationStats {
  sessions: number; // 교육 횟수(세션)
  days: number; // 교육 일수
  headcount: number; // 연인원(참석 누계)
  avg: string; // 평균 참석/회
}

export interface EducationReportContent {
  companyName: string | null;
  periodLabel: string;
  stats: EducationStats;
  types: { type: string; count: number }[];
  days: EducationDay[];
  keywords: string[];
}

const MAX_CONTENT_PER_DAY = 800;
const MAX_DAYS = 40;

/**
 * 날짜별 교육 내용 → 날짜별 1줄 요약 + 주제 키워드 (AI, Haiku).
 * education-insight 라우트와 보고서 발송이 공유하는 단일 출처.
 */
export async function generateEducationInsight(
  dayBlocks: { date: string; content: string }[]
): Promise<{ days: { date: string; summary: string }[]; keywords: string[] }> {
  const empty = { days: [], keywords: [] };
  if (!process.env.ANTHROPIC_API_KEY || dayBlocks.length === 0) return empty;
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const userText = dayBlocks.map((b) => `=== ${b.date} ===\n${b.content}`).join("\n\n");

    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1800,
      temperature: 0.2,
      system: `당신은 건설·물류 현장의 안전보건 관리자입니다.
아래는 한 달간 날짜별 안전교육(TBM)일지 내용입니다. (각 날짜는 "=== YYYY-MM-DD ===" 로 구분)
반드시 format_education_summary 도구(tool)를 호출하여 결과를 전달하세요.

[작성 규칙]
- 각 날짜마다 그날 교육의 핵심을 '한 줄'로 통합 요약하세요. 하루에 여러 내용이 있어도 가장 핵심적인 2~3개 주제만 골라 1줄(공백 포함 30자 내외)로 묶습니다. 4개 이상 나열하지 마세요.
- 요약은 명사형 키워드 중심으로 간결하게. 예) "지게차 안전수칙·안전모 착용 점검", "고소작업 추락 예방·안전대 결속"
- 단, 날마다 똑같이 쓰지 말고 그날 내용에서 특징적인 주제를 우선 골라 날짜별로 변별되게 작성하세요.
- date 필드에는 입력에 주어진 날짜(YYYY-MM-DD)를 그대로 echo 하세요. 날짜를 새로 만들거나 빠뜨리지 마세요.
- keywords: 이 달 전체에서 자주 다룬 교육 주제를 빈도가 높은 순으로 5~8개 뽑으세요. (예: "안전모 착용", "스트레칭", "지게차 안전수칙")
- 입력에 없는 내용을 지어내지 마세요. 주어진 내용만 사용합니다.`,
      tools: [
        {
          name: "format_education_summary",
          description: "날짜별 교육 요약과 주제 키워드를 구조화하여 저장합니다.",
          input_schema: {
            type: "object",
            properties: {
              days: {
                type: "array",
                description: "날짜별 1줄 요약 목록",
                items: {
                  type: "object",
                  properties: {
                    date: { type: "string", description: "YYYY-MM-DD (입력 날짜 그대로)" },
                    summary: { type: "string", description: "그날 교육 핵심 1줄 요약" },
                  },
                  required: ["date", "summary"],
                },
              },
              keywords: {
                type: "array",
                description: "이 달 자주 다룬 교육 주제 (빈도순 5~8개)",
                items: { type: "string" },
              },
            },
            required: ["days", "keywords"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "format_education_summary" },
      messages: [{ role: "user", content: userText }],
    });

    const toolUse = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    const raw = (toolUse?.input ?? {}) as { days?: unknown; keywords?: unknown };

    const validDates = new Set(dayBlocks.map((b) => b.date));
    const days = (Array.isArray(raw.days) ? raw.days : [])
      .map((d: any) => ({ date: String(d?.date ?? "").trim(), summary: String(d?.summary ?? "").trim() }))
      .filter((d) => validDates.has(d.date) && d.summary);

    const keywords = (Array.isArray(raw.keywords) ? raw.keywords : [])
      .map((k: any) => String(k ?? "").trim())
      .filter(Boolean)
      .slice(0, 8);

    return { days, keywords };
  } catch (e) {
    console.error("education insight AI error:", e);
    return empty;
  }
}

/**
 * 한 사용자의 [fromDate, toDate] 안전교육일지를 집계해 보고서 콘텐츠를 만든다.
 * 교육일지가 한 건도 없으면 null.
 */
export async function buildEducationRangeContent(
  admin: SupabaseClient,
  userId: string,
  companyName: string | null,
  fromDate: string,
  toDate: string,
  periodLabel: string
): Promise<EducationReportContent | null> {
  const { data: rows } = await admin
    .from("tbm_logs")
    .select("id, date, education_type, education_content")
    .eq("user_id", userId)
    .gte("date", fromDate)
    .lte("date", toDate)
    .order("date", { ascending: true });

  const logs = (rows as any[]) || [];
  if (logs.length === 0) return null;

  // 통계
  const sessions = logs.length;
  const dayCount = new Set(logs.map((l) => l.date)).size;
  const ids = logs.map((l) => l.id);
  const { count } = await admin
    .from("tbm_participants")
    .select("id", { count: "exact", head: true })
    .in("log_id", ids);
  const headcount = count ?? 0;
  const avg = sessions ? (headcount / sessions).toFixed(1) : "0.0";

  // 교육 유형 분포
  const typeMap = new Map<string, number>();
  for (const l of logs) {
    const t = (l.education_type as string) || "기타";
    typeMap.set(t, (typeMap.get(t) || 0) + 1);
  }
  const types = [...typeMap.entries()].sort((a, b) => b[1] - a[1]).map(([type, c]) => ({ type, count: c }));

  // 날짜별 내용 병합 → AI 요약
  const byDate = new Map<string, string[]>();
  for (const l of logs) {
    const d = String(l.date);
    const c = String(l.education_content ?? "").trim();
    if (!byDate.has(d)) byDate.set(d, []);
    if (c) byDate.get(d)!.push(c);
  }
  const dayBlocks = [...byDate.entries()]
    .filter(([, contents]) => contents.length > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_DAYS)
    .map(([date, contents]) => ({ date, content: contents.join("\n").slice(0, MAX_CONTENT_PER_DAY) }));

  const insight = await generateEducationInsight(dayBlocks);
  const summaryMap = new Map(insight.days.map((d) => [d.date, d.summary]));

  // 날짜별 세션 수 + 요약 (최신순)
  const dayMap = new Map<string, number>();
  for (const l of logs) dayMap.set(l.date, (dayMap.get(l.date) || 0) + 1);
  const days: EducationDay[] = [...dayMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, n]) => ({ date, sessions: n, summary: summaryMap.get(date) || "" }));

  return { companyName, periodLabel, stats: { sessions, days: dayCount, headcount, avg }, types, days, keywords: insight.keywords };
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

/** 교육 보고서 메일 HTML (회의록 메일과 동일 톤) */
export function renderEducationReportHtml(content: EducationReportContent): string {
  const { companyName, periodLabel, stats, types, days, keywords } = content;

  const statCells = [
    { label: "교육 횟수", value: `${stats.sessions}`, unit: "회" },
    { label: "교육 일수", value: `${stats.days}`, unit: "일" },
    { label: "연인원", value: `${stats.headcount}`, unit: "명" },
    { label: "평균 인원", value: stats.avg, unit: "명/회" },
  ]
    .map(
      (s) =>
        `<td style="width:25%;background:#fff;border:1px solid #e6e5e0;border-radius:8px;padding:12px 4px;">
          <div style="font-size:11px;color:#807d72;margin-bottom:4px;">${s.label}</div>
          <div style="font-size:20px;font-weight:700;color:#26251e;">${s.value}<span style="font-size:12px;color:#888;margin-left:2px;">${s.unit}</span></div>
        </td>`
    )
    .join("");

  const typeLine =
    types.length > 0
      ? types.map((t) => `${escapeHtml(t.type)} ${t.count}회`).join(" · ")
      : "";

  const keywordChips =
    keywords.length > 0
      ? keywords
          .map(
            (k) =>
              `<span style="display:inline-block;font-size:13px;font-weight:600;color:#26251e;background:#f1f0ea;border:1px solid #e6e5e0;border-radius:9999px;padding:6px 12px;margin:0 6px 8px 0;">#${escapeHtml(
                k
              )}</span>`
          )
          .join("")
      : `<span style="font-size:13px;color:#999;">집계된 주제가 없습니다.</span>`;

  const dayRows = days
    .map(
      (d) =>
        `<tr style="vertical-align:top;">
          <td style="border-bottom:1px solid #eee;padding:8px 6px;white-space:nowrap;color:#26251e;font-weight:600;font-size:13px;">${escapeHtml(d.date)}${
          d.sessions > 1 ? ` <span style="color:#f54e00;font-weight:700;">(${d.sessions}회)</span>` : ""
        }</td>
          <td style="border-bottom:1px solid #eee;padding:8px 6px;font-size:13px;color:#444;">${escapeHtml(d.summary) || `교육 ${d.sessions}회 실시`}</td>
        </tr>`
    )
    .join("");

  return `
  <div style="max-width:640px;margin:0 auto;font-family:'Apple SD Gothic Neo',Arial,sans-serif;color:#26251e;">
    <div style="border:1px solid #e6e5e0;border-radius:14px;overflow:hidden;background:#fff;">
    <div style="padding:22px 24px 18px;border-bottom:1px solid #eee;">
      <div style="font-size:12px;font-weight:700;color:#f54e00;letter-spacing:.2px;">● 안전톡톡e · 안전교육일지 종합분석</div>
      <div style="color:#26251e;font-size:24px;font-weight:700;margin-top:8px;letter-spacing:-0.5px;">${escapeHtml(periodLabel)}</div>
      ${companyName ? `<div style="color:#807d72;font-size:14px;margin-top:3px;">${escapeHtml(companyName)}</div>` : ""}
    </div>
    <div style="padding:24px;background:#fff;">

      <table style="width:100%;border-collapse:separate;border-spacing:6px;margin:-6px 0 16px;text-align:center;">
        <tr>${statCells}</tr>
      </table>

      ${typeLine ? `<div style="font-size:13px;color:#807d72;margin-bottom:18px;"><span style="font-weight:700;color:#26251e;">교육 유형</span> · ${typeLine}</div>` : ""}

      <div style="font-size:15px;font-weight:700;margin-bottom:10px;"># 자주 다룬 교육 주제</div>
      <div style="margin-bottom:22px;">${keywordChips}</div>

      <div style="font-size:15px;font-weight:700;margin-bottom:10px;">날짜별 교육 요약</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e6e5e0;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#f4f3ee;color:#807d72;font-size:12px;">
            <th style="padding:8px 6px;text-align:left;width:96px;">날짜</th>
            <th style="padding:8px 6px;text-align:left;">교육 핵심 요약</th>
          </tr>
        </thead>
        <tbody>${dayRows}</tbody>
      </table>

      <div style="font-size:12px;color:#999;margin-top:24px;text-align:center;line-height:1.6;">
        본 보고서는 안전톡톡e가 ${escapeHtml(periodLabel)} 안전교육일지를 분석해 자동 생성했습니다.<br/>
        날짜별 요약은 작성된 교육일지 내용을 AI가 정리한 것입니다.
      </div>
    </div>
    </div>
  </div>`;
}

/** 날짜별 교육 요약 → 엑셀(CSV). BOM 포함(한글 깨짐 방지). */
export function buildEducationCsv(content: EducationReportContent): string {
  const { stats, types, days } = content;
  const header = ["날짜", "교육 횟수", "교육 핵심 요약"];
  const rows = days.map((d) => [d.date, d.sessions, d.summary]);
  const top = [
    ["안전교육일지 종합"],
    ["현장/업체", content.companyName || "-", "대상기간", content.periodLabel],
    ["교육 횟수", `${stats.sessions}회`, "교육 일수", `${stats.days}일`, "연인원", `${stats.headcount}명`, "평균", `${stats.avg}명/회`],
    ["교육 유형", types.map((t) => `${t.type} ${t.count}회`).join(" / ") || "-"],
    [],
    header,
    ...rows,
  ];
  return "﻿" + top.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
}

type MailAttachment = { filename: string; content: string | Buffer; contentType?: string };

/** 교육 보고서 첨부: 결재서류 PDF + 날짜별 요약 엑셀(CSV). PDF 실패해도 메일·CSV는 발송. */
export async function buildEducationAttachments(
  content: EducationReportContent,
  docTitle: string,
  date: string
): Promise<MailAttachment[]> {
  const attachments: MailAttachment[] = [];

  try {
    const { renderEducationApprovalPdf } = await import("@/lib/approvalPdf");
    const pdf = await renderEducationApprovalPdf(content, docTitle);
    attachments.push({ filename: `안전교육일지_결재서류_${date}.pdf`, content: pdf, contentType: "application/pdf" });
  } catch (e) {
    console.error("교육 결재서류 PDF 생성 실패:", e);
  }

  attachments.push({
    filename: `안전교육일지_종합_${date}.csv`,
    content: buildEducationCsv(content),
    contentType: "text/csv;charset=utf-8",
  });

  return attachments;
}
