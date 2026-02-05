// app/login/page.tsx
"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { AlertCircle, Loader2, HardHat } from "lucide-react"

export default function LoginPage() {
    const router = useRouter()
    const [userId, setUserId] = useState("") // 이메일 대신 ID
    const [password, setPassword] = useState("")
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

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

            router.push("/")
        } catch (err: any) {
            console.error(err)
            setError("아이디 또는 비밀번호를 확인해주세요.")
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-100 p-4">
            <Card className="w-full max-w-md border-0 shadow-xl bg-white">
                <CardHeader className="space-y-4 text-center pb-8 pt-10">
                    <div className="mx-auto bg-orange-100 w-16 h-16 rounded-full flex items-center justify-center mb-2">
                        <HardHat className="w-8 h-8 text-orange-600" />
                    </div>
                    <CardTitle className="text-3xl font-extrabold text-slate-900">TBM 디지털 일지</CardTitle>
                    <CardDescription className="text-lg">
                        발급받은 현장 아이디로 로그인하세요.
                    </CardDescription>
                </CardHeader>
                <CardContent className="px-8 pb-10">
                    <form onSubmit={handleLogin} className="space-y-6">
                        <div className="space-y-2">
                            <Label htmlFor="userId" className="text-lg font-bold text-slate-700">아이디</Label>
                            <Input
                                id="userId"
                                type="text"
                                placeholder="예: site01"
                                value={userId}
                                onChange={(e) => setUserId(e.target.value)}
                                required
                                className="h-14 text-lg bg-slate-50 border-slate-300"
                                autoComplete="off"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="password" className="text-lg font-bold text-slate-700">비밀번호</Label>
                            <Input
                                id="password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                className="h-14 text-lg bg-slate-50 border-slate-300"
                            />
                        </div>

                        {error && (
                            <div className="flex items-center gap-2 p-4 text-sm font-medium text-red-600 bg-red-50 rounded-lg border border-red-100">
                                <AlertCircle className="w-5 h-5" />
                                {error}
                            </div>
                        )}

                        <Button type="submit" className="w-full h-14 text-xl bg-orange-600 hover:bg-orange-700 font-bold shadow-md transition-all active:scale-[0.98]" disabled={loading}>
                            {loading ? <Loader2 className="mr-2 h-6 w-6 animate-spin" /> : "로그인 하기"}
                        </Button>
                    </form>
                </CardContent>
            </Card>
        </div>
    )
}