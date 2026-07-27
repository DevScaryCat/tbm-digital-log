// app/api/org/export-format/route.ts — 회사 공통 문서 출력 형식 저장 (감독자/단독 전용)
// 형식은 개인 취향이 아니라 회사 양식이다 — 감독자 계정의 preferred_export_format이
// 회사 값의 원본이고, 저장 시 활성 현장 계정 전체에 전파한다.
// 문서 뷰어들은 각자 user_metadata만 읽으므로 소비 측 코드는 무변경.
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { getOrgContext } from "@/lib/org";
import { EXPORT_FORMATS } from "@/lib/exportFormats";

export const runtime = "nodejs";
export const maxDuration = 60; // 현장 수 상한이 없는 과금 모델 — 대규모 조직 전파 시간 확보

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

    const { format } = await request.json().catch(() => ({}));
    if (!EXPORT_FORMATS.some((f) => f.value === format)) {
      return NextResponse.json({ error: "지원하지 않는 형식입니다." }, { status: 400 });
    }

    const admin = getAdminClient();
    const ctx = await getOrgContext(user.id, admin);
    if (ctx.kind === "member") {
      return NextResponse.json(
        { error: "문서 형식은 회사 공통 설정입니다. 회사 감독자에게 문의하세요." },
        { status: 403 }
      );
    }

    // 본인(=회사 값의 원본) 먼저 — 실패하면 전파도 하지 않는다
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const { error: selfErr } = await admin.auth.admin.updateUserById(user.id, {
      user_metadata: { ...meta, preferred_export_format: format },
    });
    if (selfErr) {
      console.error("export-format self update error:", selfErr);
      return NextResponse.json({ error: "저장에 실패했습니다." }, { status: 500 });
    }

    // 활성 현장 계정 전파 — listOrgMembers와 같은 병렬 배치 (현장 수 상한이 없는 과금 모델)
    const memberIds = ctx.memberIds ?? [];
    let updated = 0;
    const CHUNK = 20;
    for (let i = 0; i < memberIds.length; i += CHUNK) {
      const chunk = memberIds.slice(i, i + CHUNK);
      const results = await Promise.all(
        chunk.map(async (id) => {
          try {
            const { data: u } = await admin.auth.admin.getUserById(id);
            const m = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
            const { error } = await admin.auth.admin.updateUserById(id, {
              user_metadata: { ...m, preferred_export_format: format },
            });
            return !error;
          } catch {
            return false;
          }
        })
      );
      updated += results.filter(Boolean).length;
    }

    return NextResponse.json({ success: true, updated, total: memberIds.length });
  } catch (e) {
    console.error("export-format error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
