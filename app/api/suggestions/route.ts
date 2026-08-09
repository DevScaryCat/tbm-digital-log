// app/api/suggestions/route.ts — 근로자 의견·제안 접수(무인증) + 저장 후 도착분 서버 합류
//
// 근로자는 QR로 무계정 접속하므로 이 라우트는 인증이 없다. 대신:
//  ① 접수는 기존 RPC submit_worker_suggestion(SECURITY DEFINER)을 그대로 호출 —
//     세션 검증(OPEN 30분 + 저장 후 30분 유예창)·세션당 30건 상한·소유자 결정 게이트를
//     재사용하고, 에러 코드는 그대로 클라이언트에 전달해 기존 안내 문구 분기를 유지한다.
//  ② 접수 성공 후, 이 세션의 저장된 회의록이 있으면(tbm_minutes.session_id — 저장 시
//     위저드가 기록. 구버전 앱 저장분은 의견 doc 링크 추적 폴백) '문서 생성 이후' 도착한
//     미연결 의견을 위험요인으로 변환해 그 문서 hazards에 서버에서 합류한다 —
//     감독자가 저장하고 나간 뒤 도착한 의견이 문서에서 영영 빠지던 구멍의 마개.
//     문서 '이전' 도착분은 여기서 건드리지 않는다: 저장 중인 위저드가 이미 로컬 합류해뒀을
//     수 있어(아직 클레임 전) 이중 반영 위험 — 그 몫은 위저드의 저장 직전 스윕과
//     /api/suggestions/reconcile(저장 직후 잔여분 정리)이 책임진다.
//  · AI는 RPC 게이트를 통과한 뒤에만 부르고, 문서 소유자 계정의 일일 사용량 원장
//    (ai_usage 'suggestion-hazards')을 따른다. 한도·AI 실패 시에도 의견을 버리지 않고
//    '[근로자 의견] {원문}'을 그대로 append한다(원문이 증거다).
//  · 멱등·동시성은 DB 함수 merge_worker_suggestion_hazards가 책임진다
//    (의견 id 조건부 클레임 + jsonb || 원자 append, 단일 트랜잭션).
//  · 접수(①) 성공 이후의 합류 실패는 전부 200으로 답한다 — 에러를 돌려주면 근로자가
//    재시도해 같은 의견이 이중 접수된다. 의견 자체는 이미 DB에 있다(제안함에서 보임).
import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/portone";
import {
  sweepSessionSuggestionsIntoMinutes,
  MAX_SUGGESTION_LEN,
} from "@/lib/suggestionHazards";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// RPC가 raise하는 코드 — 이 문자열이 그대로 클라이언트 안내 문구 분기에 쓰인다
const KNOWN_RPC_CODES = [
  "CONTENT_TOO_SHORT",
  "CONTENT_TOO_LONG",
  "NAME_TOO_LONG",
  "SESSION_CLOSED",
  "TOO_MANY_SUGGESTIONS",
] as const;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  const authorName =
    typeof body?.authorName === "string" && body.authorName.trim()
      ? body.authorName.trim()
      : null;

  if (!UUID_RE.test(sessionId) || !content || content.length > MAX_SUGGESTION_LEN) {
    return NextResponse.json({ error: "요청이 올바르지 않습니다." }, { status: 400 });
  }

  const admin = getAdminClient();

  // ① 접수 — 기존 게이트 재사용(SECURITY DEFINER RPC)
  const { error: rpcError } = await admin.rpc("submit_worker_suggestion", {
    p_session: sessionId,
    p_content: content,
    p_author_name: authorName,
  });
  if (rpcError) {
    const code = KNOWN_RPC_CODES.find((c) => rpcError.message?.includes(c));
    return NextResponse.json(
      { error: code ?? "전송에 실패했습니다. 잠시 후 다시 시도해주세요." },
      { status: code ? 400 : 500 }
    );
  }

  // ② 저장 후 도착분 합류 — 실패해도 접수는 성공이므로 200
  try {
    const merged = await sweepSessionSuggestionsIntoMinutes(admin, sessionId, {
      afterDocOnly: true,
    });
    return NextResponse.json({ ok: true, merged: merged > 0 });
  } catch (e) {
    console.error("suggestion post-save merge error:", e);
    return NextResponse.json({ ok: true, merged: false });
  }
}
