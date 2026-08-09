// app/api/billing/apple/verify/route.ts — iOS 인앱결제 영수증 검증 및 구독 반영
//
// 앱은 결제가 끝나면 transactionId를 여기로 보낸다. 클라이언트가 보낸 상태(가격·기간·성공여부)는
// 일절 믿지 않고 애플에 직접 물어 확정한다. 성공 시 subscriptions를 app_store 출처로 갱신한다.
// (애플은 구글의 acknowledge에 해당하는 서버 호출이 없다 — 거래 완료(finish)는 StoreKit이
//  기기에서 처리하므로, 앱이 이 API의 성공 응답을 받은 뒤 finish 하면 된다.)

import { NextResponse } from "next/server"
import { getUserFromRequest, getAdminClient } from "@/lib/portone"
import { getSubscription, toLocalStatus, isRevoked } from "@/lib/appStore"
import { isStoreSource, storePurchaseGuard } from "@/lib/billing"

export const runtime = "nodejs"

export async function POST(request: Request) {
    try {
        const user = await getUserFromRequest(request)
        if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 })

        const body = (await request.json().catch(() => ({}))) as {
            transactionId?: unknown
            originalTransactionId?: unknown
        }
        const rawId =
            typeof body.transactionId === "string" && body.transactionId.trim()
                ? body.transactionId.trim()
                : typeof body.originalTransactionId === "string"
                  ? body.originalTransactionId.trim()
                  : ""
        if (!rawId) {
            return NextResponse.json({ error: "구매 정보가 없습니다." }, { status: 400 })
        }

        const purchase = await getSubscription(rawId)

        // 결제 시작 때 심어둔 계정 표식이 현재 로그인 계정과 다르면 남의 영수증이다.
        // (애플은 appAccountToken을 UUID로만 받고 우리가 넣은 그대로 돌려준다 — 앱이 user.id를 넣는다)
        const stamped = purchase.appAccountToken
        if (stamped && stamped.toLowerCase() !== user.id.toLowerCase()) {
            return NextResponse.json({ error: "다른 계정의 결제입니다." }, { status: 403 })
        }

        const admin = getAdminClient()
        const token = purchase.originalTransactionId

        const { data: existing } = await admin
            .from("subscriptions")
            .select("id, trial_used, source, billing_key")
            .eq("user_id", user.id)
            .maybeSingle()

        // 감독자(회사 소유주)는 인앱 단일 상품으로 커버되지 않는다 — 앱 UI(eligibility)만이 아니라
        // 여기서도 막아야 API 직타로 좌석 몫(N×3,900)이 통째로 무과금이 되는 경로가 닫힌다.
        const guard = await storePurchaseGuard(admin, user.id, existing?.source)
        if (guard.block) return NextResponse.json({ error: guard.block }, { status: 409 })

        // 같은 영수증이 다른 계정에 이미 붙어 있으면 거절 — 영수증 하나로 여러 계정을 여는 경로 차단.
        // (DB에도 부분 유일 인덱스가 있지만, 여기서 막아야 사용자에게 이유를 설명할 수 있다)
        const { data: owner } = await admin
            .from("subscriptions")
            .select("user_id")
            .eq("store_purchase_token", token)
            .maybeSingle()
        if (owner && owner.user_id !== user.id) {
            return NextResponse.json(
                { error: "이 결제는 다른 계정에 이미 연결되어 있습니다." },
                { status: 409 }
            )
        }

        const status = toLocalStatus(purchase)
        if (isRevoked(purchase)) {
            return NextResponse.json(
                { error: "이미 만료되었거나 사용할 수 없는 결제입니다.", status },
                { status: 409 }
            )
        }

        const patch: Record<string, unknown> = {
            user_id: user.id,
            plan: "monthly_pro",
            status,
            source: "app_store",
            store_product_id: purchase.productId,
            store_purchase_token: token,
            current_period_end: purchase.expiresAt,
            amount: 4900, // 앱 가격(스토어 수수료 15% 포함) — 웹 3,900원과 별도
            currency: "KRW",
            canceled_at: status === "canceled" ? new Date().toISOString() : null,
            failed_attempts: 0,
            updated_at: new Date().toISOString(),
        }
        // 체험으로 개통됐다면 이 계정은 체험을 소진한 것으로 기록(웹·안드로이드에서 또 받지 못하게)
        if (purchase.isTrial) {
            patch.trial_used = true
            patch.trial_end = purchase.expiresAt
        }

        if (existing) {
            // PortOne 카드가 붙어 있던 계정이 앱 결제로 **넘어오면** 카드 자동청구를 끊는다 —
            // 안 끊으면 우리 크론과 애플이 같은 달에 각각 청구해 이중결제가 된다.
            // 단, 이미 스토어 출처(app_store/google_play)인 행의 카드는 좌석 몫(N×3,900)
            // 청구용으로 등록한 것(/api/billing/card)이라 재검증·복원 때 지우면 좌석 청구가 끊긴다.
            // 좌석(회사)을 가진 계정의 카드도 지우지 않는다 — 좌석 몫을 받을 유일한 수단이라
            // 지우는 순간 그 감독자의 현장이 전부 무과금이 된다(위 guard가 이미 대부분 막지만,
            // 스토어 결제 중인 감독자 경로가 여기로 들어온다).
            if (existing.billing_key && !isStoreSource(existing.source) && !guard.ownsOrg) {
                patch.billing_key = null
                patch.billing_key_verified = false
                patch.card_info = null
            }
            const { error: upErr } = await admin
                .from("subscriptions")
                .update(patch)
                .eq("id", existing.id)
            // 저장 실패인데 성공을 돌려주면 "돈은 냈는데 못 쓰는" 상태가 되고 앱은 재시도조차 안 한다
            if (upErr) {
                console.error("apple verify update error:", upErr)
                return NextResponse.json({ error: "구독 반영에 실패했습니다." }, { status: 500 })
            }
        } else {
            const { error: insErr } = await admin.from("subscriptions").insert(patch)
            if (insErr) {
                console.error("apple verify insert error:", insErr)
                return NextResponse.json({ error: "구독 반영에 실패했습니다." }, { status: 500 })
            }
        }

        return NextResponse.json({
            ok: true,
            status,
            expiresAt: purchase.expiresAt,
            trial: purchase.isTrial,
            environment: purchase.environment,
        })
    } catch (error) {
        console.error("apple verify error:", error)
        return NextResponse.json(
            { error: "결제 확인 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요." },
            { status: 500 }
        )
    }
}
