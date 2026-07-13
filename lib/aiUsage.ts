import { getAdminClient } from "@/lib/portone"

// AI 엔드포인트 남용 방어(비용 보호). 제품 제한이 아니라 정상 사용의 수 배 여유를 둔 상한 —
// 유료 계정 하나가 Deepgram/Anthropic 비용을 무제한 태우는 것을 막는다.
// KST 하루 창 안에서 라우트별 호출 수를 세고, 허용 시 즉시 1건 기록한다.
// (ai_usage 테이블은 RLS deny-all — service role로만 접근)
export const AI_DAILY_LIMITS = {
  stt: 500, // 문서 5건 × 세그먼트 ~50개 = 250회가 현실 상한 → 2배 여유
  summary: 60,
  minutes: 60,
  "minutes-insight": 30,
  "education-insight": 30,
} as const

export async function checkAndRecordAiUsage(
  userId: string,
  route: keyof typeof AI_DAILY_LIMITS,
): Promise<boolean> {
  const admin = getAdminClient()
  const kstYmd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date()) // "YYYY-MM-DD"
  const startISO = new Date(`${kstYmd}T00:00:00+09:00`).toISOString()

  const { count } = await admin
    .from("ai_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("route", route)
    .gte("created_at", startISO)
  if ((count ?? 0) >= AI_DAILY_LIMITS[route]) return false

  const { error } = await admin.from("ai_usage").insert({ user_id: userId, route })
  if (error) console.error("ai_usage insert error:", error) // 기록 실패가 기능을 막지는 않는다
  return true
}

export const AI_LIMIT_MESSAGE = "오늘 AI 사용 한도에 도달했습니다. 내일 다시 이용해주세요."
