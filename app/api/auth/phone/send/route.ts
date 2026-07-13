import { NextResponse } from "next/server"
import { getAdminClient } from "@/lib/portone"
import { phoneAuthEnabled, normalizePhone, hashOtp, generateOtpCode, sendOtpSms } from "@/lib/phoneAuth"

export const runtime = "nodejs"

// 인증번호 발송 (무인증 엔드포인트 — 가입 전이므로 로그인 없음)
// 남용 방어: 번호당 일 5회 + 재발송 60초 쿨다운 + IP당 일 20회. 발송 자체가 건당 과금이라 필수.
export async function POST(request: Request) {
  try {
    if (!phoneAuthEnabled()) {
      return NextResponse.json({ error: "휴대폰 인증이 아직 준비되지 않았습니다." }, { status: 503 })
    }
    const body = await request.json().catch(() => ({}))
    const phone = normalizePhone(body?.phone)
    if (!phone) {
      return NextResponse.json({ error: "올바른 휴대폰 번호(010)를 입력해주세요." }, { status: 400 })
    }

    const admin = getAdminClient()

    // 이미 체험을 소진한 번호면 발송 전에 알려준다 (SMS 비용 절약 + 명확한 안내)
    const { data: redeemed } = await admin
      .from("trial_redemptions").select("id").eq("phone", phone).maybeSingle()
    if (redeemed) {
      return NextResponse.json(
        { error: "이 번호로는 무료체험을 이미 사용했습니다. 로그인 후 결제수단을 등록해 이용해주세요." },
        { status: 409 },
      )
    }

    const dayAgoISO = new Date(Date.now() - 24 * 3600 * 1000).toISOString()

    // 번호당 일 5회
    const { count: phoneCount } = await admin
      .from("phone_otps").select("id", { count: "exact", head: true })
      .eq("phone", phone).gte("created_at", dayAgoISO)
    if ((phoneCount ?? 0) >= 5) {
      return NextResponse.json({ error: "인증번호 발송 한도를 초과했습니다. 내일 다시 시도해주세요." }, { status: 429 })
    }

    // 재발송 60초 쿨다운
    const { data: recent } = await admin
      .from("phone_otps").select("created_at").eq("phone", phone)
      .order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (recent && Date.now() - new Date(recent.created_at).getTime() < 60_000) {
      return NextResponse.json({ error: "잠시 후 다시 요청해주세요. (60초)" }, { status: 429 })
    }

    // IP당 일 20회 (프록시 뒤라 참고용 방어선)
    const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown"
    const { count: ipCount } = await admin
      .from("phone_otps").select("id", { count: "exact", head: true })
      .eq("purpose", `trial_gate:${ip}`).gte("created_at", dayAgoISO)
    if ((ipCount ?? 0) >= 20) {
      return NextResponse.json({ error: "요청이 너무 많습니다. 내일 다시 시도해주세요." }, { status: 429 })
    }

    const code = generateOtpCode()
    const { error: insErr } = await admin.from("phone_otps").insert({
      phone,
      code_hash: hashOtp(phone, code),
      purpose: `trial_gate:${ip}`, // IP 캡 집계를 위해 purpose에 IP를 함께 기록
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    })
    if (insErr) {
      console.error("phone_otps insert error:", insErr)
      return NextResponse.json({ error: "발송 준비에 실패했습니다." }, { status: 500 })
    }

    await sendOtpSms(phone, code)
    return NextResponse.json({ success: true })
  } catch (e) {
    console.error("phone send error:", e)
    return NextResponse.json({ error: "인증번호 발송에 실패했습니다." }, { status: 500 })
  }
}
