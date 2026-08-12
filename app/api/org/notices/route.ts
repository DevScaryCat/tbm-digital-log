// app/api/org/notices/route.ts — 감독자 인앱 알림.
//
// 원칙: 전용 테이블을 읽지 **않는** 것이 기본이다. "내 결제가 끊겼다"는 상태에서 파생 가능하므로
// (본인 구독 + 멤버 존재) 배너는 파생값으로 그린다. org_notices를 읽는 이유는 **파생 불가능한
// 이벤트** 때문뿐이다 — "현장 N곳이 결제를 요청했어요", "현장이 스스로 나갔어요".
//
// GET  → { unread, pingCount7d, lapse, emailMissing }
// POST → 읽음 처리 ({ ids?: string[] } — 없으면 미읽음 전체)
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { getOrgContext } from "@/lib/org";
import { orgLapseTiming, orgLapsedAt } from "@/lib/orgGrace";
import { resolveMyReportEmail } from "@/lib/myEmail";
import type { OrgNoticeRow } from "@/lib/orgNotices";

export const runtime = "nodejs";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

    const admin = getAdminClient();
    const ctx = await getOrgContext(user.id, admin);
    // 감독자 전용 — 회사가 없으면 알릴 것도 없다(빈 응답, 오류가 아니다)
    if (ctx.kind !== "owner" || !ctx.org) {
      return NextResponse.json({ unread: [], pingCount7d: 0, lapse: null, emailMissing: false });
    }

    const { data: rows } = await admin
      .from("org_notices")
      .select("id, org_id, owner_user_id, kind, actor_user_id, lapsed_at, dedupe_key, email_status, email_retries, read_at, created_at")
      .eq("owner_user_id", user.id)
      .is("read_at", null)
      .order("created_at", { ascending: false })
      .limit(50);
    const unread = (rows ?? []) as OrgNoticeRow[];

    const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const { count: pingCount7d } = await admin
      .from("org_notices")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ctx.org.id)
      .eq("kind", "member_ping")
      .gte("created_at", since);

    // 감독자 본인의 유예 요약 — 멤버가 받는 것과 **같은 함수**로 판정한다(규칙 사본 금지).
    const { data: mySub } = await admin
      .from("subscriptions")
      .select("status, current_period_end, billing_key, canceled_at")
      .eq("user_id", user.id)
      .maybeSingle();
    const anchor = orgLapsedAt(mySub);
    const lapse = anchor ? orgLapseTiming(anchor) : null;

    // 결제 알림을 받을 이메일이 아예 없으면 인앱만 남는다 — 감독자가 앱·웹을 안 켜면 7일이
    // 통째로 흘러간다. 화면이 "내 정보 수정에서 이메일 등록" 배너를 함께 띄우도록 사실을 내린다.
    const emailMissing = !resolveMyReportEmail(user);

    return NextResponse.json({
      unread: unread.map((n) => ({
        id: n.id,
        kind: n.kind,
        actorUserId: n.actor_user_id,
        lapsedAt: n.lapsed_at,
        emailStatus: n.email_status,
        createdAt: n.created_at,
      })),
      pingCount7d: pingCount7d ?? 0,
      lapse,
      emailMissing,
    });
  } catch (e) {
    console.error("org notices GET error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

    let ids: string[] | null = null;
    try {
      const body = (await request.json()) as { ids?: unknown };
      if (Array.isArray(body?.ids)) ids = body.ids.filter((v): v is string => typeof v === "string");
    } catch {
      /* 본문 없음 = 미읽음 전체 */
    }

    const admin = getAdminClient();
    // owner_user_id로 좁히므로 남의 알림을 읽음 처리할 수 없다(id를 알아도 매치되지 않는다)
    let q = admin
      .from("org_notices")
      .update({ read_at: new Date().toISOString() })
      .eq("owner_user_id", user.id)
      .is("read_at", null);
    if (ids && ids.length > 0) q = q.in("id", ids);
    const { error } = await q;
    if (error) {
      console.error("org notices read error:", error);
      return NextResponse.json({ error: "처리 실패" }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("org notices POST error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
