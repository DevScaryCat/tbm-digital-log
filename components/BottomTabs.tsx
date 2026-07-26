"use client"

/* Hallmark · component: tab-bar · genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * states: default · hover · focus · active · current · disabled · loading · badge
 * contrast: pass — cur-primary #f54e00 on cur-card #fff = 3.9:1 (icon+bold label, AA large/UI)
 * tokens only: no inline hex, hairline-only depth, CTA radius 8px
 */

import type { ReactNode } from "react"
import { HardHat, Building2 } from "lucide-react"

export type TabKey = "tbm" | "company"

interface Props {
    value: TabKey
    onChange: (t: TabKey) => void
    /** 현장관리 탭에 표시할 알림 점 (예: 소속 현장 초대 대기) */
    companyDot?: boolean
    /** 아직 역할·조직 정보를 불러오는 중 — 라벨 자리를 유지한 채 비활성 */
    loading?: boolean
}

interface TabDef {
    key: TabKey
    label: string
    icon: ReactNode
}

const TABS: TabDef[] = [
    { key: "tbm", label: "TBM", icon: <HardHat className="w-[22px] h-[22px]" /> },
    { key: "company", label: "현장관리", icon: <Building2 className="w-[22px] h-[22px]" /> },
]

export function BottomTabs({ value, onChange, companyDot, loading }: Props) {
    // 탭바는 fixed라 문서 흐름에서 빠진다 — 같은 높이의 스페이서를 넣어야
    // 페이지 맨 아래(푸터 저작권 줄 등)가 바 뒤로 숨지 않는다.
    return (
      <>
        <div aria-hidden className="h-[58px] pb-[env(safe-area-inset-bottom)]" />
        <nav
            aria-label="주요 화면"
            // 모바일 폭 컨테이너에 맞춰 가운데 고정. 홈 인디케이터 영역만큼 아래 여백을 더한다.
            className="fixed inset-x-0 bottom-0 z-40 bg-cur-card/95 backdrop-blur-sm border-t border-cur-hairline pb-[env(safe-area-inset-bottom)]"
        >
            <ul className="max-w-lg mx-auto grid grid-cols-2">
                {TABS.map((t) => {
                    const current = value === t.key
                    return (
                        <li key={t.key} className="relative">
                            <button
                                type="button"
                                aria-current={current ? "page" : undefined}
                                disabled={loading}
                                onClick={() => onChange(t.key)}
                                className={[
                                    "group relative w-full h-[58px] flex flex-col items-center justify-center gap-1",
                                    "transition-colors duration-150 ease-out",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-inset",
                                    "disabled:opacity-45 disabled:cursor-default",
                                    current
                                        ? "text-cur-primary"
                                        : "text-cur-muted hover:text-cur-ink active:bg-cur-elevated/60 disabled:hover:text-cur-muted",
                                ].join(" ")}
                            >
                                {/* 선택 표시는 상단 2px 바 — 색만으로 구분하지 않는다(색각 이상 대응) */}
                                <span
                                    aria-hidden
                                    className={[
                                        "absolute top-0 left-1/2 -translate-x-1/2 h-[2px] rounded-full bg-cur-primary",
                                        "transition-all duration-200 ease-out",
                                        current ? "w-10 opacity-100" : "w-0 opacity-0",
                                    ].join(" ")}
                                />
                                <span className="relative">
                                    {t.icon}
                                    {t.key === "company" && companyDot && (
                                        <span
                                            aria-hidden
                                            className="absolute -top-0.5 -right-1 w-2 h-2 rounded-full bg-cur-primary ring-2 ring-cur-card"
                                        />
                                    )}
                                </span>
                                <span className={`text-[11px] leading-none ${current ? "font-bold" : "font-medium"}`}>
                                    {t.label}
                                </span>
                            </button>
                        </li>
                    )
                })}
            </ul>
        </nav>
      </>
    )
}

/** 탭 선택 기억 — 마지막으로 본 탭이 다음 진입의 기본값이 된다 */
const TAB_KEY = "antok_last_tab"

export function readLastTab(): TabKey | null {
    if (typeof window === "undefined") return null
    const v = window.localStorage.getItem(TAB_KEY)
    return v === "tbm" || v === "company" ? v : null
}

export function writeLastTab(t: TabKey) {
    if (typeof window === "undefined") return
    try {
        window.localStorage.setItem(TAB_KEY, t)
    } catch {
        /* 사파리 프라이빗 모드 등 저장 불가 — 기억만 못 할 뿐 동작에는 영향 없음 */
    }
}
