import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/portone";

// PortOne V2 웹훅: 결제 상태 보정 (비동기 결과 동기화)
// NOTE: 운영 전 서명 검증(@portone/server-sdk Webhook.verify) 강화 권장.
export async function POST(request: Request) {
  try {
    const payload = await request.json().catch(() => null);
    const data = payload?.data || {};
    const paymentId: string | undefined = data.paymentId;
    const type: string = String(payload?.type || "");

    if (!paymentId) {
      return NextResponse.json({ received: true });
    }

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
  } catch (e: any) {
    console.error("webhook error:", e);
    return NextResponse.json({ received: true });
  }
}
