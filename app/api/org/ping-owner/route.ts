// app/api/org/ping-owner/route.ts — 현장 계정 → 감독자 "결제 요청" (현장 본인이 호출)
//
// 세 상황에서 같은 버튼이 여기로 온다:
//   ① 유예 중(회사 결제가 끊겼다)  ② 좌석만 잠김(회사 구독은 유효한데 내 좌석이 안 열렸다)
//   ③ 본인이 직접 결제 중(self_store) — 언제든 회사 부담으로 되돌려 달라고 요청할 수 있다
// 셋을 나누지 않는 이유: 감독자가 할 일("결제를 확인한다")이 같기 때문이다.
//
// 하루 1회/멤버. 판정은 카운터가 아니라 unique(dedupe_key) 충돌이다 — 동시에 두 번 눌러도
// 두 통이 되지 않는다. 이메일은 org당 하루 1통으로 묶인다(lib/orgNotices.ts의 24h 하한).
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { getOrgContext, pingDedupeKey } from "@/lib/org";
import { buildNoticeMail, notify } from "@/lib/orgNotices";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

    const admin = getAdminClient();
    const ctx = await getOrgContext(user.id, admin);

    // 소속을 두 갈래에서 찾는다: 유예 중이면 kind가 'solo'로 강등돼 있고 상세는 orgLapse에 있다.
    const target = ctx.orgLapse
      ? { orgId: ctx.orgLapse.orgId, orgName: ctx.orgLapse.orgName, ownerUserId: ctx.orgLapse.ownerUserId }
      : ctx.kind === "member" && ctx.org
        ? { orgId: ctx.org.id, orgName: ctx.org.name, ownerUserId: ctx.org.ownerUserId }
        : null;

    if (!target) {
      // 유예 중에 감독자가 연결을 해제하면 여기로 떨어진다. 오류 토스트로 띄우지 말 것 —
      // 클라이언트는 이 코드를 보고 안내 문구를 바꾸고 화면을 새로 고친다.
      return NextResponse.json(
        { error: "회사 연결이 해제됐어요.", code: "not_in_org" },
        { status: 404 }
      );
    }

    const siteName = String((user.user_metadata as Record<string, unknown> | null)?.company_name ?? "") || null;
    const dedupeKey = pingDedupeKey(target.orgId, user.id);
    const res = await notify({
      admin,
      orgId: target.orgId,
      ownerUserId: target.ownerUserId,
      kind: "member_ping",
      dedupeKey,
      actorUserId: user.id,
      lapsedAt: ctx.orgLapse?.lapsedAt ?? null,
      mail: buildNoticeMail("member_ping", { orgName: target.orgName, siteName }),
    });

    // ⚠️ 중복과 실패를 구분한다. 종전에는 `alreadySentToday: !res.created` 하나여서,
    // RLS·네트워크·컬럼 불일치로 알림이 한 줄도 기록되지 않고 이메일도 안 나간 경우에
    // 현장 계정이 "오늘은 이미 감독자에게 전달됐어요"(+ 완료 배지)를 봤다. 유예 7일 동안
    // 사용자가 할 수 있는 유일한 행동이 이것 하나다 — 실패하면 실패했다고 말해야 한다.
    if (res.error) {
      return NextResponse.json(
        { error: "전달하지 못했어요. 잠시 후 다시 시도해 주세요.", code: "notify_failed" },
        { status: 500 }
      );
    }

    // 두 번째 이후 요청자에게 429·오류를 주면 사용자는 계속 누른다 — 성공으로 응답하고
    // "오늘 이미 전달됐어요"라고 사실만 말한다.
    // lastPingAt은 **실제 전송 시각**이다(중복이면 오늘 기록된 행의 created_at) — 방금 누른
    // 시각을 돌려주면 "오늘 이미 전달됨"의 시각 표시가 거짓이 된다. 앱(tbm-app)이 이 이름으로
    // 읽고 있어 sentAt과 함께 내려준다(둘 중 하나만 바꾸면 배포 순서에 따라 null이 된다).
    let lastPingAt = new Date().toISOString();
    if (res.duplicate) {
      const { data: existing } = await admin
        .from("org_notices")
        .select("created_at")
        .eq("dedupe_key", dedupeKey)
        .maybeSingle();
      lastPingAt = (existing as { created_at?: string } | null)?.created_at ?? lastPingAt;
    }

    return NextResponse.json({
      success: true,
      alreadySentToday: res.duplicate,
      sentAt: lastPingAt,
      lastPingAt,
    });
  } catch (e) {
    console.error("ping-owner error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
