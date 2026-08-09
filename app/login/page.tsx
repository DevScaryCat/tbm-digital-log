// app/login/page.tsx
"use client"

import { Suspense, useState, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AlertCircle, Loader2, MessageSquareWarning } from "lucide-react"
import { Logo } from "@/components/Logo"
import { InAppBrowserNotice } from "@/components/InAppBrowserNotice"

const FIELD_CLS =
    "h-12 rounded-[8px] bg-cur-elevated border-cur-hairline text-[16px] md:text-[16px] font-medium text-cur-ink placeholder:text-cur-muted-soft focus-visible:ring-1 focus-visible:ring-cur-primary"
const CARD_CLS = "bg-cur-card border border-cur-hairline rounded-[12px] p-5 space-y-4"
const DIALOG_CLS =
    "bg-cur-card border-cur-hairline rounded-[20px] shadow-[0_8px_32px_rgba(0,0,0,0.1)] p-5 gap-4 w-[calc(100%-2rem)] sm:max-w-md"
const BTN_CLS =
    "w-full h-12 text-[15px] font-bold rounded-[8px] transition-transform active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-cur-primary"

export default function LoginPage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-cur-canvas" />}>
            <LoginScreen />
        </Suspense>
    )
}

function LoginScreen() {
    const router = useRouter()
    const searchParams = useSearchParams()
    const [userId, setUserId] = useState("")
    const [password, setPassword] = useState("")
    const [loading, setLoading] = useState(false)
    const [kakaoBusy, setKakaoBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [rememberMe, setRememberMe] = useState(false)
    const [consentOpen, setConsentOpen] = useState(false)
    const [consentChecked, setConsentChecked] = useState(false)

    // 감독자가 발급한 아이디를 손에 쥔 현장소장이 착지하는 주소 — 그에게 쓸모없는 카카오 버튼이 맨 위에 있으면 안 된다
    const idFirst = searchParams.get("m") === "id"
    const busy = loading || kakaoBusy

    useEffect(() => {
        // 이미 로그인돼 있으면 홈으로 (세션 유지 시 재로그인 방지)
        let alive = true
        supabase.auth.getSession().then(({ data }) => { if (alive && data.session) router.replace("/") })
        // 카카오 콜백이 이 주소로 돌아온다 — 코드 교환이 위 getSession보다 늦게 끝날 수 있어 구독으로도 받는다
        const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
            if (alive && session) router.replace("/")
        })
        return () => { alive = false; sub.subscription.unsubscribe() }
    }, [router])

    useEffect(() => {
        // 초대 링크가 지정한 아이디가 저장된 아이디보다 우선
        const fromLink = searchParams.get("id")
        if (fromLink) { setUserId(fromLink); return }
        const saved = localStorage.getItem("tbm_saved_login")
        if (saved) {
            try {
                const { id } = JSON.parse(saved)
                setUserId(id || "")
                setRememberMe(true)
            } catch {}
        }
    }, [searchParams])

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError(null)

        try {
            const emailForLogin = `${userId}@tbm.com`

            const { error } = await supabase.auth.signInWithPassword({
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

    const handleKakao = async () => {
        setConsentOpen(false)
        setKakaoBusy(true)
        setError(null)
        // 지금은 세션이 없어 서버에 기록할 수 없다 — 방금 받은 명시적 동의를 콜백 뒤 ConsentGate가
        // 이어받아 기록하도록 표식만 남긴다. 탭을 닫으면 사라지고, 소비되면 즉시 지워진다
        try { sessionStorage.setItem("antok_pending_consent", "1") } catch {}
        const { error: oauthErr } = await supabase.auth.signInWithOAuth({
            provider: "kakao",
            // 취소·인앱브라우저 실패 시 마케팅 랜딩이 아니라 이 화면으로 되돌아오게 한다
            options: { redirectTo: `${window.location.origin}/login` },
        })
        if (oauthErr) {
            // 동의가 실제 가입으로 이어지지 않았으므로 표식을 남겨두지 않는다
            try { sessionStorage.removeItem("antok_pending_consent") } catch {}
            setError("카카오 로그인에 실패했어요. 잠시 후 다시 시도해주세요.")
            setKakaoBusy(false)
        }
    }

    const divider = (
        <div className="flex items-center gap-3">
            <span className="flex-1 h-px bg-cur-hairline" />
            <span className="text-[12px] text-cur-muted-soft">또는</span>
            <span className="flex-1 h-px bg-cur-hairline" />
        </div>
    )

    const kakaoBlock = (
        <Button
            type="button"
            onClick={() => { setConsentChecked(false); setConsentOpen(true) }}
            disabled={busy}
            className={`${BTN_CLS} bg-[#FEE500] hover:bg-[#FEE500]/90 text-[#000000] flex items-center justify-center`}
        >
            {kakaoBusy ? (
                <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
                <><MessageSquareWarning className="w-5 h-5 mr-2 fill-black" /> 카카오로 계속하기</>
            )}
        </Button>
    )

    const idBlock = (
        <form onSubmit={handleLogin} className="space-y-4">
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
                    className="w-[18px] h-[18px] rounded-[5px] border-cur-hairline-strong data-[state=checked]:bg-cur-primary data-[state=checked]:text-cur-on-primary data-[state=checked]:border-cur-primary focus-visible:ring-2 focus-visible:ring-cur-primary"
                />
                <label htmlFor="rememberMe" className="text-[13px] font-medium text-cur-muted cursor-pointer select-none">
                    아이디 저장
                </label>
            </div>

            <Button
                type="submit"
                disabled={busy}
                className={`${BTN_CLS} bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary`}
            >
                {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "로그인"}
            </Button>

            {/* 아이디 계정은 비밀번호를 잃으면 복구 수단이 없다 — 잠기기 전에 여기서 빠져나갈 수 있어야 한다 */}
            <div className="flex items-center justify-center gap-2 text-[13px] text-cur-muted">
                <a href="/forgot-id" className="hover:text-cur-ink hover:underline rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary">
                    아이디 찾기
                </a>
                <span className="text-cur-hairline-strong">·</span>
                <a href="/forgot-password" className="hover:text-cur-ink hover:underline rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary">
                    비밀번호 찾기
                </a>
            </div>
        </form>
    )

    return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-cur-canvas px-5 py-10 font-sans text-cur-ink">
            <InAppBrowserNotice />

            <div className="w-full max-w-md">
                <div className="flex flex-col items-center gap-5 mb-7">
                    <Logo size="md" />
                    <div className="text-center space-y-1">
                        <h1 className="text-[22px] font-bold tracking-[-0.02em] text-cur-ink">안톡 시작하기</h1>
                        <p className="text-[13px] text-cur-muted">카카오로 시작하거나, 현장 아이디로 로그인하세요</p>
                    </div>
                </div>

                <div className={CARD_CLS}>
                    {error && (
                        <div className="flex items-center gap-2 p-3 text-[13px] font-medium text-cur-error bg-cur-error/[0.06] rounded-[8px]">
                            <AlertCircle className="w-4 h-4 shrink-0" />
                            {error}
                        </div>
                    )}

                    {idFirst ? (
                        <>{idBlock}{divider}{kakaoBlock}</>
                    ) : (
                        <>{kakaoBlock}{divider}{idBlock}</>
                    )}
                </div>

                <p className="text-center text-[14px] text-cur-muted mt-5">
                    아직 계정이 없으신가요?
                    <a
                        href="/signup"
                        className="font-semibold text-cur-primary hover:underline ml-1.5 rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                    >
                        아이디로 새로 가입하기
                    </a>
                </p>
            </div>

            {/* 카카오는 세션이 없어 서버 동의 이력을 조회할 수 없다 — 개인정보가 넘어오기 전에 동의를 먼저 받는다 */}
            <Dialog open={consentOpen} onOpenChange={(o) => { if (!o) { setConsentOpen(false); setConsentChecked(false) } }}>
                <DialogContent aria-describedby={undefined} className={DIALOG_CLS}>
                    <DialogHeader className="text-left">
                        <DialogTitle className="text-[16px] font-bold text-cur-ink">계속하기 전에 동의가 필요해요</DialogTitle>
                    </DialogHeader>

                    <div className="flex items-start gap-3 bg-cur-elevated rounded-[8px] p-4">
                        <Checkbox
                            id="kakao-consent"
                            checked={consentChecked}
                            onCheckedChange={(checked) => setConsentChecked(checked === true)}
                            className="mt-0.5 w-[18px] h-[18px] rounded-[5px] border-cur-hairline-strong data-[state=checked]:bg-cur-primary data-[state=checked]:text-cur-on-primary data-[state=checked]:border-cur-primary focus-visible:ring-2 focus-visible:ring-cur-primary"
                        />
                        <label htmlFor="kakao-consent" className="text-[13px] text-cur-body leading-[1.6] cursor-pointer select-none">
                            <a
                                href="/privacy"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-cur-primary font-medium hover:underline rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                            >
                                개인정보처리방침
                            </a>{" "}
                            및{" "}
                            <a
                                href="/terms"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-cur-primary font-medium hover:underline rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                            >
                                서비스 이용약관
                            </a>
                            에 동의합니다.
                        </label>
                    </div>

                    <Button
                        type="button"
                        onClick={handleKakao}
                        disabled={!consentChecked || kakaoBusy}
                        className={`${BTN_CLS} bg-[#FEE500] hover:bg-[#FEE500]/90 text-[#000000] flex items-center justify-center disabled:opacity-40`}
                    >
                        <MessageSquareWarning className="w-5 h-5 mr-2 fill-black" /> 동의하고 카카오로 계속하기
                    </Button>
                </DialogContent>
            </Dialog>
        </div>
    )
}
