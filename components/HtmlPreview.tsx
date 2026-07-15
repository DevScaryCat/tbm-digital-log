"use client"

import { useRef, useState, useEffect, useCallback } from "react"

// 이메일 발송본 HTML(640px 데스크톱 폭 설계)을 앱 안에서 미리보기.
// 원본 HTML 문자열은 실제 발송 메일에도 재사용되므로 절대 수정하지 않고,
// 여기(React 래퍼)에서 폰 폭에 맞춰 축소(썸네일)하거나 실제 크기 가로 스크롤로 보여준다.
const DESIGN_WIDTH = 640

export function HtmlPreview({ html }: { html: string }) {
    const [actualSize, setActualSize] = useState(false)
    const outerRef = useRef<HTMLDivElement>(null)
    const innerRef = useRef<HTMLDivElement>(null)
    const [scale, setScale] = useState(1)
    const [boxHeight, setBoxHeight] = useState<number | undefined>(undefined)

    const recompute = useCallback(() => {
        const outer = outerRef.current
        const inner = innerRef.current
        if (!outer || !inner) return
        if (actualSize) {
            setScale(1)
            setBoxHeight(undefined)
            return
        }
        const avail = outer.clientWidth
        const s = Math.min(1, avail / DESIGN_WIDTH)
        setScale(s)
        // transform:scale은 레이아웃 박스에 영향을 주지 않으므로 scrollHeight는 미축소 높이 → 축소분 곱해 래퍼 높이 보정
        setBoxHeight(inner.scrollHeight * s)
    }, [actualSize])

    useEffect(() => {
        recompute()
        const ro = new ResizeObserver(recompute)
        if (outerRef.current) ro.observe(outerRef.current)
        // 폰트/이미지 로드 후 높이가 바뀔 수 있어 한 번 더
        const t = setTimeout(recompute, 150)
        return () => {
            ro.disconnect()
            clearTimeout(t)
        }
    }, [recompute, html])

    return (
        <div className="space-y-2">
            <div
                ref={outerRef}
                className={`rounded-lg border border-cur-hairline bg-white ${actualSize ? "overflow-x-auto" : "overflow-hidden"}`}
                style={!actualSize && boxHeight ? { height: boxHeight } : undefined}
            >
                <div
                    ref={innerRef}
                    style={{
                        width: DESIGN_WIDTH,
                        transform: actualSize ? undefined : `scale(${scale})`,
                        transformOrigin: "top left",
                    }}
                    dangerouslySetInnerHTML={{ __html: html }}
                />
            </div>
            <button
                type="button"
                onClick={() => setActualSize((v) => !v)}
                className="text-[12px] text-cur-muted hover:text-cur-ink transition-colors"
            >
                {actualSize ? "← 화면에 맞추기" : "실제 크기로 보기 (가로 스크롤) →"}
            </button>
        </div>
    )
}
