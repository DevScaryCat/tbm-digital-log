"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { MessageSquareWarning, UserCircle, ArrowLeft } from "lucide-react"
import { Logo } from "@/components/Logo"

export default function StartPage() {
    const router = useRouter()
    const [privacyAgreed, setPrivacyAgreed] = useState(false)
    const [loading, setLoading] = useState(false)

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
                </div>
            </div>
        </div>
    )
}
