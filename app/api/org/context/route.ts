// app/api/org/context/route.ts — 클라이언트 컴포넌트용 역할 판정 엔드포인트.
// 홈 스왑(owner=관제 대시보드), 헤더 메뉴 분기, attach 수락 모달이 이걸 소비한다.
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { getOrgContext } from "@/lib/org";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const ctx = await getOrgContext(user.id);

  // 공통화 이전에 발급된 현장 계정은 근로자 구분·업종·공종이 비어 교육시간 목표가
  // 기본값(비사무직 12시간)으로 어긋난다. 세션마다 오는 이 판정 요청에서 비어 있는 키만
  // 감독자 값으로 채워 초기값을 맞춘다 — 비어 있을 때만 채우므로, 현장 계정이 자기
  // 근로자 구분을 직접 고친 뒤에는 다시 덮이지 않는다.
  if (ctx.kind === "member" && ctx.org?.ownerUserId) {
    try {
      const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
      const missing = ["worker_type", "industry", "work_category"].filter((k) => !meta[k]);
      if (missing.length) {
        const admin = getAdminClient();
        const { data: o } = await admin.auth.admin.getUserById(ctx.org.ownerUserId);
        const om = (o?.user?.user_metadata ?? {}) as Record<string, unknown>;
        const fill: Record<string, unknown> = {};
        for (const k of missing) if (om[k]) fill[k] = om[k];
        if (Object.keys(fill).length) {
          // admin update는 metadata 전체 치환 — 최신 값을 다시 읽어 병합 (다른 키 유실 방지)
          const { data: me } = await admin.auth.admin.getUserById(user.id);
          const mine = (me?.user?.user_metadata ?? {}) as Record<string, unknown>;
          await admin.auth.admin.updateUserById(user.id, { user_metadata: { ...mine, ...fill } });
        }
      }
    } catch { /* 비치명 — 다음 세션이나 owner 저장 전파가 채운다 */ }
  }

  return NextResponse.json(ctx);
}
