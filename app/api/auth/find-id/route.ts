// app/api/auth/find-id/route.ts — 아이디 찾기 (무로그인)
// 입력한 이메일이 '인증된 복구 이메일'인 계정을 찾아 그 주소로 아이디를 보낸다.
// 아이디는 메일에만 실린다 — 응답 본문에 담으면 이메일 하나만 알면 아이디를 긁어갈 수 있다.
import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/portone";
import {
  RECOVERY_GENERIC_MESSAGE,
  isValidRecoveryEmail,
  loginIdFromEmail,
  logFindIdSend,
  recoverySendThrottled,
  requestIp,
  sendFindIdMail,
} from "@/lib/accountRecovery";

export const runtime = "nodejs";

/** 계정이 있든 없든 화면이 보는 응답은 언제나 이것 하나 */
const generic = () => NextResponse.json({ success: true, message: RECOVERY_GENERIC_MESSAGE });

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const email = String(body?.email ?? "").trim();
  // 형식 오류는 계정 정보를 흘리지 않는다(입력 실수 안내) — 그 외에는 무조건 같은 성공 문구
  if (!isValidRecoveryEmail(email)) {
    return NextResponse.json({ error: "이메일 주소를 다시 확인해주세요." }, { status: 400 });
  }

  const admin = getAdminClient();
  try {
    const { data, error } = await admin.rpc("find_accounts_by_recovery_email", { p_email: email });
    if (error) {
      console.error("find-id RPC 실패:", error);
      return generic();
    }
    const rows = (data ?? []) as { user_id: string; login_email: string; recovery_verified: boolean }[];
    if (rows.length === 0) return generic();

    const loginIds = [
      ...new Set(rows.map((r) => loginIdFromEmail(r.login_email)).filter((v): v is string => !!v)),
    ];
    // 카카오 계정은 아이디 자체가 없다 — 메일에서 "카카오로 로그인하세요"로 안내한다
    const hasKakao = rows.some((r) => !loginIdFromEmail(r.login_email));
    if (loginIds.length === 0 && !hasKakao) return generic();

    const userIds = rows.map((r) => r.user_id);
    if (await recoverySendThrottled(admin, userIds)) return generic(); // 조용히 건너뛴다

    // 이력을 먼저 남긴다 — 발송이 느리거나 실패해도 연타로 폭탄이 되지 않게
    await logFindIdSend(admin, userIds, requestIp(request));
    const r = await sendFindIdMail({ to: email, loginIds, hasKakao });
    if (!r.ok) console.error("아이디 찾기 메일 발송 실패:", r.error);
  } catch (e) {
    console.error("find-id 처리 오류:", e);
  }
  return generic();
}
