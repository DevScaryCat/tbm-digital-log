// app/api/org/leave/route.ts — 현장 계정이 **스스로** 회사 연결을 끊는다.
//
// 자격은 하나뿐이다: **본인이 직접 결제 중일 때만**(seat_state='self_store').
// 그리고 그 판정은 클라이언트 값이 아니라 **서버가 DB 함수로 다시 한다.**
// 클라가 보낸 seat_state를 믿으면, 회사가 요금을 내주는 좌석 멤버가 그 값을 위조해 스스로
// 나갈 수 있다 — 미러가 canceled로 접히고 회사 보고서에서도 빠지는데 본인 결제도 없는
// 완전 차단 상태를 자가 생성한다. 정원 규칙과 같은 규율: 판정은 DB 함수 하나가 한다.
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { detachOrgMember } from "@/lib/org";
import { isSelfPaid } from "@/lib/orgSeats";
import { kstDay, notify } from "@/lib/orgNotices";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

    const admin = getAdminClient();
    const { data: membership } = await admin
      .from("org_members")
      .select("org_id, organizations!inner(id, name, owner_user_id)")
      .eq("member_user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (!membership) {
      return NextResponse.json({ error: "연결된 회사가 없어요.", code: "not_in_org" }, { status: 404 });
    }

    // 자가 결제 판정은 회계(청구·정원·미러)와 **같은 함수**를 쓴다 — 스토어뿐 아니라 본인 카드로
    // 직접 결제 중인 멤버도 회사 청구에서 빠져 있으므로 나갈 자격이 있다.
    const selfPaid = await isSelfPaid(admin, user.id);
    if (!selfPaid) {
      return NextResponse.json(
        {
          error:
            "회사가 요금을 내는 계정은 스스로 나갈 수 없어요. 감독자에게 연결 해제를 요청해 주세요.",
          code: "company_paid",
        },
        { status: 403 }
      );
    }

    // 감독자 해제와 **같은 함수**를 부른다. 자가 결제자에게 안전한 이유가 코드에 있다:
    // cancelOrgSeatMirrors의 UPDATE는 전부 .eq("plan","org_seat")로 좁혀져 있는데,
    // 자가 결제자의 행은 스토어 verify가 plan='monthly_pro'로 써둔 것이라 한 행도 매치되지 않는다
    // — 본인 스토어 구독이 실수로 끊기는 경로가 구조적으로 없다.
    await detachOrgMember(user.id, admin);

    // PostgREST의 조인 결과 타입은 배열로 추론된다(!inner라 실제로는 객체 하나) — 다른 라우트와
    // 같은 방식으로 좁힌다(app/api/org/attach/route.ts의 (invite as any).organizations와 동일 규율)
    const org = (membership as unknown as {
      organizations: { id: string; name: string; owner_user_id: string };
    }).organizations;
    // 감독자에게는 인앱으로만 알린다(이메일 없음 — 결제가 끊기는 사건이 아니다)
    await notify({
      admin,
      orgId: org.id,
      ownerUserId: org.owner_user_id,
      kind: "member_left",
      dedupeKey: `left:${org.id}:${user.id}:${kstDay()}:${Date.now()}`,
      actorUserId: user.id,
      mail: null,
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("org leave error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
