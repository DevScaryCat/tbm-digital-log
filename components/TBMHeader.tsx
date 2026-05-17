// components/TBMHeader.tsx
"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { LogOut, LayoutDashboard, User, ShieldCheck } from "lucide-react"

interface TBMHeaderProps {
    title?: string
    onLogout?: () => void
}

export function TBMHeader({ title = "TBM 일지", onLogout }: TBMHeaderProps) {
    const router = useRouter()
    const [userName, setUserName] = useState("사용자")

    useEffect(() => {
        const getUser = async () => {
            const { data: { session } } = await supabase.auth.getSession()
            if (session) {
                setUserName(session.user.user_metadata.full_name || session.user.user_metadata.company_name || "현장")
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

    return (
        <div className="flex justify-between items-center py-3 px-1 rounded-none border-0">
            <h1 className="text-[18px] font-semibold text-cur-ink flex items-center gap-2 cursor-pointer tracking-tight" onClick={() => router.push('/')}>
                <div className="bg-cur-primary p-1.5 rounded-[8px]">
                    <ShieldCheck className="w-5 h-5 text-cur-on-primary" />
                </div>
                <span className="text-cur-ink">{title}</span>
            </h1>

            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="h-10 px-2 rounded-[8px] hover:bg-cur-elevated text-cur-body">
                        <div className="flex items-center gap-2">
                            <span className="text-[14px] font-medium text-cur-body hidden md:inline-block text-right">
                                {userName}
                            </span>
                            <Avatar className="h-8 w-8 border border-cur-hairline">
                                <AvatarFallback className="bg-cur-primary text-cur-on-primary font-semibold text-[11px] uppercase tracking-wide">
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
                    <DropdownMenuItem onClick={() => router.push('/dashboard')} className="cursor-pointer text-[14px] text-cur-body font-medium px-3 py-2.5 focus:bg-cur-elevated focus:text-cur-ink">
                        <LayoutDashboard className="mr-2 h-4 w-4 text-cur-muted" /> 일지 관리 달력
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => router.push('/')} className="cursor-pointer text-[14px] text-cur-body font-medium px-3 py-2.5 focus:bg-cur-elevated focus:text-cur-ink">
                        <User className="mr-2 h-4 w-4 text-cur-muted" /> 일지 작성하기
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="bg-cur-hairline" />
                    <DropdownMenuItem onClick={handleLogout} className="cursor-pointer text-cur-error font-medium px-3 py-2.5 focus:bg-cur-error/10 focus:text-cur-error">
                        <LogOut className="mr-2 h-4 w-4" /> 로그아웃
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    )
}