import { supabase } from "@/lib/supabaseClient"

// 저장된 public 스토리지 URL을 signed URL로 변환 (버킷 private 대응).
// DB에는 항상 public URL(getPublicUrl 결과)이 저장돼 있어, 조회 때마다 새 signed URL을 발급한다.
const PUBLIC_RE = /\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/

/**
 * 여러 저장 URL을 한 번에 signed URL로 변환한 매핑(원본URL→signedURL)을 반환.
 * base64(data:)·외부·이미 서명된 값 등 매칭 안 되는 것은 매핑에서 제외(원본 그대로 사용).
 */
export async function resolveSignedMap(
  urls: (string | null | undefined)[],
  expiresIn = 60 * 60 * 24 // 1일
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
    const { data, error } = await supabase.storage
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
export function signed<T extends string | null | undefined>(map: Record<string, string>, url: T): T {
  if (!url) return url
  return (map[url] ?? url) as T
}
