import { getAdminClient } from "@/lib/portone";
import { renderReportHtml, ReportContent } from "@/lib/monthlyReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function MonthlyReportPublicPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const admin = getAdminClient();

  const { data: report } = await admin
    .from("monthly_reports")
    .select("id, content, first_opened_at, open_count, created_at")
    .eq("token", token)
    .maybeSingle();

  // 링크 만료(발행 후 180일) — 토큰이 유출돼도 영구 접근되지 않도록 차단
  const REPORT_TTL_MS = 180 * 24 * 60 * 60 * 1000;
  const isExpired = !!report?.created_at && Date.now() - new Date(report.created_at).getTime() > REPORT_TTL_MS;

  if (!report || isExpired) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Apple SD Gothic Neo, Arial, sans-serif", color: "#888" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#26251e" }}>보고서를 찾을 수 없습니다</div>
          <div style={{ fontSize: 14, marginTop: 8 }}>링크가 만료되었거나 잘못된 주소입니다.</div>
        </div>
      </div>
    );
  }

  // 열람 추적 (사장/안전관리자 점검 증빙) — best-effort
  try {
    await admin
      .from("monthly_reports")
      .update({
        open_count: (report.open_count ?? 0) + 1,
        first_opened_at: report.first_opened_at ?? new Date().toISOString(),
      })
      .eq("id", report.id);
  } catch {}

  const html = renderReportHtml(report.content as ReportContent);

  return (
    <div style={{ minHeight: "100vh", background: "#f7f7f4", padding: "24px 12px" }}>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
