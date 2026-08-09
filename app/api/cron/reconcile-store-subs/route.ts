// app/api/cron/reconcile-store-subs/route.ts — 스토어 구독(구글 Play·애플 App Store) 재조회 스윕
//
// 왜 필요한가: 스토어 구독의 상태는 서버 알림(RTDN·App Store Server Notifications)에만 의존해
// 갱신돼 왔다. 알림은 유실된다 — 엔드포인트 미등록·URL 오타·우리 쪽 장애가 재전송 한도를
// 넘김·Pub/Sub 구독 만료. 그러면 환불·해지·만료가 **영영 반영되지 않고** subscriptions 행이
// status='active'인 채 남아 무기한 무료 이용이 된다(subscriptionAllows는 status만 보고 통과시킨다).
//
// 그래서 하루 한 번, 이용 기간이 지난 스토어 행을 스토어에 직접 다시 물어 상태를 확정한다.
// 알림이 정상이면 이 크론은 대부분 아무것도 바꾸지 않는다(기간이 미래로 밀려 대상에서 빠진다).
//
// 멱등: 매 실행이 스토어의 현재 상태로 덮어쓸 뿐이라 같은 날 여러 번 돌려도 결과가 같다.
// 회수된 행의 만료일도 이미 과거면 그대로 둔다(now()로 매번 다시 박지 않는다).

import { NextResponse } from "next/server"
import { getAdminClient } from "@/lib/portone"
import { STORE_SOURCES } from "@/lib/billing"
import { storeSyncPatch, type StoreSyncRow } from "@/lib/storeSync"
import {
    getSubscription as getAppleSubscription,
    toLocalStatus as appleToLocalStatus,
    isRevoked as appleIsRevoked,
} from "@/lib/appStore"
import {
    getSubscription as getGoogleSubscription,
    toLocalStatus as googleToLocalStatus,
    isRevokedState as googleIsRevoked,
} from "@/lib/googlePlay"

export const runtime = "nodejs"
// 스토어 왕복이 건당 수백 ms — 건수가 늘어도 뒤쪽 행이 타임아웃으로 누락되지 않게 명시
export const maxDuration = 300

export async function POST(request: Request) {
    return run(request)
}
// Vercel Cron은 GET으로 호출됨
export async function GET(request: Request) {
    return run(request)
}

interface StoreRow extends StoreSyncRow {
    id: string
    source: string | null
    store_purchase_token: string | null
}

async function run(request: Request) {
    const cronSecret = process.env.CRON_SECRET
    const provided = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
    if (!cronSecret || provided !== cronSecret) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const admin = getAdminClient()
        const now = new Date()
        const nowIso = now.toISOString()

        // 대상: 스토어 출처 + 이용 기간이 이미 지난 행.
        // 상태로 거르지 않는다 — 앱 밖(스토어 설정)에서 재구독하면 우리 verify를 타지 않으므로,
        // canceled로 접힌 행도 다시 물어봐야 되살아난다.
        const { data: rows, error } = await admin
            .from("subscriptions")
            .select(
                "id, source, status, current_period_end, store_purchase_token, store_product_id, canceled_at"
            )
            .in("source", STORE_SOURCES as unknown as string[])
            .not("store_purchase_token", "is", null)
            // 기간이 지난 행 + 기간이 아예 없는 행(만료일을 못 받아 저장된 고장난 행 — 이대로
            // 두면 어떤 스윕에도 걸리지 않고 영구 이용이 된다)
            .or(`current_period_end.is.null,current_period_end.lt.${nowIso}`)
            .order("current_period_end", { ascending: true })
            .limit(300)

        if (error) {
            console.error("reconcile-store-subs query error:", error)
            return NextResponse.json({ error: "조회 실패" }, { status: 500 })
        }

        const summary = { checked: 0, renewed: 0, revoked: 0, unchanged: 0, failed: 0 }
        const errors: string[] = []

        for (const row of (rows ?? []) as StoreRow[]) {
            summary.checked++
            // 한 건이 실패해도 나머지는 계속 처리한다 — 죽은 영수증 하나로 스윕 전체가 멈추면
            // 애초에 막으려던 누수가 그대로 남는다.
            try {
                const token = row.store_purchase_token as string
                let status: string
                let revoked: boolean
                let storeEnd: string | null
                let productId: string | null

                if (row.source === "app_store") {
                    const p = await getAppleSubscription(token)
                    status = appleToLocalStatus(p)
                    revoked = appleIsRevoked(p)
                    storeEnd = p.expiresAt
                    productId = p.productId
                } else {
                    const p = await getGoogleSubscription(token)
                    status = googleToLocalStatus(p)
                    revoked = googleIsRevoked(p.subscriptionState)
                    storeEnd = p.expiryTime
                    productId = p.productId
                }

                const { changed, patch } = storeSyncPatch(
                    row,
                    { status, revoked, storeEnd, productId },
                    now
                )
                if (!changed) {
                    summary.unchanged++
                    continue
                }

                const { error: upErr } = await admin
                    .from("subscriptions")
                    .update(patch)
                    .eq("id", row.id)
                if (upErr) throw new Error(`저장 실패: ${upErr.message}`)

                if (revoked) summary.revoked++
                else summary.renewed++
            } catch (e) {
                summary.failed++
                const msg = e instanceof Error ? e.message : String(e)
                console.error("reconcile-store-subs error:", row.id, msg)
                // 운영에서 원인을 바로 보되 응답이 비대해지지 않게 앞 5건만
                if (errors.length < 5) errors.push(`${row.id}: ${msg.slice(0, 200)}`)
            }
        }

        return NextResponse.json({ success: true, ...summary, errors })
    } catch (e: any) {
        console.error("reconcile-store-subs route error:", e)
        return NextResponse.json({ error: "서버 오류" }, { status: 500 })
    }
}
