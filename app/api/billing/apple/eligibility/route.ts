// app/api/billing/apple/eligibility/route.ts — 앱이 구매를 띄우기 전에 묻는 "이 계정, 체험 자격 있나?"
//
// 애플의 소개 오퍼(무료체험) 자격은 **애플 계정(구독 그룹) 기준**이라, 웹이나 안드로이드에서
// 이미 첫 달을 쓴 사람이 iOS에서 또 체험을 받을 수 있다. 그래서 우리 계정 기준(trial_used)으로
// 한 번 더 판정해, 자격이 없으면 앱이 체험 오퍼가 아닌 기본 요금제로 결제를 띄우게 한다.
// (구글 eligibility와 동일 계약 — 응답 필드도 같다)

import { NextResponse } from "next/server"
import { getUserFromRequest, getAdminClient } from "@/lib/portone"

export const runtime = "nodejs"

export async function GET(request: Request) {
    const user = await getUserFromRequest(request)
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 })

    const admin = getAdminClient()

    // 감독자(조직 소유주) 여부 — 정보 필드. 한때 앱이 이 값으로 결제 UI를 막았지만(좌석 몫 무과금 우려)
    // 2026-08-09 번복: 본인 몫(4,900)은 스토어, 좌석 몫(N×3,900)은 보존된 카드로 좌석 크론이
    // 계속 청구하므로 감독자도 인앱결제를 연다. 차단 신호로 쓰지 말 것.
    const { count: ownedOrgs } = await admin
        .from("organizations")
        .select("id", { count: "exact", head: true })
        .eq("owner_user_id", user.id)

    const { data: sub } = await admin
        .from("subscriptions")
        .select("trial_used, status, source, current_period_end")
        .eq("user_id", user.id)
        .maybeSingle()

    // 이미 이용 중이면 중복 결제를 막는다(앱에서 버튼 자체를 잠그게)
    const activeNow =
        !!sub &&
        (["active", "trialing", "past_due"].includes(sub.status) ||
            (sub.status === "canceled" &&
                !!sub.current_period_end &&
                new Date(sub.current_period_end) > new Date()))

    return NextResponse.json({
        trialEligible: !sub?.trial_used,
        alreadySubscribed: activeNow,
        source: sub?.source ?? null,
        // 정보 필드(차단 신호 아님) — 감독자 본인 몫은 인앱, 좌석 몫은 카드로 공존 청구된다
        orgOwner: (ownedOrgs ?? 0) > 0,
    })
}
