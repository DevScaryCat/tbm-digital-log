"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { LogOut, LayoutDashboard, User, ShieldCheck } from "lucide-react"

export function TBMHeader() {
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
        await supabase.auth.signOut()
        router.push("/login")
    }

    return (
        <div className="flex justify-between items-center mb-4 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
            <h1 className="text-lg font-bold text-slate-900 flex items-center gap-2 cursor-pointer" onClick={() => router.push('/')}>
                <ShieldCheck className="w-6 h-6 text-slate-800" />
                TBM 디지털 일지
            </h1>

            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="h-10 px-2 rounded-full hover:bg-slate-100">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-slate-700 hidden md:inline-block text-right">
                                {userName} 님
                            </span>
                            <Avatar className="h-8 w-8 border border-slate-300">
                                <AvatarFallback className="bg-slate-100 text-slate-700 font-bold text-xs">
                                    {userName[0]}
                                </AvatarFallback>
                            </Avatar>
                        </div>
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56" align="end">
                    <DropdownMenuLabel>내 계정 ({userName})</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => router.push('/dashboard')} className="cursor-pointer">
                        <LayoutDashboard className="mr-2 h-4 w-4" /> 대시보드
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => router.push('/')} className="cursor-pointer">
                        <User className="mr-2 h-4 w-4" /> 일지 작성하기
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={handleLogout} className="text-red-600 cursor-pointer">
                        <LogOut className="mr-2 h-4 w-4" /> 로그아웃
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    )
}