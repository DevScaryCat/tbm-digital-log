"use client"

import { useEffect, useState } from "react"
import { Check, Loader2 } from "lucide-react"

export type ProgressStep = {
    key: string
    /** 진행 중일 때 문구 — "…하는 중" */
    label: string
    /** 끝났을 때 문구 (생략하면 label 유지) */
    doneLabel?: string
}

/**
 * 진행 중인 단계의 경과 초. 단계마다 새로 마운트되므로(key=단계) 0부터 다시 센다.
 * 3초 넘게 걸릴 때만 나타난다 — 짧은 단계에서 숫자가 깜빡이면 소음이다.
 */
function ElapsedSeconds() {
    const [n, setN] = useState(0)
    useEffect(() => {
        const t = setInterval(() => setN((v) => v + 1), 1000)
        return () => clearInterval(t)
    }, [])
    if (n < 3) return null
    return <span className="text-[12px] leading-6 text-cur-muted-soft tabular-nums shrink-0">{n}초</span>
}

/**
 * 분석 진행 상태 — 10~20초 걸리는 동안 "지금 뭘 하고 있는지"를 보여준다.
 *
 * 가짜 퍼센트·가짜 단계는 넣지 않는다. activeKey는 호출부가 실제 작업 경계
 * (회의록 수집 완료 → AI 응답 도착 → 미리보기 생성)에서만 바꾸므로,
 * 체크가 켜졌다는 건 그 일이 실제로 끝났다는 뜻이다.
 * 경과 초는 진행 중인 단계에만, 3초 넘게 걸릴 때만 붙는다(짧은 단계의 깜빡임 방지).
 */
export function AnalyzeProgress({
    steps,
    activeKey,
    title,
    subtitle,
}: {
    steps: ProgressStep[]
    activeKey: string
    title: string
    subtitle?: string
}) {
    const found = steps.findIndex((s) => s.key === activeKey)
    const idx = found < 0 ? 0 : found

    return (
        <div className="bg-cur-card rounded-[12px] border border-cur-hairline p-5 py-7">
            <p className="text-[15px] font-bold text-cur-ink text-center">{title}</p>
            {subtitle && <p className="text-[12px] text-cur-muted-soft text-center mt-1">{subtitle}</p>}

            {/* 스크린리더에는 현재 단계만 한 줄로 — 목록 전체를 매번 다시 읽지 않게 */}
            <p className="sr-only" aria-live="polite">{steps[idx]?.label}</p>

            <ol className="mt-6">
                {steps.map((s, i) => {
                    const state = i < idx ? "done" : i === idx ? "active" : "pending"
                    const last = i === steps.length - 1
                    return (
                        <li key={s.key} className="flex gap-3">
                            <div className="flex flex-col items-center shrink-0">
                                <span
                                    className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors duration-200 ease-out ${
                                        state === "done"
                                            ? "bg-cur-primary text-cur-on-primary"
                                            : state === "active"
                                              ? "bg-cur-primary/15 text-cur-primary"
                                              : "border border-cur-hairline-strong text-cur-muted-soft"
                                    }`}
                                >
                                    {state === "done" ? (
                                        <Check className="w-3.5 h-3.5 animate-in zoom-in-50 duration-200 motion-reduce:animate-none" strokeWidth={3} />
                                    ) : state === "active" ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" />
                                    ) : (
                                        <span className="w-1.5 h-1.5 rounded-full bg-cur-hairline-strong" />
                                    )}
                                </span>
                                {/* 단계를 잇는 레일 — 지나온 구간만 색이 찬다 */}
                                {!last && (
                                    <span
                                        className={`w-px flex-1 min-h-[18px] transition-colors duration-300 ease-out ${
                                            i < idx ? "bg-cur-primary" : "bg-cur-hairline"
                                        }`}
                                    />
                                )}
                            </div>
                            <div className={`min-w-0 flex-1 flex items-baseline gap-2 ${last ? "" : "pb-4"}`}>
                                <span
                                    className={`text-[14px] leading-6 transition-colors duration-200 ease-out ${
                                        state === "active"
                                            ? "font-bold text-cur-ink"
                                            : state === "done"
                                              ? "font-medium text-cur-muted"
                                              : "text-cur-muted-soft"
                                    }`}
                                >
                                    {state === "done" ? (s.doneLabel ?? s.label) : s.label}
                                </span>
                                {state === "active" && <ElapsedSeconds key={activeKey} />}
                            </div>
                        </li>
                    )
                })}
            </ol>
        </div>
    )
}
