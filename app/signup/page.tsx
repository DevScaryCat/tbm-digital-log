"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { AlertCircle, Loader2, HardHat, CheckCircle } from "lucide-react"
import Link from "next/link"
import { cn } from "@/lib/utils"

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
            <div className="min-h-screen flex items-center justify-center bg-expo-surface-strong p-4 font-sans text-expo-ink">
                <Card className="w-full max-w-md border border-expo-hairline shadow-[0_8px_32px_rgba(0,0,0,0.04)] bg-white text-center py-10 rounded-[24px]">
                    <CardContent className="space-y-4 flex flex-col items-center">
                        <CheckCircle className="w-16 h-16 text-[#16a34a] mb-2" />
                        <h2 className="text-[24px] font-bold text-expo-ink tracking-tight">회원가입 완료!</h2>
                        <p className="text-[15px] text-expo-muted font-medium">성공적으로 계정이 생성되었습니다.<br/>잠시 후 로그인 페이지로 이동합니다.</p>
                        <Button variant="outline" className="mt-4 border-expo-hairline-strong text-expo-ink hover:bg-expo-surface-strong rounded-[12px] h-12 px-6 font-semibold" onClick={() => router.push("/login")}>
                            로그인 바로가기
                        </Button>
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-expo-surface-strong p-4 font-sans text-expo-ink">
            <Card className="w-full max-w-md border border-expo-hairline shadow-[0_8px_32px_rgba(0,0,0,0.04)] bg-white rounded-[24px]">
                <CardHeader className="space-y-4 text-center pb-6 pt-10">
                    <div className="mx-auto bg-expo-canvas-soft w-16 h-16 rounded-[16px] flex items-center justify-center mb-2 shadow-sm border border-expo-hairline">
                        <HardHat className="w-8 h-8 text-expo-primary" />
                    </div>
                    <CardTitle className="text-[28px] font-extrabold text-expo-ink tracking-tight">현장 계정 생성</CardTitle>
                    <CardDescription className="text-[15px] text-expo-muted font-medium">
                        새로운 현장 관리 아이디를 생성합니다.
                    </CardDescription>
                </CardHeader>
                <CardContent className="px-8 pb-10">
                    <form onSubmit={handleSignup} className="space-y-5">
                        <div className="space-y-2.5">
                            <Label htmlFor="siteName" className="text-[15px] font-bold text-expo-ink">현장명 (회사명)</Label>
                            <Input
                                id="siteName"
                                type="text"
                                placeholder="소속 현장명 (또는 업체명)"
                                value={siteName}
                                onChange={(e) => setSiteName(e.target.value)}
                                required
                                className="h-14 text-[16px] bg-white border-expo-hairline-strong rounded-[12px] focus-visible:ring-1 focus-visible:ring-expo-primary"
                            />
                        </div>
                        <div className="space-y-2.5">
                            <Label htmlFor="id" className="text-[15px] font-bold text-expo-ink">사용할 아이디</Label>
                            <Input
                                id="id"
                                type="text"
                                placeholder="예: site01 (영문/숫자)"
                                value={id}
                                onChange={(e) => setId(e.target.value)}
                                required
                                minLength={3}
                                className="h-14 text-[16px] bg-white border-expo-hairline-strong rounded-[12px] focus-visible:ring-1 focus-visible:ring-expo-primary"
                                autoComplete="off"
                            />
                        </div>
                        <div className="space-y-2.5">
                            <Label htmlFor="password" className="text-[15px] font-bold text-expo-ink">비밀번호</Label>
                            <Input
                                id="password"
                                type="password"
                                placeholder="6자 이상 입력"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                minLength={6}
                                className="h-14 text-[16px] bg-white border-expo-hairline-strong rounded-[12px] focus-visible:ring-1 focus-visible:ring-expo-primary"
                            />
                        </div>
                        <div className="space-y-2.5">
                            <Label htmlFor="passwordConfirm" className="text-[15px] font-bold text-expo-ink">비밀번호 확인</Label>
                            <Input
                                id="passwordConfirm"
                                type="password"
                                placeholder="비밀번호 다시 입력"
                                value={passwordConfirm}
                                onChange={(e) => setPasswordConfirm(e.target.value)}
                                required
                                minLength={6}
                                className="h-14 text-[16px] bg-white border-expo-hairline-strong rounded-[12px] focus-visible:ring-1 focus-visible:ring-expo-primary"
                            />
                        </div>

                        {error && (
                            <div className="flex items-center gap-2 p-4 text-[14px] font-bold text-[#b91c1c] bg-[#fef2f2] rounded-[12px] border border-[#fecaca]">
                                <AlertCircle className="w-5 h-5 shrink-0" />
                                {error}
                            </div>
                        )}

                        <Button type="submit" className="w-full h-14 text-[16px] bg-expo-primary hover:bg-[#1a1a1a] text-white rounded-[12px] font-bold shadow-[0_4px_12px_rgba(0,0,0,0.1)] transition-transform active:scale-[0.98] mt-2" disabled={loading}>
                            {loading ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : "회원가입 하기"}
                        </Button>

                        <div className="text-center mt-8 text-[14px] font-medium text-expo-muted border-t border-expo-hairline pt-6">
                            이미 계정이 있으신가요?{" "}
                            <Link href="/login" className="font-bold text-expo-primary hover:underline ml-1">
                                로그인 화면으로
                            </Link>
                        </div>
                    </form>
                </CardContent>
            </Card>
        </div>
    )
}
