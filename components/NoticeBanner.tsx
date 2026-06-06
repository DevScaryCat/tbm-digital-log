"use client"

import { useEffect, useState } from "react"
import { NOTICES } from "@/lib/notices"

const STORAGE_KEY = "dismissed_notices"

// 최신 공지를 배너로 표시. 닫으면 localStorage에 기록되어 다시 안 뜸.
export function NoticeBanner() {
    const [dismissed, setDismissed] = useState<string[]>([])
    const [ready, setReady] = useState(false)

    useEffect(() => {
        try {
            setDismissed(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"))
        } catch {}
        setReady(true)
    }, [])

    if (!ready) return null
    const notice = NOTICES.find((n) => !dismissed.includes(n.id))
    if (!notice) return null

    const close = () => {
        const next = [...dismissed, notice.id]
        setDismissed(next)
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
        } catch {}
    }

    return (
        <div className="relative bg-cur-primary/[0.06] border border-cur-primary/30 rounded-[12px] p-4">
            <button
                onClick={close}
                className="absolute top-3 right-3 text-[12px] text-cur-muted hover:text-cur-ink"
            >
                닫기
            </button>
            <div className="text-[11px] font-semibold text-cur-primary mb-1">공지 · {notice.date}</div>
            <div className="font-bold text-[15px] text-cur-ink mb-1 pr-10">{notice.title}</div>
            <p className="text-[13px] text-cur-body leading-relaxed">{notice.body}</p>
        </div>
    )
}
