// app/api/suggestions/route.ts — 근로자 의견·제안 접수(무인증) + 저장 후 도착분 서버 합류
//
// 근로자는 QR로 무계정 접속하므로 이 라우트는 인증이 없다. 대신:
//  ① 접수는 기존 RPC submit_worker_suggestion(SECURITY DEFINER)을 그대로 호출 —
//     세션 OPEN(30분) 검증·세션당 30건 상한·소유자 결정 게이트를 재사용하고,
//     에러 코드는 그대로 클라이언트에 전달해 기존 안내 문구 분기를 유지한다.
//  ② 접수 성공 후, 이 세션이 "이미 저장된 회의록"에 연결돼 있으면(저장 시
//     worker_suggestions UPDATE가 남긴 doc_type='minute'/doc_id 흔적을 따라간다)
//     방금 의견을 위험요인으로 변환해 그 문서 hazards에 서버에서 합류한다 —
//     감독자가 저장하고 나간 뒤 도착한 의견이 문서에서 영영 빠지던 구멍의 마개.
//  · AI는 RPC 게이트를 통과한 뒤에만 부르고, 문서 소유자 계정의 일일 사용량 원장
//    (ai_usage 'suggestion-hazards')을 따른다. 한도·AI 실패 시에도 의견을 버리지 않고
//    '[근로자 의견] {원문}'을 그대로 append한다(원문이 증거다).
//  · 멱등·동시성은 DB 함수 merge_worker_suggestion_hazards가 책임진다
//    (의견 id 조건부 클레임 + jsonb || 원자 append, 단일 트랜잭션).
//  · 접수(①) 성공 이후의 합류 실패는 전부 200으로 답한다 — 에러를 돌려주면 근로자가
//    재시도해 같은 의견이 이중 접수된다. 의견 자체는 이미 DB에 있다(제안함에서 보임).
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "@/lib/portone";
import { checkAndRecordAiUsage } from "@/lib/aiUsage";
import {
  convertSuggestionsToHazards,
  rawSuggestionHazard,
  MAX_SUGGESTION_LEN,
  type SuggestionHazard,
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
  // RPC는 SQL trim(공백만)을 하므로 여기서 JS trim을 먼저 해 저장값과 요청값을 일치시킨다
  // (아래에서 방금 넣은 행을 content 완전일치로 되찾는 근거)
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
    const merged = await mergeIntoSavedMinutes(admin, sessionId, content);
    return NextResponse.json({ ok: true, merged });
  } catch (e) {
    console.error("suggestion post-save merge error:", e);
    return NextResponse.json({ ok: true, merged: false });
  }
}

async function mergeIntoSavedMinutes(
  admin: SupabaseClient,
  sessionId: string,
  content: string
): Promise<boolean> {
  // 이 세션이 이미 저장된 회의록에 연결돼 있나 — 저장 시 UPDATE가 남긴 흔적을 따른다.
  // 없으면 아직 저장 전: step 4 폴링 또는 저장 직전 스윕이 줍는다(여기서 끝).
  const { data: linked, error: linkErr } = await admin
    .from("worker_suggestions")
    .select("doc_id")
    .eq("session_id", sessionId)
    .eq("doc_type", "minute")
    .not("doc_id", "is", null)
    .limit(1);
  if (linkErr || !linked || linked.length === 0) return false;

  // 방금 RPC가 넣은 행(의견 id·문서 소유자) — content 완전일치 + 미연결 최신 행
  const { data: rows, error: rowErr } = await admin
    .from("worker_suggestions")
    .select("id, user_id")
    .eq("session_id", sessionId)
    .eq("content", content)
    .is("doc_id", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const row = rows?.[0] as { id: string; user_id: string } | undefined;
  if (rowErr || !row) return false;

  // 게이트(①) 통과 후에만 AI — 비용은 문서 소유자 계정의 일일 원장으로 계수.
  // 한도 도달·AI 오류 시 원문 폴백: 의견을 버리는 것보다 거친 항목이 낫다.
  let hazards: SuggestionHazard[];
  try {
    hazards = (await checkAndRecordAiUsage(row.user_id, "suggestion-hazards"))
      ? await convertSuggestionsToHazards([content])
      : [rawSuggestionHazard(content)];
  } catch (e) {
    console.error("suggestion conversion failed, falling back to raw:", e);
    hazards = [rawSuggestionHazard(content)];
  }
  // 모델이 "위험요인 해석 불가"로 거른 경우(빈 배열)는 검토 화면 폴링과 동일하게
  // hazards에는 넣지 않되, 문서 연결(클레임)은 수행한다(제안함 링크 유지).

  const { data: status, error: mergeErr } = await admin.rpc(
    "merge_worker_suggestion_hazards",
    { p_suggestion: row.id, p_hazards: hazards }
  );
  if (mergeErr) {
    console.error("merge_worker_suggestion_hazards error:", mergeErr);
    return false;
  }
  return status === "MERGED";
}
