"use client"

/* Hallmark · component: modal (전역 안내·확인 대화상자) · genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * states: default · hover · focus-visible · active · (확인/취소 2종) · danger
 * tokens only — hairline depth, card radius 12px
 */

// 브라우저 기본 alert()/confirm()을 대신 그리는 전역 호스트. layout에 하나만 둔다.
// 요청은 lib/uiDialog의 모듈 큐에서 오므로, 훅을 쓸 수 없는 위치(핸들러 안 등)에서도 부를 수 있다.

import { useEffect, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import { peekDialog, resolveDialog, subscribeDialogs, type DialogRequest } from "@/lib/uiDialog"

export function DialogHost() {
    // 큐는 리액트 밖 상태 — 구독해서 맨 앞 요청만 그린다
    const current = useSyncExternalStore<DialogRequest | null>(
        subscribeDialogs,
        peekDialog,
        () => null, // 서버 렌더에는 대화상자가 없다
    )
    // 열릴 때 확인 버튼으로 포커스를 옮겨 Enter/Esc가 바로 먹게 한다
    const [node, setNode] = useState<HTMLButtonElement | null>(null)
    useEffect(() => { node?.focus() }, [node, current?.id])

    useEffect(() => {
        if (!current) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") { e.preventDefault(); resolveDialog(current.id, false) }
        }
        document.addEventListener("keydown", onKey)
        // 대화상자 뒤 본문이 같이 스크롤되면 어디를 보고 있었는지 잃는다
        const prev = document.body.style.overflow
        document.body.style.overflow = "hidden"
        return () => {
            document.removeEventListener("keydown", onKey)
            document.body.style.overflow = prev
        }
    }, [current])

    if (!current) return null

    const close = (ok: boolean) => resolveDialog(current.id, ok)

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label={current.title ?? "안내"}
            className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
        >
            {/* 바깥 클릭 = 취소. 확인(파괴적 행동)은 버튼으로만 일어난다 */}
            <button
                type="button"
                aria-label="닫기"
                onClick={() => close(false)}
                className="absolute inset-0 bg-cur-ink/40 animate-in fade-in duration-150 motion-reduce:animate-none"
            />
            <div className="relative w-full max-w-sm bg-cur-card rounded-[12px] border border-cur-hairline shadow-[0_12px_40px_rgba(0,0,0,0.16)] p-5 space-y-4 animate-in fade-in zoom-in-95 slide-in-from-bottom-2 sm:slide-in-from-bottom-0 duration-200 motion-reduce:animate-none">
                {current.title && (
                    <p className="text-[16px] font-bold text-cur-ink">{current.title}</p>
                )}
                {/* 줄바꿈은 원문 그대로 — 기본 대화상자에서 쓰던 \n 안내가 그대로 읽혀야 한다 */}
                <p className="text-[14px] leading-relaxed text-cur-body whitespace-pre-wrap break-words">
                    {current.message}
                </p>
                <div className="flex gap-2 pt-1">
                    {current.isConfirm && (
                        <Button
                            variant="outline"
                            onClick={() => close(false)}
                            className="flex-1 h-11 rounded-[8px] border-cur-hairline text-cur-ink text-[14px] font-semibold hover:bg-cur-elevated"
                        >
                            취소
                        </Button>
                    )}
                    <Button
                        ref={setNode}
                        onClick={() => close(true)}
                        className={`flex-[2] h-11 rounded-[8px] text-cur-on-primary text-[14px] font-bold focus-visible:ring-2 focus-visible:ring-offset-2 ${
                            current.danger
                                ? "bg-cur-error hover:bg-cur-error/90 focus-visible:ring-cur-error"
                                : "bg-cur-primary hover:bg-cur-primary-active focus-visible:ring-cur-primary"
                        }`}
                    >
                        {current.confirmText ?? "확인"}
                    </Button>
                </div>
            </div>
        </div>
    )
}
