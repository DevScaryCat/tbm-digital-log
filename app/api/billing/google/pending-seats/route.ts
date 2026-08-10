// app/api/billing/google/pending-seats/route.ts — 지연 다운그레이드(−) 예약값 기록 (표시 전용)
//
// 왜 필요한가: 정원을 줄이는 요금제 변경은 플랫폼이 **다음 결제일 적용**을 강제한다(우회 불가).
// deferred 교체는 구매 콜백이 즉시 오지 않아 앱 화면의 숫자가 그대로다 — "눌렀는데 아무 일도
// 안 일어난다"가 된다. 그래서 예약값을 여기 적어두고 "N개로 변경 예약됨 · M월 D일 적용"을 띄운다.
//
// ⚠️ 이 값은 **클라이언트 주장값**이다. 발급 게이트·청구에 절대 쓰지 않는다(그 둘은 오직
// subscriptions.store_seat_capacity를 본다). 실제 정원은 RTDN이 갱신하며 그때 이 필드를 비운다.
// 그래도 아무 숫자나 받지는 않는다 — store_products에 실재하는 요금제이고, 현재 정원보다
// **작을 때만** 받는다. 증액은 즉시 반영(verify)이라 예약이라는 개념 자체가 없다.

import { NextResponse } from "next/server"
import { getUserFromRequest, getAdminClient } from "@/lib/portone"
import { resolveStorePlan } from "@/lib/storePlans"

export const runtime = "nodejs"

export async function POST(request: Request) {
    try {
        const user = await getUserFromRequest(request)
        if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 })

        const { basePlanId } = (await request.json().catch(() => ({}))) as { basePlanId?: unknown }
        if (typeof basePlanId !== "string" || !basePlanId.trim()) {
            return NextResponse.json({ error: "요금제 정보가 없습니다." }, { status: 400 })
        }

        const admin = getAdminClient()
        const { data } = await admin
            .from("subscriptions")
            .select("id, source, store_product_id, store_seat_capacity, current_period_end")
            .eq("user_id", user.id)
            .maybeSingle()
        const sub = data as {
            id: string
            source: string | null
            store_product_id: string | null
            store_seat_capacity: number | null
            current_period_end: string | null
        } | null
        if (!sub || sub.source !== "google_play") {
            return NextResponse.json({ error: "앱 구독이 아닙니다." }, { status: 409 })
        }
        const current = sub.store_seat_capacity
        if (current == null) {
            return NextResponse.json({ error: "정원제 구독이 아닙니다." }, { status: 409 })
        }

        const lookup = await resolveStorePlan(admin, "google_play", sub.store_product_id, basePlanId)
        if (lookup.kind !== "ok" || lookup.seatCapacity == null) {
            return NextResponse.json({ error: "알 수 없는 요금제입니다." }, { status: 400 })
        }
        if (lookup.seatCapacity >= current) {
            // 증액은 결제가 즉시 일어나고 verify가 정원을 확정한다 — 예약으로 기록할 것이 없다.
            return NextResponse.json({ error: "예약 대상이 아닙니다." }, { status: 400 })
        }

        const { error: upErr } = await admin
            .from("subscriptions")
            .update({
                store_pending_seat_capacity: lookup.seatCapacity,
                updated_at: new Date().toISOString(),
            })
            .eq("id", sub.id)
        if (upErr) {
            console.error("pending-seats update error:", upErr)
            return NextResponse.json({ error: "예약 기록에 실패했습니다." }, { status: 500 })
        }

        return NextResponse.json({
            ok: true,
            pendingSeatCapacity: lookup.seatCapacity,
            // 화면이 "언제부터 적용되는지"를 날짜로 못박을 수 있게 한다
            effectiveAt: sub.current_period_end ?? null,
        })
    } catch (e) {
        console.error("pending-seats error:", e)
        return NextResponse.json({ error: "서버 오류" }, { status: 500 })
    }
}
