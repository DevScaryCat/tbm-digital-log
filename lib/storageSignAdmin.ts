// lib/storageSignAdmin.ts
// 저장된 public 스토리지 URL → admin 권한 signed URL. 버킷이 private이라 원본 URL로는 못 읽는다.
//
// lib/storageSign.ts와 파싱 규칙은 같지만 서명 주체가 다르다: 거긴 브라우저의 로그인 세션으로
// 서명하고(본인 파일만), 여긴 service role로 대신 발급한다. 감독자가 자식 현장 문서를 열거나
// 서버가 출력물을 만들 때는 세션 권한으로 서명할 수 없다.
import type { SupabaseClient } from "@supabase/supabase-js"

const PUBLIC_RE = /\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/

export async function resolveSignedMapAdmin(
  admin: SupabaseClient,
  urls: (string | null | undefined)[],
  expiresIn = 60 * 60, // 출력물 생성 중에만 쓰이므로 1시간이면 충분하다
): Promise<Record<string, string>> {
  const byBucket = new Map<string, { url: string; path: string }[]>()
  for (const u of urls) {
    if (!u || typeof u !== "string" || u.startsWith("data:")) continue
    const m = u.match(PUBLIC_RE)
    if (!m) continue
    const bucket = m[1]
    const path = decodeURIComponent(m[2].split("?")[0])
    if (!byBucket.has(bucket)) byBucket.set(bucket, [])
    byBucket.get(bucket)!.push({ url: u, path })
  }
  const map: Record<string, string> = {}
  for (const [bucket, items] of byBucket) {
    const { data, error } = await admin.storage
      .from(bucket)
      .createSignedUrls(items.map((i) => i.path), expiresIn)
    if (error || !data) continue
    data.forEach((d, i) => {
      if (d.signedUrl) map[items[i].url] = d.signedUrl
    })
  }
  return map
}

/** map에 있으면 signed URL로, 없으면 원본 그대로. */
export function signedAdmin<T extends string | null | undefined>(map: Record<string, string>, url: T): T {
  if (!url) return url
  return (map[url] ?? url) as T
}
