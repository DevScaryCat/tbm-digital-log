"use client"

import { type ReactNode } from "react"
import { ChevronRight } from "lucide-react"

// 설정/관리 화면 공용 리스트 (A안) — 흰 카드 안에 항목들을 hairline 구분선으로 묶는다.
// 계정·보고서설정·프로필 등 설정성 화면의 시각 언어를 통일하는 프리미티브.
export function SettingsCard({
    children,
    className = "",
}: {
    children: ReactNode
    className?: string
}) {
    return (
        <div
            className={`bg-cur-card rounded-2xl border border-cur-hairline overflow-hidden divide-y divide-cur-hairline ${className}`}
        >
            {children}
        </div>
    )
}

type SettingsRowProps = {
    icon?: ReactNode
    label: string
    sublabel?: string
    /** 오른쪽에 보여줄 현재값 (예: "카카오페이", "Pro") */
    value?: ReactNode
    /** 우측 커스텀 컨트롤(스위치/셀렉트 등). value와 함께 쓰지 않는 게 보통 */
    trailing?: ReactNode
    onClick?: () => void
    /** 다른 화면으로 이동/펼침 어포던스. onClick 있으면 기본 표시 */
    chevron?: boolean
    /** 파괴적 동작(해지·삭제 등) — 강조 없이 조용한 회색, hover 시에만 빨강 */
    destructive?: boolean
    disabled?: boolean
}

export function SettingsRow({
    icon,
    label,
    sublabel,
    value,
    trailing,
    onClick,
    chevron,
    destructive = false,
    disabled = false,
}: SettingsRowProps) {
    const interactive = !!onClick && !disabled
    const showChevron = chevron ?? (interactive && !trailing)
    const content = (
        <>
            {icon && (
                <span className="flex w-5 h-5 items-center justify-center shrink-0 text-cur-muted">
                    {icon}
                </span>
            )}
            <span className="flex-1 min-w-0">
                <span
                    className={`block text-[14px] font-medium truncate ${
                        destructive
                            ? "text-cur-muted group-hover:text-cur-error transition-colors"
                            : "text-cur-ink"
                    }`}
                >
                    {label}
                </span>
                {sublabel && (
                    <span className="block text-[12px] text-cur-muted-soft truncate mt-0.5">{sublabel}</span>
                )}
            </span>
            {value != null && <span className="text-[13px] text-cur-muted shrink-0">{value}</span>}
            {trailing}
            {showChevron && <ChevronRight className="w-[18px] h-[18px] text-cur-hairline-strong shrink-0" />}
        </>
    )

    const base = "group w-full flex items-center gap-3 px-4 py-3.5 text-left"
    if (!interactive) {
        return <div className={`${base} ${disabled ? "opacity-50" : ""}`}>{content}</div>
    }
    return (
        <button
            type="button"
            onClick={onClick}
            className={`${base} hover:bg-cur-canvas-soft active:bg-cur-elevated transition-colors`}
        >
            {content}
        </button>
    )
}
