// app/api/billing/google/verify/route.ts — 앱 인앱결제 영수증 검증 및 구독 반영
//
// 앱은 결제가 끝나면 purchaseToken을 여기로 보낸다. 클라이언트가 보낸 상태(가격·기간·성공여부)는
// 일절 믿지 않고 구글에 직접 물어 확정한다. 성공 시 subscriptions를 google_play 출처로 갱신하고
// 구매 확인(acknowledge)까지 끝낸다 — 3일 내 미확인 시 구글이 자동 환불하기 때문.

import { NextResponse } from "next/server"
import { getUserFromRequest, getAdminClient } from "@/lib/portone"
import {
    getSubscription,
    acknowledge,
    toLocalStatus,
    isRevokedState,
    obfuscatedAccountIdFor,
} from "@/lib/googlePlay"
import { isStoreSource, ownsOrganization } from "@/lib/billing"
import { resolveStorePlan, storePlanPatch, reconcileCapacitySeats, effectiveCapacityForReconcile } from "@/lib/storePlans"
import { markGrandfatherForRestore } from "@/lib/grandfather"

export const runtime = "nodejs"

export async function POST(request: Request) {
    try {
        const user = await getUserFromRequest(request)
        if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 })

        const { purchaseToken } = (await request.json().catch(() => ({}))) as {
            purchaseToken?: unknown
        }
        if (typeof purchaseToken !== "string" || !purchaseToken.trim()) {
            return NextResponse.json({ error: "구매 정보가 없습니다." }, { status: 400 })
        }

        const purchase = await getSubscription(purchaseToken)

        // 결제 시작 때 심어둔 계정 표식이 현재 로그인 계정과 다르면 남의 영수증이다.
        // (구글은 이 값을 우리가 넣은 그대로 돌려준다 — 앱이 user.id를 넣는다)
        const stamped = purchase.obfuscatedExternalAccountId
        if (stamped && stamped !== obfuscatedAccountIdFor(user.id)) {
            return NextResponse.json({ error: "다른 계정의 결제입니다." }, { status: 403 })
        }

        const admin = getAdminClient()

        const { data: existing } = await admin
            .from("subscriptions")
            .select("id, trial_used, plan, source, billing_key, store_seat_capacity")
            .eq("user_id", user.id)
            .maybeSingle()

        // 감독자(회사 소유주)도 스토어 결제를 허용한다(2026-08-09 번복) — 본인 몫(4,900)은 스토어,
        // 좌석 몫(N×3,900)은 보존된 카드로 좌석 크론이 계속 청구한다. ownsOrg는 아래 카드 보존 판정용.
        const ownsOrg = await ownsOrganization(admin, user.id)

        // 같은 영수증이 다른 계정에 이미 붙어 있으면 거절 — 영수증 하나로 여러 계정을 여는 경로 차단.
        // (DB에도 유일 인덱스가 있지만, 여기서 막아야 사용자에게 이유를 설명할 수 있다)
        const { data: owner } = await admin
            .from("subscriptions")
            .select("user_id")
            .eq("store_purchase_token", purchaseToken)
            .maybeSingle()
        if (owner && owner.user_id !== user.id) {
            return NextResponse.json(
                { error: "이 결제는 다른 계정에 이미 연결되어 있습니다." },
                { status: 409 }
            )
        }

        const status = toLocalStatus(purchase)
        if (isRevokedState(purchase.subscriptionState)) {
            return NextResponse.json(
                { error: "이미 만료되었거나 사용할 수 없는 결제입니다.", status },
                { status: 409 }
            )
        }

        // grandfather(영구 무료)가 인앱결제를 하면 아래 patch가 plan을 monthly_pro로 덮어써
        // 그 지위가 영영 사라진다 — 해지해도 돌아올 자리가 없는 편도문(2026-08-10 적대적 검수).
        // 표식은 app_metadata(=service_role 전용)에 남긴다 — user_metadata는 클라이언트가
        // 직접 쓸 수 있어 아무나 '나는 원래 영구 무료였다'를 자칭할 수 있다.
        if (existing?.plan === "grandfather") {
            await markGrandfatherForRestore(admin, user.id)
        }

        // 좌석 정원은 요금제(base plan)가 정한다 — 문자열을 파싱하지 않고 store_products를 조인한다.
        // ok가 아니면(미등록·DB 장애) 정원·금액에 **손대지 않는다**: 매핑 누락 하나로 정상 고객의
        // 현장 계정이 잠기는 것이 최악이다. 대신 로그를 남겨 콘솔에 seed를 추가하면 다음 검증에 붙는다.
        const planLookup = await resolveStorePlan(
            admin,
            "google_play",
            purchase.productId,
            purchase.basePlanId
        )
        if (planLookup.kind !== "ok") {
            console.error("STORE_PLAN_UNMAPPED", {
                userId: user.id,
                productId: purchase.productId,
                basePlanId: purchase.basePlanId,
                kind: planLookup.kind,
            })
        }

        const patch: Record<string, unknown> = {
            user_id: user.id,
            plan: "monthly_pro",
            status,
            source: "google_play",
            store_product_id: purchase.productId,
            store_purchase_token: purchaseToken,
            current_period_end: purchase.expiryTime,
            // 금액은 매핑된 요금제 가격. 매핑이 없으면 기존 값을 유지하되, 신규 행은 기댈 값이
            // 없으므로 legacy 단일 요금제 가격(4,900 — 구글 수수료 포함, 웹 3,900과 별도)으로 연다.
            ...(planLookup.kind === "ok" ? {} : existing ? {} : { amount: 4900 }),
            currency: "KRW",
            canceled_at: status === "canceled" ? new Date().toISOString() : null,
            failed_attempts: 0,
            updated_at: new Date().toISOString(),
            // store_base_plan_id / store_seat_capacity / amount / pending 초기화 (ok일 때만)
            ...storePlanPatch(planLookup, purchase.basePlanId),
        }
        // 체험으로 개통됐다면 이 계정은 체험을 소진한 것으로 기록(웹에서 또 받지 못하게)
        if (purchase.isTrial) {
            patch.trial_used = true
            patch.trial_end = purchase.expiryTime
        }

        if (existing) {
            // PortOne 카드가 붙어 있던 계정이 앱 결제로 **넘어오면** 카드 자동청구를 끊는다 —
            // 안 끊으면 우리 크론과 구글이 같은 달에 각각 청구해 이중결제가 된다.
            // 단, 이미 스토어 출처(google_play·app_store)인 행의 카드는 좌석 몫(N×3,900)
            // 청구용으로 등록한 것(/api/billing/card)이다 — 재검증·복원(또는 iOS→안드로이드
            // 기기 교체)마다 지우면 좌석 청구가 끊겨 무과금이 된다.
            // 좌석(회사)을 가진 계정의 카드도 지우지 않는다 — 좌석 몫을 받을 유일한 수단이라
            // 지우는 순간 그 감독자의 현장이 전부 무과금이 된다.
            if (existing.billing_key && !isStoreSource(existing.source) && !ownsOrg) {
                patch.billing_key = null
                patch.billing_key_verified = false
                patch.card_info = null
            }
            const { error: upErr } = await admin
                .from("subscriptions")
                .update(patch)
                .eq("id", existing.id)
            // 저장 실패인데 성공을 돌려주면 앱이 finishTransaction까지 해버려 **영수증이 소실**되고
            // "돈은 냈는데 못 쓰는" 상태가 된다(앱은 재시도조차 하지 않는다).
            if (upErr) {
                console.error("google verify update error:", upErr)
                return NextResponse.json({ error: "구독 반영에 실패했습니다." }, { status: 500 })
            }
        } else {
            const { error: insErr } = await admin.from("subscriptions").insert(patch)
            if (insErr) {
                console.error("google verify insert error:", insErr)
                return NextResponse.json({ error: "구독 반영에 실패했습니다." }, { status: 500 })
            }
        }

        // 권한을 부여한 뒤에 확인 — 확인만 하고 반영에 실패하면 돈은 받고 못 쓰는 상태가 된다.
        // 요금제 교체(스테퍼 +)도 새 purchaseToken을 발급하므로 여기서 새 토큰으로 다시 확인해야
        // 한다 — 3일 내 미확인은 교체 구매에도 똑같이 자동 환불이다.
        if (!purchase.acknowledged && purchase.productId) {
            await acknowledge(purchase.productId, purchaseToken)
        }

        // 정원이 확정됐으면 실제 좌석을 그 안으로 맞춘다(정원 복구 시 접혔던 현장 자동 복원).
        // 비치명 — 실패해도 결제 반영은 이미 끝났고 RTDN·다음 검증이 다시 잡는다.
        // ⚠️ monthly 강등을 정원 1로 접기 위해 effectiveCapacityForReconcile을 거친다(RTDN과 동일 규율)
        const prevCapacity = (existing?.store_seat_capacity as number | null | undefined) ?? null
        const seatCapacity =
            planLookup.kind === "ok" ? effectiveCapacityForReconcile(planLookup, prevCapacity) : prevCapacity
        try {
            await reconcileCapacitySeats(admin, user.id, seatCapacity, !isRevokedState(purchase.subscriptionState))
        } catch (e) {
            console.error("verify: capacity seat reconcile failed", e)
        }

        return NextResponse.json({
            ok: true,
            status,
            expiresAt: purchase.expiryTime,
            trial: purchase.isTrial,
            // 앱이 "요청한 정원이 실제로 반영됐는지"를 대조한다 — 매핑 누락이면 요청값과 달라지고,
            // 앱은 조용히 성공 처리하는 대신 '요금제 반영이 지연되고 있어요'를 띄운다.
            basePlanId: purchase.basePlanId,
            seatCapacity,
        })
    } catch (error) {
        console.error("google verify error:", error)
        return NextResponse.json(
            { error: "결제 확인 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요." },
            { status: 500 }
        )
    }
}
