// components/TBMHeader.tsx
"use client"

import { useState, useEffect, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { LogOut, User, Home, ChevronLeft, Loader2, CreditCard, Mail } from "lucide-react"
import { Logo } from "@/components/Logo"
import { startOfMonth, addMonths, format } from "date-fns"
import { fetchSubscription, planBadge } from "@/lib/useSubscription"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface TBMHeaderProps {
    title?: string
    onLogout?: () => void
    pageBadge?: string
    titleAction?: ReactNode
    /** 좌상단 버튼을 홈(/) 대신 지정 경로로 '돌아가기'(←)로 표시 */
    backHref?: string
}

// 플랜별 월 한도
const LIMITS: Record<string, { log: number; minutes: number; ra: number }> = {
    monthly_basic: { log: 80, minutes: 10, ra: 0 },
    monthly_pro: { log: 200, minutes: 30, ra: 20 },
}
function limitFor(plan: string | null, kind: "log" | "minutes" | "ra"): number {
    // grandfather(영구 무료)도 사용량 한도는 베이직과 동일 (DB 트리거 enforce_tbm_monthly_limit와 일치)
    return (LIMITS[plan ?? "monthly_basic"] ?? LIMITS.monthly_basic)[kind]
}
function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
    // Pro 전용(베이직 위험성평가)
    if (limit === 0) {
        return (
            <div className="flex justify-between text-[12px]">
                <span className="text-cur-muted">{label}</span>
                <span className="text-cur-muted-soft font-medium">Pro 전용</span>
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
    const [badge, setBadge] = useState<{ label: string; isPro: boolean } | null>(null)
    const [plan, setPlan] = useState<string | null>(null)
    const [usage, setUsage] = useState<{ log: number; minutes: number; ra: number } | null>(null)
    const [isEditProfileOpen, setIsEditProfileOpen] = useState(false)
    const [fullName, setFullName] = useState("")
    const [companyName, setCompanyName] = useState("")
    const [workerType, setWorkerType] = useState("현장 근로자 (비사무직)")
    const [isSavingProfile, setIsSavingProfile] = useState(false)

    useEffect(() => {
        const getUser = async () => {
            const { data: { session } } = await supabase.auth.getSession()
            if (session) {
                const meta = session.user.user_metadata
                setUserName(meta.full_name || meta.company_name || "사용자")
                setFullName(meta.full_name || "")
                setCompanyName(meta.company_name || "")
                setWorkerType(meta.worker_type || "현장 근로자 (비사무직)")
                const sub = await fetchSubscription()
                setBadge(planBadge(sub))
                setPlan(sub?.plan ?? null)
                // 이번 달(KST 근사) 사용량 집계
                const startISO = startOfMonth(new Date()).toISOString()
                const [logs, mins, ras] = await Promise.all([
                    supabase.from("tbm_logs").select("id", { count: "exact", head: true }).gte("created_at", startISO),
                    supabase.from("tbm_minutes").select("id", { count: "exact", head: true }).gte("created_at", startISO),
                    supabase.from("tbm_risk_assessments").select("id", { count: "exact", head: true }).gte("created_at", startISO),
                ])
                setUsage({ log: logs.count ?? 0, minutes: mins.count ?? 0, ra: ras.count ?? 0 })
            }
        }
        getUser()
    }, [])

    const handleLogout = async () => {
        if (onLogout) {
            onLogout()
        } else {
            await supabase.auth.signOut()
            router.push("/login")
        }
    }

    const handleSaveProfile = async () => {
        if (!fullName.trim()) return alert("성명을 입력해주세요.")
        if (!companyName.trim()) return alert("소속 현장명(업체명)을 입력해주세요.")
        setIsSavingProfile(true)
        try {
            const { data, error } = await supabase.auth.updateUser({
                data: {
                    full_name: fullName.trim(),
                    company_name: companyName.trim(),
                    worker_type: workerType
                }
            })
            if (error) throw error
            setUserName(data.user.user_metadata.full_name || data.user.user_metadata.company_name || "사용자")
            setIsEditProfileOpen(false)
            alert("내 정보가 성공적으로 변경되었습니다.")
            window.location.reload()
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : "알 수 없는 오류"
            alert("정보 변경 실패: " + errMsg)
        } finally {
            setIsSavingProfile(false)
        }
    }

    const userProfileDropdown = (
        <div className="flex items-center gap-2">
            {badge && (
                <button
                    onClick={() => router.push("/pricing")}
                    className={`text-[10px] font-bold px-2 py-1 rounded-[4px] tracking-wide ${
                        badge.isPro
                            ? "bg-cur-primary text-cur-on-primary hover:bg-cur-primary-active"
                            : "bg-cur-elevated text-cur-muted border border-cur-hairline hover:bg-cur-hairline"
                    }`}
                >
                    {badge.label}
                </button>
            )}
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-10 px-3 rounded-[8px] hover:bg-cur-elevated text-cur-body">
                    <span className="text-[14px] font-medium text-cur-body">{userName}</span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56 rounded-[12px] border-cur-hairline bg-cur-card shadow-[0_8px_24px_rgba(0,0,0,0.08)] font-sans" align="end">
                {usage && (
                    <>
                        <div className="px-3 py-2.5 space-y-2.5">
                            <div className="flex items-center justify-between">
                                <span className="text-[11px] text-cur-muted-soft font-semibold">이번 달 사용량</span>
                                <span className="text-[11px] text-cur-muted-soft">{format(startOfMonth(addMonths(new Date(), 1)), "M월 d일")} 초기화</span>
                            </div>
                            <UsageBar label="TBM 회의록" used={usage.minutes} limit={limitFor(plan, "minutes")} />
                            <UsageBar label="안전보건교육일지" used={usage.log} limit={limitFor(plan, "log")} />
                            <UsageBar label="위험성평가" used={usage.ra} limit={limitFor(plan, "ra")} />
                        </div>
                    </>
                )}
                <DropdownMenuSeparator className="bg-cur-hairline" />
                <DropdownMenuItem onClick={() => setIsEditProfileOpen(true)} className="cursor-pointer text-[14px] text-cur-body font-medium px-3 py-2.5 focus:bg-cur-elevated focus:text-cur-ink">
                    <User className="mr-2 h-4 w-4 text-cur-muted" /> 내 정보 수정
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => router.push('/account')} className="cursor-pointer text-[14px] text-cur-body font-medium px-3 py-2.5 focus:bg-cur-elevated focus:text-cur-ink">
                    <CreditCard className="mr-2 h-4 w-4 text-cur-muted" /> 구독 및 결제
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-cur-hairline" />
                <DropdownMenuItem onClick={() => router.push('/report-settings')} className="cursor-pointer text-[14px] text-cur-body font-medium px-3 py-2.5 focus:bg-cur-elevated focus:text-cur-ink">
                    <Mail className="mr-2 h-4 w-4 text-cur-muted" /> 자동 보고서 설정
                    <span className="ml-auto bg-cur-primary/15 text-cur-primary text-[9px] font-bold px-1 py-0.5 rounded-[3px] tracking-wide">PRO</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-cur-hairline" />
                <DropdownMenuItem onClick={handleLogout} className="cursor-pointer text-cur-error font-medium px-3 py-2.5 focus:bg-cur-error/10 focus:text-cur-error">
                    <LogOut className="mr-2 h-4 w-4" /> 로그아웃
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
        </div>
    )

    return (
        <div className="flex flex-col py-1 px-1 rounded-none border-0 gap-3">
            {title === "안전톡톡e" ? (
                <div className="flex justify-between items-center w-full">
                    <Logo size="sm" />
                    {userProfileDropdown}
                </div>
            ) : (
                <>
                    <div className="flex justify-between items-center w-full">
                        <Button
                            variant="outline"
                            size="icon"
                            onClick={() => router.push(backHref ?? '/')}
                            className="h-10 w-10 border border-cur-hairline bg-cur-card hover:bg-cur-elevated text-cur-ink rounded-[8px] shadow-[0_2px_8px_rgba(0,0,0,0.04)] transition-colors"
                        >
                            {backHref ? <ChevronLeft className="w-5 h-5 text-cur-body" /> : <Home className="w-5 h-5 text-cur-body" />}
                        </Button>
                        {userProfileDropdown}
                    </div>
                    <div className="w-full h-[1px] bg-cur-hairline my-1" />
                    <div className="flex items-center justify-between w-full gap-2">
                        <div className="flex items-center gap-2">
                            <h1 className="text-[20px] font-bold text-cur-ink tracking-tight">{title}</h1>
                            {pageBadge && (
                                <span className="text-[11px] font-bold text-cur-primary bg-cur-primary/10 px-2 py-0.5 rounded-full">
                                    {pageBadge}
                                </span>
                            )}
                        </div>
                        {titleAction}
                    </div>
                </>
            )}

            <Dialog open={isEditProfileOpen} onOpenChange={setIsEditProfileOpen}>
                <DialogContent showCloseButton={true} className="max-w-sm w-[calc(100%-2rem)] rounded-[12px] p-6 border-cur-hairline shadow-[0_16px_48px_rgba(0,0,0,0.1)] bg-cur-card font-sans">
                    <DialogHeader>
                        <DialogTitle className="text-[18px] font-bold text-cur-ink tracking-tight">내 정보 수정</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label className="text-[13px] font-medium text-cur-body">성명</Label>
                            <Input
                                value={fullName}
                                onChange={(e) => setFullName(e.target.value)}
                                placeholder="성명을 입력하세요"
                                className="h-11 text-[14px] border-cur-hairline rounded-[6px] focus:border-cur-primary focus:ring-1 focus:ring-cur-primary bg-cur-elevated text-cur-ink placeholder:text-cur-muted"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-[13px] font-medium text-cur-body">소속 현장명 (또는 업체명)</Label>
                            <Input
                                value={companyName}
                                onChange={(e) => setCompanyName(e.target.value)}
                                placeholder="소속 현장명 (또는 업체명)"
                                className="h-11 text-[14px] border-cur-hairline rounded-[6px] focus:border-cur-primary focus:ring-1 focus:ring-cur-primary bg-cur-elevated text-cur-ink placeholder:text-cur-muted"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-[13px] font-medium text-cur-body">근로자 구분 (교육시간 산정용)</Label>
                            <Select value={workerType} onValueChange={setWorkerType}>
                                <SelectTrigger className="w-full h-11 text-[14px] border-cur-hairline rounded-[6px] bg-cur-elevated text-cur-ink focus:ring-1 focus:ring-cur-primary">
                                    <SelectValue placeholder="직군 선택" />
                                </SelectTrigger>
                                <SelectContent className="bg-cur-card border-cur-hairline text-cur-body">
                                    <SelectItem value="현장 근로자 (비사무직)">현장 근로자 (비사무직) (반기 12시간)</SelectItem>
                                    <SelectItem value="사무직 / 판매직">사무직 / 판매직 (반기 6시간)</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <DialogFooter className="flex gap-2">
                        <Button variant="outline" onClick={() => setIsEditProfileOpen(false)} className="flex-1 h-11 text-[14px] font-semibold border-cur-hairline text-cur-ink rounded-[6px] hover:bg-cur-elevated">취소</Button>
                        <Button onClick={handleSaveProfile} disabled={isSavingProfile} className="flex-1 h-11 text-[14px] font-semibold bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-[6px]">
                            {isSavingProfile && <Loader2 className="animate-spin mr-2 w-4 h-4 inline-block" />} 저장
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}