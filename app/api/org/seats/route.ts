// app/api/org/seats/route.ts — 좌석 증설/감축 (안전관리자 전용)
// 증설: 즉시 일할 청구 + 즉시 활성. chargeSubscription을 재사용하면 정기 paymentId
// (sub_{id}_{다음결제일})를 선점해 다음 달 정기청구가 영구 누락된다(검증 F2) —
// 반드시 chargeWithBillingKey 직접 호출 + 전용 paymentId('seat_' 프리픽스)를 쓴다.
// 감축: organizations.pending_seat_count 예약 → 다음 정기청구에서 적용(chargeSubscription).
import { NextResponse } from "next/server";
import {
  getAdminClient,
  getUserFromRequest,
  chargeWithBillingKey,
  newPaymentId,
  ORG_SEAT_PRICE,
} from "@/lib/portone";
import { getOrgContext } from "@/lib/org";
import { paymentsEnabled } from "@/lib/utils";

export const runtime = "nodejs";

const MAX_SEATS = 100;
const DAY = 24 * 60 * 60 * 1000;

export async function POST(request: Request) {
  try {
    if (!paymentsEnabled()) {
      return NextResponse.json({ error: "결제 기능 준비 중입니다." }, { status: 403 });
    }
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

    const admin = getAdminClient();
    const ctx = await getOrgContext(user.id, admin);
    if (ctx.kind !== "owner" || !ctx.org) {
      return NextResponse.json({ error: "안전관리자 계정만 좌석을 관리할 수 있습니다." }, { status: 403 });
    }
    const org = ctx.org;

    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, plan, status, billing_key, current_period_end")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!sub || sub.plan !== "org" || !["active", "past_due"].includes(sub.status)) {
      return NextResponse.json({ error: "유효한 회사 플랜 구독이 없습니다." }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const now = new Date();

    // ── 증설: 즉시 일할 청구 + seat_count 즉시 증가 ─────────────────
    if (action === "increase") {
      const add = Math.floor(Number(body.add));
      if (!Number.isFinite(add) || add < 1 || org.seatCount + add > MAX_SEATS) {
        return NextResponse.json({ error: "추가 좌석 수가 올바르지 않습니다." }, { status: 400 });
      }
      if (!sub.billing_key) {
        return NextResponse.json({ error: "등록된 결제수단이 없습니다." }, { status: 400 });
      }
      const end = sub.current_period_end ? new Date(sub.current_period_end) : null;
      if (!end || end.getTime() <= now.getTime()) {
        return NextResponse.json(
          { error: "결제 주기 정보를 확인할 수 없습니다. 잠시 후 다시 시도해주세요." },
          { status: 409 }
        );
      }
      // 일할: 이번 주기 잔여일 비율 (주기 시작 = 종료-1개월 근사 30일 대신 실제 한 달 전 날짜)
      const periodStart = new Date(end);
      periodStart.setMonth(periodStart.getMonth() - 1);
      const total = Math.max(DAY, end.getTime() - periodStart.getTime());
      const remaining = Math.min(total, Math.max(0, end.getTime() - now.getTime()));
      const prorated = Math.max(100, Math.floor((ORG_SEAT_PRICE * add * remaining) / total)); // 최소 100원 (PG 최소금액)

      const paymentId = newPaymentId("seat");
      const res = await chargeWithBillingKey({
        paymentId,
        billingKey: sub.billing_key,
        orderName: `안톡 좌석 추가 ${add}명 (잔여기간 일할)`,
        amount: prorated,
        customer: { id: user.id, email: user.email ?? undefined },
      });
      const resBody: any = res.body || {};
      const pgStatus = String(resBody?.payment?.status ?? resBody?.status ?? "").toUpperCase();
      const paid = res.ok && (pgStatus === "" || pgStatus === "PAID");

      await admin.from("payments").upsert(
        {
          subscription_id: sub.id,
          user_id: user.id,
          payment_id: paymentId,
          amount: prorated,
          status: paid ? "paid" : "failed",
          pg_raw: resBody,
          paid_at: paid ? now.toISOString() : null,
        },
        { onConflict: "payment_id" }
      );
      if (!paid) {
        return NextResponse.json({ error: "좌석 추가 결제에 실패했습니다. 카드를 확인해주세요." }, { status: 402 });
      }

      const newSeats = org.seatCount + add;
      // 감축 예약이 있었다면 증설이 이를 대체 (혼재 방지)
      await admin
        .from("organizations")
        .update({ seat_count: newSeats, pending_seat_count: null })
        .eq("id", org.id);
      await admin
        .from("subscriptions")
        .update({ amount: newSeats * ORG_SEAT_PRICE, updated_at: now.toISOString() })
        .eq("id", sub.id);
      return NextResponse.json({ success: true, seatCount: newSeats, charged: prorated });
    }

    // ── 감축: 다음 결제일부터 적용 (pending_seat_count 예약) ─────────
    if (action === "decrease") {
      const to = Math.floor(Number(body.to));
      if (!Number.isFinite(to) || to < 1 || to >= org.seatCount) {
        return NextResponse.json({ error: "줄일 좌석 수가 올바르지 않습니다." }, { status: 400 });
      }
      const activeMembers = (ctx.memberIds ?? []).length;
      if (activeMembers > to) {
        return NextResponse.json(
          {
            error: `사용 중인 현장이 ${activeMembers}곳이라 좌석을 ${to}개로 줄일 수 없습니다. 먼저 좌석 관리에서 현장을 해제해주세요.`,
          },
          { status: 409 }
        );
      }
      await admin.from("organizations").update({ pending_seat_count: to }).eq("id", org.id);
      return NextResponse.json({ success: true, pendingSeatCount: to, effectiveDate: sub.current_period_end });
    }

    // ── 감축 예약 취소 ───────────────────────────────────────────────
    if (action === "cancel_decrease") {
      await admin.from("organizations").update({ pending_seat_count: null }).eq("id", org.id);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "알 수 없는 동작입니다." }, { status: 400 });
  } catch (e) {
    console.error("org seats error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
