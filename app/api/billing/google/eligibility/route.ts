// app/api/billing/google/eligibility/route.ts — 앱이 구매를 띄우기 전에 묻는 "이 계정, 체험 자격 있나?"
//
// 구글의 무료체험 자격은 **구글 계정** 기준이라, 웹에서 이미 첫 달을 쓴 사람이 앱에서 또 체험을
// 받을 수 있다. 그래서 우리 계정 기준(trial_used)으로 한 번 더 판정해, 자격이 없으면 앱이
// 체험 오퍼가 아닌 기본 요금제로 결제를 띄우게 한다.

import { NextResponse } from "next/server"
import { getUserFromRequest, getAdminClient } from "@/lib/portone"

export const runtime = "nodejs"

export async function GET(request: Request) {
    const user = await getUserFromRequest(request)
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 })

    const admin = getAdminClient()
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
    })
}
