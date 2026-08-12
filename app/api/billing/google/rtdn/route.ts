// app/api/billing/google/rtdn/route.ts — Google Play 실시간 개발자 알림(RTDN) 수신
//
// 갱신·해지·환불·결제실패는 앱이 켜져 있지 않아도 일어난다. 구글이 Pub/Sub로 밀어주는 이 알림을
// 받아야 "해지했는데 계속 쓰이는" / "갱신됐는데 잠기는" 어긋남이 사라진다.
//
// 보안: 알림 내용(상태·기간)은 믿지 않는다. purchaseToken만 꺼내 **구글 API로 실제 상태를 다시 조회**해
// 반영하므로, 위조 알림으로 만들 수 있는 최대 피해는 "이미 아는 구독의 상태를 새로고침"뿐이다.
// 그 위에 공유 시크릿(?key=)으로 무의미한 호출 자체를 걸러낸다.

import { NextResponse } from "next/server"
import { getAdminClient } from "@/lib/portone"
import { getSubscription, toLocalStatus, isRevokedState, obfuscatedAccountIdFor, ANDROID_PACKAGE, type GooglePurchase } from "@/lib/googlePlay"
import { resolveStorePlan, storePlanPatch, reconcileCapacitySeats, effectiveCapacityForReconcile, foldSeatsIfOwnerLapsed } from "@/lib/storePlans"
import { restoreGrandfatherIfEligible } from "@/lib/grandfather"

export const runtime = "nodejs"

interface PubSubEnvelope {
    message?: { data?: string }
}

export async function POST(request: Request) {
    // 시크릿이 설정돼 있으면 일치해야 한다(미설정 시엔 검사 생략 — 초기 연결 확인용)
    const expected = process.env.GOOGLE_PLAY_RTDN_SECRET
    if (expected) {
        const key = new URL(request.url).searchParams.get("key")
        if (key !== expected) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }

    try {
        const envelope = (await request.json().catch(() => ({}))) as PubSubEnvelope
        const raw = envelope.message?.data
        // Pub/Sub는 2xx가 아니면 계속 재전송한다. 해석 불가한 메시지에 200을 주지 않으면 무한 재시도가 된다.
        if (!raw) return NextResponse.json({ ok: true, skipped: "no-data" })

        const payload = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
            packageName?: string
            subscriptionNotification?: { purchaseToken?: string }
            voidedPurchaseNotification?: { purchaseToken?: string }
            testNotification?: unknown
        }

        if (payload.testNotification) return NextResponse.json({ ok: true, test: true })
        if (payload.packageName && payload.packageName !== ANDROID_PACKAGE) {
            return NextResponse.json({ ok: true, skipped: "other-package" })
        }

        const admin = getAdminClient()

        // 환불·차지백: 구글이 돈을 돌려줬으므로 이용 권한도 즉시 회수한다
        const voidedToken = payload.voidedPurchaseNotification?.purchaseToken
        if (voidedToken) {
            const { data: voidedRows } = await admin
                .from("subscriptions")
                .update({
                    // status 체크 제약이 허용하는 값만 쓴다 — 'expired'를 쓰면 UPDATE가 실패해
                    // 환불했는데 권한이 살아 있는 상태가 된다. 기간을 과거로 박아 즉시 차단.
                    status: "canceled",
                    current_period_end: new Date().toISOString(),
                    canceled_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                })
                .eq("store_purchase_token", voidedToken)
                .select("user_id")
            // 환불·차지백 = 이용권 즉시 종료 확정 → 결제 전 grandfather였다면 영구 무료로 되돌린다
            for (const r of (voidedRows ?? []) as { user_id: string }[]) {
                await restoreGrandfatherIfEligible(admin, r.user_id)
                // 감독자였다면 그 조직의 좌석 미러도 즉시 접는다 — 카드 3회 실패 경로와 같은 처리.
                // 비치명: 실패해도 크론 스윕이 하루 안에 같은 일을 한다.
                try {
                    await foldSeatsIfOwnerLapsed(admin, r.user_id)
                } catch (e) {
                    console.error("RTDN voided: 좌석 미러 접기 실패", e)
                }
            }
            return NextResponse.json({ ok: true, voided: true })
        }

        const purchaseToken = payload.subscriptionNotification?.purchaseToken
        if (!purchaseToken) return NextResponse.json({ ok: true, skipped: "no-token" })

        // 우리가 모르는 토큰(다른 앱·이전 설치)은 조용히 무시 — 조회 비용도 아낀다
        const findRow = (token: string) =>
            admin
                .from("subscriptions")
                .select("id, user_id, store_seat_capacity")
                .eq("store_purchase_token", token)
                .maybeSingle()

        let { data: row } = await findRow(purchaseToken)

        // ── purchaseToken 회전 폴백 ────────────────────────────────────────────
        // 요금제를 갈아타면(스테퍼 +/−) 구글이 **새 purchaseToken**을 발급한다. 알림은 새 토큰으로
        // 오는데 DB에는 구 토큰이 있어, 여기서 포기하면 요금제 변경을 통째로 놓친다.
        // 특히 지연 다운그레이드(−)는 반영 경로가 RTDN뿐이라, 이 폴백이 없으면 **낸 돈보다 많은
        // 계정을 무기한** 쓰게 된다(증액은 verify가 즉시 반영해 테스트에서 티가 안 난다).
        // 조회를 한 번 더 하는 비용은 '모르는 토큰'일 때만 발생한다.
        let purchase: GooglePurchase | null = null
        if (!row) {
            // 모르는 토큰 조회 실패(폐기·404·5xx·쿼터)는 200으로 흘린다 — 여기서 throw하면 바깥
            // catch가 500을 주고 Pub/Sub가 보존 기간 내내 같은 메시지를 재전송한다. 재시도가
            // 의미 있는 것은 '우리가 아는 구독의 반영 실패'뿐이다(2026-08-10 검수).
            try {
                purchase = await getSubscription(purchaseToken)
            } catch (e) {
                console.error("RTDN: unknown-token lookup failed", e)
                return NextResponse.json({ ok: true, skipped: "lookup-failed" })
            }
            if (purchase.linkedPurchaseToken) {
                const linked = await findRow(purchase.linkedPurchaseToken)
                const candidate = linked.data
                // ⚠️ 소유권 대조 — verify가 지키는 유일한 관문(obfuscatedExternalAccountId)이
                // 이 폴백으로 우회되면 안 된다. 한 기기에서 앱 계정 A로 구독→만료→계정 B로
                // 재구독하면 새 구매의 linkedPurchaseToken이 A의 토큰이라, 대조 없이 채택하면
                // A가 B의 결제로 구독·정원을 얻고 B는 verify에서 409로 영구히 못 쓴다.
                // 표식이 없는 구형 결제는 폴백을 **포기**한다 — 토큰 회전을 한 번 놓치는 쪽이
                // 남의 구독을 붙이는 쪽보다 싸다(다음 verify·reconcile 크론이 다시 잡는다).
                if (candidate) {
                    const stamped = purchase.obfuscatedExternalAccountId
                    if (stamped && stamped === obfuscatedAccountIdFor(candidate.user_id)) {
                        row = candidate
                    } else {
                        console.warn("RTDN: linked-token owner mismatch — fallback abandoned", {
                            subId: candidate.id,
                            hasStamp: !!stamped,
                        })
                        return NextResponse.json({ ok: true, skipped: "account-mismatch" })
                    }
                }
            }
            if (!row) return NextResponse.json({ ok: true, skipped: "unknown-token" })
        }

        if (!purchase) purchase = await getSubscription(purchaseToken)
        const status = toLocalStatus(purchase)

        // 회수 상태(만료·보류·일시정지·미결제)는 남은 기간을 인정하지 않고 지금으로 끊는다.
        // 해지 예약(CANCELED)은 구글이 준 만료일까지 이용을 허용한다(이미 낸 돈이므로).
        const revoked = isRevokedState(purchase.subscriptionState)
        const periodEnd = revoked ? new Date().toISOString() : purchase.expiryTime

        // 요금제 → 좌석 정원. verify와 **같은 함수**를 쓴다(두 곳에 규칙을 베끼면 반드시 어긋난다).
        // 여기가 지연 다운그레이드(−)의 유일한 반영 경로다.
        const planLookup = await resolveStorePlan(
            admin,
            "google_play",
            purchase.productId,
            purchase.basePlanId
        )
        if (planLookup.kind !== "ok") {
            console.error("STORE_PLAN_UNMAPPED", {
                userId: row.user_id,
                productId: purchase.productId,
                basePlanId: purchase.basePlanId,
                kind: planLookup.kind,
            })
        }

        const { error: upErr } = await admin
            .from("subscriptions")
            .update({
                status,
                current_period_end: periodEnd,
                store_product_id: purchase.productId,
                // 회전한 토큰을 최신으로 — 다음 알림이 다시 폴백을 타지 않게 한다
                store_purchase_token: purchaseToken,
                canceled_at: status === "canceled" ? new Date().toISOString() : null,
                updated_at: new Date().toISOString(),
                // ok가 아니면 정원·금액에 손대지 않는다(현상 유지)
                ...storePlanPatch(planLookup, purchase.basePlanId),
            })
            .eq("id", row.id)
        // 갱신 실패를 삼키면 해지·환불이 반영되지 않은 채 200을 돌려주고 구글은 재전송을 멈춘다.
        // 500을 줘서 Pub/Sub가 다시 보내게 한다.
        if (upErr) {
            console.error("RTDN update error:", upErr)
            return NextResponse.json({ error: "구독 갱신 실패" }, { status: 500 })
        }

        // 회수 확정(만료·보류·일시정지·미결제)일 때만 영구 무료 복원 —
        // 해지 예약(CANCELED, 만료일 미래)에 걸면 이미 낸 유료 기간을 뺏는다.
        if (revoked) await restoreGrandfatherIfEligible(admin, row.user_id)

        // 정원이 줄었으면(지연 다운그레이드 적용·환불 후 매핑 변경) 초과분 현장을 최근 합류 순으로
        // 접는다. 멤버십은 남기므로 정원을 다시 올리면 자동 복원된다. 비치명 — 실패해도 다음
        // 알림이나 verify가 다시 잡는다.
        // ⚠️ planLookup.seatCapacity를 그대로 쓰면 monthly 강등(스테퍼 '−'의 최하단)에서 좌석이
        //    한 자리도 안 접혀 무과금 이용이 열린다 — effectiveCapacityForReconcile 주석 참조.
        const prevCapacity = (row.store_seat_capacity as number | null | undefined) ?? null
        const seatCapacity =
            planLookup.kind === "ok" ? effectiveCapacityForReconcile(planLookup, prevCapacity) : prevCapacity
        try {
            await reconcileCapacitySeats(admin, row.user_id, seatCapacity, !revoked)
        } catch (e) {
            console.error("RTDN: capacity seat reconcile failed", e)
        }

        // ⚠️ reconcileCapacitySeats는 '정원 초과분'만 접는다 — 구독이 회수돼도 정원에 여유가
        // 있으면 한 명도 안 접히고, 정원제가 아니면 아무것도 하지 않는다. 회수·만료로 감독자
        // 구독이 무효가 되면 **그 조직의 활성 좌석 전부**를 접어야 한다(카드 3회 실패와 같은 처리).
        try {
            await foldSeatsIfOwnerLapsed(admin, row.user_id)
        } catch (e) {
            console.error("RTDN: 좌석 미러 접기 실패", e)
        }

        return NextResponse.json({ ok: true, status, revoked, seatCapacity })
    } catch (error) {
        console.error("RTDN error:", error)
        // 5xx면 Pub/Sub가 재전송한다 — 일시 장애는 재시도로 복구되는 게 맞다
        return NextResponse.json({ error: "처리 실패" }, { status: 500 })
    }
}
