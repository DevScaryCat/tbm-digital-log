// lib/monthlyReport.ts — TBM 회의록 종합분석 보고서 (월간/기간 공용 단일 템플릿)
// 위험요인은 TBM 회의록(tbm_minutes)에서만 집계. 위험성평가표(riskItems)가 있으면 주요 위험요인 아래에 엑셀표로 추가.
import { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { sendMail, mailerConfigured } from "@/lib/mailer";
import { formatRangeLabelKo } from "@/lib/utils";

export interface ReportSubscription {
  id: string;
  user_id: string;
  plan?: string | null;
  report_recipients?: string[] | null;
}

export interface ReportStats {
  total: number; // 회의록 건수
  high: number; // 위험성(상)
  mid: number; // 위험성(중)
}

export interface HazardRow {
  factor: string;
  level: "상" | "중" | "하";
  measure: string;
  process: string;
  date: string;
}

/** 위험성평가 항목 (주요 위험요인 아래 엑셀표) */
export interface RiskItem {
  hazard: string;
  cause: string;
  frequency: number;
  severity: number;
  risk: number;
  level: string; // 매우높음/높음/보통/낮음
  measures: string;
  recurring?: boolean;
}

export interface ReportContent {
  companyName: string | null;
  periodLabel: string;
  stats: ReportStats;
  keywords: { word: string; count: number }[];
  hazards: HazardRow[];
  aiSummary: string;
  riskItems?: RiskItem[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 위험 등급 → 상/중/하 (회의록 hazards.level은 이미 상/중/하) */
function gradeOf(level: unknown): "상" | "중" | "하" {
  const s = String(level ?? "").trim();
  if (s === "상" || s === "매우높음" || s === "높음") return "상";
  if (s === "중" || s === "보통") return "중";
  if (s === "하" || s === "낮음") return "하";
  const n = Number(s);
  if (!isNaN(n)) { if (n >= 9) return "상"; if (n >= 4) return "중"; return "하"; }
  return "중";
}
const rankOf = (l: string) => (l === "상" ? 3 : l === "중" ? 2 : 1);

/** 한 사용자의 [fromDate, toDate] (둘 다 포함) TBM 회의록을 집계해 콘텐츠를 만든다. */
async function buildMinutesContent(
  admin: SupabaseClient,
  userId: string,
  companyName: string | null,
  fromDate: string,
  toDate: string,
  periodLabel: string
): Promise<ReportContent> {
  const { data: minutes } = await admin
    .from("tbm_minutes")
    .select("date, hazards, work_name, process_name")
    .eq("user_id", userId)
    .gte("date", fromDate)
    .lte("date", toDate);
  const minuteRows = (minutes as any[]) || [];

  const items: HazardRow[] = [];
  for (const m of minuteRows) {
    const hs = Array.isArray(m.hazards) ? m.hazards : [];
    for (const h of hs) {
      const factor = String(h?.factor ?? "").trim();
      if (!factor) continue;
      items.push({
        factor,
        level: gradeOf(h?.level),
        measure: String(h?.measure ?? "").trim(),
        process: m.process_name || m.work_name || "",
        date: m.date || "",
      });
    }
  }

  const freq = new Map<string, number>();
  for (const it of items) freq.set(it.factor, (freq.get(it.factor) || 0) + 1);
  const keywords = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([word, count]) => ({ word, count }));

  const high = items.filter((it) => it.level === "상").length;
  const mid = items.filter((it) => it.level === "중").length;
  const hazards = items.slice().sort((a, b) => rankOf(b.level) - rankOf(a.level)).slice(0, 30);

  const stats: ReportStats = { total: minuteRows.length, high, mid };
  const aiSummary = await generateAISummary(companyName, periodLabel, stats, keywords);

  return { companyName, periodLabel, stats, keywords, hazards, aiSummary };
}

/** 월간(year, month) 보고서 콘텐츠 */
export async function buildReportContent(
  admin: SupabaseClient,
  userId: string,
  companyName: string | null,
  year: number,
  month: number
): Promise<ReportContent> {
  const from = `${year}-${pad(month)}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const to = `${year}-${pad(month)}-${pad(lastDay)}`;
  return buildMinutesContent(admin, userId, companyName, from, to, `${year}년 ${month}월`);
}

/** 임의 기간(fromDate~toDate) 보고서 콘텐츠 — 위험성평가 발송에서 사용 */
export async function buildRangeContent(
  admin: SupabaseClient,
  userId: string,
  companyName: string | null,
  fromDate: string,
  toDate: string
): Promise<ReportContent> {
  const label = formatRangeLabelKo(fromDate, toDate);
  return buildMinutesContent(admin, userId, companyName, fromDate, toDate, label);
}

/** 모델이 마크다운/머리말을 흘려도 메일·PDF에 날것 기호가 안 보이도록 줄글로 정리한다. */
function sanitizeSummary(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1") // **굵게**
    .replace(/__(.*?)__/g, "$1")
    .replace(/\*(.*?)\*/g, "$1") // *기울임*
    .replace(/`+/g, "")
    .replace(/^\s*#{1,6}\s*/gm, "") // # 머리말
    .replace(/^\s*[-*•]\s+/gm, "") // 글머리 기호
    .replace(/^\s*[①-⑳]\s*/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "") // 1. 2)
    .replace(/^\s*[-=_]{3,}\s*$/gm, "") // --- 구분선
    .replace(/^\s*(안전\s*총평|기간)\s*[:：].*$/gim, "") // 라벨성 머리말
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function generateAISummary(
  companyName: string | null,
  periodLabel: string,
  stats: ReportStats,
  keywords: { word: string; count: number }[]
): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return "";
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const facts = [
      `현장/업체: ${companyName ?? "미상"}`,
      `대상 기간: ${periodLabel} (TBM 회의록 기준)`,
      `회의록 ${stats.total}건, 위험요인 등급 상 ${stats.high}건 / 중 ${stats.mid}건`,
      `자주 논의된 위험요인: ${keywords.map((k) => `${k.word}(${k.count})`).join(", ") || "없음"}`,
    ].join("\n");

    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      temperature: 0.4,
      system: [
        "당신은 건설·물류 현장의 베테랑 안전보건 관리자입니다.",
        "아래 TBM 회의록 위험요인 집계만 보고, 사업주에게 보고하듯 '안전 총평'을 씁니다.",
        "",
        "[형식]",
        "- 마크다운 절대 금지: #, *, **, -, ---, 번호목록(①, 1.) 어떤 기호도 쓰지 마세요. 순수한 줄글 문장만.",
        "- 제목·머리말 없이 본문 문장으로 바로 시작합니다. ('안전 총평', '기간:' 같은 라벨 금지)",
        "- 2~3문장, 200자 내외. 짧고 단정하게.",
        "",
        "[내용·어조]",
        "- 가장 우선 관리할 위험을 구체적인 위험요인 이름으로 짚고, 실무적인 권고 한 가지를 덧붙입니다.",
        "- 'AI가 분석한', '~로 보입니다', '~필요가 있어 보입니다' 같은 군더더기·기계적 표현을 피하고 현장 관리자가 말하듯 단정적으로.",
        "- 주어진 집계 수치만 사용하고, 없는 수치·사실을 지어내지 마세요.",
      ].join("\n"),
      messages: [{ role: "user", content: facts }],
    });
    const raw = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    return sanitizeSummary(raw);
  } catch (e) {
    console.error("AI summary error:", e);
    return "";
  }
}

function levelBadge(level: string): string {
  const c =
    level === "상" ? { bg: "#fde7ec", fg: "#cf2d56" } : level === "중" ? { bg: "#ffeede", fg: "#d4691a" } : { bg: "#e7f6ee", fg: "#1f8a65" };
  return `<span style="display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:9999px;background:${c.bg};color:${c.fg};white-space:nowrap;">${level}</span>`;
}

/** 상/중/하 표시 색 (위험성평가표 등급 텍스트용) */
function gradeColor(g: string): string {
  return g === "상" ? "#cf2d56" : g === "중" ? "#d4691a" : "#1f8a65";
}

/** 위험성평가 엑셀표 섹션 (주요 위험요인 아래) */
function riskTableHtml(items: RiskItem[]): string {
  if (!items || items.length === 0) return "";
  const recurring = items.filter((it) => it.recurring).length;
  const rows = items
    .map(
      (it, i) => `
      <tr style="vertical-align:top;">
        <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:center;color:#999;font-size:12px;">${i + 1}</td>
        <td style="padding:8px 6px;border-bottom:1px solid #eee;">
          ${it.recurring ? `<span style="display:inline-block;font-size:10px;font-weight:700;color:#f54e00;background:#f54e0018;padding:1px 6px;border-radius:4px;margin-bottom:2px;">반복</span><br/>` : ""}
          <span style="font-weight:600;color:#26251e;font-size:13px;">${escapeHtml(it.hazard)}</span>
          ${it.cause ? `<div style="font-size:11px;color:#999;margin-top:2px;">${escapeHtml(it.cause)}</div>` : ""}
        </td>
        <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:center;font-size:12px;color:#555;white-space:nowrap;">${it.frequency}×${it.severity}</td>
        <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:center;white-space:nowrap;"><b style="color:${gradeColor(gradeOf(it.risk))};font-size:13px;">${it.risk} · ${gradeOf(it.risk)}</b></td>
        <td style="padding:8px 6px;border-bottom:1px solid #eee;font-size:12px;color:#444;">${escapeHtml(it.measures) || "-"}</td>
      </tr>`
    )
    .join("");
  return `
      <div style="font-size:15px;font-weight:700;margin:22px 0 10px;">위험성평가표</div>
      ${recurring ? `<div style="background:#f54e000d;border:1px solid #f54e0033;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#c2410c;">⟳ 반복 위험요인 ${recurring}건 — 여러 TBM에서 반복 등장, 우선 관리 대상</div>` : ""}
      <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e6e5e0;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#f4f3ee;color:#807d72;font-size:12px;">
            <th style="padding:8px 6px;text-align:center;width:34px;">No</th>
            <th style="padding:8px 6px;text-align:left;">유해·위험요인 / 원인</th>
            <th style="padding:8px 6px;text-align:center;width:60px;">가능성×중대성</th>
            <th style="padding:8px 6px;text-align:center;width:74px;">위험성</th>
            <th style="padding:8px 6px;text-align:left;">감소대책</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
}

/** 이메일/공개페이지용 HTML 본문 (월간·위험성평가 공용 단일 템플릿) */
export function renderReportHtml(content: ReportContent, viewUrl?: string): string {
  const { companyName, periodLabel } = content;
  const stats = content.stats || ({ total: 0, high: 0, mid: 0 } as ReportStats);
  const keywords = content.keywords || [];
  const hazards = content.hazards || [];
  const aiSummary = content.aiSummary || "";
  const riskItems = content.riskItems || [];
  // 위(주요 위험요인)·아래(위험성평가표) 등급 통일: 위험성평가(riskItems)가 있으면 그 위험성 점수(가능성×중대성)로
  // 상/중/하를 산정하고, 위 요약표도 riskItems에서 파생 → 같은 항목이 두 표에서 같은 등급을 갖는다.
  const summaryItems = riskItems.length > 0
    ? riskItems.map((it) => ({ factor: it.hazard, process: it.cause || "", date: "", level: gradeOf(it.risk), measure: it.measures }))
    : hazards;
  const displayStats = riskItems.length > 0
    ? { total: stats.total, high: riskItems.filter((it) => gradeOf(it.risk) === "상").length, mid: riskItems.filter((it) => gradeOf(it.risk) === "중").length }
    : stats;

  const topWords = keywords.slice(0, 2).map((k) => escapeHtml(k.word));
  const keywordChips =
    keywords.length > 0
      ? keywords
          .map(
            (k) =>
              `<span style="display:inline-block;font-size:13px;font-weight:600;color:#26251e;background:#f1f0ea;border:1px solid #e6e5e0;border-radius:9999px;padding:6px 12px;margin:0 6px 8px 0;">#${escapeHtml(
                k.word
              )} <span style="color:#888;font-weight:500;">(${k.count})</span></span>`
          )
          .join("")
      : `<span style="font-size:13px;color:#999;">집계된 위험 키워드가 없습니다.</span>`;

  const hazardRows =
    summaryItems.length > 0
      ? summaryItems
          .map(
            (h, i) =>
              `<tr style="vertical-align:top;">
                <td style="border-bottom:1px solid #eee;padding:8px 6px;text-align:center;color:#999;font-size:12px;">${i + 1}</td>
                <td style="border-bottom:1px solid #eee;padding:8px 6px;">
                  <div style="font-weight:600;color:#26251e;font-size:13px;">${escapeHtml(h.factor)}</div>
                  ${h.process ? `<div style="font-size:11px;color:#999;margin-top:2px;">${escapeHtml(h.process)}${h.date ? ` · ${escapeHtml(h.date)}` : ""}</div>` : h.date ? `<div style="font-size:11px;color:#999;margin-top:2px;">${escapeHtml(h.date)}</div>` : ""}
                </td>
                <td style="border-bottom:1px solid #eee;padding:8px 6px;text-align:center;">${levelBadge(h.level)}</td>
                <td style="border-bottom:1px solid #eee;padding:8px 6px;font-size:12px;color:#444;">${escapeHtml(h.measure) || "-"}</td>
              </tr>`
          )
          .join("")
      : `<tr><td colspan="4" style="padding:14px;color:#999;font-size:13px;text-align:center;">집계된 위험요인이 없습니다.</td></tr>`;

  return `
  <div style="max-width:640px;margin:0 auto;font-family:'Apple SD Gothic Neo',Arial,sans-serif;color:#26251e;">
    <div style="border:1px solid #e6e5e0;border-radius:14px;overflow:hidden;background:#fff;">
    <div style="padding:22px 24px 18px;border-bottom:1px solid #eee;">
      <div style="font-size:12px;font-weight:700;color:#f54e00;letter-spacing:.2px;">● 안전톡톡e · TBM 회의록 종합분석</div>
      <div style="color:#26251e;font-size:24px;font-weight:700;margin-top:8px;letter-spacing:-0.5px;">${escapeHtml(periodLabel)}</div>
      ${companyName ? `<div style="color:#807d72;font-size:14px;margin-top:3px;">${escapeHtml(companyName)}</div>` : ""}
    </div>
    <div style="padding:24px;background:#fff;">

      <table style="width:100%;border-collapse:separate;border-spacing:8px;margin:-8px 0 18px;text-align:center;">
        <tr>
          <td style="width:33%;background:#fff;border:1px solid #e6e5e0;border-radius:8px;padding:12px 6px;">
            <div style="font-size:12px;color:#807d72;margin-bottom:4px;">총 회의록</div>
            <div style="font-size:22px;font-weight:700;color:#26251e;">${stats.total}<span style="font-size:13px;color:#888;margin-left:2px;">건</span></div>
          </td>
          <td style="width:33%;background:#fdecef;border:1px solid #f6cdd6;border-radius:8px;padding:12px 6px;">
            <div style="font-size:12px;color:#cf2d56;margin-bottom:4px;">위험성 (상)</div>
            <div style="font-size:22px;font-weight:700;color:#cf2d56;">${displayStats.high}<span style="font-size:13px;margin-left:2px;">건</span></div>
          </td>
          <td style="width:33%;background:#fff1e3;border:1px solid #ffd9b3;border-radius:8px;padding:12px 6px;">
            <div style="font-size:12px;color:#d4691a;margin-bottom:4px;">위험성 (중)</div>
            <div style="font-size:22px;font-weight:700;color:#d4691a;">${displayStats.mid}<span style="font-size:13px;margin-left:2px;">건</span></div>
          </td>
        </tr>
      </table>

      ${
        aiSummary
          ? `<div style="background:#fafaf7;border:1px solid #eee;border-radius:10px;padding:16px;margin-bottom:20px;">
              <div style="font-size:13px;font-weight:700;color:#f54e00;margin-bottom:8px;">✨ AI 안전 총평</div>
              <div style="font-size:14px;line-height:1.7;color:#444;white-space:pre-line;">${escapeHtml(aiSummary)}</div>
            </div>`
          : ""
      }

      <div style="font-size:15px;font-weight:700;margin-bottom:10px;"># 핵심 위험 키워드</div>
      <div style="margin-bottom:6px;">${keywordChips}</div>
      ${
        topWords.length > 0
          ? `<div style="font-size:13px;color:#807d72;line-height:1.6;margin-bottom:22px;"><span style="color:#cf2d56;font-weight:700;">${topWords[0]}</span>${topWords[1] ? ` 및 <span style="color:#cf2d56;font-weight:700;">${topWords[1]}</span>` : ""} 관련 위험요인의 언급 빈도가 가장 높습니다. 해당 작업 전 집중 안전점검이 필요합니다.</div>`
          : `<div style="margin-bottom:22px;"></div>`
      }

      <div style="font-size:15px;font-weight:700;margin-bottom:10px;">주요 위험요인</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e6e5e0;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#f4f3ee;color:#807d72;font-size:12px;">
            <th style="padding:8px 6px;text-align:center;width:34px;">No</th>
            <th style="padding:8px 6px;text-align:left;">유해·위험요인 / 공정</th>
            <th style="padding:8px 6px;text-align:center;width:54px;">등급</th>
            <th style="padding:8px 6px;text-align:left;">감소대책</th>
          </tr>
        </thead>
        <tbody>${hazardRows}</tbody>
      </table>

      ${riskTableHtml(riskItems)}

      ${
        viewUrl
          ? `<div style="text-align:center;margin-top:24px;">
              <a href="${viewUrl}" style="display:inline-block;background:#26251e;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;">보고서 전체 보기</a>
            </div>`
          : ""
      }
      <div style="font-size:12px;color:#999;margin-top:24px;text-align:center;line-height:1.6;">
        본 보고서는 안전톡톡e가 ${escapeHtml(periodLabel)} TBM 회의록을 분석해 자동 생성했습니다.<br/>
        위험요인은 작성된 회의록에서만 집계됩니다.
      </div>
    </div>
    </div>
  </div>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
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

type MailAttachment = { filename: string; content: string | Buffer; contentType?: string };

/** 위험성평가표 → 엑셀(CSV) 문자열. BOM 포함(한글 깨짐 방지). */
export function buildRiskCsv(
  items: RiskItem[],
  meta: { company: string; period: string; date: string }
): string {
  const header = ["No", "반복", "유해·위험요인", "발생 원인", "가능성", "중대성", "위험성", "등급", "감소대책"];
  const rows = items.map((it, i) => [i + 1, it.recurring ? "반복" : "", it.hazard, it.cause, it.frequency, it.severity, it.risk, gradeOf(it.risk), it.measures]);
  const top = [["위험성평가표"], ["현장/업체", meta.company || "-", "대상기간", meta.period, "작성일", meta.date], [], header, ...rows];
  return "﻿" + top.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
}

/**
 * 보고서 메일 첨부 일괄 생성: 결재서류 PDF + (위험성평가표가 있으면) 엑셀 CSV.
 * react-pdf는 무겁고 Node 전용이라 동적 import로 필요할 때만 로드한다.
 */
export async function buildReportAttachments(
  content: ReportContent,
  docTitle: string,
  date: string
): Promise<MailAttachment[]> {
  const attachments: MailAttachment[] = [];

  // 결재서류 PDF: 실패해도 메일(본문+CSV)은 나가도록 비치명적 처리.
  try {
    const { renderApprovalPdf } = await import("@/lib/approvalPdf");
    const pdf = await renderApprovalPdf(content, docTitle);
    attachments.push({ filename: `결재서류_${date}.pdf`, content: pdf, contentType: "application/pdf" });
  } catch (e) {
    console.error("결재서류 PDF 생성 실패:", e);
  }

  if (content.riskItems && content.riskItems.length > 0) {
    const meta = { company: content.companyName || "", period: content.periodLabel, date };
    try {
      const { buildRiskXlsx } = await import("@/lib/reportXlsx");
      const xlsx = await buildRiskXlsx(content.riskItems, meta);
      attachments.push({ filename: `위험성평가표_${date}.xlsx`, content: xlsx, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    } catch (e) {
      console.error("위험성평가표 엑셀 생성 실패, CSV로 대체:", e);
      attachments.push({ filename: `위험성평가표_${date}.csv`, content: buildRiskCsv(content.riskItems, meta), contentType: "text/csv;charset=utf-8" });
    }
  }

  return attachments;
}

export async function generateAndSendReport(
  admin: SupabaseClient,
  sub: ReportSubscription,
  year: number,
  month: number,
  opts: { companyName?: string | null; force?: boolean } = {}
): Promise<GenerateResult> {
  const recipients = (sub.report_recipients || []).filter((e) => e && e.includes("@"));
  if (recipients.length === 0) return { status: "no_recipients" };

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
  if (content.stats.total === 0) return { status: "no_data" };

  const token = existing?.token || randomUUID();

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

  if (!mailerConfigured()) return { status: "mail_failed", token, detail: "메일 미설정" };
  const today = new Date().toISOString().slice(0, 10);
  const docTitle = `${content.companyName ? content.companyName + " " : ""}${year}년 ${month}월 TBM 회의록 종합분석 결재 보고서`;
  const attachments = await buildReportAttachments(content, docTitle, today);
  const sent = await sendMail({
    to: recipients,
    subject: `[안전톡톡e] ${content.companyName ? content.companyName + " " : ""}${year}년 ${month}월 TBM 회의록 분석 보고서`,
    html,
    attachments,
  });
  if (!sent.ok) return { status: "mail_failed", token, detail: sent.error };

  await admin
    .from("monthly_reports")
    .update({ sent_at: new Date().toISOString() })
    .eq("user_id", sub.user_id)
    .eq("period_year", year)
    .eq("period_month", month);

  return { status: "sent", token };
}

/**
 * 임의 기간(주간 등) 회의록 보고서를 즉시 발송 — monthly_reports 기록 없이.
 * 크론 주간 발송에서 사용. (월간은 generateAndSendReport 사용)
 */
export async function generateAndSendRangeReport(
  admin: SupabaseClient,
  userId: string,
  recipients: string[],
  companyName: string | null,
  fromDate: string,
  toDate: string
): Promise<GenerateResult> {
  const valid = recipients.filter((e) => e && e.includes("@"));
  if (valid.length === 0) return { status: "no_recipients" };
  if (!mailerConfigured()) return { status: "mail_failed", detail: "메일 미설정" };

  const content = await buildRangeContent(admin, userId, companyName, fromDate, toDate);
  if (content.stats.total === 0) return { status: "no_data" };

  const html = renderReportHtml(content);
  const today = new Date().toISOString().slice(0, 10);
  const docTitle = `${content.companyName ? content.companyName + " " : ""}${content.periodLabel} TBM 회의록 종합분석 결재 보고서`;
  const attachments = await buildReportAttachments(content, docTitle, today);
  const sent = await sendMail({
    to: valid,
    subject: `[안전톡톡e] ${content.companyName ? content.companyName + " " : ""}TBM 회의록 분석 보고서 (${content.periodLabel})`,
    html,
    attachments,
  });
  if (!sent.ok) return { status: "mail_failed", detail: sent.error };
  return { status: "sent" };
}

/** 직전 월 (year, month) 반환 — 크론이 매월 1일 실행될 때 사용 */
export function previousMonth(now: Date): { year: number; month: number } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  if (m === 1) return { year: y - 1, month: 12 };
  return { year: y, month: m - 1 };
}
