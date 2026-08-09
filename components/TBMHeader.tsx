// components/TBMHeader.tsx
"use client"

import { useState, useEffect, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { LogOut, User, Home, ChevronLeft, Users, CreditCard, Lock, Settings } from "lucide-react"
import { Logo } from "@/components/Logo"
import { fetchSubscription, planBadge } from "@/lib/useSubscription"
import { fetchOrgContext, type ClientOrgContext } from "@/lib/useOrgContext"

interface TBMHeaderProps {
    title?: string
    onLogout?: () => void
    pageBadge?: string
    titleAction?: ReactNode
    /** 좌상단 버튼을 홈(/) 대신 지정 경로로 '돌아가기'(←)로 표시 */
    backHref?: string
}

// 월 한도 — DB 트리거 enforce_tbm_monthly_limit와 반드시 같은 집합/같은 숫자여야 한다.
// 유료 단일 티어(monthly_pro·org_seat·구 org) = 200/30/20, legacy(구 베이직·영구무료) = 80/10/0.
const PAID = { log: 200, minutes: 30, ra: 20 }
const LEGACY = { log: 80, minutes: 10, ra: 0 }
const LIMITS: Record<string, { log: number; minutes: number; ra: number }> = {
    monthly_pro: PAID,
    org_seat: PAID,
    org: PAID,
    monthly_basic: LEGACY,
    grandfather: LEGACY,
}
function limitFor(plan: string | null, kind: "log" | "minutes" | "ra"): number {
    return (LIMITS[plan ?? "monthly_pro"] ?? PAID)[kind]
}
function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
    // legacy 플랜에서 AI 분석처럼 한도가 0인 항목
    if (limit === 0) {
        return (
            <div className="flex justify-between text-[12px]">
                <span className="text-cur-muted">{label}</span>
                <span className="text-cur-muted-soft font-medium">미포함</span>
            </div>
        )
    }
    // 무제한(grandfather)
    if (!isFinite(limit)) {
        return (
            <div className="flex justify-between text-[12px]">
                <span className="text-cur-muted">{label}</span>
                <span className="text-cur-ink font-medium">{used}회 · 무제한</span>
            </div>
        )
    }
    const remaining = Math.max(0, limit - used)
    // 사용량 기준 바 (0에서 채워지는 방향)
    const pct = Math.min(100, Math.max(0, Math.round((used / limit) * 100)))
    const full = remaining <= 0
    const low = !full && remaining <= Math.max(1, Math.ceil(limit * 0.2))
    const color = full ? "bg-red-500" : low ? "bg-amber-400" : "bg-cur-primary"
    return (
        <div className="space-y-1">
            <div className="flex justify-between text-[12px]">
                <span className="text-cur-muted">{label}</span>
                <span className={`font-medium ${full ? "text-red-600" : low ? "text-amber-600" : "text-cur-ink"}`}>
                    {used} / {limit}회 사용
                </span>
            </div>
            <div className="w-full h-1.5 bg-cur-elevated rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
            </div>
        </div>
    )
}

export function TBMHeader({ title = "TBM 일지", onLogout, pageBadge, titleAction, backHref }: TBMHeaderProps) {
    const router = useRouter()
    const [userName, setUserName] = useState("사용자")
    const [badge, setBadge] = useState<{ label: string; isPro: boolean; trial: boolean } | null>(null)
    const [plan, setPlan] = useState<string | null>(null)
    const [usage, setUsage] = useState<{ log: number; minutes: number; ra: number } | null>(null)
    const [usageStartISO, setUsageStartISO] = useState<string | null>(null)
    const [resetLabel, setResetLabel] = useState("매월 1일 초기화")
    // 조직 역할 — member는 보고서 설정·구독/결제 메뉴 숨김, owner는 좌석 관리 노출
    const [orgKind, setOrgKind] = useState<"owner" | "member" | "solo" | null>(null)
    // 현장 계정 점 배지 판정용 — 조회 실패(null)면 점을 띄우지 않는다 (근거 없이 재촉하지 않기)
    const [orgCtx, setOrgCtx] = useState<ClientOrgContext | null>(null)
    // '여러 현장을 관리해요'를 골랐는가 — user_metadata.usage_type(단일 진실)에서 파생
    const [multiSite, setMultiSite] = useState(false)

    useEffect(() => {
        const getUser = async () => {
            const { data: { session } } = await supabase.auth.getSession()
            if (session) {
                const meta = session.user.user_metadata
                setUserName(meta.full_name || meta.company_name || "사용자")
                setMultiSite(meta.usage_type === "multi")
                const sub = await fetchSubscription()
                setBadge(planBadge(sub))
                setPlan(sub?.plan ?? null)
                // 한도 창은 DB 트리거 enforce_tbm_monthly_limit·AI 분석 API와 동일한
                // KST 달력월이어야 한다. 결제주기 창(usageWindow)으로 세면 헤더는 여유라는데
                // 트리거가 P0001로 저장을 거부하는 어긋남이 생긴다.
                const kstYmd = new Intl.DateTimeFormat("en-CA", {
                    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
                }).format(new Date())
                setUsageStartISO(new Date(`${kstYmd.slice(0, 7)}-01T00:00:00+09:00`).toISOString())
                setResetLabel("매월 1일 초기화")
                fetchOrgContext().then((c) => { setOrgKind(c?.kind ?? "solo"); setOrgCtx(c) })
            }
        }
        getUser()
    }, [])

    // 사용량 3종은 닫힌 드롭다운 안에서만 보이므로, 매 페이지 마운트마다
    // 미리 조회하지 않고 메뉴를 처음 열 때 1회 조회한다(페이지당 불필요한 count 쿼리 제거).
    const loadUsage = async () => {
        // 유료 단일 티어(200/30/20)는 실사용이 닿지 않는 한도라 미터가 불안만 만든다 —
        // 한도가 실재하는 legacy(구 베이직 80/10/0·영구무료)에게만 보여준다.
        if (plan !== "monthly_basic" && plan !== "grandfather") return
        if (usage) return
        // KST 달력월 시작 — DB 트리거와 동일 규칙
        const kstYmd = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date())
        const startISO = usageStartISO ?? new Date(`${kstYmd.slice(0, 7)}-01T00:00:00+09:00`).toISOString()
        const [logs, mins, ras] = await Promise.all([
            supabase.from("tbm_logs").select("id", { count: "exact", head: true }).gte("created_at", startISO),
            supabase.from("tbm_minutes").select("id", { count: "exact", head: true }).gte("created_at", startISO),
            supabase.from("tbm_risk_assessments").select("id", { count: "exact", head: true }).gte("created_at", startISO),
        ])
        setUsage({ log: logs.count ?? 0, minutes: mins.count ?? 0, ra: ras.count ?? 0 })
    }

    const handleLogout = async () => {
        if (onLogout) {
            onLogout()
        } else {
            await supabase.auth.signOut()
            router.push("/login")
        }
    }

    // 관리+계정 통합 메뉴 — 기어 버튼을 없애고 이름 하나로 모음 (Chris 7/31).
    // 항목이 늘어난 만큼 섹션 라벨+구분선으로 분류를 명확히 나눈다.
    // 소속 현장에게는 관리 항목을 잠긴 모습으로 보여준다: 어디서 관리되는지 알게.
    // '여러 현장' 선택자가 아직 현장 계정을 하나도 안 만든 상태 — 현장 계정 관리 메뉴에 점을 띄운다.
    // 파생 조건 우선: 현장 계정이 1개라도 생기면(owner + 활성 member 존재) 선택값과 무관하게 끈다.
    // 판정 실패(orgCtx null)·소속 현장(member)·조직 구독 만료(orgLapsed)에는 띄우지 않는다. (앱과 동일 규칙)
    const needsFirstSiteAccount =
        multiSite &&
        !!orgCtx &&
        (orgCtx.kind === "owner"
            ? (orgCtx.memberIds ?? []).length === 0
            : orgCtx.kind === "solo" && !orgCtx.orgLapsed)

    const userProfileDropdown = (() => {
        const item = (m: { href: string; label: string; icon: ReactNode; dot?: boolean }) =>
            orgKind === "member" ? (
                <DropdownMenuItem key={m.href} disabled className="text-[14px] text-cur-muted-soft font-medium px-3 py-2.5 opacity-60">
                    <Lock className="mr-2 h-4 w-4" /> {m.label}
                    <span className="ml-auto text-[11px]">감독자 관리</span>
                </DropdownMenuItem>
            ) : (
                <DropdownMenuItem key={m.href} onClick={() => router.push(m.href)} className="cursor-pointer text-[14px] text-cur-body font-medium px-3 py-2.5 focus:bg-cur-elevated focus:text-cur-ink">
                    {m.icon} {m.label}
                    {/* 할 일 점 — 앱 메뉴의 점과 같은 규격(주황 1.5) */}
                    {m.dot && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-cur-primary" />}
                </DropdownMenuItem>
            )
        const groupLabel = (text: string) => (
            <DropdownMenuLabel className="px-3 pt-2 pb-0.5 text-[11px] font-semibold text-cur-muted-soft tracking-[0.5px]">{text}</DropdownMenuLabel>
        )
        return (
            <DropdownMenu onOpenChange={(open) => { if (open) loadUsage() }}>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="h-10 px-3 rounded-[8px] hover:bg-cur-elevated text-cur-body focus-visible:ring-2 focus-visible:ring-cur-primary">
                        <span className="text-[14px] font-medium text-cur-body">{userName}</span>
                    </Button>
                </DropdownMenuTrigger>
                {/* 좁은 화면에서 우측 정렬 + 화면 밖으로 안 나가게 max-w 안전장치 */}
                <DropdownMenuContent className="w-56 max-w-[calc(100vw-16px)] rounded-[12px] border-cur-hairline bg-cur-card shadow-[0_8px_24px_rgba(0,0,0,0.08)] font-sans" align="end">
                    {usage && (
                        <>
                            <div className="px-3 py-2.5 space-y-2.5">
                                <div className="flex items-center justify-between">
                                    <span className="text-[11px] text-cur-muted-soft font-semibold">사용량</span>
                                    <span className="text-[11px] text-cur-muted-soft">{resetLabel}</span>
                                </div>
                                {badge?.trial && (
                                    <div className="rounded-lg bg-cur-primary/[0.06] border border-cur-primary/30 px-2.5 py-1.5 text-[11px] font-medium text-cur-primary">
                                        무료체험 중
                                    </div>
                                )}
                                <UsageBar label="TBM 회의록" used={usage.minutes} limit={limitFor(plan, "minutes")} />
                                <UsageBar label="안전보건교육일지" used={usage.log} limit={limitFor(plan, "log")} />
                                <UsageBar label="AI 분석 보고서" used={usage.ra} limit={limitFor(plan, "ra")} />
                            </div>
                            <DropdownMenuSeparator className="bg-cur-hairline" />
                        </>
                    )}
                    {groupLabel("보고서·분석")}
                    {/* AI 분석 보고서 진입은 출력·통계 페이지의 맥락 버튼으로 이동 — 메뉴에서는 제거 */}
                    {item({ href: "/org/reports", label: "출력/발송 설정", icon: <Settings className="mr-2 h-4 w-4 text-cur-muted" /> })}
                    <DropdownMenuSeparator className="bg-cur-hairline" />
                    {groupLabel("회사 관리")}
                    {item({ href: "/org/members", label: "현장 계정 관리", icon: <Users className="mr-2 h-4 w-4 text-cur-muted" />, dot: needsFirstSiteAccount })}
                    {item({ href: "/account", label: "구독 및 결제", icon: <CreditCard className="mr-2 h-4 w-4 text-cur-muted" /> })}
                    {orgKind === "member" && (
                        <p className="px-3 pb-1.5 pt-0.5 text-[11px] text-cur-muted-soft leading-snug">지금은 회사 감독자가 설정을 관리하고 있어요.</p>
                    )}
                    <DropdownMenuSeparator className="bg-cur-hairline" />
                    {groupLabel("계정")}
                    <DropdownMenuItem onClick={() => router.push('/profile')} className="cursor-pointer text-[14px] text-cur-body font-medium px-3 py-2.5 focus:bg-cur-elevated focus:text-cur-ink">
                        <User className="mr-2 h-4 w-4 text-cur-muted" /> 내 정보 수정
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleLogout} className="cursor-pointer text-cur-error font-medium px-3 py-2.5 focus:bg-cur-error/10 focus:text-cur-error">
                        <LogOut className="mr-2 h-4 w-4" /> 로그아웃
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        )
    })()

    return (
        <div className="flex flex-col py-1 px-1 rounded-none border-0 gap-3">
            {title === "안톡" ? (
                <div className="flex justify-between items-center w-full">
                    <Logo size="sm" />
                    {userProfileDropdown}
                </div>
            ) : (
                <>
                    {/* 아이콘·제목·프로필을 한 줄로 — 제목이 별도 행을 차지하던 이전 배치보다 컴팩트 */}
                    <div className="flex justify-between items-center w-full gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                            <Button
                                variant="outline"
                                size="icon"
                                onClick={() => router.push(backHref ?? '/')}
                                className="h-10 w-10 shrink-0 border border-cur-hairline bg-cur-card hover:bg-cur-elevated text-cur-ink rounded-[8px] shadow-[0_2px_8px_rgba(0,0,0,0.04)] transition-colors"
                            >
                                {backHref ? <ChevronLeft className="w-5 h-5 text-cur-body" /> : <Home className="w-5 h-5 text-cur-body" />}
                            </Button>
                            <h1 className="text-[18px] font-bold text-cur-ink tracking-tight truncate">{title}</h1>
                            {pageBadge && (
                                <span className="text-[11px] font-bold text-cur-primary bg-cur-primary/10 px-2 py-0.5 rounded-full shrink-0">
                                    {pageBadge}
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            {titleAction}
                            {userProfileDropdown}
                        </div>
                    </div>
                </>
            )}
        </div>
    )
}