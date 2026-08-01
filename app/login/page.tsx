// app/login/page.tsx
"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { AlertCircle, Loader2, MessageSquareWarning } from "lucide-react"
import { Logo } from "@/components/Logo"
import { InAppBrowserNotice } from "@/components/InAppBrowserNotice"
import { hasAgreedTerms } from "@/lib/consentStorage"

// 조용한 필드: 면(elevated)으로 구분하고 포커스에서만 카드색+링 — 앱 작성 화면과 동일 문법
const FIELD_CLS =
    "h-12 px-4 text-[16px] md:text-[16px] bg-cur-elevated border-0 shadow-none rounded-[10px] text-cur-ink placeholder:text-cur-muted-soft focus:bg-cur-card focus-visible:ring-1 focus-visible:ring-cur-primary focus-visible:border-0"

export default function LoginPage() {
    const router = useRouter()
    const [userId, setUserId] = useState("")
    const [password, setPassword] = useState("")
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [rememberMe, setRememberMe] = useState(false)

    useEffect(() => {
        // 이미 로그인돼 있으면 홈으로 (세션 유지 시 재로그인 방지)
        supabase.auth.getSession().then(({ data }) => { if (data.session) router.replace("/") })
        const saved = localStorage.getItem("tbm_saved_login")
        if (saved) {
            try {
                const { id } = JSON.parse(saved)
                setUserId(id || "")
                setRememberMe(true)
            } catch {}
        }
    }, [router])

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
        <div className="min-h-screen flex flex-col items-center justify-center bg-cur-canvas px-5 py-10 font-sans text-cur-ink">
            <InAppBrowserNotice />

            <div className="w-full max-w-sm">
                <div className="flex flex-col items-center gap-5 mb-7">
                    <Logo size="md" />
                    <div className="text-center space-y-1">
                        <h1 className="text-[22px] font-bold tracking-[-0.02em] text-cur-ink">로그인</h1>
                        <p className="text-[13px] text-cur-muted">현장 아이디로 로그인하세요</p>
                    </div>
                </div>

                <form
                    onSubmit={handleLogin}
                    className="bg-cur-card border border-cur-hairline rounded-2xl p-6 space-y-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
                >
                    <div className="space-y-1.5">
                        <Label htmlFor="userId" className="text-[13px] font-medium text-cur-body">아이디</Label>
                        <Input
                            id="userId"
                            type="text"
                            value={userId}
                            onChange={(e) => setUserId(e.target.value)}
                            required
                            className={FIELD_CLS}
                            autoComplete="username"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="password" className="text-[13px] font-medium text-cur-body">비밀번호</Label>
                        <Input
                            id="password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            className={FIELD_CLS}
                            autoComplete="current-password"
                        />
                    </div>

                    <div className="flex items-center gap-2.5 pt-0.5">
                        <Checkbox
                            id="rememberMe"
                            checked={rememberMe}
                            onCheckedChange={(checked) => setRememberMe(checked === true)}
                            className="w-[18px] h-[18px] rounded-[5px] border-cur-hairline-strong data-[state=checked]:bg-cur-primary data-[state=checked]:text-cur-on-primary data-[state=checked]:border-cur-primary"
                        />
                        <label htmlFor="rememberMe" className="text-[13px] font-medium text-cur-muted cursor-pointer select-none">
                            아이디 저장
                        </label>
                    </div>

                    {error && (
                        <div className="flex items-center gap-2 p-3 text-[13px] font-medium text-cur-error bg-cur-error/[0.06] rounded-[10px]">
                            <AlertCircle className="w-4 h-4 shrink-0" />
                            {error}
                        </div>
                    )}

                    <Button
                        type="submit"
                        disabled={loading}
                        className="w-full h-12 text-[15px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-xl font-bold transition-transform active:scale-[0.99]"
                    >
                        {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "로그인"}
                    </Button>

                    <div className="flex items-center gap-3 pt-1">
                        <span className="flex-1 h-px bg-cur-hairline" />
                        <span className="text-[12px] text-cur-muted-soft">또는</span>
                        <span className="flex-1 h-px bg-cur-hairline" />
                    </div>

                    {/* 카카오 가입자의 재로그인 입구 — 시작 페이지에만 있어서 로그인 화면에선 길이 없었다.
                        약관 동의 이력이 없는(=사실상 신규) 사용자는 동의 절차가 있는 /start로 보낸다 */}
                    <Button
                        type="button"
                        onClick={async () => {
                            if (!hasAgreedTerms()) { router.push("/start"); return }
                            setLoading(true)
                            const { error: oauthErr } = await supabase.auth.signInWithOAuth({
                                provider: "kakao",
                                options: { redirectTo: `${window.location.origin}/` },
                            })
                            if (oauthErr) {
                                setError("카카오 로그인에 실패했어요. 잠시 후 다시 시도해주세요.")
                                setLoading(false)
                            }
                        }}
                        disabled={loading}
                        className="w-full h-12 bg-[#FEE500] hover:bg-[#FEE500]/90 text-[#000000] text-[15px] font-semibold rounded-xl flex items-center justify-center transition-transform active:scale-[0.99]"
                    >
                        <MessageSquareWarning className="w-5 h-5 mr-2 fill-black" /> 카카오로 로그인
                    </Button>
                </form>

                <p className="text-center text-[13px] text-cur-muted mt-5">
                    아직 계정이 없으신가요?
                    <a href="/signup" className="font-semibold text-cur-primary hover:underline ml-1.5">회원가입</a>
                </p>
            </div>
        </div>
    )
}