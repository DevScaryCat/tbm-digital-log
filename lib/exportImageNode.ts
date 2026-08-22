// lib/exportImageNode.ts
// 서버(Node)에서 쓰는 이미지 로더 — exportDocx.loadImage의 canvas 판을 대체한다.
//
// 왜 따로 있나: exportDocx.loadImage는 createImageBitmap + <canvas>로 재인코딩한다(브라우저 전용).
// 출력물을 서버에서 만들려면 canvas 없이 같은 계약({data, type, width, height})을 돌려줘야 한다.
// 재인코딩을 포기하는 대신 두 가지를 직접 한다.
//   1) 포맷 판별 — 매직 바이트로 PNG/JPEG만 통과시킨다. WebP·HEIC 등은 실패로 집계하고 생략한다
//      (엑셀이 못 읽는 걸 넣으면 파일이 통째로 깨진다 — 빠지는 편이 낫다).
//   2) 치수 판별 — 헤더만 파싱한다. 셀 박스에 비율 유지로 앉히려면 실제 폭·높이가 필요하다.
// 축소는 하지 않는다. 앱이 촬영 단계에서 이미 1600px·JPEG 0.7로 줄여 올린다(useImageCapture).

import type { ImageLoadStats, ImgType, LoadedImage } from "@/lib/exportDocx"

/** PNG IHDR에서 폭·높이 (8바이트 시그니처 + 4바이트 길이 + "IHDR" 다음) */
function pngSize(b: Uint8Array): { width: number; height: number } | null {
    if (b.length < 24) return null
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    return { width: dv.getUint32(16), height: dv.getUint32(20) }
}

/** JPEG SOF 마커에서 폭·높이 — 세그먼트를 건너뛰며 SOF0~SOF15(단 DHT/DAC/RST 제외)를 찾는다 */
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    let i = 2
    while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue }
        const marker = b[i + 1]
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
        const len = dv.getUint16(i + 2)
        const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        if (isSOF) return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) }
        i += 2 + len
    }
    return null
}

export async function loadImageNode(
    url: string | null | undefined,
    stats: ImageLoadStats,
): Promise<LoadedImage | null> {
    if (!url) return null // 값이 없는 건 실패가 아니다(서명 미수집 등)
    try {
        const res = await fetch(url)
        if (!res.ok) { stats.failures++; return null }
        const raw = await res.arrayBuffer()
        const b = new Uint8Array(raw)

        let type: ImgType
        let size: { width: number; height: number } | null
        if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
            type = "png"
            size = pngSize(b)
        } else if (b[0] === 0xff && b[1] === 0xd8) {
            type = "jpg"
            size = jpegSize(b)
        } else {
            stats.failures++
            return null
        }
        if (!size || size.width < 1 || size.height < 1) { stats.failures++; return null }
        return { data: raw, type, width: size.width, height: size.height }
    } catch {
        stats.failures++
        return null
    }
}
