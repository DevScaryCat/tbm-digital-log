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

export default function LoginPage() {
    const router = useRouter()
    const [userId, setUserId] = useState("")
    const [password, setPassword] = useState("")
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [rememberMe, setRememberMe] = useState(false)

    useEffect(() => {
        const saved = localStorage.getItem("tbm_saved_login")
        if (saved) {
            try {
                const { id } = JSON.parse(saved)
                setUserId(id || "")
                setRememberMe(true)
            } catch {}
        }
    }, [])

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError(null)

        try {
            const emailForLogin = `${userId}@tbm.com`

            const { data, error } = await supabase.auth.signInWithPassword({
                email: emailForLogin,
                password,
            })

            if (error) throw error

            if (rememberMe) {
                localStorage.setItem("tbm_saved_login", JSON.stringify({ id: userId }))
            } else {
                localStorage.removeItem("tbm_saved_login")
            }

            router.push("/")
        } catch (err: unknown) {
            console.error(err)
            setError("아이디 또는 비밀번호를 확인해주세요.")
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-cur-canvas p-4 font-sans text-cur-ink">
            <Card className="w-full max-w-md border border-cur-hairline bg-cur-card rounded-[24px] shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                <CardHeader className="space-y-4 text-center pb-8 pt-10">
                    <div className="mx-auto bg-cur-elevated w-16 h-16 rounded-[12px] flex items-center justify-center mb-2 border border-cur-hairline">
                        <HardHat className="w-8 h-8 text-cur-primary" />
                    </div>
                    <CardTitle className="text-[28px] font-normal text-cur-ink tracking-[-0.72px]">TBM 일지</CardTitle>
                    <CardDescription className="text-[15px] text-cur-muted font-medium">
                        발급받은 현장 아이디로 로그인하세요.
                    </CardDescription>
                </CardHeader>
                <CardContent className="px-8 pb-10">
                    <form onSubmit={handleLogin} className="space-y-6">
                        <div className="space-y-2.5">
                            <Label htmlFor="userId" className="text-[15px] font-semibold text-cur-ink">아이디</Label>
                            <Input
                                id="userId"
                                type="text"
                                placeholder="예: site01"
                                value={userId}
                                onChange={(e) => setUserId(e.target.value)}
                                required
                                className="h-14 text-[16px] bg-cur-card border-cur-hairline rounded-[8px] focus-visible:ring-1 focus-visible:ring-cur-primary text-cur-ink placeholder:text-cur-muted-soft"
                                autoComplete="off"
                            />
                        </div>
                        <div className="space-y-2.5">
                            <Label htmlFor="password" className="text-[15px] font-semibold text-cur-ink">비밀번호</Label>
                            <Input
                                id="password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                className="h-14 text-[16px] bg-cur-card border-cur-hairline rounded-[8px] focus-visible:ring-1 focus-visible:ring-cur-primary text-cur-ink"
                            />
                        </div>

                        <div className="flex items-center gap-3">
                            <Checkbox
                                id="rememberMe"
                                checked={rememberMe}
                                onCheckedChange={(checked) => setRememberMe(checked === true)}
                                className="w-5 h-5 rounded-[6px] border-cur-hairline data-[state=checked]:bg-cur-primary data-[state=checked]:text-cur-on-primary data-[state=checked]:border-cur-primary"
                            />
                            <label htmlFor="rememberMe" className="text-[14px] font-medium text-cur-muted cursor-pointer select-none">
                                아이디 / 비밀번호 저장
                            </label>
                        </div>

                        {error && (
                            <div className="flex items-center gap-2 p-4 text-[14px] font-semibold text-cur-error bg-cur-error/5 rounded-[8px] border border-cur-error/20">
                                <AlertCircle className="w-5 h-5 shrink-0" />
                                {error}
                            </div>
                        )}

                        <Button type="submit" className="w-full h-14 text-[16px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-[8px] font-medium transition-transform active:scale-[0.98]" disabled={loading}>
                            {loading ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : "로그인 하기"}
                        </Button>

                        <div className="mt-8 text-center text-[14px] font-medium text-cur-muted border-t border-cur-hairline pt-6">
                            아직 현장 계정이 없으신가요?{" "}
                            <a href="/signup" className="font-semibold text-cur-primary hover:underline ml-1">
                                회원가입 하기
                            </a>
                        </div>
                    </form>
                </CardContent>
            </Card>
        </div>
    )
}