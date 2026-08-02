// app/api/onboarding/route.ts — 첫 로그인 온보딩 모달 저장 (사용 형태 · 내 이메일 · 출력 형식)
//
// 이메일은 인증 절차 없이 그대로 수신처가 된다(Chris 결정). 가입 직후 인증 메일을 한 번 더
// 누르게 하는 마찰이 실등록률을 죽였고(운영 25계정 중 18개 이메일 없음), 본인이 받겠다고
// 본인 주소를 적는 자리라 "받아도 되냐"는 승인 질문 자체가 성립하지 않는다.
// 오타 리스크는 화면 문구("여기로 보고서가 갑니다 — 정확하게")와 내 정보 수정의 변경 경로로 진다.
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { ensureSelfConsent } from "@/lib/consent";
import { isValidEmail } from "@/lib/emailVerification";
import { EXPORT_FORMATS } from "@/lib/exportFormats";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const usage = body.usage === "multi" ? "multi" : "solo";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const exportFormat = EXPORT_FORMATS.some((f) => f.value === body.exportFormat) ? String(body.exportFormat) : "";

  if (!exportFormat) {
    return NextResponse.json({ error: "출력 형식을 선택해주세요." }, { status: 400 });
  }
  if (email && (!isValidEmail(email) || email.toLowerCase().endsWith("@tbm.com"))) {
    return NextResponse.json({ error: "이메일 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const admin = getAdminClient();
  const now = new Date().toISOString();
  try {
    // admin update는 metadata 전체 치환 — 최신 값을 읽어 병합 (다른 키 유실 방지)
    const { data: u } = await admin.auth.admin.getUserById(user.id);
    const meta = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
    await admin.auth.admin.updateUserById(user.id, {
      user_metadata: {
        ...meta,
        preferred_export_format: exportFormat,
        usage_type: usage,
        onboarded_at: now,
        // 이메일을 적었으면 즉시 '인증된 내 이메일'로 — 위 파일 머리말의 결정 사항
        ...(email ? { real_email: email, real_email_verified_at: now } : {}),
      },
    });
  } catch (e) {
    console.error("onboarding metadata update 실패:", e);
    return NextResponse.json({ error: "저장에 실패했습니다. 잠시 후 다시 시도해주세요." }, { status: 500 });
  }

  // 수신처에도 바로 올린다 — 발송 판정(approved만 발송)과 화면 목록이 이 행을 본다
  if (email) await ensureSelfConsent(admin, user.id, email);

  return NextResponse.json({ success: true });
}
