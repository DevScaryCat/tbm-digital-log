// app/api/export/xlsx/route.ts — 회의록·교육일지를 서식 있는 .xlsx로 만들어 내려준다.
//
// 왜 서버인가(2026-08-22 Chris: "출력물은 전부 엑셀"): 엑셀 빌더(lib/exportXlsx)는 원래
// 브라우저에서 돌았다. 앱에는 DOM도 canvas도 없고 exceljs를 번들에 넣는 것도 부담이라,
// 같은 빌더를 Node에서 돌리고 앱은 파일만 받아 공유 시트로 넘긴다.
// 이미지 로더만 갈아끼운다(lib/exportImageNode) — 워크북 코드는 웹과 완전히 같다.
//
// 두 종류를 함께 받는다: 일괄 출력 화면은 기간 안의 회의록·교육일지가 섞여 있고,
// 종류별로 파일을 두 개 주면 사용자가 둘을 짝지어 관리해야 한다. 한 통합문서로 낸다.
import { NextResponse } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { getAdminClient, getUserFromRequest } from "@/lib/portone"
import { getOrgContext } from "@/lib/org"
import { resolveSignedMapAdmin, signedAdmin } from "@/lib/storageSignAdmin"
import { photoList } from "@/lib/storageSign"
import { loadImageNode } from "@/lib/exportImageNode"

export const runtime = "nodejs"
// 사진이 여러 장 붙은 문서를 여러 건 묶으면 이미지 내려받기·인코딩에 시간이 걸린다
export const maxDuration = 60

/** 한 번에 묶을 수 있는 문서 수(종류 합산) — 이미지 버퍼가 동시에 메모리에 뜨므로 상한을 둔다 */
const MAX_DOCS = 40

type Row = Record<string, unknown> & { id: string; user_id: string }

const idList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []

export async function POST(request: Request) {
  const user = await getUserFromRequest(request)
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as { minutes?: unknown; education?: unknown }
  let minuteIds = idList(body.minutes)
  let eduIds = idList(body.education)
  // 회의록을 먼저 채우고 남은 자리에 교육일지를 넣는다(시트 순서와 같은 우선순위)
  minuteIds = minuteIds.slice(0, MAX_DOCS)
  eduIds = eduIds.slice(0, Math.max(0, MAX_DOCS - minuteIds.length))
  if (minuteIds.length + eduIds.length === 0) {
    return NextResponse.json({ error: "내보낼 문서를 찾지 못했습니다." }, { status: 400 })
  }

  const admin = getAdminClient()

  async function fetchDocs(table: string, ids: string[]): Promise<Row[]> {
    if (ids.length === 0) return []
    const { data } = await admin.from(table).select("*").in("id", ids)
    const rows = (data ?? []) as Row[]
    // 요청 순서 유지 — 화면 목록과 시트 순서가 어긋나면 찾기 어렵다
    const order = new Map(ids.map((id, i) => [id, i]))
    return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  }

  const [minuteRows, eduRows] = await Promise.all([
    fetchDocs("tbm_minutes", minuteIds),
    fetchDocs("tbm_logs", eduIds),
  ])
  if (minuteRows.length + eduRows.length === 0) {
    return NextResponse.json({ error: "문서를 찾을 수 없습니다." }, { status: 404 })
  }

  // 본인 문서가 아니면 감독자→활성 하위 현장 관계일 때만 허용 (org/minutes/[id]와 같은 규칙)
  const foreign = [...minuteRows, ...eduRows].filter((d) => d.user_id !== user.id)
  if (foreign.length > 0) {
    const ctx = await getOrgContext(user.id, admin as unknown as SupabaseClient)
    const allowed = new Set(ctx.kind === "owner" ? ctx.memberIds ?? [] : [])
    if (foreign.some((d) => !allowed.has(d.user_id))) {
      return NextResponse.json({ error: "우리 조직의 문서가 아닙니다." }, { status: 403 })
    }
  }

  async function fetchParts(table: string, key: string, ids: string[]) {
    if (ids.length === 0) return new Map<string, Record<string, unknown>[]>()
    const { data } = await admin.from(table).select("*").in(key, ids)
    const map = new Map<string, Record<string, unknown>[]>()
    for (const p of (data ?? []) as Record<string, unknown>[]) {
      const k = String(p[key])
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(p)
    }
    return map
  }

  const [minuteParts, eduParts] = await Promise.all([
    fetchParts("tbm_minutes_participants", "minutes_id", minuteRows.map((d) => d.id)),
    fetchParts("tbm_participants", "log_id", eduRows.map((d) => d.id)),
  ])

  // 사진·서명은 private 버킷이라 서명 URL을 만들어야 로더가 읽는다
  const urls: (string | null | undefined)[] = []
  for (const d of [...minuteRows, ...eduRows]) {
    urls.push(
      d.leader_signature as string | null,
      d.instructor_signature as string | null,
      d.confirmation_signature as string | null,
      ...photoList(d as never),
    )
  }
  for (const m of [minuteParts, eduParts]) {
    for (const arr of m.values()) for (const p of arr) urls.push(p.signature as string | null)
  }
  const sig = await resolveSignedMapAdmin(admin as unknown as SupabaseClient, urls)

  const signDoc = (d: Row) => ({
    ...d,
    leader_signature: signedAdmin(sig, d.leader_signature as string | null),
    instructor_signature: signedAdmin(sig, d.instructor_signature as string | null),
    confirmation_signature: signedAdmin(sig, d.confirmation_signature as string | null),
    photo_url: signedAdmin(sig, d.photo_url as string | null),
    photo_urls: photoList(d as never).map((u) => sig[u] ?? u),
  })
  const signParts = (arr: Record<string, unknown>[] | undefined) =>
    (arr ?? []).map((p) => ({ ...p, signature: signedAdmin(sig, p.signature as string | null) }))

  try {
    const { buildCombinedXlsx, suggestXlsxFilename } = await import("@/lib/exportXlsx")
    const built = await buildCombinedXlsx(
      minuteRows.map((d) => ({ minutes: signDoc(d), participants: signParts(minuteParts.get(d.id)) })) as never,
      eduRows.map((d) => ({ log: signDoc(d), participants: signParts(eduParts.get(d.id)) })) as never,
      loadImageNode,
    )

    // 파일명은 첫 문서 기준 — 종류가 섞이면 회의록을 대표로 삼는다(시트 순서와 같은 규칙)
    const head = (minuteRows[0] ?? eduRows[0]) as Row
    const dateLabel = String(head?.date ?? "").slice(0, 10) || "전체"
    const company = String(head?.company_name ?? head?.location ?? "") || undefined
    const filename = suggestXlsxFilename(minuteRows.length > 0 ? "minutes" : "education", dateLabel, company)

    const buf = await built.blob.arrayBuffer()
    return new NextResponse(buf, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        // 한글 파일명은 RFC 5987 형식으로만 안전하게 넘어간다
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        // 이미지 로드 실패 건수 — 앱이 "일부 사진이 빠졌다"를 말할 수 있게
        "X-Image-Failures": String(built.imageFailures ?? 0),
        "Cache-Control": "no-store",
      },
    })
  } catch (e) {
    console.error("xlsx 생성 실패:", e)
    return NextResponse.json({ error: "엑셀 파일을 만들지 못했습니다." }, { status: 500 })
  }
}
