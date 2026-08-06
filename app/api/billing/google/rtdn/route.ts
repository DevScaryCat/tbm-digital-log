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
import { getSubscription, toLocalStatus, isRevokedState, ANDROID_PACKAGE } from "@/lib/googlePlay"

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
            await admin
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
            return NextResponse.json({ ok: true, voided: true })
        }

        const purchaseToken = payload.subscriptionNotification?.purchaseToken
        if (!purchaseToken) return NextResponse.json({ ok: true, skipped: "no-token" })

        // 우리가 모르는 토큰(다른 앱·이전 설치)은 조용히 무시 — 조회 비용도 아낀다
        const { data: row } = await admin
            .from("subscriptions")
            .select("id")
            .eq("store_purchase_token", purchaseToken)
            .maybeSingle()
        if (!row) return NextResponse.json({ ok: true, skipped: "unknown-token" })

        const purchase = await getSubscription(purchaseToken)
        const status = toLocalStatus(purchase)

        // 회수 상태(만료·보류·일시정지·미결제)는 남은 기간을 인정하지 않고 지금으로 끊는다.
        // 해지 예약(CANCELED)은 구글이 준 만료일까지 이용을 허용한다(이미 낸 돈이므로).
        const revoked = isRevokedState(purchase.subscriptionState)
        const periodEnd = revoked ? new Date().toISOString() : purchase.expiryTime

        const { error: upErr } = await admin
            .from("subscriptions")
            .update({
                status,
                current_period_end: periodEnd,
                store_product_id: purchase.productId,
                canceled_at: status === "canceled" ? new Date().toISOString() : null,
                updated_at: new Date().toISOString(),
            })
            .eq("id", row.id)
        // 갱신 실패를 삼키면 해지·환불이 반영되지 않은 채 200을 돌려주고 구글은 재전송을 멈춘다.
        // 500을 줘서 Pub/Sub가 다시 보내게 한다.
        if (upErr) {
            console.error("RTDN update error:", upErr)
            return NextResponse.json({ error: "구독 갱신 실패" }, { status: 500 })
        }

        return NextResponse.json({ ok: true, status, revoked })
    } catch (error) {
        console.error("RTDN error:", error)
        // 5xx면 Pub/Sub가 재전송한다 — 일시 장애는 재시도로 복구되는 게 맞다
        return NextResponse.json({ error: "처리 실패" }, { status: 500 })
    }
}
