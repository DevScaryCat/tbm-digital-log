import { NextResponse } from "next/server"
import { getAdminClient } from "@/lib/portone"

export const runtime = "nodejs"

// 가입 위저드 1단계: 아이디 형식 + 중복 여부를 즉시 확인 (최종 제출 전에 걸러냄)
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}))
  const id = typeof body?.id === "string" ? body.id.trim().toLowerCase() : ""
  if (!/^[a-z0-9_]{3,20}$/.test(id)) {
    return NextResponse.json(
      { available: false, error: "아이디는 영문 소문자·숫자·밑줄 3~20자로 입력해주세요." },
      { status: 400 },
    )
  }
  const admin = getAdminClient()
  const { data, error } = await admin.rpc("check_login_id_taken", { p_id: id })
  if (error) {
    console.error("check-id error:", error)
    return NextResponse.json({ error: "확인 중 오류가 발생했습니다." }, { status: 500 })
  }
  return NextResponse.json({ available: data === false })
}
