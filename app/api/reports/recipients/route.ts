import { NextResponse } from "next/server";
import { getAdminClient, getUserAndSubscription } from "@/lib/portone";
import { normMethod, normMatrix } from "@/lib/riskMatrix";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clampDay(d: unknown): number {
  const n = Math.round(Number(d));
  if (!Number.isFinite(n)) return 1;
  return Math.min(28, Math.max(1, n));
}

// 월간 보고서 설정(수신처 + 발송일) 조회
export async function GET(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const admin = getAdminClient();
  const { data } = await admin
    .from("subscriptions")
    .select("report_recipients, report_send_day, report_frequency, report_weekday, risk_assessment_method, risk_matrix")
    .eq("user_id", user.id)
    .maybeSingle();
  // 비Pro는 상중하로 고정 노출 (저장값이 뭐든 클라엔 level3로 보여 '베이직=상중하 고정' 일치)
  const riskMethod = isPro ? normMethod(data?.risk_assessment_method) : "level3";
  return NextResponse.json({
    recipients: data?.report_recipients ?? [],
    sendDay: data?.report_send_day ?? 1,
    frequency: data?.report_frequency ?? "monthly",
    weekday: data?.report_weekday ?? 1,
    riskMethod,
    riskMatrix: normMatrix(data?.risk_matrix),
    isPro,
  });
}

// 월간 보고서 설정 저장 (Pro 전용)
export async function POST(request: Request) {
  const { user, isPro } = await getUserAndSubscription(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!isPro)
    return NextResponse.json({ error: "월간 보고서는 Pro 플랜 기능입니다." }, { status: 403 });

  const body = await request.json();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.recipients !== undefined) {
    if (!Array.isArray(body.recipients)) {
      return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
    }
    const cleaned: string[] = [
      ...new Set<string>(body.recipients.map((e: any) => String(e).trim()).filter(Boolean)),
    ];
    if (cleaned.length > 5) {
      return NextResponse.json({ error: "수신처는 최대 5개까지 등록할 수 있습니다." }, { status: 400 });
    }
    const invalid = cleaned.find((e) => !EMAIL_RE.test(e));
    if (invalid) {
      return NextResponse.json({ error: `이메일 형식이 올바르지 않습니다: ${invalid}` }, { status: 400 });
    }
    update.report_recipients = cleaned;
  }

  if (body.sendDay !== undefined) {
    update.report_send_day = clampDay(body.sendDay);
  }
  if (body.frequency !== undefined) {
    update.report_frequency = body.frequency === "weekly" ? "weekly" : "monthly";
  }
  if (body.weekday !== undefined) {
    const w = Math.round(Number(body.weekday));
    update.report_weekday = Number.isFinite(w) ? Math.min(6, Math.max(0, w)) : 1;
  }
  // 위험성평가 방법·매트릭스 (POST가 이미 Pro 게이트라 freq_sev 저장은 Pro만 가능)
  if (body.riskMethod !== undefined) {
    update.risk_assessment_method = normMethod(body.riskMethod);
  }
  if (body.riskMatrix !== undefined) {
    update.risk_matrix = normMatrix(body.riskMatrix);
  }

  const admin = getAdminClient();
  const { data, error } = await admin
    .from("subscriptions")
    .update(update)
    .eq("user_id", user.id)
    .select("report_recipients, report_send_day, report_frequency, report_weekday, risk_assessment_method, risk_matrix")
    .maybeSingle();
  if (error) {
    console.error("recipients update error:", error);
    return NextResponse.json({ error: "저장 실패" }, { status: 500 });
  }
  return NextResponse.json({
    success: true,
    recipients: data?.report_recipients ?? [],
    sendDay: data?.report_send_day ?? 1,
    frequency: data?.report_frequency ?? "monthly",
    weekday: data?.report_weekday ?? 1,
    riskMethod: normMethod(data?.risk_assessment_method),
    riskMatrix: normMatrix(data?.risk_matrix),
  });
}
