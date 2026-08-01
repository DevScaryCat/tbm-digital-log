// AI 정리 결과 캐시 — 같은 사용자·같은 원문이면 재생성하지 않는다.
// 실사용 패턴이 정확히 이 모양이다: 키워드 레퍼토리를 매일 반복 낭독하거나 동일 트리거
// 입력("안전 안전 안전")이 잦아, 동일 입력이 실호출의 30~50%를 차지한다. temperature≈0이라
// 재생성해도 사실상 같은 결과가 나오므로 캐시 반환이 품질 손실 없이 비용·지연만 줄인다.
// (ai_cache 테이블은 RLS deny-all — service role로만 접근)
import { createHash } from "crypto"
import { getAdminClient } from "@/lib/portone"

export function aiInputHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex")
}

export async function getAiCache(
  userId: string,
  route: string,
  hash: string
): Promise<Record<string, unknown> | null> {
  try {
    const admin = getAdminClient()
    const { data } = await admin
      .from("ai_cache")
      .select("output")
      .eq("user_id", userId)
      .eq("route", route)
      .eq("input_hash", hash)
      .maybeSingle()
    return (data?.output as Record<string, unknown>) ?? null
  } catch {
    return null // 캐시 조회 실패는 비치명 — 그냥 생성 경로로
  }
}

export async function setAiCache(
  userId: string,
  route: string,
  hash: string,
  output: Record<string, unknown>
): Promise<void> {
  try {
    const admin = getAdminClient()
    await admin
      .from("ai_cache")
      .upsert(
        { user_id: userId, route, input_hash: hash, output },
        { onConflict: "user_id,route,input_hash" }
      )
  } catch {
    /* 캐시 저장 실패는 비치명 */
  }
}
