import { NextResponse } from "next/server";
import { Webhook } from "@portone/server-sdk";
import { getAdminClient } from "@/lib/portone";

export const runtime = "nodejs";

// PortOne V2 웹훅: 서명 검증 후에만 결제 상태를 보정한다.
// 시크릿 미설정/검증 실패 시 DB를 변경하지 않는다(fail-closed).
export async function POST(request: Request) {
  const secret = process.env.PORTONE_WEBHOOK_SECRET;
  const bodyText = await request.text();

  if (!secret) {
    console.warn("PORTONE_WEBHOOK_SECRET 미설정 — 웹훅 검증 불가로 무시함");
    return NextResponse.json({ received: true });
  }

  let payload: any;
  try {
    payload = await Webhook.verify(secret, bodyText, {
      "webhook-id": request.headers.get("webhook-id") ?? "",
      "webhook-signature": request.headers.get("webhook-signature") ?? "",
      "webhook-timestamp": request.headers.get("webhook-timestamp") ?? "",
    });
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  try {
    const data = payload?.data || {};
    const paymentId: string | undefined = data.paymentId;
    const type = String(payload?.type || "");
    if (!paymentId) return NextResponse.json({ received: true });

    let status: "paid" | "failed" | "canceled" | null = null;
    if (/Paid/i.test(type)) status = "paid";
    else if (/Cancelled|Canceled/i.test(type)) status = "canceled";
    else if (/Failed/i.test(type)) status = "failed";

    if (status) {
      const admin = getAdminClient();
      await admin
        .from("payments")
        .update({
          status,
          paid_at: status === "paid" ? new Date().toISOString() : null,
        })
        .eq("payment_id", paymentId);
    }
    return NextResponse.json({ received: true });
  } catch (e) {
    console.error("webhook error:", e);
    return NextResponse.json({ received: true });
  }
}
