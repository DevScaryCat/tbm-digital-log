// app/api/org/context/route.ts — 클라이언트 컴포넌트용 역할 판정 엔드포인트.
// 홈 스왑(owner=관제 대시보드), 헤더 메뉴 분기, attach 수락 모달이 이걸 소비한다.
import { NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/portone";
import { getOrgContext } from "@/lib/org";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const ctx = await getOrgContext(user.id);
  return NextResponse.json(ctx);
}
