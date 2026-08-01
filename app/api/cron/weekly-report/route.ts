// app/api/cron/weekly-report/route.ts — 주간 보고서 (매일 실행, report_weekday 요일에만 발송)
// report_send_weekly=true인 감독자/단독 계정 대상: 지난 7일(오늘 제외) 종합을 승인 수신처에 발송.
// 감독자는 본인+소속 현장 병합(월간 회사경로와 동일 기준), 단독은 본인만.
// 멱등 키(kind)에 ISO 발송일을 넣어 같은 주 재실행(?force=1) 중복을 막는다.
import { NextResponse } from "next/server";
import { getAdminClient, subscriptionAllows, isProPlan } from "@/lib/portone";
import { buildMergedMinutesForRange, renderReportHtml, buildReportAttachments } from "@/lib/monthlyReport";
import { buildMergedEducationForRange, renderEducationReportHtml, buildEducationAttachments } from "@/lib/educationReport";
import { mailerConfigured, sendMail } from "@/lib/mailer";
import { AiBatch } from "@/lib/aiBatch";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) { return run(request); }
export async function GET(request: Request) { return run(request); }

async function alreadySent(admin: SupabaseClient, email: string, year: number, month: number, kind: string) {
  const { data } = await admin
    .from("consolidated_report_sends")
    .select("recipient_email")
    .eq("recipient_email", email).eq("period_year", year).eq("period_month", month).eq("kind", kind)
    .maybeSingle();
  return !!data;
}
async function recordSent(admin: SupabaseClient, email: string, year: number, month: number, kind: string, count: number) {
  await admin.from("consolidated_report_sends").insert({ recipient_email: email, period_year: year, period_month: month, kind, account_count: count });
}

async function run(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const provided = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!cronSecret || provided !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const admin = getAdminClient();
    const now = new Date();
    const force = new URL(request.url).searchParams.get("force") === "1";

    const todayKST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    // KST 기준 요일 (0=일 .. 6=토) — todayKST(YYYY-MM-DD)를 UTC 정오로 파싱해 TZ 흔들림 없이 getUTCDay
    const [wy, wm, wd] = todayKST.split("-").map(Number);
    const kstWeekday = new Date(Date.UTC(wy, wm - 1, wd, 12)).getUTCDay();
    if (!mailerConfigured()) return NextResponse.json({ error: "메일 미설정" }, { status: 500 });

    // 지난 7일 [오늘-7, 오늘-1] (KST)
    const dayMs = 86400000;
    const kstMidnight = new Date(`${todayKST}T00:00:00+09:00`).getTime();
    const from = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(kstMidnight - 7 * dayMs));
    const to = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(kstMidnight - dayMs));
    const periodLabel = `${from} ~ ${to}`;
    // period_year/month는 발송월로 기록. 멱등 키(kind)는 계정 소유자 id를 포함해야 한다 —
    // 같은 원청 이메일을 두 회사가 승인했을 때 먼저 보낸 쪽만 나가는 교차 누락 방지 (월간 크론과 동일 교훈).
    const [py, pm] = todayKST.split("-").map(Number);

    // 주간 ON 계정 조회
    const { data: subs } = await admin
      .from("subscriptions")
      .select("user_id, plan, status, current_period_end, report_send_weekly, report_weekday")
      .eq("report_send_weekly", true)
      .limit(3000);

    const results = { candidates: 0, sent: 0, skipped: 0, failed: 0, today: todayKST, weekday: kstWeekday, period: periodLabel };

    // 2단계 구조: ① 대상별 콘텐츠 빌드(AI 요약은 배치에 예약) → ② 배치 1회 실행(50% 할인,
    // 실패·시간초과는 동기 폴백) → ③ 발송. 발송 지연·품질 저하 없이 요금만 아끼는 배치다.
    const aiBatch = new AiBatch();
    const sendJobs: Array<() => Promise<void>> = [];

    for (const s of (subs as any[]) || []) {
      if (!force && (s.report_weekday ?? 1) !== kstWeekday) continue;
      if (!isProPlan(s.plan) || !subscriptionAllows(s)) continue;
      // 소속 현장(member) 계정은 제외 — 발송 주체는 감독자/단독뿐. 멤버가 켜져 있어도
      // 감독자 병합본에 이미 포함되므로 개별 발송하면 이중이 된다(월간 orgLinked와 같은 취지).
      const { data: asMember } = await admin.from("org_members").select("member_user_id").eq("member_user_id", s.user_id).eq("status", "active").maybeSingle();
      if (asMember) continue;
      results.candidates++;

      // 멱등 키에 소유자 id 포함 — 여러 회사가 같은 수신자를 승인해도 각각 발송된다
      const kindMinutes = `weekly_minutes_${s.user_id}_${todayKST}`;
      const kindEdu = `weekly_education_${s.user_id}_${todayKST}`;

      // 발송 대상 현장 묶음 — 감독자면 본인+활성 소속, 아니면 본인
      const { data: ownOrg } = await admin.from("organizations").select("id, name").eq("owner_user_id", s.user_id).maybeSingle();
      const accounts: { userId: string; siteName: string }[] = [];
      let companyName: string | null = null;
      const labelOf = async (id: string, isOwner: boolean) => {
        try {
          const { data: u } = await admin.auth.admin.getUserById(id);
          const meta = (u?.user?.user_metadata ?? {}) as Record<string, any>;
          // 감독자의 company_name은 '회사명'이라 현장명으로 쓰면 안 된다 (월간 크론과 동일 규칙)
          return String(meta.site_name ?? "").trim() || (isOwner ? "본사 현장" : String(meta.company_name ?? "").trim()) || "현장";
        } catch { return "현장"; }
      };
      accounts.push({ userId: s.user_id, siteName: await labelOf(s.user_id, true) });
      if (ownOrg) {
        companyName = ownOrg.name;
        const { data: members } = await admin.from("org_members").select("member_user_id").eq("org_id", ownOrg.id).eq("status", "active");
        for (const m of (members as any[]) || []) accounts.push({ userId: m.member_user_id, siteName: await labelOf(m.member_user_id, false) });
      }

      // 승인 수신처
      const { data: consents } = await admin
        .from("report_recipient_consents")
        .select("recipient_email")
        .eq("account_user_id", s.user_id)
        .eq("status", "approved");
      const recipients = ((consents as any[]) || []).map((c) => c.recipient_email as string);
      if (recipients.length === 0) { results.skipped++; continue; }

      try {
        const minutes = await buildMergedMinutesForRange(admin, accounts, from, to, periodLabel, companyName, undefined, aiBatch);
        const edu = await buildMergedEducationForRange(admin, accounts.map((a) => a.userId), from, to, periodLabel, companyName, aiBatch);
        const tag = accounts.length > 1 ? ` (전 ${accounts.length}현장 통합)` : "";
        const title = companyName || accounts[0]?.siteName || "현장";
        // 같은 이메일이 중복 승인돼 있어도 1회만 — 멱등 기록(recordSent)이 발송 단계로 미뤄져
        // 같은 실행 안의 중복은 여기서 걸러야 한다
        const emailList = [...new Set(recipients)];

        sendJobs.push(async () => {
          try {
            for (const email of emailList) {
              if (minutes.stats.total > 0 && !(await alreadySent(admin, email, py, pm, kindMinutes))) {
                const html = renderReportHtml(minutes);
                const attachments = await buildReportAttachments(minutes, `${title} 주간 TBM 회의록 종합 (${periodLabel})`, todayKST);
                const sent = await sendMail({ to: email, subject: `[안톡] ${title} 주간 TBM 회의록 종합${tag} (${periodLabel})`, html, attachments });
                if (sent.ok) { await recordSent(admin, email, py, pm, kindMinutes, accounts.length); results.sent++; }
                else results.failed++;
              }
              if (edu && !(await alreadySent(admin, email, py, pm, kindEdu))) {
                const html = renderEducationReportHtml(edu);
                const attachments = await buildEducationAttachments(edu, `${title} 주간 안전보건교육일지 종합`, todayKST);
                const sent = await sendMail({ to: email, subject: `[안톡] ${title} 주간 안전보건교육일지 종합${tag} (${periodLabel})`, html, attachments });
                if (sent.ok) { await recordSent(admin, email, py, pm, kindEdu, accounts.length); results.sent++; }
                else results.failed++;
              }
            }
          } catch (e) {
            console.error("weekly report send error:", s.user_id, e);
            results.failed++;
          }
        });
      } catch (e) {
        console.error("weekly report error:", s.user_id, e);
        results.failed++;
      }
    }

    // AI 요약 배치 실행(시간 예산 내 미완료 시 동기 폴백) 후 발송
    const batchStat = await aiBatch.flush(120_000);
    for (const job of sendJobs) await job();

    return NextResponse.json({ success: true, ...results, aiBatch: batchStat });
  } catch (e: any) {
    console.error("weekly-report cron error:", e);
    return NextResponse.json({ error: "서버 오류", detail: e?.message }, { status: 500 });
  }
}
