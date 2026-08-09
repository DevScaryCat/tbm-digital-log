// app/api/suggestions/reconcile/route.ts — 저장 직후 잔여 의견 정리 스윕 (인증 필수)
//
// 위저드가 회의록 저장을 마친 직후(참석자 → 의견 클레임 UPDATE → pending DELETE 뒤) 부른다.
// 대상: 저장 직전 스윕의 SELECT와 저장 사이에 도착했거나, 스윕의 AI 호출이 실패(한도 429 등)해
// 화면 hazards에 합류하지 못한 미연결 의견 — 이 행들은 클레임 UPDATE(.in 화면 합류분)에
// 잡히지 않으므로, 여기서 서버가 변환해 저장된 문서에 합류시킨다. 이 경로가 없으면
// 그 의견들은 문서에 영영 빠진다(과거엔 저장 UPDATE가 미합류분까지 클레임해 조용히 유실됐다).
//
//  · 멱등: 행별 merge_worker_suggestion_hazards(조건부 클레임 + 원자 append) — 재호출·
//    /api/suggestions 접수 직후 합류와 동시에 달려도 클레임 승자만 append한다. 재시도 안전.
//  · 인증: 문서 소유자 본인만 — sweep이 문서 소유자(user_id)의 의견만 다루므로,
//    호출자가 소유자와 일치하는지 확인해 타인 세션 id로 남의 계정 AI 원장을 태우는 것을 막는다.
//  · AI 한도·실패 시 '[근로자 의견] 원문' 폴백 — 의견을 버리지 않는다.
import { NextResponse } from "next/server";
import { getUserFromRequest, getAdminClient } from "@/lib/portone";
import {
  findSavedMinuteForSession,
  sweepSessionSuggestionsIntoMinutes,
} from "@/lib/suggestionHazards";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
    if (!UUID_RE.test(sessionId)) {
      return NextResponse.json({ error: "요청이 올바르지 않습니다." }, { status: 400 });
    }

    const admin = getAdminClient();
    const doc = await findSavedMinuteForSession(admin, sessionId);
    if (!doc) return NextResponse.json({ ok: true, merged: 0 }); // 저장본 없음 — 정리할 것도 없다
    if (doc.user_id !== user.id) {
      return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
    }

    const merged = await sweepSessionSuggestionsIntoMinutes(admin, sessionId);
    return NextResponse.json({ ok: true, merged });
  } catch (e) {
    console.error("suggestion reconcile error:", e);
    return NextResponse.json({ error: "정리에 실패했습니다." }, { status: 500 });
  }
}
