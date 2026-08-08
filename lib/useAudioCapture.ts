"use client"

// lib/useAudioCapture.ts — 브라우저 음성인식과 **동시에** 원음을 파일로 남긴다.
//
// 왜 필요한가: 브라우저 무료 음성인식(Web Speech API)은 조용한 환경의 일반 대화용이라
// 현장 소음·전문용어에서 오인식이 잦고(지게차→"집에서"), iOS Safari는 확정 결과를 누적
// 재전송하는 버그까지 있다. 반면 원음이 있으면 서버에서 정확한 엔진으로 다시 받아적을 수 있다.
// 앱(tbm-app)은 이미 이 2계층 구조로 동작하며, 웹도 같은 구조로 맞춘다.
//
// 안전 규칙: 이 훅이 실패해도 녹음·인식은 그대로 진행돼야 한다. 마이크 권한·코덱·브라우저
// 미지원은 전부 "원음 없이 진행"으로 흡수하고, 기존 실시간 인식본이 폴백이 된다.

import { useCallback, useRef } from "react"

/** 명시적으로 끄지 않는 한 사용 — 한시 운영 후 요금 판단이 서면 조정한다 */
export const SERVER_STT_ENABLED = process.env.NEXT_PUBLIC_SERVER_STT !== "off"

/** iPhone·iPad (iPadOS 13+는 UA가 Macintosh로 나와 터치포인트로 구분) */
function detectIOS(): boolean {
    if (typeof navigator === "undefined") return false
    const ua = navigator.userAgent
    if (/iPad|iPhone|iPod/.test(ua)) return true
    return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
}

/**
 * iOS는 브라우저 음성인식을 쓰지 않고 **서버 전사만** 쓴다.
 *
 * 근거(실데이터): iOS 사파리에서 인식기와 녹음이 마이크를 동시에 잡으면 녹음 쪽이 빈 채로 열린다
 * — 26초를 녹음했는데 원음이 0.1초만 담겼고(2026-08-06 이현로지스), 결국 부정확한 실시간본이 그대로
 * 저장됐다. 게다가 iOS 인식기는 확정 결과를 누적 재전송하는 버그까지 있어 원문 품질이 가장 나쁘다.
 * 인식기를 아예 켜지 않으면 마이크 충돌이 사라지고, 원문은 Deepgram이 만든다.
 */
export const SERVER_STT_ONLY = SERVER_STT_ENABLED && detectIOS()

/** 브라우저가 지원하는 오디오 컨테이너 중 하나 고르기 (Chrome=webm/opus, Safari=mp4/aac) */
function pickMimeType(): string | undefined {
    if (typeof MediaRecorder === "undefined") return undefined
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"]
    return candidates.find((t) => MediaRecorder.isTypeSupported(t))
}

export function useAudioCapture() {
    const streamRef = useRef<MediaStream | null>(null)
    const recorderRef = useRef<MediaRecorder | null>(null)
    const chunksRef = useRef<BlobPart[]>([])
    // 회차별 완성 원음 — 녹음/일시정지를 반복해도 순서대로 쌓인다
    const blobsRef = useRef<Blob[]>([])

    /**
     * 녹음 시작. throw하지 않고 성공 여부를 boolean으로 돌려준다 —
     * 인식기를 병행하는 환경에선 실패해도 진행하지만, iOS(서버 전사 전용)에선
     * 이게 실패하면 원문 소스가 아예 없으므로 호출부가 시작 자체를 막아야 한다.
     */
    const start = useCallback(async (): Promise<boolean> => {
        if (!SERVER_STT_ENABLED) return false
        if (recorderRef.current) return true // 이미 녹음 중
        try {
            const mimeType = pickMimeType()
            if (!mimeType || !navigator.mediaDevices?.getUserMedia) return false

            const stream = await navigator.mediaDevices.getUserMedia({
                // 현장 소음 대비 — 브라우저 기본 전처리를 켜둔다
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            })
            const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 })
            chunksRef.current = []
            recorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
            }
            recorder.onstop = () => {
                if (chunksRef.current.length) {
                    blobsRef.current.push(new Blob(chunksRef.current, { type: mimeType }))
                }
                chunksRef.current = []
            }
            // 1초 타임슬라이스 — 탭이 갑자기 닫혀도 직전까지의 조각은 남는다
            recorder.start(1000)
            recorderRef.current = recorder
            streamRef.current = stream
            return true
        } catch {
            // 권한 거부·장치 없음 등
            recorderRef.current = null
            streamRef.current = null
            return false
        }
    }, [])

    /** 녹음 정지와 함께 호출. 마이크 점유를 반드시 해제한다(권한 표시등이 계속 켜져 있으면 불신). */
    const stop = useCallback(() => {
        try {
            recorderRef.current?.stop()
        } catch {
            /* 이미 정지 */
        }
        recorderRef.current = null
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
    }, [])

    const getBlobs = useCallback(() => blobsRef.current.slice(), [])

    const reset = useCallback(() => {
        stop()
        blobsRef.current = []
        chunksRef.current = []
    }, [stop])

    return { start, stop, getBlobs, reset }
}

/**
 * 원음 조각들을 서버로 보내 정확본을 받는다.
 * 실패·한도초과는 빈 문자열을 돌려주고, 호출부가 실시간 인식본을 그대로 쓰게 한다.
 */
// 저장 재시도(AI 실패 후 재제출 등) 때 이미 전사한 조각을 다시 올리면 Deepgram에
// 그대로 이중 과금된다(실측 17.3초 녹음에 38.9초 청구). 성공 응답은 Blob 단위로
// 기억해 재호출 시 업로드 없이 재사용한다 — 실패한 조각만 다시 시도된다.
const transcriptCache = new WeakMap<Blob, string>()

export async function transcribeBlobs(blobs: Blob[], accessToken?: string): Promise<string> {
    if (!blobs.length) return ""
    const texts: string[] = []
    for (const [i, blob] of blobs.entries()) {
        const cached = transcriptCache.get(blob)
        if (cached !== undefined) {
            if (cached) texts.push(cached)
            continue
        }
        try {
            const ext = blob.type.includes("mp4") ? "mp4" : blob.type.includes("aac") ? "aac" : "webm"
            const form = new FormData()
            form.append("file", new File([blob], `rec-${i}.${ext}`, { type: blob.type }))
            form.append("source", "web")
            const res = await fetch("/api/ai/stt", {
                method: "POST",
                headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
                body: form,
            })
            if (!res.ok) continue // 한 조각 실패로 전체를 버리지 않는다
            const j = (await res.json()) as { transcript?: string }
            const t = j.transcript?.trim() ?? ""
            // 무음 조각(빈 전사)도 성공 응답이면 기억 — 재시도마다 다시 과금되는 것을 막는다
            transcriptCache.set(blob, t)
            if (t) texts.push(t)
        } catch {
            /* 이 조각은 건너뛴다 */
        }
    }
    return texts.join(" ").trim()
}
