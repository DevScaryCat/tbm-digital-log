// app/login/page.tsx
"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { AlertCircle, Loader2, HardHat } from "lucide-react"
import { cn } from "@/lib/utils"

export default function LoginPage() {
    const router = useRouter()
    const [userId, setUserId] = useState("") // 이메일 대신 ID
    const [password, setPassword] = useState("")
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [rememberMe, setRememberMe] = useState(false)

    // 저장된 아이디/비밀번호 불러오기
    useEffect(() => {
        const saved = localStorage.getItem("tbm_saved_login")
        if (saved) {
            try {
                const { id, pw } = JSON.parse(saved)
                setUserId(id || "")
                setPassword(pw || "")
                setRememberMe(true)
            } catch {}
        }
    }, [])

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError(null)

        try {
            // ⭐️ 핵심: 사용자가 입력한 ID 뒤에 가상의 도메인을 붙여서 Supabase에 보냄
            const emailForLogin = `${userId}@tbm.com`

            const { data, error } = await supabase.auth.signInWithPassword({
                email: emailForLogin,
                password,
            })

            if (error) throw error

            // 아이디/비밀번호 저장 처리
            if (rememberMe) {
                localStorage.setItem("tbm_saved_login", JSON.stringify({ id: userId, pw: password }))
            } else {
                localStorage.removeItem("tbm_saved_login")
            }

            router.push("/")
        } catch (err: any) {
            console.error(err)
            setError("아이디 또는 비밀번호를 확인해주세요.")
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-expo-surface-strong p-4 font-sans text-expo-ink">
            <Card className="w-full max-w-md border border-expo-hairline shadow-[0_8px_32px_rgba(0,0,0,0.04)] bg-white rounded-[24px]">
                <CardHeader className="space-y-4 text-center pb-8 pt-10">
                    <div className="mx-auto bg-expo-canvas-soft w-16 h-16 rounded-[16px] flex items-center justify-center mb-2 shadow-sm border border-expo-hairline">
                        <HardHat className="w-8 h-8 text-expo-primary" />
                    </div>
                    <CardTitle className="text-[28px] font-extrabold text-expo-ink tracking-tight">TBM 일지</CardTitle>
                    <CardDescription className="text-[15px] text-expo-muted font-medium">
                        발급받은 현장 아이디로 로그인하세요.
                    </CardDescription>
                </CardHeader>
                <CardContent className="px-8 pb-10">
                    <form onSubmit={handleLogin} className="space-y-6">
                        <div className="space-y-2.5">
                            <Label htmlFor="userId" className="text-[15px] font-bold text-expo-ink">아이디</Label>
                            <Input
                                id="userId"
                                type="text"
                                placeholder="예: site01"
                                value={userId}
                                onChange={(e) => setUserId(e.target.value)}
                                required
                                className="h-14 text-[16px] bg-white border-expo-hairline-strong rounded-[12px] focus-visible:ring-1 focus-visible:ring-expo-primary"
                                autoComplete="off"
                            />
                        </div>
                        <div className="space-y-2.5">
                            <Label htmlFor="password" className="text-[15px] font-bold text-expo-ink">비밀번호</Label>
                            <Input
                                id="password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                className="h-14 text-[16px] bg-white border-expo-hairline-strong rounded-[12px] focus-visible:ring-1 focus-visible:ring-expo-primary"
                            />
                        </div>

                        <div className="flex items-center gap-3">
                            <Checkbox
                                id="rememberMe"
                                checked={rememberMe}
                                onCheckedChange={(checked) => setRememberMe(checked === true)}
                                className="w-5 h-5 rounded-[6px] border-expo-hairline-strong data-[state=checked]:bg-expo-primary data-[state=checked]:text-white data-[state=checked]:border-expo-primary"
                            />
                            <label htmlFor="rememberMe" className="text-[14px] font-medium text-expo-body cursor-pointer select-none">
                                아이디 / 비밀번호 저장
                            </label>
                        </div>

                        {error && (
                            <div className="flex items-center gap-2 p-4 text-[14px] font-bold text-[#b91c1c] bg-[#fef2f2] rounded-[12px] border border-[#fecaca]">
                                <AlertCircle className="w-5 h-5 shrink-0" />
                                {error}
                            </div>
                        )}

                        <Button type="submit" className="w-full h-14 text-[16px] bg-expo-primary hover:bg-[#1a1a1a] text-white rounded-[12px] font-bold shadow-[0_4px_12px_rgba(0,0,0,0.1)] transition-transform active:scale-[0.98]" disabled={loading}>
                            {loading ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : "로그인 하기"}
                        </Button>

                        <div className="mt-8 text-center text-[14px] font-medium text-expo-muted border-t border-expo-hairline pt-6">
                            아직 현장 계정이 없으신가요?{" "}
                            <a href="/signup" className="font-bold text-expo-primary hover:underline ml-1">
                                회원가입 하기
                            </a>
                        </div>
                    </form>
                </CardContent>
            </Card>
        </div>
    )
}