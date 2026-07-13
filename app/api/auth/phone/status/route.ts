import { NextResponse } from "next/server"
import { phoneAuthEnabled } from "@/lib/phoneAuth"

// 가입 위저드가 휴대폰인증 스텝을 보여줄지 결정 (키 미설정 프로덕션 = 기존 흐름 유지)
export async function GET() {
  return NextResponse.json({ enabled: phoneAuthEnabled() })
}
