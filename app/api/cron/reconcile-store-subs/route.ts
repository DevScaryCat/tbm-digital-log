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
import { resolveStorePlan, storePlanPatch, reconcileCapacitySeats, effectiveCapacityForReconcile, foldSeatsIfOwnerLapsed } from "@/lib/storePlans"
import { restoreGrandfatherIfEligible } from "@/lib/grandfather"
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
    user_id: string
    source: string | null
    store_purchase_token: string | null
    // 요금제(정원) 동기화 비교용 — 값이 그대로면 UPDATE를 내지 않는다(멱등 유지)
    store_base_plan_id: string | null
    store_seat_capacity: number | null
    store_pending_seat_capacity: number | null
    amount: number | null
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
                "id, user_id, source, status, current_period_end, store_purchase_token, store_product_id, canceled_at, store_base_plan_id, store_seat_capacity, store_pending_seat_capacity, amount"
            )
            .in("source", STORE_SOURCES as unknown as string[])
            .not("store_purchase_token", "is", null)
            // 기간이 지난 행 + 기간이 아예 없는 행(만료일을 못 받아 저장된 고장난 행 — 이대로
            // 두면 어떤 스윕에도 걸리지 않고 영구 이용이 된다)
            .or(`current_period_end.is.null,current_period_end.lt.${nowIso}`)
            // NULL을 먼저 본다. Postgres의 ASC 기본값은 NULLS LAST라, 그냥 두면 만료일이 없는
            // 행(=위 주석이 말한 '영구 이용' 행)이 항상 맨 뒤로 밀려 limit을 넘는 순간 영원히
            // 스윕에 도달하지 못한다 — 가장 위험한 행이 가장 먼저 굶는다.
            .order("current_period_end", { ascending: true, nullsFirst: true })
            .limit(300)

        if (error) {
            console.error("reconcile-store-subs query error:", error)
            return NextResponse.json({ error: "조회 실패" }, { status: 500 })
        }

        const summary = { checked: 0, renewed: 0, revoked: 0, unchanged: 0, failed: 0, planSynced: 0 }
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
                let basePlanId: string | null = null

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
                    // 요금제(base plan)까지 읽는다 — 정원의 근거는 상품이 아니라 이 값이다.
                    basePlanId = p.basePlanId
                }

                const { changed, patch } = storeSyncPatch(
                    row,
                    { status, revoked, storeEnd, productId },
                    now
                )

                // ── 요금제(정원) 동기화 ────────────────────────────────────────
                // 지연 다운그레이드(−)의 반영 경로가 RTDN 하나뿐이면, 알림 유실 시 감독자가
                // **낮은 요금으로 높은 정원**을 무기한 유지한다. 이 크론이 바로 그 유실의
                // 백스톱인데 정원만 구멍이 나 있었다(2026-08-10 검수).
                // 규칙은 손으로 베끼지 않는다 — verify·RTDN과 **같은 함수**를 쓴다.
                let planPatch: Record<string, unknown> = {}
                let capacity = row.store_seat_capacity ?? null
                // 좌석을 접을 때 쓸 실효 정원 — 컬럼에 쓰는 값(capacity)과 다를 수 있다.
                // monthly 강등은 컬럼엔 NULL을 쓰되 좌석은 정원 1로 접어야 무과금이 안 생긴다.
                let reconcileCapacity: number | null = capacity
                if (row.source === "google_play" && basePlanId) {
                    const lookup = await resolveStorePlan(admin, "google_play", productId, basePlanId)
                    if (lookup.kind === "ok") {
                        planPatch = storePlanPatch(lookup, basePlanId)
                        capacity = lookup.seatCapacity
                        reconcileCapacity = effectiveCapacityForReconcile(lookup, row.store_seat_capacity ?? null)
                    } else {
                        // ok가 아니면 현상 유지 — 매핑 누락 하나로 정상 고객의 현장이 잠기면 안 된다
                        console.error("STORE_PLAN_UNMAPPED", {
                            userId: row.user_id,
                            productId,
                            basePlanId,
                            kind: lookup.kind,
                        })
                    }
                }
                // 값이 그대로면 UPDATE를 내지 않는다(이 크론의 멱등 규율)
                const planChanged =
                    Object.keys(planPatch).length > 0 &&
                    ((capacity ?? null) !== (row.store_seat_capacity ?? null) ||
                        (basePlanId ?? null) !== (row.store_base_plan_id ?? null) ||
                        row.store_pending_seat_capacity != null ||
                        Number(planPatch.amount) !== Number(row.amount ?? NaN))

                if (changed || planChanged) {
                    const { error: upErr } = await admin
                        .from("subscriptions")
                        .update(planChanged ? { ...patch, ...planPatch } : patch)
                        .eq("id", row.id)
                    if (upErr) throw new Error(`저장 실패: ${upErr.message}`)
                    if (planChanged) summary.planSynced++
                }

                // 정원이 실제로 바뀌었으면 좌석을 그 안으로 맞춘다(초과분 접기·복원).
                // 비치명 — 실패해도 다음 스윕이나 RTDN·verify가 다시 잡는다.
                if (planChanged && reconcileCapacity != null) {
                    try {
                        await reconcileCapacitySeats(admin, row.user_id, reconcileCapacity, !revoked)
                    } catch (e) {
                        console.error("reconcile-store-subs: capacity seat reconcile failed", row.id, e)
                    }
                }

                // 회수 확정 → 결제 전 grandfather였다면 영구 무료로 되돌린다.
                // changed 여부와 무관하게 시도한다: 알림이 이미 회수를 반영해 둔 뒤라
                // (changed=false) 복원만 남은 경우가 있고, 한 번 실패해도 다음 스윕이 다시 잡는다.
                // 복원되면 행이 portone/토큰 없음으로 바뀌어 이 쿼리 대상에서 영구히 빠진다.
                if (revoked) await restoreGrandfatherIfEligible(admin, row.user_id)

                // 회수·만료가 확정된 감독자의 좌석 미러는 **전부** 접는다.
                // reconcileCapacitySeats는 정원 초과분만 접으므로 여유가 있으면 한 명도 안 접힌다
                // (정원제가 아니면 아예 아무것도 안 한다) — 그 사이가 무과금 구간이었다.
                // 판정은 저장된 상태가 한다(해지 예약처럼 잔여 기간이 남으면 무동작).
                try {
                    await foldSeatsIfOwnerLapsed(admin, row.user_id)
                } catch (e) {
                    console.error("reconcile-store-subs: 좌석 미러 접기 실패", row.id, e)
                }

                if (!changed) {
                    // 요금제만 바뀐 건은 planSynced로 이미 셌다 — unchanged로 또 세지 않는다
                    if (!planChanged) summary.unchanged++
                    continue
                }

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
