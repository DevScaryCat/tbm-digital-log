"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { AlertCircle, Loader2, HardHat, CheckCircle } from "lucide-react"
import Link from "next/link"

export default function SignupPage() {
    const router = useRouter()
    const [id, setId] = useState("")
    const [password, setPassword] = useState("")
    const [passwordConfirm, setPasswordConfirm] = useState("")
    const [siteName, setSiteName] = useState("")
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState(false)

    const handleSignup = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError(null)

        if (password !== passwordConfirm) {
            setError("비밀번호가 일치하지 않습니다.")
            setLoading(false)
            return
        }

        try {
            const res = await fetch('/api/signup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, password, siteName })
            })

            const data = await res.json()

            if (!res.ok) {
                throw new Error(data.error || "회원가입에 실패했습니다.")
            }

            setSuccess(true)
            // 3초 후 로그인 페이지로
            setTimeout(() => {
                router.push("/login")
            }, 3000)

        } catch (err: any) {
            console.error(err)
            setError(err.message || "오류가 발생했습니다. 다시 시도해주세요.")
        } finally {
            setLoading(false)
        }
    }

    if (success) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-100 p-4">
                <Card className="w-full max-w-md border-0 shadow-xl bg-white text-center py-10">
                    <CardContent className="space-y-4 flex flex-col items-center">
                        <CheckCircle className="w-16 h-16 text-green-500 mb-2" />
                        <h2 className="text-2xl font-bold text-slate-800">회원가입 완료!</h2>
                        <p className="text-slate-600">성공적으로 계정이 생성되었습니다.<br/>잠시 후 로그인 페이지로 이동합니다.</p>
                        <Button variant="outline" className="mt-4" onClick={() => router.push("/login")}>
                            로그인 바로가기
                        </Button>
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-100 p-4">
            <Card className="w-full max-w-md border-0 shadow-xl bg-white">
                <CardHeader className="space-y-4 text-center pb-6 pt-10">
                    <div className="mx-auto bg-orange-100 w-16 h-16 rounded-full flex items-center justify-center mb-2">
                        <HardHat className="w-8 h-8 text-orange-600" />
                    </div>
                    <CardTitle className="text-2xl font-extrabold text-slate-900">현장 계정 생성</CardTitle>
                    <CardDescription className="text-base">
                        새로운 현장 관리 아이디를 생성합니다.
                    </CardDescription>
                </CardHeader>
                <CardContent className="px-8 pb-10">
                    <form onSubmit={handleSignup} className="space-y-5">
                        <div className="space-y-2">
                            <Label htmlFor="siteName" className="text-sm font-bold text-slate-700">현장명 (회사명)</Label>
                            <Input
                                id="siteName"
                                type="text"
                                placeholder="예: 무신사 로지스틱스 1센터"
                                value={siteName}
                                onChange={(e) => setSiteName(e.target.value)}
                                required
                                className="h-12 bg-slate-50 border-slate-300"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="id" className="text-sm font-bold text-slate-700">사용할 아이디</Label>
                            <Input
                                id="id"
                                type="text"
                                placeholder="예: site01 (영문/숫자)"
                                value={id}
                                onChange={(e) => setId(e.target.value)}
                                required
                                minLength={3}
                                className="h-12 bg-slate-50 border-slate-300"
                                autoComplete="off"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="password" className="text-sm font-bold text-slate-700">비밀번호</Label>
                            <Input
                                id="password"
                                type="password"
                                placeholder="6자 이상 입력"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                minLength={6}
                                className="h-12 bg-slate-50 border-slate-300"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="passwordConfirm" className="text-sm font-bold text-slate-700">비밀번호 확인</Label>
                            <Input
                                id="passwordConfirm"
                                type="password"
                                placeholder="비밀번호 다시 입력"
                                value={passwordConfirm}
                                onChange={(e) => setPasswordConfirm(e.target.value)}
                                required
                                minLength={6}
                                className="h-12 bg-slate-50 border-slate-300"
                            />
                        </div>

                        {error && (
                            <div className="flex items-center gap-2 p-3 text-sm font-medium text-red-600 bg-red-50 rounded-lg border border-red-100">
                                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                                {error}
                            </div>
                        )}

                        <Button type="submit" className="w-full h-12 text-lg bg-orange-600 hover:bg-orange-700 font-bold shadow-md transition-all active:scale-[0.98]" disabled={loading}>
                            {loading ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : "회원가입 하기"}
                        </Button>

                        <div className="text-center mt-6 text-sm text-slate-600">
                            이미 계정이 있으신가요?{" "}
                            <Link href="/login" className="font-bold text-orange-600 hover:underline">
                                로그인 화면으로
                            </Link>
                        </div>
                    </form>
                </CardContent>
            </Card>
        </div>
    )
}
