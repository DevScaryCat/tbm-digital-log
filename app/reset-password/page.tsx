"use client"

// app/reset-password/page.tsx — 메일 링크로 들어와 새 비밀번호를 정하는 화면
import { Suspense, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react"
import { Logo } from "@/components/Logo"
import { supabase } from "@/lib/supabaseClient"
import { CARD_CLS, FIELD_CLS, PRIMARY_BTN_CLS } from "@/lib/authStyles"

const MIN_LENGTH = 8 // 가입 화면과 같은 규칙

export default function ResetPasswordPage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-cur-canvas" />}>
            <ResetPasswordScreen />
        </Suspense>
    )
}

function ResetPasswordScreen() {
    const router = useRouter()
    const token = useSearchParams().get("token") || ""
    const [password, setPassword] = useState("")
    const [confirm, setConfirm] = useState("")
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [done, setDone] = useState(false)

    const submit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (loading) return
        if (password.length < MIN_LENGTH) return setError(`비밀번호는 ${MIN_LENGTH}자 이상 입력해주세요.`)
        if (password !== confirm) return setError("비밀번호가 일치하지 않습니다.")

        setLoading(true)
        setError(null)
        try {
            const res = await fetch("/api/auth/reset", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token, newPassword: password }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) {
                setError(data?.error || "비밀번호를 바꾸지 못했어요. 잠시 후 다시 시도해주세요.")
                return
            }
            // 서버가 기존 세션을 모두 끊었다 — 이 브라우저에 남은 껍데기 세션도 같이 정리한다
            await supabase.auth.signOut().catch(() => {})
            setDone(true)
        } catch {
            setError("네트워크 상태를 확인하고 다시 시도해주세요.")
        } finally {
            setLoading(false)
        }
    }

    const shell = (children: React.ReactNode, subtitle: string) => (
        <div className="min-h-screen flex flex-col items-center justify-center bg-cur-canvas px-5 py-10 font-sans text-cur-ink">
            <div className="w-full max-w-md">
                <div className="flex flex-col items-center gap-5 mb-7">
                    <Logo size="md" />
                    <div className="text-center space-y-1">
                        <h1 className="text-[22px] font-bold tracking-[-0.02em] text-cur-ink">비밀번호 새로 정하기</h1>
                        <p className="text-[13px] text-cur-muted">{subtitle}</p>
                    </div>
                </div>
                {children}
                <p className="text-center text-[14px] text-cur-muted mt-5">
                    <a
                        href="/login"
                        className="font-semibold text-cur-primary hover:underline rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                    >
                        로그인 화면으로 돌아가기
                    </a>
                </p>
            </div>
        </div>
    )

    if (!token) {
        return shell(
            <div className={CARD_CLS}>
                <div className="flex items-center gap-2 p-3 text-[13px] font-medium text-cur-error bg-cur-error/[0.06] rounded-[8px]">
                    <AlertCircle className="w-4 h-4 shrink-0" aria-hidden />
                    링크가 올바르지 않아요. 메일에 있는 링크를 다시 눌러주세요.
                </div>
                <Button type="button" onClick={() => router.push("/forgot-password")} className={PRIMARY_BTN_CLS}>
                    비밀번호 찾기 다시 하기
                </Button>
            </div>,
            "링크를 다시 확인해주세요",
        )
    }

    if (done) {
        return shell(
            <div className={CARD_CLS}>
                <div className="flex flex-col items-center text-center gap-3 py-2">
                    <span className="w-11 h-11 rounded-full bg-cur-success/[0.10] flex items-center justify-center">
                        <CheckCircle2 className="w-5 h-5 text-cur-success" aria-hidden />
                    </span>
                    <div className="space-y-1.5">
                        <p className="text-[15px] font-bold text-cur-ink">비밀번호를 바꿨어요</p>
                        <p className="text-[13px] text-cur-muted leading-[1.7]" aria-live="polite">
                            안전을 위해 기존에 로그인돼 있던 기기는 모두 로그아웃했어요.
                            <br />
                            새 비밀번호로 다시 로그인해주세요.
                        </p>
                    </div>
                </div>
                <Button type="button" onClick={() => router.push("/login?m=id")} className={PRIMARY_BTN_CLS}>
                    로그인하러 가기
                </Button>
            </div>,
            "이제 새 비밀번호로 로그인하세요",
        )
    }

    return shell(
        <form onSubmit={submit} className={CARD_CLS}>
            {error && (
                <div className="flex items-center gap-2 p-3 text-[13px] font-medium text-cur-error bg-cur-error/[0.06] rounded-[8px]">
                    <AlertCircle className="w-4 h-4 shrink-0" aria-hidden />
                    {error}
                </div>
            )}

            <div className="space-y-1.5">
                <Label htmlFor="new-password" className="text-[13px] font-medium text-cur-body">새 비밀번호</Label>
                <Input
                    id="new-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={`${MIN_LENGTH}자 이상 입력`}
                    minLength={MIN_LENGTH}
                    autoComplete="new-password"
                    required
                    className={FIELD_CLS}
                />
            </div>

            <div className="space-y-1.5">
                <Label htmlFor="new-password-confirm" className="text-[13px] font-medium text-cur-body">새 비밀번호 확인</Label>
                <Input
                    id="new-password-confirm"
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="비밀번호 다시 입력"
                    minLength={MIN_LENGTH}
                    autoComplete="new-password"
                    required
                    className={FIELD_CLS}
                />
            </div>

            <Button type="submit" disabled={loading || !password || !confirm} className={PRIMARY_BTN_CLS}>
                {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "비밀번호 바꾸기"}
            </Button>

            <p className="text-[12px] text-cur-muted-soft leading-[1.6]">
                링크는 30분 동안만 쓸 수 있어요. 시간이 지났다면 비밀번호 찾기를 다시 요청해주세요.
            </p>
        </form>,
        "새로 쓸 비밀번호를 입력해주세요",
    )
}
