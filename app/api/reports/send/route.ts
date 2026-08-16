import { NextResponse } from "next/server";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import { buildMergedMinutesContent, renderReportHtml, buildReportAttachments } from "@/lib/monthlyReport";
import { buildMergedEducationContent, renderEducationReportHtml, buildEducationAttachments } from "@/lib/educationReport";
import { sendMail, mailerConfigured } from "@/lib/mailer";
import { getOrgContext } from "@/lib/org";

export const runtime = "nodejs";
export const maxDuration = 120;

// '지금 한 번 보내보기' — 등록·승인이 실제로 됐는지 그 자리에서 확인시키는 수동 발송.
//
// ⚠️ 2026-08-14 전면 재작성. 종전 판은 subscriptions.report_recipients(레거시 컬럼)를
// 읽었는데, 수신처가 승인제(report_recipient_consents)로 옮겨간 뒤 아무도 그 컬럼을
// 쓰지 않아 **전원이 무조건 "먼저 수신처를 등록해주세요" 400**을 받았다 — 이 버튼이
// 해결하려던 바로 그 사람("등록했는데 안 와요")에게 세 번째 거짓말을 하는 셈이었다.
// 지금은 크론(monthly-report)과 같은 소스에서 읽는다: 승인된 수신 동의 + 병합 빌더.
//
// 크론과 일부러 다르게 두는 것 두 가지:
// · consolidated_report_sends에 기록하지 않는다 — 월중 수동 발송이 기록을 남기면
//   다음 1일 크론이 '이미 보냄'으로 그달 진짜 종합을 스킵한다.
// · monthly_reports(앱 열람 저장)를 쓰지 않는다 — 월중 스냅샷이 행을 선점하면
//   크론의 저장 경로가 월말 완성본으로 덮지 못하고 반쪽짜리가 영구 동결된다.
export async function POST(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!isPro)
    return NextResponse.json({ error: "월간 보고서는 Pro 플랜 기능입니다." }, { status: 403 });
  if (!mailerConfigured())
    return NextResponse.json({ error: "메일 발송이 설정되지 않았습니다." }, { status: 500 });

  const admin = getAdminClient();
  const ctx = await getOrgContext(user.id, admin);
  // 역할 게이트(§4-C): 조직 하위는 발송 불가 (isPro만 보면 org_seat가 통과해버림)
  if (ctx.kind === "member") {
    return NextResponse.json(
      { error: "조직 소속 계정입니다. 보고서는 회사 안전관리자가 관리합니다." },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const which: "prev" | "current" = body?.which === "current" ? "current" : "prev";

  // 월 판정은 크론과 같은 KST 기준 — UTC로 하면 매월 1일 00:00~08:59(KST)에
  // '이번 달'이 지난달로 계산돼 화면 안내("이번 달 기록으로")가 거짓이 된다.
  const todayKST = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const [ty, tm] = todayKST.split("-").map(Number);
  let year = ty, month = tm;
  if (which === "prev") { month -= 1; if (month === 0) { month = 12; year -= 1; } }

  // 수신처: 화면과 같은 원장(승인제)에서 읽는다.
  const { data: consents } = await admin
    .from("report_recipient_consents")
    .select("recipient_email")
    .eq("account_user_id", user.id)
    .eq("status", "approved");
  const recipients = [...new Set((consents ?? []).map((c) => c.recipient_email).filter(Boolean))];
  if (recipients.length === 0) {
    return NextResponse.json(
      { error: "승인된 받는 사람이 없어요. 확인 메일의 승인 링크를 눌러야 발송됩니다." },
      { status: 400 },
    );
  }

  // 대상 계정: 감독자면 크론의 회사 경로와 동일하게 본인+소속 현장 병합 —
  // 수동 발송이 본인 현장만 담으면 매월 1일 받던 통합본과 다른 문서가 나간다.
  // 현장명 해석은 크론(monthly-report)과 같은 규칙 — 다르면 '지금 한 번 보내보기'가
  // 매월 1일본과 현장 이름이 다른 문서를 승인 수신처(원청)에 보낸다(2026-08-16 QA).
  // 규칙: site_name 우선, 감독자의 company_name은 회사명이라 현장명으로 쓰지 않는다.
  const siteNameOf = async (id: string, isOwner: boolean): Promise<string> => {
    try {
      const { data: u } = await admin.auth.admin.getUserById(id);
      const m = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
      const label = String(m.site_name ?? "").trim()
        || (isOwner ? "" : String(m.company_name ?? "").trim());
      return label || "현장";
    } catch { return "현장"; }
  };
  const memberIds = ctx.kind === "owner" ? (ctx.memberIds ?? []) : [];
  const ownerLabel = ctx.kind === "owner"
    ? await siteNameOf(user.id, true)
    : ((user.user_metadata as any)?.company_name as string)?.trim() || "현장";
  const accounts = [
    { userId: user.id, siteName: ownerLabel },
    ...(await Promise.all(memberIds.map(async (id) => ({ userId: id, siteName: await siteNameOf(id, false) })))),
  ];
  const company =
    (ctx.kind === "owner" && ctx.org?.name) || accounts[0].siteName;
  const tag = accounts.length > 1 ? ` (전 ${accounts.length}현장 통합)` : "";
  const testTag = which === "current" ? " [월중 발송]" : "";

  // 빌드 — 회의록·교육일지 둘 다. 종전 판은 회의록만 보내서, 교육일지만 쓰는
  // 실고객 패턴(안성센터: 교육 26건·회의록 0건)이 "기록이 없다" 400을 맞았다.
  const minutes = await buildMergedMinutesContent(admin, accounts, year, month, company);
  const edu = await buildMergedEducationContent(admin, accounts.map((a) => a.userId), year, month, company);
  const hasMinutes = minutes.stats.total > 0;
  if (!hasMinutes && !edu) {
    return NextResponse.json(
      { error: `${year}년 ${month}월에 작성된 기록이 없어 보고서를 만들 수 없습니다.` },
      { status: 400 },
    );
  }

  const date = todayKST;
  const failures: string[] = [];
  let sentMinutes = 0, sentEdu = 0;
  for (const email of recipients) {
    if (hasMinutes) {
      const html = renderReportHtml(minutes);
      const docTitle = `${company} ${year}년 ${month}월 TBM 회의록 종합분석 결재 보고서`;
      const attachments = await buildReportAttachments(minutes, docTitle, date);
      const r = await sendMail({
        to: email,
        subject: `[안톡] ${company} ${year}년 ${month}월 TBM 회의록 분석 보고서${tag}${testTag}`,
        html, attachments,
      });
      if (r.ok) sentMinutes++; else failures.push(`${email}(회의록): ${r.error ?? "발송 실패"}`);
    }
    if (edu) {
      const html = renderEducationReportHtml(edu);
      const docTitle = `${company} 안전보건교육일지 종합 보고서`;
      const attachments = await buildEducationAttachments(edu, docTitle, date);
      const r = await sendMail({
        to: email,
        subject: `[안톡] ${company} ${year}년 ${month}월 안전보건교육일지 종합${tag}${testTag}`,
        html, attachments,
      });
      if (r.ok) sentEdu++; else failures.push(`${email}(교육일지): ${r.error ?? "발송 실패"}`);
    }
  }

  if (sentMinutes + sentEdu === 0) {
    return NextResponse.json(
      { error: "메일 발송 실패: " + (failures[0] ?? "알 수 없는 오류") },
      { status: 502 },
    );
  }
  return NextResponse.json({
    success: true,
    period: { year, month },
    sent: { minutes: sentMinutes, education: sentEdu },
    recipients: recipients.length,
    // 부분 실패를 성공으로 뭉개지 않는다 — 화면이 그대로 보여줄 수 있게 목록을 내려준다.
    failures: failures.length ? failures : undefined,
  });
}
