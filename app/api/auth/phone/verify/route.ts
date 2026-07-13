import { NextResponse } from "next/server"
import { getAdminClient } from "@/lib/portone"
import { phoneAuthEnabled, normalizePhone, hashOtp } from "@/lib/phoneAuth"

export const runtime = "nodejs"

// 인증번호 확인 → 성공 시 verificationId 반환 (가입 API가 이 ID를 소진하며 체험을 개시)
export async function POST(request: Request) {
  try {
    if (!phoneAuthEnabled()) {
      return NextResponse.json({ error: "휴대폰 인증이 아직 준비되지 않았습니다." }, { status: 503 })
    }
    const body = await request.json().catch(() => ({}))
    const phone = normalizePhone(body?.phone)
    const code = typeof body?.code === "string" ? body.code.trim() : ""
    if (!phone || !/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: "인증번호 6자리를 입력해주세요." }, { status: 400 })
    }

    const admin = getAdminClient()
    const { data: otp } = await admin
      .from("phone_otps")
      .select("id, code_hash, attempts, verified, consumed, expires_at")
      .eq("phone", phone)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!otp || otp.consumed || new Date(otp.expires_at) < new Date()) {
      return NextResponse.json({ error: "인증번호가 만료되었습니다. 다시 요청해주세요." }, { status: 400 })
    }
    if (otp.attempts >= 5) {
      return NextResponse.json({ error: "시도 횟수를 초과했습니다. 인증번호를 다시 요청해주세요." }, { status: 429 })
    }

    if (otp.code_hash !== hashOtp(phone, code)) {
      await admin.from("phone_otps").update({ attempts: otp.attempts + 1 }).eq("id", otp.id)
      return NextResponse.json({ error: "인증번호가 올바르지 않습니다." }, { status: 400 })
    }

    await admin.from("phone_otps").update({ verified: true }).eq("id", otp.id)
    return NextResponse.json({ success: true, verificationId: otp.id })
  } catch (e) {
    console.error("phone verify error:", e)
    return NextResponse.json({ error: "인증 확인에 실패했습니다." }, { status: 500 })
  }
}
