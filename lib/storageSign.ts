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

/**
 * 사진 URL 목록 정규화 — photo_urls(신규·여러 장)를 우선하고, 없으면 photo_url(구버전 한 장)로
 * 되돌아간다. 2026-08-22에 여러 장을 도입하면서 기존 행은 photo_url만 갖고 있어서, 화면·출력이
 * 두 컬럼을 매번 따로 분기하지 않도록 여기 한 곳에서 합친다.
 */
export function photoList(row: { photo_url?: string | null; photo_urls?: unknown }): string[] {
  const many = Array.isArray(row?.photo_urls)
    ? (row.photo_urls as unknown[]).filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : []
  if (many.length > 0) return many
  const one = typeof row?.photo_url === "string" ? row.photo_url.trim() : ""
  return one ? [one] : []
}
