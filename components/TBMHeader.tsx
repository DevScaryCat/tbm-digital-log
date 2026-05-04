"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { LogOut, LayoutDashboard, User, ShieldCheck } from "lucide-react"

export function TBMHeader({ title = "TBM 일지", onLogout }: { title?: string, onLogout?: () => void }) {
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
        <div className="flex justify-between items-center bg-white py-3 px-1 rounded-none border-0">
            <h1 className="text-[18px] font-semibold text-expo-ink flex items-center gap-2 cursor-pointer tracking-tight" onClick={() => router.push('/')}>
                <div className="bg-expo-surface-strong p-1.5 rounded-[8px]">
                    <ShieldCheck className="w-5 h-5 text-expo-ink" />
                </div>
                {title}
            </h1>

            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="h-10 px-2 rounded-[8px] hover:bg-expo-surface-strong">
                        <div className="flex items-center gap-2">
                            <span className="text-[14px] font-medium text-expo-ink hidden md:inline-block text-right">
                                {userName}
                            </span>
                            <Avatar className="h-8 w-8 border border-expo-hairline-strong shadow-sm">
                                <AvatarFallback className="bg-expo-surface-dark text-white font-semibold text-[11px] uppercase tracking-wide">
                                    {userName[0]}
                                </AvatarFallback>
                            </Avatar>
                        </div>
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56 rounded-[12px] border-expo-hairline shadow-[0_4px_12px_rgba(0,0,0,0.06)] font-sans" align="end">
                    <DropdownMenuLabel className="text-[13px] text-expo-muted font-semibold tracking-wide uppercase px-3 py-2">
                        내 계정 ({userName})
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator className="bg-expo-hairline" />
                    <DropdownMenuItem onClick={() => router.push('/dashboard')} className="cursor-pointer text-[14px] text-expo-ink font-medium px-3 py-2.5 focus:bg-expo-surface-strong focus:text-expo-ink">
                        <LayoutDashboard className="mr-2 h-4 w-4 text-expo-muted" /> 일지 관리 달력
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => router.push('/')} className="cursor-pointer text-[14px] text-expo-ink font-medium px-3 py-2.5 focus:bg-expo-surface-strong focus:text-expo-ink">
                        <User className="mr-2 h-4 w-4 text-expo-muted" /> 일지 작성하기
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="bg-expo-hairline" />
                    <DropdownMenuItem onClick={handleLogout} className="cursor-pointer text-[#eb8e90] font-medium px-3 py-2.5 focus:bg-[#eb8e90]/10 focus:text-[#eb8e90]">
                        <LogOut className="mr-2 h-4 w-4" /> 로그아웃
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    )
}