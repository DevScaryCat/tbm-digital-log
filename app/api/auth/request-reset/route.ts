// app/api/auth/request-reset/route.ts — 비밀번호 재설정 링크 요청 (무로그인)
// 아이디 계정에 '인증된' 복구 이메일이 있을 때만 그 주소로 링크를 보낸다.
// 미인증 주소로는 절대 보내지 않는다 — 인증 안 된 주소는 그 사람 것이라는 증거가 없다.
import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/portone";
import {
  RECOVERY_GENERIC_MESSAGE,
  baseUrlFrom,
  normalizeLoginId,
  recoverySendThrottled,
  requestIp,
  sendResetMail,
} from "@/lib/accountRecovery";

export const runtime = "nodejs";

/** 계정이 있든 없든, 복구 이메일이 등록됐든 아니든 화면이 보는 응답은 언제나 이것 하나 */
const generic = () => NextResponse.json({ success: true, message: RECOVERY_GENERIC_MESSAGE });

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const loginId = normalizeLoginId(body?.loginId);
  // 빈 값·공백·@ 포함 같은 명백한 입력 실수만 되돌린다. 계정 존재 여부는 여전히 새지 않는다
  if (!loginId) {
    return NextResponse.json({ error: "아이디를 다시 확인해주세요." }, { status: 400 });
  }

  const admin = getAdminClient();
  try {
    const { data: userId, error } = await admin.rpc("find_user_id_by_login_email", {
      p_email: `${loginId}@tbm.com`,
    });
    if (error) {
      console.error("request-reset 계정 조회 실패:", error);
      return generic();
    }
    if (!userId) return generic();

    const { data: u } = await admin.auth.admin.getUserById(String(userId));
    const meta = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
    const recoveryEmail = typeof meta.real_email === "string" ? meta.real_email.trim() : "";
    // 인증 시각이 없으면 수신 보장도, 본인 확인도 없다 → 발송하지 않는다(응답은 동일)
    if (!recoveryEmail || !meta.real_email_verified_at) return generic();

    if (await recoverySendThrottled(admin, [String(userId)])) return generic(); // 조용히 건너뛴다

    await sendResetMail(admin, {
      userId: String(userId),
      to: recoveryEmail,
      loginId,
      baseUrl: baseUrlFrom(request),
      ip: requestIp(request),
    });
  } catch (e) {
    console.error("request-reset 처리 오류:", e);
  }
  return generic();
}
