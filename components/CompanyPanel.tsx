"use client"

/* Hallmark · component: panel (company tab) · genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * states: loading · empty(onboarding) · populated · read-only(member) · error
 * tokens only — hairline depth, card radius 12px, CTA radius 8px, cur-primary used scarcely
 *
 * 회사관리 탭. 세 역할이 같은 골격을 본다 (결정 4):
 *   - 감독자/단독: 조작 가능
 *   - 소속 현장: 같은 화면을 보되 조작 불가 + "감독자가 관리 중" 안내
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import {
    Loader2, ChevronRight, FileBarChart2, Settings2, Users, Sparkles,
    CheckCircle2, CircleDashed, Lock, CreditCard,
} from "lucide-react"

interface SiteRow {
    userId: string
    siteName: string
    managerName: string
    status: "active" | "detached"
    isOwner: boolean
    isSelf: boolean
    todayDone: boolean
    todayMinutes: number
    todayLogs: number
    monthMinutes: number
    monthLogs: number
    lastActivity: string | null
}

interface Overview {
    kind: "owner" | "member" | "solo"
    canManage: boolean
    orgName: string
    accountCount: number
    memberCount: number
    todayDoneCount: number
    today: string
    sites: SiteRow[]
}

const SEAT_PRICE = 3900

export function CompanyPanel() {
    const router = useRouter()
    const [data, setData] = useState<Overview | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        ;(async () => {
            try {
                const { data: s } = await supabase.auth.getSession()
                const res = await fetch("/api/org/overview", {
                    headers: { Authorization: `Bearer ${s?.session?.access_token}` },
                })
                if (res.ok) setData(await res.json())
            } finally {
                setLoading(false)
            }
        })()
    }, [])

    if (loading) {
        return (
            <div className="py-24 flex justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-cur-muted" />
            </div>
        )
    }
    if (!data) {
        return <p className="text-[14px] text-cur-muted text-center py-16">현황을 불러오지 못했습니다.</p>
    }

    const managed = data.canManage
    const activeSites = data.sites.filter((s) => s.status === "active")

    // ── 첫 진입: 아직 소속 현장이 없는 감독자/단독 ──────────────────────
    if (managed && data.memberCount === 0) {
        return (
            <div className="space-y-5">
                <header className="text-center space-y-2 pt-2">
                    <h1 className="text-[22px] font-bold text-cur-ink tracking-[-0.02em]">
                        현장을 추가하면 시작이에요
                    </h1>
                    <p className="text-[13px] text-cur-muted leading-relaxed">
                        현장 계정을 만들어 담당자에게 전달하면<br />
                        그 현장의 기록이 여기로 모입니다
                    </p>
                </header>

                <ol className="bg-cur-card rounded-[12px] border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                    {[
                        { n: 1, t: "현장 계정 만들기", d: "아이디·비밀번호를 정해 담당자에게 전달", now: true },
                        { n: 2, t: "현장에서 TBM 기록", d: "담당자가 회의록·교육일지를 작성해요" },
                        { n: 3, t: "매달 1일 종합 보고서", d: "전 현장을 묶은 보고서가 여기 쌓여요" },
                    ].map((s) => (
                        <li key={s.n} className="flex items-start gap-3 p-4">
                            <span
                                className={`w-6 h-6 rounded-full text-[12px] font-bold flex items-center justify-center shrink-0 ${
                                    s.now ? "bg-cur-primary text-cur-on-primary" : "bg-cur-elevated text-cur-muted-soft"
                                }`}
                            >
                                {s.n}
                            </span>
                            <span className="flex-1 min-w-0">
                                <span className={`block text-[14px] font-semibold ${s.now ? "text-cur-ink" : "text-cur-muted"}`}>
                                    {s.t}
                                </span>
                                <span className="block text-[12px] text-cur-muted-soft mt-0.5">{s.d}</span>
                            </span>
                        </li>
                    ))}
                </ol>

                <div className="space-y-2">
                    <button
                        onClick={() => router.push("/org/members?new=1")}
                        className="w-full h-12 rounded-[8px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[15px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-offset-2"
                    >
                        현장 계정 만들기
                    </button>
                    <button
                        onClick={() => router.push("/org/members")}
                        className="w-full h-11 rounded-[8px] text-[13px] font-semibold text-cur-muted hover:text-cur-ink hover:bg-cur-elevated transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                    >
                        이미 안톡을 쓰던 현장이 있어요 (기존 계정 편입)
                    </button>
                </div>

                <p className="text-[12px] text-cur-muted-soft text-center leading-relaxed">
                    현장을 추가하면 계정 1개당 월 {SEAT_PRICE.toLocaleString()}원이 더해져요.<br />
                    지금은 내 계정 1개 — 월 {SEAT_PRICE.toLocaleString()}원.
                </p>
            </div>
        )
    }

    return (
        <div className="space-y-5">
            {/* 소속 현장 안내 — 왜 아무것도 못 누르는지 먼저 설명한다 */}
            {!managed && (
                <div className="flex items-start gap-3 p-3.5 rounded-[12px] bg-cur-elevated border border-cur-hairline">
                    <Lock className="w-4 h-4 mt-0.5 shrink-0 text-cur-muted" />
                    <p className="text-[13px] text-cur-body leading-relaxed">
                        <span className="font-semibold text-cur-ink">{data.orgName || "회사"}</span> 소속 현장이에요.
                        계정·결제·보고서 설정은 <span className="font-semibold text-cur-ink">감독자가 관리 중</span>입니다.
                    </p>
                </div>
            )}

            {/* 오늘 요약 */}
            <section className="bg-cur-card rounded-[12px] border border-cur-hairline p-5">
                {data.orgName && <p className="text-[13px] text-cur-muted">{data.orgName}</p>}
                <h1 className="text-[20px] font-bold text-cur-ink mt-0.5">
                    오늘 TBM 실시 <span className="text-cur-primary">{data.todayDoneCount}</span>
                    <span className="text-cur-muted font-semibold text-[16px]"> / {activeSites.length}개 현장</span>
                </h1>
                <div className="mt-3 h-2 rounded-full bg-cur-elevated overflow-hidden">
                    <div
                        className="h-full bg-cur-primary rounded-full transition-all duration-700 ease-out"
                        style={{ width: activeSites.length ? `${Math.round((data.todayDoneCount / activeSites.length) * 100)}%` : "0%" }}
                    />
                </div>
                {managed && (
                    <p className="text-[12px] text-cur-muted-soft mt-2">
                        계정 {data.accountCount}개 · 월 {(data.accountCount * SEAT_PRICE).toLocaleString()}원
                    </p>
                )}
            </section>

            {/* 현장 목록 — 감독자 본인 현장이 맨 위 */}
            <section className="space-y-2">
                <h2 className="text-[14px] font-bold text-cur-ink px-1">현장 현황</h2>
                <div className="bg-cur-card rounded-[12px] border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                    {activeSites.map((s) => {
                        const openable = managed
                        const Row = openable ? "button" : "div"
                        return (
                            <Row
                                key={s.userId}
                                {...(openable
                                    ? {
                                          onClick: () => router.push(`/org/sites/${s.userId}`),
                                          className:
                                              "w-full flex items-center gap-3 p-4 text-left hover:bg-cur-elevated/50 active:bg-cur-elevated transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-inset",
                                      }
                                    : { className: "w-full flex items-center gap-3 p-4 text-left" })}
                            >
                                {s.todayDone ? (
                                    <span className="w-9 h-9 rounded-full bg-cur-success/10 text-cur-success flex items-center justify-center shrink-0">
                                        <CheckCircle2 className="w-5 h-5" />
                                    </span>
                                ) : (
                                    <span className="w-9 h-9 rounded-full bg-cur-elevated text-cur-muted-soft flex items-center justify-center shrink-0">
                                        <CircleDashed className="w-5 h-5" />
                                    </span>
                                )}
                                <span className="flex-1 min-w-0">
                                    <span className="flex items-center gap-1.5">
                                        <span className="text-[15px] font-semibold text-cur-ink truncate">{s.siteName}</span>
                                        {s.isSelf && (
                                            <span className="shrink-0 text-[10px] font-bold text-cur-primary bg-cur-primary/10 px-1.5 py-0.5 rounded-[4px]">
                                                내 현장
                                            </span>
                                        )}
                                    </span>
                                    <span className="block text-[12px] text-cur-muted mt-0.5">
                                        {s.todayDone
                                            ? `오늘 회의록 ${s.todayMinutes} · 일지 ${s.todayLogs}`
                                            : s.lastActivity
                                              ? `마지막 활동 ${s.lastActivity}`
                                              : "이번 달 기록 없음"}
                                        {" · "}이번 달 {s.monthMinutes + s.monthLogs}건
                                    </span>
                                </span>
                                {openable && <ChevronRight className="w-4 h-4 text-cur-muted-soft shrink-0" />}
                            </Row>
                        )
                    })}
                </div>
            </section>

            {/* 관리 바로가기 — 소속 현장에게는 잠긴 모습으로 같은 자리에 보인다 */}
            <section className="grid grid-cols-2 gap-2.5">
                {[
                    { href: "/org/reports", label: "월간 보고서", desc: "전 현장 종합 열람", icon: <FileBarChart2 className="w-5 h-5" /> },
                    { href: "/risk-assessment", label: "AI 분석 보고서", desc: "현장별 위험요인 분석", icon: <Sparkles className="w-5 h-5" /> },
                    { href: "/report-settings", label: "보고서 설정", desc: "외부 수신처 관리", icon: <Settings2 className="w-5 h-5" /> },
                    { href: "/org/members", label: "현장 계정 관리", desc: "계정 발급·편입", icon: <Users className="w-5 h-5" /> },
                    { href: "/account", label: "구독 및 결제", desc: "카드·해지", icon: <CreditCard className="w-5 h-5" /> },
                ].map((q) => (
                    <button
                        key={q.href}
                        type="button"
                        disabled={!managed}
                        aria-disabled={!managed}
                        onClick={() => managed && router.push(q.href)}
                        className={[
                            "bg-cur-card rounded-[12px] border border-cur-hairline p-4 text-left transition-all",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary",
                            managed
                                ? "hover:border-cur-primary/40 active:bg-cur-elevated/40 cursor-pointer"
                                : "opacity-55 cursor-not-allowed",
                        ].join(" ")}
                    >
                        <span
                            className={`w-9 h-9 rounded-[8px] flex items-center justify-center ${
                                managed ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-elevated text-cur-muted-soft"
                            }`}
                        >
                            {managed ? q.icon : <Lock className="w-4 h-4" />}
                        </span>
                        <span className="block text-[14px] font-bold text-cur-ink mt-2.5">{q.label}</span>
                        <span className="block text-[12px] text-cur-muted mt-0.5">
                            {managed ? q.desc : "감독자가 관리"}
                        </span>
                    </button>
                ))}
            </section>
        </div>
    )
}
