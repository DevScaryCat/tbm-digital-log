// app/api/billing/apple/eligibility/route.ts — 앱이 구매를 띄우기 전에 묻는 "이 계정, 체험 자격 있나?"
//
// 애플의 소개 오퍼(무료체험) 자격은 **애플 계정(구독 그룹) 기준**이라, 웹이나 안드로이드에서
// 이미 첫 달을 쓴 사람이 iOS에서 또 체험을 받을 수 있다. 그래서 우리 계정 기준(trial_used)으로
// 한 번 더 판정해, 자격이 없으면 앱이 체험 오퍼가 아닌 기본 요금제로 결제를 띄우게 한다.
// (구글 eligibility와 동일 계약 — 응답 필드도 같다)

import { NextResponse } from "next/server"
import { getUserFromRequest, getAdminClient, isProPlan } from "@/lib/portone"

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
        .select("trial_used, status, plan, source, current_period_end")
        .eq("user_id", user.id)
        .maybeSingle()

    // 이미 이용 중이면 중복 결제를 막는다(앱에서 버튼 자체를 잠그게).
    //
    // ⚠️ 상태(status)만 보면 안 된다 — 2026-08-10 실측 사고 2건:
    //  ① 체험이 끝난 계정(status는 여전히 'trialing', 기간만 지남)이 '이미 이용 중'으로 잠겨
    //     **돈을 내겠다는 사람이 결제를 못 했다**(Chris 실기기).
    //  ② grandfather 8계정(status='active', 기간 null)이 전부 잠겨 있었다 —
    //     legacy 페이월이 '구독 시작하기'로 보내는데 그 끝이 막다른 길이었다(실고객 이현로지스 전원).
    //
    // 판정 기준: **지금 유효한 Pro 이용권이 있는가**. 있으면 새 구매가 중복이니 막고, 없으면 열어준다.
    //  · isProPlan: monthly_basic(구 베이직)만 false → 업그레이드 구매를 열어준다.
    //  · 기간: null이면 무기한 유효(org_seat 미러·grandfather), 값이 있으면 미래일 때만 유효.
    //
    // 2026-08-10 Chris 결정으로 grandfather(영구 무료)는 isProPlan=true + 기간 null(무기한)이 되어
    // 여기서 alreadySubscribed=true가 된다 → 앱의 구매 버튼이 잠긴다. **이게 의도다**:
    // 영구 무료 계정은 유료와 같은 기능을 이미 쓰고 있고 결제 시스템 자체를 걷어냈다.
    // (위 ②의 '막다른 길' 지적은 그때 grandfather가 유료 기능을 못 쓰던 전제에서 나온 것이고,
    //  이제는 기능이 동일하므로 구매를 막는 것이 맞다.)
    // 체험 중(기간 유효)인 monthly_pro는 여전히 막힌다 — 카드 체험과 스토어 구독의 이중과금 방지.
    const hasValidPro =
        !!sub &&
        isProPlan(sub.plan) &&
        (sub.current_period_end === null || new Date(sub.current_period_end) > new Date())

    return NextResponse.json({
        trialEligible: !sub?.trial_used,
        alreadySubscribed: hasValidPro,
        source: sub?.source ?? null,
        // 정보 필드(차단 신호 아님) — 감독자 본인 몫은 인앱, 좌석 몫은 카드로 공존 청구된다
        orgOwner: (ownedOrgs ?? 0) > 0,
    })
}
