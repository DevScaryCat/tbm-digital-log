import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { cancelUserSubscription } from "@/lib/cancelSubscription";
import { getOrgContext, cancelOrgSeatMirrors } from "@/lib/org";

export const runtime = "nodejs";

// 구독 해지 — 공용 로직은 lib/cancelSubscription.ts (편입 흐름과 공유)
// 회사 플랜(org) 해지 시 하위 미러 구독을 즉시 강등한다 (결정 8).
export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }

    const admin = getAdminClient();

    // 조직 소속 하위(관리감독자)는 개인 구독이 없다(미러 0원) — 해지 대상 아님
    const ctx = await getOrgContext(user.id, admin);
    if (ctx.kind === "member") {
      return NextResponse.json(
        { error: "조직 소속 계정입니다. 구독 관리는 회사 안전관리자가 합니다." },
        { status: 403 }
      );
    }

    const r = await cancelUserSubscription(admin, user.id);
    if (r.notFound) return NextResponse.json({ error: "구독을 찾을 수 없습니다." }, { status: 404 });
    if (r.grandfather)
      return NextResponse.json({ error: "해당 계정은 해지 대상이 아닙니다." }, { status: 400 });
    if (r.alreadyCanceled) return NextResponse.json({ success: true, alreadyCanceled: true });
    if (!r.ok) return NextResponse.json({ error: "해지 처리 실패" }, { status: 500 });

    // 회사 플랜 해지 → 하위 강등. 단 즉시 강등은 환불이 완료돼 기간이 즉시 종료된 경우만 —
    // 환불 실패/0원 환불이면 owner는 잔여 기간을 계속 쓰므로 하위도 그 기간까지 유지하고
    // cron reconciliation 스윕이 만료 시점에 접는다 (리뷰 L: 결제된 기간의 서비스 상실 방지)
    if (ctx.kind === "owner" && ctx.memberIds && ctx.memberIds.length > 0 && r.refunded > 0) {
      await cancelOrgSeatMirrors(ctx.memberIds, admin);
    }

    return NextResponse.json({
      success: true,
      refunded: r.refunded,
      ...(r.refundFailed
        ? {
            refundNotice:
              "해지는 완료되었으나 자동 환불에 실패했습니다. 고객센터로 문의해주시면 잔여 기간을 환불해 드립니다.",
          }
        : {}),
    });
  } catch (e) {
    console.error("cancel route error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
