"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { MessageSquareWarning, UserCircle, ArrowLeft, HardHat, MonitorCheck, ChevronRight } from "lucide-react"
import { Logo } from "@/components/Logo"
import { InAppBrowserNotice } from "@/components/InAppBrowserNotice"

export default function StartPage() {
    const router = useRouter()
    const [privacyAgreed, setPrivacyAgreed] = useState(false)
    const [loading, setLoading] = useState(false)
    // 첫 온보딩 역할 선택: 관리감독자(현장 기록) / 안전관리자(여러 현장 관제)
    const [role, setRole] = useState<null | "supervisor">(null)

    useEffect(() => {
        // 이미 로그인돼 있으면 홈으로 (세션 유지 시 재동의·재로그인 방지)
        supabase.auth.getSession().then(({ data }) => { if (data.session) router.replace("/") })
    }, [router])

    const handleKakaoLogin = async () => {
        setLoading(true)
        const { error } = await supabase.auth.signInWithOAuth({
            provider: "kakao",
            options: { redirectTo: `${window.location.origin}/` },
        })
        if (error) {
            alert("카카오 로그인 에러: " + error.message)
            setLoading(false)
        }
    }

    return (
        <div className="min-h-screen bg-cur-canvas flex flex-col relative overflow-hidden font-sans">
            <InAppBrowserNotice />
            <div className="absolute top-0 left-0 right-0 h-[50vh] bg-gradient-to-b from-cur-primary/10 via-cur-primary/5 to-transparent -z-10" />

            <div className="p-4">
                <Button variant="ghost" size="icon" onClick={() => router.push("/")} className="text-cur-muted hover:text-cur-ink">
                    <ArrowLeft className="w-5 h-5" />
                </Button>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-lg mx-auto w-full">
                <div className="space-y-6 flex flex-col items-center">
                    <Logo size="lg" />
                    <p className="text-cur-muted text-[16px] sm:text-[18px]">더 많은 대화로 더 안전한 현장을</p>
                </div>

                <div className="w-full space-y-5 bg-cur-card p-6 rounded-[12px] border border-cur-hairline">
                    <div className="flex items-start gap-3 bg-cur-elevated rounded-[8px] p-4 text-left">
                        <Checkbox
                            id="privacy-agree"
                            checked={privacyAgreed}
                            onCheckedChange={(checked) => setPrivacyAgreed(checked === true)}
                            className="mt-0.5 border-cur-muted data-[state=checked]:bg-cur-primary data-[state=checked]:text-cur-on-primary rounded-[4px]"
                        />
                        <label htmlFor="privacy-agree" className="text-[14px] text-cur-body leading-[1.5] cursor-pointer">
                            <a href="/privacy" target="_blank" className="text-cur-primary font-medium hover:underline">개인정보처리방침</a> 및{" "}
                            <a href="/terms" target="_blank" className="text-cur-primary font-medium hover:underline">서비스 이용약관</a>에 동의합니다.
                        </label>
                    </div>

                    {role === null ? (
                        <div className="space-y-3">
                            <button
                                onClick={() => setRole("supervisor")}
                                disabled={!privacyAgreed}
                                className="w-full flex items-center gap-3 p-4 rounded-[10px] border border-cur-hairline bg-cur-elevated hover:border-cur-primary/40 text-left transition-all disabled:opacity-30"
                            >
                                <span className="w-11 h-11 rounded-[10px] bg-cur-primary/12 text-cur-primary flex items-center justify-center shrink-0"><HardHat className="w-5 h-5" /></span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-[15px] font-bold text-cur-ink">관리감독자로 시작</span>
                                    <span className="block text-[12px] text-cur-muted mt-0.5">현장에서 TBM·안전교육을 기록해요</span>
                                </span>
                                <ChevronRight className="w-4 h-4 text-cur-muted-soft shrink-0" />
                            </button>
                            <button
                                onClick={() => router.push("/signup/manager")}
                                disabled={!privacyAgreed}
                                className="w-full flex items-center gap-3 p-4 rounded-[10px] border border-cur-hairline bg-cur-elevated hover:border-cur-primary/40 text-left transition-all disabled:opacity-30"
                            >
                                <span className="w-11 h-11 rounded-[10px] bg-cur-ink/8 text-cur-ink flex items-center justify-center shrink-0"><MonitorCheck className="w-5 h-5" /></span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-[15px] font-bold text-cur-ink">안전관리자로 시작</span>
                                    <span className="block text-[12px] text-cur-muted mt-0.5">여러 현장을 한눈에 관제하고 보고서를 관리해요</span>
                                </span>
                                <ChevronRight className="w-4 h-4 text-cur-muted-soft shrink-0" />
                            </button>
                            <p className="text-[12px] text-cur-muted-soft text-center leading-relaxed pt-1">
                                회사에서 초대 링크를 받았다면 그 링크로 가입하세요.
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <Button
                                onClick={handleKakaoLogin}
                                disabled={!privacyAgreed || loading}
                                className="w-full h-12 bg-[#FEE500] hover:bg-[#FEE500]/90 text-[#000000] text-[15px] font-semibold rounded-[6px] flex items-center justify-center transition-all disabled:opacity-30"
                            >
                                <MessageSquareWarning className="w-5 h-5 mr-2 fill-black" /> 카카오 계정으로 시작
                            </Button>

                            <Button
                                onClick={() => router.push("/login")}
                                disabled={!privacyAgreed}
                                variant="outline"
                                className="w-full h-12 bg-cur-elevated border border-cur-hairline hover:bg-cur-elevated/80 text-cur-body text-[15px] font-semibold rounded-[6px] flex items-center justify-center transition-all disabled:opacity-30"
                            >
                                <UserCircle className="w-5 h-5 mr-2" /> 일반 계정으로 시작
                            </Button>
                            <button onClick={() => setRole(null)} className="w-full text-[13px] text-cur-muted hover:text-cur-ink transition-colors">← 역할 다시 고르기</button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
