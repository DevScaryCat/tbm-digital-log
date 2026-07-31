// app/api/org/profile/route.ts — 회사 공통 프로필(근로자 구분·업종·공종) 전파 (감독자/단독 전용)
// 근로자 구분·업종·공종은 개인 취향이 아니라 회사 공통 설정 — 감독자 계정의 값이 원본이고,
// 저장 시 활성 현장 계정 전체에 전파한다. 본인 메타데이터는 클라이언트 updateUser가 이미
// 저장했으므로 여기서는 건드리지 않는다(이중 저장 레이스 방지) — 자식 전파만 담당.
import { NextResponse } from "next/server";
import { getAdminClient, getUserFromRequest } from "@/lib/portone";
import { getOrgContext } from "@/lib/org";

export const runtime = "nodejs";
export const maxDuration = 60; // 현장 수 상한이 없는 과금 모델 — 대규모 조직 전파 시간 확보

// 가입 API와 같은 화이트리스트 — 교육시간 산정 분기 키라 임의 값이 들어오면 안 된다
const WORKER_TYPES = ["현장 근로자 (비사무직)", "사무직 / 판매직"];

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    if (!WORKER_TYPES.includes(body.workerType)) {
      return NextResponse.json({ error: "지원하지 않는 근로자 구분입니다." }, { status: 400 });
    }
    const workerType = body.workerType as string;
    // 업종/공종: 가입 API와 같은 규칙(임의 값 방지, 최대 40자 — KSIC 분류명 수용), 빈 값은 null
    const industry = typeof body.industry === "string" ? body.industry.trim().slice(0, 40) || null : null;
    const workCategory = typeof body.workCategory === "string" ? body.workCategory.trim().slice(0, 40) || null : null;

    const admin = getAdminClient();
    const ctx = await getOrgContext(user.id, admin);
    if (ctx.kind === "member") {
      return NextResponse.json(
        { error: "근로자 구분·업종·공종은 회사 공통 설정입니다. 회사 감독자에게 문의하세요." },
        { status: 403 }
      );
    }

    // 활성 현장 계정 전파 — export-format과 같은 병렬 배치. solo는 memberIds가 없어 updated 0으로 성공.
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
            // null도 명시 저장 — 자식 값은 회사 값과 항상 일치해야 한다 (감독자가 비우면 자식도 비움)
            const { error } = await admin.auth.admin.updateUserById(id, {
              user_metadata: { ...m, worker_type: workerType, industry, work_category: workCategory },
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
    console.error("org profile error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
