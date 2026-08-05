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

    /** 녹음 시작과 함께 호출. 실패해도 throw하지 않는다(원음 없이 진행). */
    const start = useCallback(async () => {
        if (!SERVER_STT_ENABLED) return
        if (recorderRef.current) return // 이미 녹음 중
        try {
            const mimeType = pickMimeType()
            if (!mimeType || !navigator.mediaDevices?.getUserMedia) return

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
        } catch {
            // 권한 거부·장치 없음 등 — 원음 없이 계속 진행
            recorderRef.current = null
            streamRef.current = null
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
export async function transcribeBlobs(blobs: Blob[], accessToken?: string): Promise<string> {
    if (!blobs.length) return ""
    const texts: string[] = []
    for (const [i, blob] of blobs.entries()) {
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
            if (j.transcript?.trim()) texts.push(j.transcript.trim())
        } catch {
            /* 이 조각은 건너뛴다 */
        }
    }
    return texts.join(" ").trim()
}
