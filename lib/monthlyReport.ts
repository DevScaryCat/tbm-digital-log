// lib/monthlyReport.ts — 월간 안전 보고서 생성 + 발송 (크론/수동 공용)
import { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { sendMail, mailerConfigured } from "@/lib/mailer";

export interface ReportSubscription {
  id: string;
  user_id: string;
  plan?: string | null;
  report_recipients?: string[] | null;
}

export interface ReportStats {
  logCount: number;
  minutesCount: number;
  riskCount: number;
  activeDays: number;
  educationHours: string;
}

export interface ReportContent {
  companyName: string | null;
  year: number;
  month: number;
  stats: ReportStats;
  topHazards: { name: string; count: number }[];
  aiSummary: string;
}

/** 지정 월의 [시작, 끝(다음달 1일)] ISO 날짜 문자열 (YYYY-MM-DD) */
function monthRange(year: number, month: number) {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  const end = `${ny}-${String(nm).padStart(2, "0")}-01`;
  return { start, end };
}

function diffMinutes(start?: string | null, end?: string | null): number {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let d = eh * 60 + em - (sh * 60 + sm);
  if (d < 0) d += 1440;
  return d > 0 ? d : 0;
}

/** 한 사용자의 월간 데이터를 집계해 보고서 콘텐츠를 만든다. */
export async function buildReportContent(
  admin: SupabaseClient,
  userId: string,
  companyName: string | null,
  year: number,
  month: number
): Promise<ReportContent> {
  const { start, end } = monthRange(year, month);

  const [{ data: logs }, { data: minutes }, { data: risks }] = await Promise.all([
    admin
      .from("tbm_logs")
      .select("date, start_time, end_time")
      .eq("user_id", userId)
      .gte("date", start)
      .lt("date", end),
    admin
      .from("tbm_minutes")
      .select("date, start_time, end_time, hazards")
      .eq("user_id", userId)
      .gte("date", start)
      .lt("date", end),
    admin
      .from("tbm_risk_assessments")
      .select("date, items")
      .eq("user_id", userId)
      .gte("date", start)
      .lt("date", end),
  ]);

  const logRows = logs || [];
  const minuteRows = minutes || [];
  const riskRows = risks || [];

  // 교육 시간 합계
  let totalMins = 0;
  for (const r of [...logRows, ...minuteRows]) {
    totalMins += diffMinutes(r.start_time, r.end_time);
  }

  // 실시일수 (중복 날짜 제거)
  const days = new Set<string>();
  for (const r of [...logRows, ...minuteRows]) if (r.date) days.add(r.date);

  // 위험요인 빈도 집계 (회의록 hazards.factor + 위험성평가 items.hazard)
  const hazardCount = new Map<string, number>();
  for (const m of minuteRows) {
    const hs = Array.isArray((m as any).hazards) ? (m as any).hazards : [];
    for (const h of hs) {
      const name = String(h?.factor ?? "").trim();
      if (name) hazardCount.set(name, (hazardCount.get(name) || 0) + 1);
    }
  }
  for (const ra of riskRows) {
    const items = Array.isArray((ra as any).items) ? (ra as any).items : [];
    for (const it of items) {
      const name = String(it?.hazard ?? "").trim();
      if (name) hazardCount.set(name, (hazardCount.get(name) || 0) + 1);
    }
  }
  const topHazards = [...hazardCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  const stats: ReportStats = {
    logCount: logRows.length,
    minutesCount: minuteRows.length,
    riskCount: riskRows.length,
    activeDays: days.size,
    educationHours: (totalMins / 60).toFixed(1),
  };

  const aiSummary = await generateAISummary(companyName, year, month, stats, topHazards);

  return { companyName, year, month, stats, topHazards, aiSummary };
}

async function generateAISummary(
  companyName: string | null,
  year: number,
  month: number,
  stats: ReportStats,
  topHazards: { name: string; count: number }[]
): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return "";
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const facts = [
      `현장/업체: ${companyName ?? "미상"}`,
      `대상 기간: ${year}년 ${month}월`,
      `TBM 일지 ${stats.logCount}건, TBM 회의록 ${stats.minutesCount}건, 위험성평가 ${stats.riskCount}건`,
      `안전교육 실시일수 ${stats.activeDays}일, 누적 교육시간 ${stats.educationHours}시간`,
      `주요 위험요인: ${topHazards.map((h) => `${h.name}(${h.count})`).join(", ") || "없음"}`,
    ].join("\n");

    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      temperature: 0.3,
      system:
        "당신은 건설·물류 현장의 안전보건 관리자입니다. 아래 한 달간 안전활동 집계를 바탕으로, 사업주/안전관리자가 한눈에 파악할 수 있는 '월간 안전현황 총평'을 작성하세요. 3~5문장으로, ① 이번 달 활동 요약 ② 주요 위험요인 경향 ③ 다음 달 권고사항 순으로 간결하게. 수치를 지어내지 말고 주어진 집계만 사용하세요.",
      messages: [{ role: "user", content: facts }],
    });
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return text;
  } catch (e) {
    console.error("AI summary error:", e);
    return "";
  }
}

function levelColor(level: string): string {
  switch (level) {
    case "매우높음": return "#dc2626";
    case "높음": return "#ea580c";
    case "보통": return "#ca8a04";
    default: return "#16a34a";
  }
}

/** 이메일/공개페이지용 HTML 본문 */
export function renderReportHtml(content: ReportContent, viewUrl?: string): string {
  const { companyName, year, month, stats, topHazards, aiSummary } = content;
  const hazardRows =
    topHazards.length > 0
      ? topHazards
          .map(
            (h, i) =>
              `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;">${i + 1}. ${escapeHtml(
                h.name
              )}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#666;">${h.count}회</td></tr>`
          )
          .join("")
      : `<tr><td style="padding:8px 12px;color:#999;">집계된 위험요인이 없습니다.</td></tr>`;

  return `
  <div style="max-width:600px;margin:0 auto;font-family:'Apple SD Gothic Neo',Arial,sans-serif;color:#26251e;">
    <div style="background:#f54e00;padding:20px 24px;border-radius:12px 12px 0 0;">
      <div style="color:#fff;font-size:13px;opacity:.9;">안전톡톡e 월간 안전 보고서</div>
      <div style="color:#fff;font-size:22px;font-weight:700;margin-top:4px;">${year}년 ${month}월</div>
      ${companyName ? `<div style="color:#fff;font-size:14px;opacity:.95;margin-top:2px;">${escapeHtml(companyName)}</div>` : ""}
    </div>
    <div style="border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;padding:24px;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;text-align:center;">
        <tr>
          ${statCell("TBM 일지", `${stats.logCount}건`)}
          ${statCell("회의록", `${stats.minutesCount}건`)}
          ${statCell("위험성평가", `${stats.riskCount}건`)}
        </tr>
        <tr>
          ${statCell("실시일수", `${stats.activeDays}일`)}
          ${statCell("교육시간", `${stats.educationHours}h`)}
          ${statCell("", "")}
        </tr>
      </table>

      ${
        aiSummary
          ? `<div style="background:#fafaf7;border:1px solid #eee;border-radius:8px;padding:16px;margin-bottom:20px;">
              <div style="font-size:13px;font-weight:700;color:#f54e00;margin-bottom:8px;">AI 안전현황 총평</div>
              <div style="font-size:14px;line-height:1.7;color:#444;white-space:pre-line;">${escapeHtml(aiSummary)}</div>
            </div>`
          : ""
      }

      <div style="font-size:14px;font-weight:700;margin-bottom:8px;">주요 위험요인 TOP ${topHazards.length || ""}</div>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:8px;">${hazardRows}</table>

      ${
        viewUrl
          ? `<div style="text-align:center;margin-top:24px;">
              <a href="${viewUrl}" style="display:inline-block;background:#26251e;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;">보고서 전체 보기</a>
            </div>`
          : ""
      }
      <div style="font-size:12px;color:#999;margin-top:24px;text-align:center;line-height:1.6;">
        본 메일은 안전톡톡e Pro 구독자가 설정한 수신처로 자동 발송되었습니다.<br/>
        별도의 로그인 없이 위 버튼으로 보고서를 확인하실 수 있습니다.
      </div>
    </div>
  </div>`;
}

function statCell(label: string, value: string): string {
  if (!label) return `<td style="padding:10px;"></td>`;
  return `<td style="padding:10px;"><div style="font-size:20px;font-weight:700;">${value}</div><div style="font-size:12px;color:#888;margin-top:2px;">${label}</div></td>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

function appBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "";
}

export interface GenerateResult {
  status: "sent" | "skipped" | "no_recipients" | "no_data" | "mail_failed";
  token?: string;
  detail?: string;
}

/**
 * 한 구독에 대해 월간 보고서를 생성·저장하고 수신처로 발송한다. (멱등)
 * - 같은 (user, year, month) 보고서가 이미 발송됐으면 force가 아닌 한 스킵
 */
export async function generateAndSendReport(
  admin: SupabaseClient,
  sub: ReportSubscription,
  year: number,
  month: number,
  opts: { companyName?: string | null; force?: boolean } = {}
): Promise<GenerateResult> {
  const recipients = (sub.report_recipients || []).filter((e) => e && e.includes("@"));
  if (recipients.length === 0) return { status: "no_recipients" };

  // 멱등성: 이미 발송된 보고서가 있으면 스킵 (force면 재발송)
  const { data: existing } = await admin
    .from("monthly_reports")
    .select("id, token, sent_at")
    .eq("user_id", sub.user_id)
    .eq("period_year", year)
    .eq("period_month", month)
    .maybeSingle();
  if (existing?.sent_at && !opts.force) {
    return { status: "skipped", token: existing.token, detail: "이미 발송됨" };
  }

  const content = await buildReportContent(admin, sub.user_id, opts.companyName ?? null, year, month);

  // 데이터가 전혀 없으면 발송하지 않음
  if (content.stats.logCount + content.stats.minutesCount + content.stats.riskCount === 0) {
    return { status: "no_data" };
  }

  const token = existing?.token || randomUUID();

  // 보고서 레코드 저장 (멱등: user+period 유니크)
  const { error: upErr } = await admin.from("monthly_reports").upsert(
    {
      user_id: sub.user_id,
      period_year: year,
      period_month: month,
      token,
      content: content as any,
      recipients,
    },
    { onConflict: "user_id,period_year,period_month" }
  );
  if (upErr) {
    console.error("monthly_reports upsert error:", upErr);
    return { status: "mail_failed", detail: "보고서 저장 실패" };
  }

  const base = appBaseUrl();
  const viewUrl = base ? `${base}/report/monthly/${token}` : undefined;
  const html = renderReportHtml(content, viewUrl);

  if (!mailerConfigured()) {
    return { status: "mail_failed", token, detail: "메일 미설정" };
  }
  const sent = await sendMail({
    to: recipients,
    subject: `[안전톡톡e] ${content.companyName ? content.companyName + " " : ""}${year}년 ${month}월 안전 보고서`,
    html,
  });
  if (!sent.ok) {
    return { status: "mail_failed", token, detail: sent.error };
  }

  await admin
    .from("monthly_reports")
    .update({ sent_at: new Date().toISOString() })
    .eq("user_id", sub.user_id)
    .eq("period_year", year)
    .eq("period_month", month);

  return { status: "sent", token };
}

/** 직전 월 (year, month) 반환 — 크론이 매월 1일 실행될 때 사용 */
export function previousMonth(now: Date): { year: number; month: number } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1-12 (현재월)
  if (m === 1) return { year: y - 1, month: 12 };
  return { year: y, month: m - 1 };
}
