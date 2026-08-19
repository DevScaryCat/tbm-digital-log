// lib/monthlyReport.ts — TBM 회의록 종합분석 보고서 (월간/기간 공용 단일 템플릿)
// 위험요인은 TBM 회의록(tbm_minutes)에서만 집계. 위험성평가표(riskItems)가 있으면 주요 위험요인 아래에 엑셀표로 추가.
import { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { sendMail, mailerConfigured } from "@/lib/mailer";
import { formatRangeLabelKo } from "@/lib/utils";
import type { AiBatch } from "@/lib/aiBatch";
import type { EducationReportContent } from "@/lib/educationReport";
import { hazardKey, mergeContainedKeys, tallyHazardWords } from "@/lib/hazardKey";
import { escapeHtml } from "@/lib/htmlEscape";

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
  /** 회의에서 언급된 위험 총 건수 = 상+중+하. 등급별 수와 혼동하면 총평이 틀린다 */
  mentioned?: number;
  low?: number; // 위험성(하)
  /** 여러 TBM에서 반복 등장한 위험 건수 */
  recurring?: number;
}

export interface HazardRow {
  factor: string;
  level: "상" | "중" | "하";
  measure: string;
  process: string;
  date: string;
  /** 같은 위험요인이 몇 번 언급됐는가 — 표 병합 후의 '×N회 언급' 표기용 */
  count?: number;
}

/** 위험요인 분석 항목 (주요 위험요인 아래 표) — 등급 산정 없는 정보성 기록 */
export interface RiskItem {
  hazard: string;
  cause: string;
  measures: string;
  recurring?: boolean;
}

/**
 * 클라이언트가 보낸 items를 신뢰하지 않고 타입을 강제한다.
 * 임의 값이 그대로 HTML/메일에 삽입되면 마크업 주입이 가능하다(D-11).
 * String으로 정규화해 API 경계에서 차단하고, 등급 계열 필드(level/frequency/severity/risk)는 버린다.
 */
export function sanitizeRiskItems(input: unknown): RiskItem[] {
  if (!Array.isArray(input)) return [];
  return input.map((x: any) => ({
    hazard: String(x?.hazard ?? ""),
    cause: String(x?.cause ?? ""),
    measures: String(x?.measures ?? ""),
    recurring: x?.recurring === true,
  }));
}

/** 기간 내 접수된 근로자 의견 1건 — 서명 페이지에서 직접 제출된 원문 */
export interface SuggestionRow {
  content: string;
  /** 실명 제출 시에만 값이 있다. null이면 렌더에서 '익명'으로 표기 — 이름을 지어내지 않는다 */
  authorName: string | null;
  /** 접수일 (KST, YYYY-MM-DD) */
  date: string;
  /** 연결된 회의록의 날짜 — 기간 내 회의록에 연결된 경우에만 */
  docDate?: string;
  /** 통합(여러 현장) 보고서에서만 채워지는 현장명 */
  site?: string;
}

export interface ReportContent {
  companyName: string | null;
  periodLabel: string;
  stats: ReportStats;
  keywords: { word: string; count: number }[];
  hazards: HazardRow[];
  aiSummary: string;
  riskItems?: RiskItem[];
  /** 기간 내 접수된 근로자 의견 — 산안법 근로자 의견청취 기록. 0건이면 렌더에서 섹션 자체 생략 */
  suggestions?: SuggestionRow[];
  /** 통합(여러 현장 병합) 보고서의 현장별 소계 — 있으면 렌더에 '현장별 요약' 섹션 표시 */
  sites?: { name: string; total: number; high: number; mid: number }[];
  /** 지난달보다 나아진 항목만 — 없으면 섹션 미표시.
   *  나빠진 항목은 절대 넣지 않는다: 부정 표시는 가라 기록을 유인한다 (제품 원칙). */
  improvements?: { label: string; detail: string }[];
}

/**
 * monthly_reports.content 에 저장되는 형태 — 회의록 종합(ReportContent) + 선택적 교육일지 종합.
 *
 * ReportContent를 그대로 넓힌 것이라 **기존 행이 그대로 유효하다**: education이 없는 행은
 * 예전과 똑같이 회의록 보고서로만 렌더된다. 반대로 교육일지만 쓰는 계정은 stats.total === 0 이고
 * education만 채워진다 — 회의록이 0건이라는 이유로 행 자체가 안 생기던 공백을 메우기 위함
 * (실고객 이현로지스 안성센터: 2026-07 교육일지 26건인데 monthly_reports 0행).
 * 뷰어는 "회의록 0건이면 회의록 섹션을 생략"하는 규칙으로 두 경우를 모두 처리한다.
 */
export type StoredMonthlyContent = ReportContent & { education?: EducationReportContent | null };

import { accidentTypeTop, agentTop } from "./koshaTaxonomy";

const pad = (n: number) => String(n).padStart(2, "0");


/** 표시용 위험요인 병합 — 같은 위험요인을 한 줄로 합치고 언급 횟수를 센다.
 *  종전에는 회의록 수만큼 같은 줄이 반복돼 표가 중첩됐다(2026-08-16 Chris 확인 — "1개에서
 *  합집합된 것도 합산되어 들어가는"). 통계(mentioned·high·mid)는 언급 횟수 기준 그대로 두고
 *  **표만** 합친다 — "몇 번 언급됐는가"는 정보고, 같은 줄 반복은 소음이다. */

/** 같은 위험요인 두 행을 하나로 — 등급은 더 높은 쪽, 대책은 그 등급의 것을 남긴다 */
function mergeHazard(target: HazardRow, src: HazardRow): void {
  target.count = (target.count ?? 1) + (src.count ?? 1);
  if (rankOf(src.level) > rankOf(target.level)) {
    target.level = src.level;
    // 등급이 더 높은 쪽의 대책을 채택한다 — 최악의 경우에 맞춘 조치가 남아야 한다
    if (src.measure) target.measure = src.measure;
  } else if (!target.measure && src.measure) {
    target.measure = src.measure;
  }
  if (src.date && (!target.date || src.date > target.date)) target.date = src.date;
  if (!target.process && src.process) target.process = src.process;
}

/**
 * 위험요인 병합. 키는 **정규화한 요인 문구 하나**다.
 * 종전 키는 `요인|등급|대책`이라 같은 위험도 대책 문구가 조금만 달라지면 별개 행이 됐고,
 * 그 중복이 아래 재해유형·기인물 집계까지 부풀렸다(2026-08-19 수정). 병합 규칙은 lib/hazardKey.ts.
 */
function dedupeHazards(items: HazardRow[], limit: number): HazardRow[] {
  const grouped = new Map<string, HazardRow>();
  for (const it of items) {
    const key = hazardKey(it.factor) || it.factor;
    const g = grouped.get(key);
    if (g) mergeHazard(g, it);
    else grouped.set(key, { ...it, count: 1 });
  }
  mergeContainedKeys(grouped, mergeHazard);
  return [...grouped.values()]
    .sort((a, b) => rankOf(b.level) - rankOf(a.level) || (b.count ?? 1) - (a.count ?? 1))
    .slice(0, limit);
}

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

  // 표기만 다른 같은 요인은 한 낱말로 — 안 합치면 "분전함 감전 위험"이 표기 차이로 갈라져
  // 키워드 칩이 같은 말을 두 번 보여주고 '반복 지적' 수도 어긋난다(2026-08-19).
  const keywords = tallyHazardWords(items.map((it) => it.factor), 8);

  const high = items.filter((it) => it.level === "상").length;
  const mid = items.filter((it) => it.level === "중").length;
  const hazards = dedupeHazards(items, 30);

  const low = items.filter((it) => it.level === "하").length;
  // 같은 문구가 2회 이상 나온 것 = 반복 지적된 위험 (우선 관리 대상)
  const recurringCount = keywords.filter((k) => k.count > 1).length;
  const stats: ReportStats = { total: minuteRows.length, high, mid, low, mentioned: items.length, recurring: recurringCount };
  // 회의록 0건이면 총평의 근거가 없다 — 호출 자체를 하지 않는다(AI는 유료). 호출자는 어차피 no_data로 끝낸다.
  const aiSummary = stats.total > 0 ? await generateAISummary(companyName, periodLabel, stats, keywords) : "";

  return { companyName, periodLabel, stats, keywords, hazards, aiSummary };
}

/** 여러 현장(계정)을 합친 통합 회의록 콘텐츠 — 현장별 소계 + 지난달 대비 개선 포함 (월간 전용) */
export async function buildMergedMinutesContent(
  admin: SupabaseClient,
  accounts: { userId: string; siteName: string }[],
  year: number,
  month: number,
  companyName: string | null,
  aiBatch?: AiBatch
): Promise<ReportContent> {
  const from = `${year}-${pad(month)}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const to = `${year}-${pad(month)}-${pad(lastDay)}`;
  return buildMergedMinutesForRange(admin, accounts, from, to, `${year}년 ${month}월`, companyName, { year, month }, aiBatch);
}

/**
 * 여러 현장 통합 회의록 콘텐츠 — 임의 기간(fromDate~toDate). 주간/월간 공용.
 * monthCtx가 주어지면 '지난달 대비 개선'을 계산(월간 전용). 주간은 생략한다.
 */
export async function buildMergedMinutesForRange(
  admin: SupabaseClient,
  accounts: { userId: string; siteName: string }[],
  from: string,
  to: string,
  periodLabel: string,
  companyName: string | null,
  monthCtx?: { year: number; month: number },
  aiBatch?: AiBatch
): Promise<ReportContent> {
  const items: HazardRow[] = [];
  const sites: { name: string; total: number; high: number; mid: number }[] = [];
  const suggestions: SuggestionRow[] = [];
  let totalMinutes = 0;
  const curDays = new Set<string>();
  // created_at(timestamptz)을 KST 날짜로 — 보고서의 기간·날짜 표기가 전부 KST 기준이다
  const kstDate = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

  for (const acc of accounts) {
    const { data: minutes } = await admin
      .from("tbm_minutes")
      .select("id, date, hazards, work_name, process_name")
      .eq("user_id", acc.userId)
      .gte("date", from)
      .lte("date", to);
    const rows = (minutes as any[]) || [];
    totalMinutes += rows.length;
    // 의견의 '연결 회의록 날짜' 역참조용 — 이미 가져온 회의록에서 만들므로 추가 조회가 없다
    const minuteDateById = new Map<string, string>();
    for (const m of rows) if (m.id && m.date) minuteDateById.set(String(m.id), String(m.date));
    let sHigh = 0;
    let sMid = 0;
    for (const m of rows) {
      if (m.date) curDays.add(String(m.date));
      const hs = Array.isArray(m.hazards) ? m.hazards : [];
      for (const h of hs) {
        const factor = String(h?.factor ?? "").trim();
        if (!factor) continue;
        const level = gradeOf(h?.level);
        if (level === "상") sHigh++;
        else if (level === "중") sMid++;
        const proc = m.process_name || m.work_name || "";
        items.push({
          factor,
          level,
          measure: String(h?.measure ?? "").trim(),
          process: proc ? `${acc.siteName} · ${proc}` : acc.siteName,
          date: m.date || "",
        });
      }
    }
    sites.push({ name: acc.siteName, total: rows.length, high: sHigh, mid: sMid });

    // 기간 내 접수된 근로자 의견 — 계정당 1쿼리(크론 부하 상한). 접수 시각은 KST 기간 경계로 자른다.
    // 실패는 비치명: 의견 섹션만 빠지고 보고서 본체는 그대로 나간다.
    try {
      const { data: sugg, error: sErr } = await admin
        .from("worker_suggestions")
        .select("content, author_name, created_at, doc_type, doc_id")
        .eq("user_id", acc.userId)
        .gte("created_at", `${from}T00:00:00+09:00`)
        .lte("created_at", `${to}T23:59:59.999+09:00`)
        .order("created_at", { ascending: true });
      if (sErr) {
        console.error("report suggestions query error:", acc.userId, sErr);
      } else {
        for (const sg of (sugg as any[]) || []) {
          const content = String(sg?.content ?? "").trim();
          if (!content) continue;
          const authorName = typeof sg?.author_name === "string" && sg.author_name.trim() ? sg.author_name.trim() : null;
          const docDate = sg?.doc_type === "minute" && sg?.doc_id ? minuteDateById.get(String(sg.doc_id)) : undefined;
          suggestions.push({
            content,
            authorName,
            date: sg?.created_at ? kstDate(String(sg.created_at)) : "",
            ...(docDate ? { docDate } : {}),
            // 현장명은 통합 보고서에서만 의미가 있다 — 단일 현장은 표기 안 함
            ...(accounts.length > 1 ? { site: acc.siteName } : {}),
          });
        }
      }
    } catch (e) {
      console.error("report suggestions query error:", acc.userId, e);
    }
  }

  // 표기만 다른 같은 요인은 한 낱말로 — 안 합치면 "분전함 감전 위험"이 표기 차이로 갈라져
  // 키워드 칩이 같은 말을 두 번 보여주고 '반복 지적' 수도 어긋난다(2026-08-19).
  const keywords = tallyHazardWords(items.map((it) => it.factor), 8);
  const high = items.filter((it) => it.level === "상").length;
  const mid = items.filter((it) => it.level === "중").length;
  const hazards = dedupeHazards(items, 40);
  const low = items.filter((it) => it.level === "하").length;
  const recurringCount = keywords.filter((k) => k.count > 1).length;
  const stats: ReportStats = { total: totalMinutes, high, mid, low, mentioned: items.length, recurring: recurringCount };
  const improvements = monthCtx
    ? await computeImprovements(admin, accounts, monthCtx.year, monthCtx.month, { total: totalMinutes, days: curDays.size, high })
    : [];

  const content: ReportContent = { companyName, periodLabel, stats, keywords, hazards, aiSummary: "", sites, improvements, suggestions };
  // 회의록 0건이면 총평을 만들 근거가 없다 — 배치 예약조차 하지 않는다. 예약만 해도 요금이 나가는데,
  // 크론의 단독 경로는 0건 계정에도 이 함수를 호출한다(교육일지만 쓰는 계정).
  if (stats.total === 0) return content;
  if (aiBatch && process.env.ANTHROPIC_API_KEY) {
    // 크론 경로: 총평 생성을 배치로 미룬다 — flush()가 content.aiSummary를 채운 뒤 렌더된다
    aiBatch.defer({
      params: summaryRequestParams(companyName, periodLabel, stats, keywords),
      apply: (msg) => { content.aiSummary = summaryFromMessage(msg); },
      fallback: async () => { content.aiSummary = await generateAISummary(companyName, periodLabel, stats, keywords); },
    });
  } else {
    content.aiSummary = await generateAISummary(companyName, periodLabel, stats, keywords);
  }
  return content;
}

/**
 * 지난달 대비 '나아진 항목만' 계산 — 나빠진 항목은 절대 만들지 않는다.
 * 부정 지표를 보여주면 기록을 부풀리는(가라) 유인이 생긴다는 제품 원칙.
 * 지난달 기록이 아예 없으면(첫 달) 비교 대상이 없으므로 빈 배열.
 */
async function computeImprovements(
  admin: SupabaseClient,
  accounts: { userId: string; siteName: string }[],
  year: number,
  month: number,
  cur: { total: number; days: number; high: number }
): Promise<{ label: string; detail: string }[]> {
  let py = year, pm = month - 1;
  if (pm === 0) { pm = 12; py -= 1; }
  const pFrom = `${py}-${pad(pm)}-01`;
  const pLast = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const pTo = `${py}-${pad(pm)}-${pad(pLast)}`;

  let prevTotal = 0;
  let prevHigh = 0;
  const prevDays = new Set<string>();
  try {
    for (const acc of accounts) {
      const { data, error } = await admin
        .from("tbm_minutes")
        .select("date, hazards")
        .eq("user_id", acc.userId)
        .gte("date", pFrom)
        .lte("date", pTo);
      // supabase-js는 실패 시 throw하지 않고 error를 돌려준다 — 한 현장이라도 조회에 실패하면
      // 지난달 합계가 실제보다 작아져 가짜 '개선'이 만들어지므로 섹션을 통째로 포기한다.
      if (error) {
        console.error("improvements prev-month query error:", acc.userId, error);
        return [];
      }
      for (const m of (data as any[]) || []) {
        prevTotal++;
        if (m.date) prevDays.add(String(m.date));
        const hs = Array.isArray(m.hazards) ? m.hazards : [];
        for (const h of hs) {
          if (String(h?.factor ?? "").trim() && gradeOf(h?.level) === "상") prevHigh++;
        }
      }
    }
  } catch (e) {
    console.error("improvements prev-month query error:", e);
    return []; // 비교 실패는 비치명 — 섹션만 생략
  }
  if (prevTotal === 0) return [];

  const out: { label: string; detail: string }[] = [];
  if (cur.total > prevTotal) {
    out.push({ label: "회의록 작성", detail: `${prevTotal}건 → ${cur.total}건 (+${cur.total - prevTotal}건)` });
  }
  if (cur.days > prevDays.size) {
    out.push({ label: "기록한 날", detail: `${prevDays.size}일 → ${cur.days}일` });
  }
  // 위험성 '상' 감소는 기록량이 줄지 않았을 때만 개선으로 친다 — 기록을 덜 써서 줄어든 건 개선이 아니다
  if (cur.total >= prevTotal && cur.high < prevHigh) {
    out.push({ label: "위험성 '상' 감소", detail: `${prevHigh}건 → ${cur.high}건 (-${prevHigh - cur.high}건)` });
  }
  return out;
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

/** 총평 요청 파라미터 — 동기 호출과 배치(AiBatch) 경로가 같은 프롬프트를 쓰도록 단일 출처 */
function summaryRequestParams(
  companyName: string | null,
  periodLabel: string,
  stats: ReportStats,
  keywords: { word: string; count: number }[]
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  const facts = [
    `현장/업체: ${companyName ?? "미상"}`,
    `대상 기간: ${periodLabel} (TBM 회의록 기준)`,
    `회의록 ${stats.total}건`,
    `회의에서 언급된 위험 총 ${stats.mentioned ?? stats.high + stats.mid}건 = 상 ${stats.high}건 + 중 ${stats.mid}건 + 하 ${stats.low ?? 0}건`,
    stats.recurring ? `여러 회의에서 반복 언급된 위험 ${stats.recurring}건` : "",
    `자주 논의된 위험요인: ${keywords.map((k) => `${k.word}(${k.count})`).join(", ") || "없음"}`,
  ].join("\n");
  return {
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
      "- 총 건수와 등급별 건수를 절대 섞지 마세요. '총 N건'은 상+중+하 합계이고, '상 N건'은 그중 상 등급만입니다.",
      "- 이 집계는 TBM에서 '언급·지적된' 위험이지 위험성평가 결과가 아닙니다. '평가되었다'가 아니라 '언급되었다/지적되었다'로 쓰세요.",
    ].join("\n"),
    messages: [{ role: "user", content: facts }],
  };
}

function summaryFromMessage(msg: Anthropic.Message): string {
  const raw = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
  return sanitizeSummary(raw);
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
    const msg = await anthropic.messages.create(summaryRequestParams(companyName, periodLabel, stats, keywords));
    return summaryFromMessage(msg);
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

/** 위험요인 분석 표 섹션 (주요 위험요인 아래) — 등급·점수 없이 정보성 항목만 */
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
        <td style="padding:8px 6px;border-bottom:1px solid #eee;font-size:12px;color:#444;">${escapeHtml(it.measures) || "-"}</td>
      </tr>`
    )
    .join("");
  return `
      <div style="font-size:15px;font-weight:700;margin:22px 0 10px;">위험요인 분석</div>
      ${recurring ? `<div style="background:#f54e000d;border:1px solid #f54e0033;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#c2410c;">반복 위험요인 ${recurring}건 — 여러 TBM에서 반복 등장, 우선 관리 대상</div>` : ""}
      <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e6e5e0;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#f4f3ee;color:#807d72;font-size:12px;">
            <th style="padding:8px 6px;text-align:center;width:34px;">No</th>
            <th style="padding:8px 6px;text-align:left;">유해·위험요인 / 원인</th>
            <th style="padding:8px 6px;text-align:left;">감소대책</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
}

/**
 * 근로자 의견 섹션 — 기간 내 서명 페이지에서 직접 접수된 원문.
 * 산안법 근로자 의견청취 기록 관점의 데이터라 원문 그대로 싣는다(요약·가공 없음).
 * 0건이면 빈 문자열(섹션 자체 생략). 익명 제출이 기본 — author_name 없으면 '익명'.
 */
function suggestionsTableHtml(items: SuggestionRow[]): string {
  if (!items || items.length === 0) return "";
  const MAX = 50; // 메일 본문 비대 방지 — 잘리면 아래에 '외 N건' 안내
  const shown = items.slice(0, MAX);
  const rows = shown
    .map((sg, i) => {
      const metaBits = [sg.site, sg.date].filter(Boolean).map((s) => escapeHtml(String(s)));
      return `
      <tr style="vertical-align:top;">
        <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:center;color:#999;font-size:12px;">${i + 1}</td>
        <td style="padding:8px 6px;border-bottom:1px solid #eee;">
          <div style="font-size:13px;color:#26251e;line-height:1.6;">${escapeHtml(sg.content)}</div>
          ${metaBits.length ? `<div style="font-size:11px;color:#999;margin-top:2px;">${metaBits.join(" · ")}</div>` : ""}
        </td>
        <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:center;font-size:12px;color:${sg.authorName ? "#26251e" : "#999"};white-space:nowrap;">${sg.authorName ? escapeHtml(sg.authorName) : "익명"}</td>
        <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:center;font-size:12px;color:#555;white-space:nowrap;">${sg.docDate ? escapeHtml(sg.docDate) : "-"}</td>
      </tr>`;
    })
    .join("");
  return `
      <div style="font-size:15px;font-weight:700;margin:22px 0 4px;">근로자 의견 (${items.length}건)</div>
      <div style="font-size:12px;color:#807d72;margin-bottom:12px;">근로자가 서명 시 직접 제출한 의견 원문입니다 — 근로자 의견 청취 기록으로 활용하세요.</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e6e5e0;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#f4f3ee;color:#807d72;font-size:12px;">
            <th style="padding:8px 6px;text-align:center;width:34px;">No</th>
            <th style="padding:8px 6px;text-align:left;">의견 내용</th>
            <th style="padding:8px 6px;text-align:center;width:72px;">제출자</th>
            <th style="padding:8px 6px;text-align:center;width:86px;">연결 회의록</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${items.length > MAX ? `<div style="font-size:12px;color:#807d72;margin-top:8px;">외 ${items.length - MAX}건 — 전체는 앱의 의견·제안함에서 확인할 수 있습니다.</div>` : ""}`;
}

/** 이메일/공개페이지용 HTML 본문 (월간·위험성평가 공용 단일 템플릿) */
export function renderReportHtml(content: ReportContent, viewUrl?: string): string {
  const { companyName, periodLabel } = content;
  const stats = content.stats || ({ total: 0, high: 0, mid: 0 } as ReportStats);
  const keywords = content.keywords || [];
  const hazards = content.hazards || [];
  const aiSummary = content.aiSummary || "";
  const riskItems = content.riskItems || [];
  // 주요 위험요인 요약·통계는 항상 회의록(hazards/stats)에서. 위험요인 분석(riskItems)은
  // 등급 없는 정보성 표라 요약·통계 파생에 쓰지 않는다.
  const summaryItems = hazards;
  const displayStats = stats;
  // 총 언급 건수는 저장된 값이 우선 — 없는 구버전 콘텐츠는 등급 합으로 되짚는다
  const mentioned = stats.mentioned ?? stats.high + stats.mid + (stats.low ?? 0);
  // 메일 클라이언트는 로컬 경로를 못 읽는다 — 절대 URL이어야 뜬다. 주소를 못 만들면 로고를 빼고
  // 글자만 남긴다(깨진 이미지 아이콘이 보고서 맨 아래 남는 것보다 낫다).
  const base = appBaseUrl();
  const logoImg = base
    ? `<img src="${base}/brand/antok-icon-256.png" alt="안톡" width="28" height="28" style="width:28px;height:28px;border-radius:6px;display:inline-block;" />`
    : `<div style="font-size:13px;font-weight:700;color:#f54e00;">안톡</div>`;
  const recurringCount = stats.recurring ?? (content.riskItems || []).filter((r) => r.recurring).length;

  // 지난달보다 나아진 점 — 개선 항목만 (없거나 첫 달이면 섹션 자체가 없다)
  const improvements = content.improvements || [];
  const improvementsSection =
    improvements.length > 0
      ? `<div style="background:#e7f6ee;border:1px solid #bfe6d2;border-radius:10px;padding:16px;margin-bottom:20px;">
          <div style="font-size:13px;font-weight:700;color:#1f8a65;margin-bottom:8px;">↑ 지난달보다 나아진 점</div>
          ${improvements
            .map(
              (im) =>
                `<div style="font-size:14px;color:#26251e;line-height:1.9;"><span style="color:#1f8a65;font-weight:700;">✓</span> ${escapeHtml(im.label)} <span style="font-weight:700;">${escapeHtml(im.detail)}</span></div>`
            )
            .join("")}
        </div>`
      : "";

  // 통합(여러 현장 병합) 보고서면 현장별 소계 섹션
  const sites = content.sites || [];
  const sitesSection =
    sites.length > 1
      ? `<div style="font-size:15px;font-weight:700;margin:0 0 10px;">현장별 요약</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e6e5e0;border-radius:8px;overflow:hidden;margin-bottom:20px;">
        <thead><tr style="background:#f4f3ee;color:#807d72;font-size:12px;">
          <th style="padding:8px 10px;text-align:left;">현장</th>
          <th style="padding:8px 6px;text-align:center;width:60px;">회의록</th>
          <th style="padding:8px 6px;text-align:center;width:48px;">상</th>
          <th style="padding:8px 6px;text-align:center;width:48px;">중</th>
        </tr></thead>
        <tbody>${sites
          .map(
            (s) => `<tr>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;font-weight:600;color:#26251e;">${escapeHtml(s.name)}</td>
          <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:center;color:#555;">${s.total}건</td>
          <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:center;color:#cf2d56;font-weight:700;">${s.high}</td>
          <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:center;color:#d4691a;font-weight:700;">${s.mid}</td>
        </tr>`
          )
          .join("")}</tbody>
      </table>`
      : "";

  // 키워드 칩은 '주요 위험요인' 표를 한 번 더 보여주는 것에 지나지 않았다(Chris).
  // 대신 재해유형·기인물로 묶어 "무엇 때문에 어떻게 다칠 위험이 언급됐나"를 보여준다.
  // ⚠️ riskItems를 여기 함께 넣지 말 것 — 그것은 **같은 회의록 위험요인을 AI가 다시 묶어
  // 쓴 것**이라, 합쳐 세면 모든 위험이 두 번 계산돼 막대가 통째로 부풀었다
  // (2026-08-19 Chris "기인물도 중첩되서 나오더라"). 승인용 PDF(approvalPdf)는 처음부터
  // hazards만 썼다 — 이제 두 문서의 집계가 같아진다.
  // 회의록이 없어 hazards가 빈 보고서에서만 riskItems로 대신한다.
  const hazardTexts =
    hazards.length > 0 ? hazards.map((h) => h.factor) : riskItems.map((r) => `${r.hazard} ${r.cause}`);
  const typeTop = accidentTypeTop(hazardTexts, 5);
  const agentTopList = agentTop(hazardTexts, 5);
  const maxOf = (rows: { count: number }[]) => Math.max(1, ...rows.map((r) => r.count));
  const tallyTable = (title: string, rows: { name: string; count: number }[]): string => {
    if (rows.length === 0) return "";
    const max = maxOf(rows);
    return `
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;margin-bottom:8px;color:#26251e;">${escapeHtml(title)}</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          ${rows
            .map(
              (r) => `<tr>
            <td style="padding:5px 0;color:#26251e;white-space:nowrap;">${escapeHtml(r.name)}</td>
            <td style="padding:5px 8px;width:100%;">
              <div style="background:#f1f0ea;border-radius:9999px;height:6px;">
                <div style="background:#f54e00;border-radius:9999px;height:6px;width:${Math.round((r.count / max) * 100)}%;"></div>
              </div>
            </td>
            <td style="padding:5px 0;text-align:right;color:#807d72;white-space:nowrap;">${r.count}건</td>
          </tr>`
            )
            .join("")}
        </table>
      </div>`;
  };

  const hazardRows =
    summaryItems.length > 0
      ? summaryItems
          .map(
            (h, i) =>
              `<tr style="vertical-align:top;">
                <td style="border-bottom:1px solid #eee;padding:8px 6px;text-align:center;color:#999;font-size:12px;">${i + 1}</td>
                <td style="border-bottom:1px solid #eee;padding:8px 6px;">
                  <div style="font-weight:600;color:#26251e;font-size:13px;">${escapeHtml(h.factor)}${(h.count ?? 1) > 1 ? ` <span style="font-weight:700;color:#c2410c;font-size:11px;">×${h.count}회 언급</span>` : ""}</div>
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
      <div style="font-size:12px;font-weight:700;color:#f54e00;letter-spacing:.2px;">안톡 · TBM 회의록 AI 분석</div>
      <div style="color:#26251e;font-size:24px;font-weight:700;margin-top:8px;letter-spacing:-0.5px;">${escapeHtml(periodLabel)}</div>
      ${companyName ? `<div style="color:#807d72;font-size:14px;margin-top:3px;">${escapeHtml(companyName)}</div>` : ""}
    </div>
    <div style="padding:24px;background:#fff;">

      <!-- 이 보고서의 성격을 맨 앞에서 못 박는다: AI가 회의록에서 '언급된' 위험을 정리한 것이지
           위험성평가가 아니다. 이 구분이 흐려지면 법정 평가를 대체한 것처럼 읽힌다. -->
      <div style="border:1px solid #e6e5e0;background:#fafaf7;border-radius:10px;padding:14px 16px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:700;color:#26251e;margin-bottom:6px;">이 문서는 AI가 정리한 참고 자료입니다 — 위험성평가가 아닙니다</div>
        <div style="font-size:13px;line-height:1.7;color:#5a5852;">
          아래 내용은 해당 기간 TBM 회의록에서 <b>현장 근로자가 실제로 언급한 위험</b>을 AI가 모아 정리한 것입니다.
          법에서 정한 위험성평가는 이 자료를 출발점으로 삼아, <b>현장 확인과 근로자 면담</b>을 통해 별도로 진행해 주세요.
        </div>
      </div>

      <table style="width:100%;border-collapse:separate;border-spacing:6px;margin:-6px 0 18px;text-align:center;">
        <tr>
          <td style="width:25%;background:#fff;border:1px solid #e6e5e0;border-radius:8px;padding:12px 4px;">
            <div style="font-size:11px;color:#807d72;margin-bottom:4px;">총 회의록</div>
            <div style="font-size:20px;font-weight:700;color:#26251e;">${stats.total}<span style="font-size:12px;color:#888;margin-left:2px;">건</span></div>
          </td>
          <td style="width:25%;background:#fff;border:1px solid #e6e5e0;border-radius:8px;padding:12px 4px;">
            <div style="font-size:11px;color:#807d72;margin-bottom:4px;">언급된 위험</div>
            <div style="font-size:20px;font-weight:700;color:#26251e;">${mentioned}<span style="font-size:12px;color:#888;margin-left:2px;">건</span></div>
          </td>
          <td style="width:25%;background:#fdecef;border:1px solid #f6cdd6;border-radius:8px;padding:12px 4px;">
            <div style="font-size:11px;color:#cf2d56;margin-bottom:4px;">고위험(상)</div>
            <div style="font-size:20px;font-weight:700;color:#cf2d56;">${displayStats.high}<span style="font-size:12px;margin-left:2px;">건</span></div>
          </td>
          <td style="width:25%;background:#fff1e3;border:1px solid #ffd9b3;border-radius:8px;padding:12px 4px;">
            <div style="font-size:11px;color:#d4691a;margin-bottom:4px;">반복 언급</div>
            <div style="font-size:20px;font-weight:700;color:#d4691a;">${recurringCount}<span style="font-size:12px;margin-left:2px;">건</span></div>
          </td>
        </tr>
      </table>

      ${improvementsSection}

      ${sitesSection}

      ${
        aiSummary
          ? `<div style="background:#fafaf7;border:1px solid #eee;border-radius:10px;padding:16px;margin-bottom:20px;">
              <div style="font-size:13px;font-weight:700;color:#f54e00;margin-bottom:8px;">AI 안전 총평</div>
              <div style="font-size:14px;line-height:1.7;color:#444;white-space:pre-line;">${escapeHtml(aiSummary)}</div>
            </div>`
          : ""
      }

      ${
        typeTop.length > 0 || agentTopList.length > 0
          ? `<div style="font-size:15px;font-weight:700;margin-bottom:4px;">무엇이, 어떻게 — 언급된 위험의 분포</div>
             <div style="font-size:12px;color:#807d72;margin-bottom:12px;">회의에서 언급된 문구를 재해유형·기인물로 묶은 것입니다.</div>
             <div style="display:flex;gap:20px;margin-bottom:22px;">
               ${tallyTable("재해유형 TOP 5", typeTop)}
               ${tallyTable("기인물 TOP 5", agentTopList)}
             </div>`
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

      ${suggestionsTableHtml(content.suggestions || [])}

      ${
        viewUrl
          ? `<div style="text-align:center;margin-top:24px;">
              <a href="${viewUrl}" style="display:inline-block;background:#26251e;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;">보고서 전체 보기</a>
            </div>`
          : ""
      }
      <div style="margin-top:28px;padding-top:18px;border-top:1px solid #eee;text-align:center;">
        ${logoImg}
        <div style="font-size:12px;color:#999;margin-top:8px;line-height:1.6;">
          본 보고서는 안톡이 ${escapeHtml(periodLabel)} TBM 회의록을 AI로 분석해 자동 생성한 참고 자료입니다.<br/>
          작성된 회의록에서 언급된 내용만 집계되며, 법정 위험성평가를 대신하지 않습니다.
        </div>
      </div>
    </div>
    </div>
  </div>`;
}

// escapeHtml 본체는 lib/htmlEscape.ts로 이동(2026-08-19) — 이 파일을 import하면
// Anthropic SDK·nodemailer까지 딸려와 가벼운 라우트 번들을 오염시킨다. 재수출은 하위 호환용.
export { escapeHtml };

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

/** 위험요인 분석 → 엑셀(CSV) 문자열. BOM 포함(한글 깨짐 방지). */
export function buildRiskCsv(
  items: RiskItem[],
  meta: { company: string; period: string; date: string }
): string {
  const header = ["No", "반복", "유해·위험요인", "발생 원인", "감소대책"];
  const rows = items.map((it, i) => [i + 1, it.recurring ? "반복" : "", it.hazard, it.cause, it.measures]);
  const top = [["위험요인 분석"], ["현장/업체", meta.company || "-", "대상기간", meta.period, "작성일", meta.date], [], header, ...rows];
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
      attachments.push({ filename: `위험요인분석_${date}.xlsx`, content: xlsx, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    } catch (e) {
      console.error("위험요인 분석 엑셀 생성 실패, CSV로 대체:", e);
      attachments.push({ filename: `위험요인분석_${date}.csv`, content: buildRiskCsv(content.riskItems, meta), contentType: "text/csv;charset=utf-8" });
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
    .select("id, token, sent_at, content")
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
  // 같은 행(user_id, year, month)은 크론이 '회의록 종합 + 교육일지 종합'을 함께 담는다.
  // 여기서 회의록만 통째로 덮어쓰면 뷰어의 교육 섹션이 조용히 사라진다 — 기존 education을 보존한다.
  const prevEdu = (existing?.content as StoredMonthlyContent | null)?.education;
  const stored: StoredMonthlyContent = prevEdu ? { ...content, education: prevEdu } : content;

  const { error: upErr } = await admin.from("monthly_reports").upsert(
    {
      user_id: sub.user_id,
      period_year: year,
      period_month: month,
      token,
      content: stored as any,
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
    subject: `[안톡] ${content.companyName ? content.companyName + " " : ""}${year}년 ${month}월 TBM 회의록 분석 보고서`,
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
    subject: `[안톡] ${content.companyName ? content.companyName + " " : ""}TBM 회의록 분석 보고서 (${content.periodLabel})`,
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
