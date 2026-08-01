// app/api/consent/route.ts — 로그인 사용자의 약관·개인정보처리방침 동의 접수.
// 운영 DB에 이미 있는 계정들은 동의 증빙이 0건이라, 이 라우트로 소급 동의를 받는다.
// (수신자 승인 응답은 app/api/consent/[token]/route.ts — 이름만 겹치는 별개 흐름)
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { consentMetaPatch, recordConsent } from "@/lib/consent";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const admin = getAdminClient();

    // updateUserById의 user_metadata는 전체 치환이라 최신 값을 다시 읽어 병합한다.
    // 토큰 안의 user_metadata는 발급 시점 스냅샷이라 그대로 쓰면 그 뒤 변경분이 날아간다.
    // 증빙 원장이 먼저 — metadata 캐시를 먼저 심으면 원장이 비었는데 게이트만 닫혀
    // 소급 동의를 다시 받을 길이 사라진다. 원장이 실패하면 500으로 재시도를 받는다.
    // (재시도로 원장 행이 중복될 수는 있으나, append 원장에서 중복은 증빙 유실보다 안전하다)
    // x-forwarded-for는 프록시 체인이라 최초 클라이언트 IP만 남긴다
    const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
    const recorded = await recordConsent(admin, user.id, {
      source: "gate",
      ip,
      userAgent: request.headers.get("user-agent"),
    });
    if (!recorded) {
      return NextResponse.json({ error: "동의 저장에 실패했습니다. 잠시 후 다시 시도해주세요." }, { status: 500 });
    }

    const { data: fresh } = await admin.auth.admin.getUserById(user.id);
    const meta = (fresh?.user?.user_metadata ?? user.user_metadata ?? {}) as Record<string, unknown>;

    const { error: updErr } = await admin.auth.admin.updateUserById(user.id, {
      user_metadata: { ...meta, ...consentMetaPatch() },
    });
    if (updErr) {
      console.error("consent metadata update error:", updErr);
      return NextResponse.json({ error: "동의 저장에 실패했습니다. 잠시 후 다시 시도해주세요." }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("consent error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
