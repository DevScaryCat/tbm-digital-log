import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getAdminClient, subscriptionAllows, isProPlan } from "@/lib/portone";
import { buildMergedMinutesContent, renderReportHtml, buildReportAttachments } from "@/lib/monthlyReport";
import { buildMergedEducationContent, renderEducationReportHtml, buildEducationAttachments } from "@/lib/educationReport";
import { sendMail, mailerConfigured } from "@/lib/mailer";
import { AiBatch } from "@/lib/aiBatch";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 300;

// Vercel Cron(매일 00:00 UTC): 매월 1일(KST)에 지난달 종합 보고서 발송. 두 축(§7):
// ① 회사 경로: 감독자 본인 현장 + 소속 현장을 병합 → 앱 열람 저장 + 승인 수신처 발송,
//    각 소속 현장은 자기 현장분을 본인 인증 이메일로 수신 (kind='member_minutes/_education_<id>').
// ② 단독 경로: 회사에 속하지 않은 계정의 기존 수신자 승인제.
//
// 두 경로는 반드시 서로소여야 한다. 예전에는 `plan === 'monthly_pro'` 필터가 org 계정을
// 우연히 배제해줬는데, 단일 요금제로 plan이 같아지면 그 우연이 깨져 같은 수신자가
// 병합본과 단독본을 각각 받게 된다. 그래서 이제 plan이 아니라 **소속(organizations/org_members)**
// 으로 배제한다 — orgLinked 참조.
export async function POST(request: Request) { return run(request); }
export async function GET(request: Request) { return run(request); }

type Account = { userId: string; siteName: string };
// org 경로는 단독 경로와 발신 주체가 달라 멱등 키(kind)를 분리한다 — 같은 수신 이메일이
// 양쪽에 걸치면 한쪽이 조용히 미발송되는 교차 누락 방지 (리뷰 G). member_* 키는
// 계정 id를 키에 포함 — 한 담당자가 두 현장의 실이메일이면 두 현장분 모두 받아야 한다 (리뷰 H).
// org_* 도 마찬가지로 소유자 id를 포함해야 한다: 회사가 둘 이상 생기면 같은 원청 이메일을
// 두 회사가 승인했을 때 먼저 보낸 쪽만 나가고 나머지는 조용히 '이미 보냄'이 된다.
type Kind = "minutes" | "education" | `org_${string}` | `member_${string}`;

async function alreadySent(admin: SupabaseClient, email: string, year: number, month: number, kind: Kind): Promise<boolean> {
  const { data } = await admin
    .from("consolidated_report_sends")
    .select("recipient_email")
    .eq("recipient_email", email).eq("period_year", year).eq("period_month", month).eq("kind", kind)
    .maybeSingle();
  return !!data;
}
async function recordSent(admin: SupabaseClient, email: string, year: number, month: number, kind: Kind, count: number) {
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
    const force = new URL(request.url).searchParams.get("force") === "1"; // 테스트: 날짜 무관 실행

    const todayKST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const todayDay = Number(todayKST.slice(8, 10));
    if (!force && todayDay !== 1) {
      return NextResponse.json({ success: true, skipped: "매월 1일에만 발송", today: todayKST });
    }
    if (!mailerConfigured()) return NextResponse.json({ error: "메일 미설정" }, { status: 500 });

    // 지난 달 (KST 기준)
    const [ty, tm] = todayKST.split("-").map(Number);
    let year = ty, month = tm - 1;
    if (month === 0) { month = 12; year -= 1; }
    const date = todayKST;

    // 2단계 구조: 각 경로는 콘텐츠를 빌드하며 AI 요약을 배치에 예약하고, 저장·발송은
    // 클로저(postJobs)로 미룬다. 모든 경로 순회 후 배치 1회 실행(50% 할인, 실패·시간초과는
    // 동기 폴백) → postJobs를 큐 순서대로 실행. 발송 지연·품질 저하 없이 요금만 아낀다.
    const aiBatch = new AiBatch();
    const postJobs: Array<() => Promise<void>> = [];

    // ══ ① 회사 경로 ════════════════════════════════════════════════════
    // 단독 경로(②)에서 배제할 계정 — 감독자 본인과 소속 현장 전부.
    const orgLinked = new Set<string>();
    const orgResults = { orgs: 0, ownerSaved: 0, ownerSent: 0, memberSent: 0, memberSkipped: 0, failed: 0 };
    {
      const { data: orgs } = await admin
        .from("organizations")
        .select("id, name, owner_user_id")
        .limit(1000);
      for (const org of (orgs as any[]) || []) {
        // 감독자 구독 유효성 — plan 문자열이 아니라 "유료 자격이 살아있는가"로 판정한다.
        const { data: ownerSub } = await admin
          .from("subscriptions")
          .select("status, current_period_end, billing_key, plan, report_send_monthly")
          .eq("user_id", org.owner_user_id)
          .maybeSingle();

        const { data: memberRows } = await admin
          .from("org_members")
          .select("member_user_id")
          .eq("org_id", org.id)
          .eq("status", "active");
        const memberIds = ((memberRows as any[]) || []).map((m) => m.member_user_id as string);

        // 구독이 끊겼으면 회사 경로는 건너뛰되, 단독 경로가 대신 주워가지 않도록
        // 배제 집합에는 넣는다(끊긴 회사의 현장에 개별 발송이 나가면 더 이상하다).
        orgLinked.add(org.owner_user_id);
        for (const id of memberIds) orgLinked.add(id);
        if (!ownerSub || !subscriptionAllows(ownerSub) || !isProPlan(ownerSub.plan)) continue;
        // 발송 설정에서 월간을 끈 계정은 건너뛴다. 여태 이 플래그를 아무도 안 읽어서
        // 화면에서 꺼도 메일이 계속 나갔다(죽은 토글).
        if ((ownerSub as any).report_send_monthly === false) continue;
        orgResults.orgs++;

        // 현장명·실이메일 메타데이터.
        // 감독자 본인도 하나의 현장이다 — 빼면 본인이 쓴 회의록·일지가 병합본에서 통째로 사라진다.
        const accounts: Account[] = [];
        const memberEmail = new Map<string, string>(); // userId → 인증된 실이메일
        for (const id of [org.owner_user_id as string, ...memberIds]) {
          try {
            const { data: u } = await admin.auth.admin.getUserById(id);
            const meta = (u?.user?.user_metadata ?? {}) as Record<string, any>;
            // 감독자의 company_name은 '회사명'이라 현장명으로 쓰면 안 된다 — site_name을 우선한다.
            const label = String(meta.site_name ?? "").trim()
              || (id === org.owner_user_id ? "" : String(meta.company_name ?? "").trim());
            accounts.push({ userId: id, siteName: label || "현장" });
            if (meta.real_email && meta.real_email_verified_at) memberEmail.set(id, String(meta.real_email));
          } catch {
            accounts.push({ userId: id, siteName: "현장" });
          }
        }
        const allIds = accounts.map((a) => a.userId);

        // (a)+(b) 병합 보고서 — 빌드(AI는 배치 예약)만 여기서, 저장·발송은 postJobs로
        try {
          const mergedContent = await buildMergedMinutesContent(admin, accounts, year, month, org.name, aiBatch);
          // 교육 종합은 회의록 유무와 독립 — 회의록 0건 달에도 교육 보고서는 나가야 한다 (리뷰 I).
          // 수신자 루프 밖에서 1회만 빌드 (AI 요약 중복 비용 방지).
          const mergedEdu = await buildMergedEducationContent(admin, allIds, year, month, org.name, aiBatch);

          // (b) 수신처 명단은 빌드 단계에서 확정 (읽기 전용 쿼리) — 중복 이메일은 1회만
          const { data: ownerConsents } = await admin
            .from("report_recipient_consents")
            .select("recipient_email")
            .eq("account_user_id", org.owner_user_id)
            .eq("status", "approved");
          const emails = [...new Set((((ownerConsents as any[]) || [])).map((c) => c.recipient_email as string))];
          const merged = accounts.length > 1;
          const tag = merged ? ` (전 ${accounts.length}현장 통합)` : "";
          // 멱등 키를 회사별로 분리 — 같은 원청 이메일을 여러 회사가 승인해도 각각 발송된다.
          const kMinutes: Kind = `org_minutes_${org.owner_user_id}`;
          const kEdu: Kind = `org_education_${org.owner_user_id}`;

          postJobs.push(async () => {
            try {
              // (a) 안전관리자 웹 열람 저장 (monthly_reports, user_id=owner) — AI 총평 반영본
              if (mergedContent.stats.total > 0) {
                const { data: existing } = await admin
                  .from("monthly_reports")
                  .select("token")
                  .eq("user_id", org.owner_user_id)
                  .eq("period_year", year)
                  .eq("period_month", month)
                  .maybeSingle();
                const token = existing?.token || randomUUID();
                const { error: upErr } = await admin.from("monthly_reports").upsert(
                  {
                    user_id: org.owner_user_id,
                    period_year: year,
                    period_month: month,
                    token,
                    content: mergedContent as any,
                    recipients: [],
                    sent_at: new Date().toISOString(),
                  },
                  { onConflict: "user_id,period_year,period_month" }
                );
                if (!upErr) orgResults.ownerSaved++;
              }

              for (const email of emails) {
                if (mergedContent.stats.total > 0 && !(await alreadySent(admin, email, year, month, kMinutes))) {
                  const html = renderReportHtml(mergedContent);
                  const docTitle = `${org.name} ${year}년 ${month}월 TBM 회의록 종합분석 결재 보고서`;
                  const attachments = await buildReportAttachments(mergedContent, docTitle, date);
                  const sent = await sendMail({
                    to: email,
                    subject: `[안톡] ${org.name} ${year}년 ${month}월 TBM 회의록 분석 보고서${tag}`,
                    html,
                    attachments,
                  });
                  if (sent.ok) { await recordSent(admin, email, year, month, kMinutes, accounts.length); orgResults.ownerSent++; }
                  else orgResults.failed++;
                }
                if (mergedEdu && !(await alreadySent(admin, email, year, month, kEdu))) {
                  const html = renderEducationReportHtml(mergedEdu);
                  const attachments = await buildEducationAttachments(mergedEdu, `${org.name} 안전보건교육일지 종합 보고서`, date);
                  const sent = await sendMail({
                    to: email,
                    subject: `[안톡] ${org.name} ${year}년 ${month}월 안전보건교육일지 종합${tag}`,
                    html,
                    attachments,
                  });
                  if (sent.ok) { await recordSent(admin, email, year, month, kEdu, accounts.length); orgResults.ownerSent++; }
                  else orgResults.failed++;
                }
              }
            } catch (e) {
              console.error("org merged report error:", org.id, e);
              orgResults.failed++;
            }
          });
        } catch (e) {
          console.error("org merged report error:", org.id, e);
          orgResults.failed++;
        }

        // (c) 소속 현장 개별: 자기 현장 1현장분 → 본인 인증 이메일.
        // 감독자 본인은 제외 — 병합본을 앱(회사관리 탭)에서 바로 보므로 같은 내용을 메일로 또 받을 이유가 없다.
        for (const acc of accounts) {
          if (acc.userId === org.owner_user_id) continue;
          const email = memberEmail.get(acc.userId);
          if (!email) { orgResults.memberSkipped++; continue; } // 미인증 — 홈 배너가 인증 유도
          // 멱등 키는 계정 id + 문서 종류별로 분리한다. 하나로 묶으면(구 member_monthly_*)
          // 회의록만 실패하고 교육만 성공한 달에 재시도(?force=1)가 통째로 건너뛰어
          // 실패분이 그 달 영구 미발송이 된다.
          const kMemberMinutes: Kind = `member_minutes_${acc.userId}`;
          const kMemberEdu: Kind = `member_education_${acc.userId}`;
          try {
            // 멱등 확인은 빌드 단계에서 (이미 보낸 문서는 빌드 자체를 생략 — 오늘과 동일)
            const doMinutes = !(await alreadySent(admin, email, year, month, kMemberMinutes));
            const doEdu = !(await alreadySent(admin, email, year, month, kMemberEdu));
            const own = doMinutes ? await buildMergedMinutesContent(admin, [acc], year, month, acc.siteName, aiBatch) : null;
            const edu = doEdu ? await buildMergedEducationContent(admin, [acc.userId], year, month, acc.siteName, aiBatch) : null;
            if (!own && !edu) continue;

            postJobs.push(async () => {
              try {
                let anySent = false;
                if (own && own.stats.total > 0) {
                  const html = renderReportHtml(own);
                  const docTitle = `${acc.siteName} ${year}년 ${month}월 TBM 회의록 종합분석 결재 보고서`;
                  const attachments = await buildReportAttachments(own, docTitle, date);
                  const sent = await sendMail({
                    to: email,
                    subject: `[안톡] ${acc.siteName} ${year}년 ${month}월 TBM 회의록 분석 보고서`,
                    html,
                    attachments,
                  });
                  if (sent.ok) { await recordSent(admin, email, year, month, kMemberMinutes, 1); anySent = true; }
                  else orgResults.failed++;
                }
                if (edu) {
                  const html = renderEducationReportHtml(edu);
                  const attachments = await buildEducationAttachments(edu, `${acc.siteName} 안전보건교육일지 종합 보고서`, date);
                  const sent = await sendMail({
                    to: email,
                    subject: `[안톡] ${acc.siteName} ${year}년 ${month}월 안전보건교육일지 종합`,
                    html,
                    attachments,
                  });
                  if (sent.ok) { await recordSent(admin, email, year, month, kMemberEdu, 1); anySent = true; }
                  else orgResults.failed++;
                }
                if (anySent) orgResults.memberSent++;
              } catch (e) {
                console.error("org member monthly error:", acc.userId, e);
                orgResults.failed++;
              }
            });
          } catch (e) {
            console.error("org member monthly error:", acc.userId, e);
            orgResults.failed++;
          }
        }
      }
    }

    // ══ ①.5 단독 계정 앱 내 열람 저장 ══════════════════════════════════
    // 현장관리 탭의 '월간 보고서' 화면은 "매월 1일 쌓입니다"라고 약속하는데,
    // 저장은 회사 경로에서만 하고 있었다 — 조직 없는 유료 계정(현 실사용 대다수)은
    // 화면이 영원히 비어 기능 고장으로 보인다. 수신 동의 여부와 무관하게 본인 몫을 저장한다.
    const soloStored = { stored: 0, failed: 0 };
    {
      const { data: allSubs } = await admin
        .from("subscriptions")
        .select("user_id, plan, status, current_period_end")
        .limit(3000);
      const nowMs0 = now.getTime();
      for (const s of (allSubs as any[]) || []) {
        if (orgLinked.has(s.user_id)) continue; // 회사 경로가 저장
        if (!isProPlan(s.plan)) continue;
        const ok = ["active", "trialing", "past_due"].includes(s.status) ||
          (s.status === "canceled" && s.current_period_end && new Date(s.current_period_end).getTime() > nowMs0);
        if (!ok) continue;
        try {
          // 이미 저장돼 있으면(재실행) 재빌드하지 않는다 — AI 요약 비용 멱등
          const { data: existing } = await admin
            .from("monthly_reports")
            .select("token")
            .eq("user_id", s.user_id)
            .eq("period_year", year)
            .eq("period_month", month)
            .maybeSingle();
          if (existing) continue;
          let label = "현장";
          try {
            const { data: u } = await admin.auth.admin.getUserById(s.user_id);
            const meta = (u?.user?.user_metadata ?? {}) as Record<string, any>;
            label = String(meta.site_name ?? "").trim() || String(meta.company_name ?? "").trim() || "현장";
          } catch { /* 라벨만 기본값 */ }
          const own = await buildMergedMinutesContent(admin, [{ userId: s.user_id, siteName: label }], year, month, label, aiBatch);
          if (own.stats.total === 0) continue; // 기록 없는 달은 저장할 것도 없다
          postJobs.push(async () => {
            const { error: upErr } = await admin.from("monthly_reports").upsert(
              {
                user_id: s.user_id,
                period_year: year,
                period_month: month,
                token: randomUUID(),
                content: own as any,
                recipients: [],
                sent_at: new Date().toISOString(),
              },
              { onConflict: "user_id,period_year,period_month" }
            );
            if (upErr) { soloStored.failed++; console.error("solo report store error:", s.user_id, upErr); }
            else soloStored.stored++;
          });
        } catch (e) {
          soloStored.failed++;
          console.error("solo report build error:", s.user_id, e);
        }
      }
    }

    // ══ ② 단독 경로 — 회사에 속하지 않은 계정의 수신자 승인제 ═══════════
    // 승인된 수신 동의
    const { data: consents } = await admin
      .from("report_recipient_consents")
      .select("recipient_email, account_user_id")
      .eq("status", "approved")
      .limit(3000);
    // 회사 경로의 postJobs가 남아 있을 수 있어 여기서 조기 반환하지 않는다 —
    // 수신 동의가 없으면 아래 루프가 자연히 비어 지나간다.
    const rows = (consents as { recipient_email: string; account_user_id: string }[]) || [];

    // 유효한 Pro 계정만 (해지+기간만료 제외)
    const accountIds = [...new Set(rows.map((r) => r.account_user_id))];
    const { data: subs } = await admin
      .from("subscriptions")
      .select("user_id, plan, status, current_period_end, report_send_monthly")
      .in("user_id", accountIds);
    const nowMs = now.getTime();
    const validPro = new Set<string>();
    for (const s of (subs as any[]) || []) {
      // 회사에 속한 계정(감독자·소속 현장)은 경로 ①이 이미 처리했다. 여기서 또 보내면
      // 같은 수신자에게 병합본과 단독본이 각각 날아간다 — 멱등 kind가 달라 중복을 못 막는다.
      if (orgLinked.has(s.user_id)) continue;
      // 구 베이직·영구무료는 월간 보고서 대상이 아니다(DB 트리거의 80/10/0 집합과 동일 기준).
      if (!isProPlan(s.plan)) continue;
      // 월간 발송을 끈 계정은 대상에서 뺀다 (화면 토글이 실제로 동작하도록)
      if ((s as any).report_send_monthly === false) continue;
      const ok = ["active", "trialing", "past_due"].includes(s.status) ||
        (s.status === "canceled" && s.current_period_end && new Date(s.current_period_end).getTime() > nowMs);
      if (ok) validPro.add(s.user_id);
    }

    // 계정별 현장명(company_name)
    const siteName = new Map<string, string>();
    for (const id of accountIds) {
      if (!validPro.has(id)) continue;
      try {
        const { data: u } = await admin.auth.admin.getUserById(id);
        siteName.set(id, (u?.user?.user_metadata as any)?.company_name?.trim() || "현장");
      } catch { siteName.set(id, "현장"); }
    }

    // 수신자별로 묶기
    const byRecipient = new Map<string, Account[]>();
    for (const r of rows) {
      if (!validPro.has(r.account_user_id)) continue;
      const arr = byRecipient.get(r.recipient_email) || [];
      arr.push({ userId: r.account_user_id, siteName: siteName.get(r.account_user_id) || "현장" });
      byRecipient.set(r.recipient_email, arr);
    }

    const results = { recipients: byRecipient.size, minutesSent: 0, eduSent: 0, skipped: 0, failed: 0 };

    for (const [email, accounts] of byRecipient) {
      const company = accounts[0].siteName; // 한 회사 가정 — 첫 현장명 사용
      const merged = accounts.length > 1;
      const tag = merged ? ` (전 ${accounts.length}현장 통합)` : "";

      // 멱등 확인은 빌드 단계에서 (이미 보낸 문서는 빌드 자체를 생략 — 오늘과 동일)
      const doMinutes = !(await alreadySent(admin, email, year, month, "minutes"));
      if (!doMinutes) results.skipped++;
      const content = doMinutes ? await buildMergedMinutesContent(admin, accounts, year, month, company, aiBatch) : null;
      const doEdu = !(await alreadySent(admin, email, year, month, "education"));
      const edu = doEdu ? await buildMergedEducationContent(admin, accounts.map((a) => a.userId), year, month, company, aiBatch) : null;
      if (!content && !edu) continue;

      postJobs.push(async () => {
        try {
          // ① 회의록 종합
          if (content && content.stats.total > 0) {
            const html = renderReportHtml(content);
            const docTitle = `${company} ${year}년 ${month}월 TBM 회의록 종합분석 결재 보고서`;
            const attachments = await buildReportAttachments(content, docTitle, date);
            const sent = await sendMail({
              to: email,
              subject: `[안톡] ${company} ${year}년 ${month}월 TBM 회의록 분석 보고서${tag}`,
              html,
              attachments,
            });
            if (sent.ok) { await recordSent(admin, email, year, month, "minutes", accounts.length); results.minutesSent++; }
            else results.failed++;
          }

          // ② 안전보건교육일지 종합
          if (edu) {
            const html = renderEducationReportHtml(edu);
            const docTitle = `${company} 안전보건교육일지 종합 보고서`;
            const attachments = await buildEducationAttachments(edu, docTitle, date);
            const sent = await sendMail({
              to: email,
              subject: `[안톡] ${company} ${year}년 ${month}월 안전보건교육일지 종합${tag}`,
              html,
              attachments,
            });
            if (sent.ok) { await recordSent(admin, email, year, month, "education", accounts.length); results.eduSent++; }
            else results.failed++;
          }
        } catch (e) {
          console.error("solo monthly send error:", email, e);
          results.failed++;
        }
      });
    }

    // AI 요약 배치 실행(시간 예산 내 미완료 시 동기 폴백) 후 저장·발송을 큐 순서대로
    const batchStat = await aiBatch.flush(120_000);
    for (const job of postJobs) await job();

    return NextResponse.json({ success: true, period: { year, month }, today: todayKST, ...results, org: orgResults, solo: soloStored, aiBatch: batchStat });
  } catch (e: any) {
    console.error("consolidated monthly-report cron error:", e);
    return NextResponse.json({ error: "서버 오류", detail: e?.message }, { status: 500 });
  }
}
