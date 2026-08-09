// app/api/billing/apple/notifications/route.ts — App Store Server Notifications V2 수신
//
// 갱신·해지·환불·결제실패는 앱이 켜져 있지 않아도 일어난다. 애플이 밀어주는 이 알림을 받아야
// "해지했는데 계속 쓰이는" / "갱신됐는데 잠기는" 어긋남이 사라진다(구글 RTDN과 같은 역할).
//
// 보안: 본문 signedPayload는 애플이 서명한 JWS라 서명 검증만으로 진위가 확정된다(구글 RTDN의
// 공유 시크릿보다 강하다). 그럼에도 알림에 실린 상태·기간은 쓰지 않고 originalTransactionId만
// 꺼내 **애플 API로 실제 상태를 다시 조회**해 반영한다 — 리플레이된 옛 알림으로 상태가
// 되감기는 것을 막는다.

import { NextResponse } from "next/server"
import { getAdminClient } from "@/lib/portone"
import {
    verifyAppleJWS,
    getSubscription,
    toLocalStatus,
    isRevoked,
    APPLE_BUNDLE_ID,
    type AppleNotification,
    type AppleTransactionInfo,
} from "@/lib/appStore"
import { restoreGrandfatherIfEligible } from "@/lib/grandfather"

export const runtime = "nodejs"

export async function POST(request: Request) {
    // 선택적 공유 시크릿(URL ?key=) — 설정돼 있으면 서명 검증 전에 잡음을 걸러낸다
    const expected = process.env.APPLE_NOTIFICATIONS_SECRET
    if (expected) {
        const key = new URL(request.url).searchParams.get("key")
        if (key !== expected) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }

    try {
        const body = (await request.json().catch(() => ({}))) as { signedPayload?: unknown }
        // 애플은 2xx가 아니면 재전송한다. 해석 불가한 본문에 2xx를 주지 않으면 무한 재시도가 된다.
        if (typeof body.signedPayload !== "string" || !body.signedPayload) {
            return NextResponse.json({ ok: true, skipped: "no-payload" })
        }

        // 서명 검증 실패는 위조이거나 우리 검증이 깨진 것 — 어느 쪽이든 반영하면 안 된다.
        // 401을 주면 애플이 재전송하지만, 위조 호출에 무한 재시도가 붙는 편이 낫다.
        let payload: AppleNotification
        try {
            payload = verifyAppleJWS<AppleNotification>(body.signedPayload)
        } catch (e) {
            console.error("apple notification signature error:", e)
            return NextResponse.json({ error: "invalid signature" }, { status: 401 })
        }

        if (payload.notificationType === "TEST") return NextResponse.json({ ok: true, test: true })

        const bundleId = payload.data?.bundleId ?? payload.summary?.bundleId
        if (bundleId && bundleId !== APPLE_BUNDLE_ID) {
            return NextResponse.json({ ok: true, skipped: "other-bundle" })
        }

        const signedTx = payload.data?.signedTransactionInfo
        if (!signedTx) return NextResponse.json({ ok: true, skipped: "no-transaction" })
        const tx = verifyAppleJWS<AppleTransactionInfo>(signedTx)
        const token = tx.originalTransactionId ?? tx.transactionId
        if (!token) return NextResponse.json({ ok: true, skipped: "no-token" })

        const admin = getAdminClient()

        // 우리가 모르는 거래(다른 앱·미검증 구매)는 조용히 무시 — 조회 비용도 아낀다
        const { data: row } = await admin
            .from("subscriptions")
            .select("id, user_id")
            .eq("store_purchase_token", token)
            .maybeSingle()
        if (!row) return NextResponse.json({ ok: true, skipped: "unknown-token" })

        // 알림 내용이 아니라 애플의 현재 상태로 확정한다
        const purchase = await getSubscription(token)
        const status = toLocalStatus(purchase)

        // 회수 상태(만료·청구재시도·환불)는 남은 기간을 인정하지 않고 지금으로 끊는다.
        // 해지 예약(자동갱신 해제)은 애플이 준 만료일까지 이용을 허용한다(이미 낸 돈이므로).
        const revoked = isRevoked(purchase)
        const periodEnd = revoked ? new Date().toISOString() : purchase.expiresAt

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
        // 갱신 실패를 삼키면 해지·환불이 반영되지 않은 채 200을 돌려주고 애플은 재전송을 멈춘다.
        // 500을 줘서 애플이 다시 보내게 한다.
        if (upErr) {
            console.error("apple notification update error:", upErr)
            return NextResponse.json({ error: "구독 갱신 실패" }, { status: 500 })
        }

        // 회수 확정(환불·만료·청구재시도 실패)일 때만 영구 무료 복원 —
        // 해지 예약(자동갱신 해제, 만료일 미래)에 걸면 이미 낸 유료 기간을 뺏는다.
        if (revoked) await restoreGrandfatherIfEligible(admin, row.user_id)

        return NextResponse.json({
            ok: true,
            type: payload.notificationType ?? null,
            status,
            revoked,
        })
    } catch (error) {
        console.error("apple notification error:", error)
        // 5xx면 애플이 재전송한다 — 일시 장애는 재시도로 복구되는 게 맞다
        return NextResponse.json({ error: "처리 실패" }, { status: 500 })
    }
}
