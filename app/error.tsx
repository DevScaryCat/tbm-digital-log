"use client"

import { useEffect } from "react"

// 세그먼트 렌더 예외를 잡는 한글 에러 화면 (없으면 Next 기본 영문 'Application error' 노출)
export default function Error({
    error,
    reset,
}: {
    error: Error & { digest?: string }
    reset: () => void
}) {
    useEffect(() => {
        console.error(error)
    }, [error])

    return (
        <div className="min-h-screen bg-cur-canvas flex items-center justify-center p-6">
            <div className="w-full max-w-sm bg-cur-card border border-cur-hairline rounded-2xl p-8 text-center shadow-[0_4px_12px_rgba(0,0,0,0.04)]">
                <div className="text-4xl">⚠️</div>
                <h1 className="mt-4 text-lg font-bold text-cur-ink">문제가 발생했어요</h1>
                <p className="mt-2 text-sm text-cur-muted leading-relaxed">
                    일시적인 오류일 수 있습니다. 다시 시도해 주세요.
                    <br />문제가 계속되면 잠시 후 다시 접속해 주세요.
                </p>
                <div className="mt-6 flex flex-col gap-2">
                    <button
                        onClick={() => reset()}
                        className="inline-flex items-center justify-center w-full h-12 rounded-[10px] bg-cur-primary text-cur-on-primary text-[15px] font-bold hover:bg-cur-primary-active transition-colors"
                    >
                        다시 시도
                    </button>
                    <a
                        href="/"
                        className="inline-flex items-center justify-center w-full h-12 rounded-[10px] border border-cur-hairline text-cur-ink text-[14px] font-semibold bg-cur-card hover:bg-cur-elevated transition-colors"
                    >
                        홈으로
                    </a>
                </div>
            </div>
        </div>
    )
}
