// components/TBMHeader.tsx
"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { LogOut, LayoutDashboard, User, Home, Loader2, CreditCard } from "lucide-react"
import { Logo } from "@/components/Logo"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface TBMHeaderProps {
    title?: string
    onLogout?: () => void
}

export function TBMHeader({ title = "TBM 일지", onLogout }: TBMHeaderProps) {
    const router = useRouter()
    const [userName, setUserName] = useState("사용자")
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
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-10 px-2 rounded-[8px] hover:bg-cur-elevated text-cur-body">
                    <div className="flex items-center gap-2">
                        <span className="text-[14px] font-medium text-cur-body hidden md:inline-block text-right">
                            {userName}
                        </span>
                        <Avatar className="h-8 w-8 border border-cur-hairline">
                            <AvatarFallback className="bg-cur-elevated text-cur-ink font-semibold text-[11px] uppercase tracking-wide">
                                {userName[0]}
                            </AvatarFallback>
                        </Avatar>
                    </div>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56 rounded-[12px] border-cur-hairline bg-cur-card shadow-[0_8px_24px_rgba(0,0,0,0.08)] font-sans" align="end">
                <DropdownMenuLabel className="text-[13px] text-cur-muted font-semibold tracking-wide uppercase px-3 py-2">
                    내 계정 ({userName})
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-cur-hairline" />
                <DropdownMenuItem onClick={() => setIsEditProfileOpen(true)} className="cursor-pointer text-[14px] text-cur-body font-medium px-3 py-2.5 focus:bg-cur-elevated focus:text-cur-ink">
                    <User className="mr-2 h-4 w-4 text-cur-muted" /> 내 정보 수정
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => router.push('/account')} className="cursor-pointer text-[14px] text-cur-body font-medium px-3 py-2.5 focus:bg-cur-elevated focus:text-cur-ink">
                    <CreditCard className="mr-2 h-4 w-4 text-cur-muted" /> 구독 및 결제
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => router.push('/dashboard')} className="cursor-pointer text-[14px] text-cur-body font-medium px-3 py-2.5 focus:bg-cur-elevated focus:text-cur-ink">
                    <LayoutDashboard className="mr-2 h-4 w-4 text-cur-muted" /> 일지 관리 달력
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-cur-hairline" />
                <DropdownMenuItem onClick={handleLogout} className="cursor-pointer text-cur-error font-medium px-3 py-2.5 focus:bg-cur-error/10 focus:text-cur-error">
                    <LogOut className="mr-2 h-4 w-4" /> 로그아웃
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
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
                            onClick={() => router.push('/')} 
                            className="h-10 w-10 border border-cur-hairline bg-cur-card hover:bg-cur-elevated text-cur-ink rounded-[8px] shadow-[0_2px_8px_rgba(0,0,0,0.04)] transition-colors"
                        >
                            <Home className="w-5 h-5 text-cur-body" /> 
                        </Button>
                        {userProfileDropdown}
                    </div>
                    <div className="w-full h-[1px] bg-cur-hairline my-1" />
                    <div className="flex items-center">
                        <h1 className="text-[20px] font-bold text-cur-ink tracking-tight">{title}</h1>
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