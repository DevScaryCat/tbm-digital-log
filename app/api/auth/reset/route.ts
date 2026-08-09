// app/api/auth/reset/route.ts — 재설정 링크로 새 비밀번호 확정 (무로그인)
import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/portone";
import {
  PASSWORD_MIN_LENGTH,
  consumeResetToken,
  invalidateOtherResetTokens,
} from "@/lib/accountRecovery";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const token = String(body?.token ?? "").trim();
  const newPassword = String(body?.newPassword ?? "");

  // 가입 화면과 같은 규칙 (8자 이상)
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return NextResponse.json(
      { error: `비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상 입력해주세요.` },
      { status: 400 }
    );
  }

  const admin = getAdminClient();
  const consumed = await consumeResetToken(admin, token);
  if ("error" in consumed) {
    return NextResponse.json({ error: consumed.error }, { status: 400 });
  }

  const { error } = await admin.auth.admin.updateUserById(consumed.userId, {
    password: newPassword,
  });
  if (error) {
    console.error("비밀번호 변경 실패:", error);
    // 토큰은 이미 소진됐다 — 되살리지 않는다(재사용 창을 열어주는 쪽이 더 위험). 다시 요청하면 된다.
    return NextResponse.json(
      { error: "비밀번호를 바꾸지 못했어요. 비밀번호 찾기를 다시 요청해주세요." },
      { status: 500 }
    );
  }

  // 비밀번호를 잃어버린 계정 = 이미 남이 쓰고 있을 수 있는 계정. 기존 세션을 전부 끊는다.
  const { error: revokeErr } = await admin.rpc("revoke_user_sessions", { p_user_id: consumed.userId });
  if (revokeErr) console.error("세션 무효화 실패:", revokeErr);
  await invalidateOtherResetTokens(admin, consumed.userId);

  return NextResponse.json({ success: true });
}
