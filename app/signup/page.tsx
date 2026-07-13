// app/signup/page.tsx — 3단계 가입 위저드
// ① 계정(아이디/비밀번호) ② 현장 정보(현장명·업종·공종 — 데이터 분석용) ③ 확인·가입
// 업종/공종은 user_metadata(industry, work_category)로 저장된다.
"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AlertCircle, Loader2, HardHat, CheckCircle, ChevronLeft } from "lucide-react"
import { cn } from "@/lib/utils"
import Link from "next/link"

const INDUSTRIES = ["건설업", "제조업", "물류·운수업", "조선·플랜트", "전기·정보통신공사", "시설관리·서비스업", "기타"]
const WORK_CATEGORIES = ["건축", "토목", "전기", "기계설비", "소방", "정보통신", "조경", "철근콘크리트", "도장·방수", "실내건축(인테리어)", "기타"]

const STEPS = [
    { no: 1, label: "계정" },
    { no: 2, label: "현장 정보" },
    { no: 3, label: "확인" },
]

export default function SignupPage() {
    const router = useRouter()
    const [step, setStep] = useState(1)
    const [id, setId] = useState("")
    const [password, setPassword] = useState("")
    const [passwordConfirm, setPasswordConfirm] = useState("")
    const [siteName, setSiteName] = useState("")
    const [industry, setIndustry] = useState("")
    const [workCategory, setWorkCategory] = useState("")
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState(false)

    const validateStep = (s: number): string | null => {
        if (s === 1) {
            if (!/^[a-z0-9_]{3,20}$/.test(id)) return "아이디는 영문 소문자·숫자·밑줄 3~20자로 입력해주세요."
            if (password.length < 8) return "비밀번호는 8자 이상 입력해주세요."
            if (password !== passwordConfirm) return "비밀번호가 일치하지 않습니다."
        }
        if (s === 2) {
            if (!siteName.trim()) return "현장명(회사명)을 입력해주세요."
            if (!industry) return "업종을 선택해주세요."
            if (industry === "건설업" && !workCategory) return "공종을 선택해주세요."
        }
        return null
    }

    const goNext = () => {
        const err = validateStep(step)
        if (err) { setError(err); return }
        setError(null)
        setStep((s) => Math.min(3, s + 1))
    }
    const goBack = () => { setError(null); setStep((s) => Math.max(1, s - 1)) }

    const handleSignup = async () => {
        setLoading(true)
        setError(null)
        try {
            const res = await fetch('/api/signup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id, password, siteName,
                    industry,
                    workCategory: industry === "건설업" ? workCategory : "",
                })
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || "회원가입에 실패했습니다.")
            setSuccess(true)
            setTimeout(() => { router.push("/login") }, 3000)
        } catch (err: unknown) {
            console.error(err)
            setError(err instanceof Error ? err.message : "오류가 발생했습니다. 다시 시도해주세요.")
        } finally {
            setLoading(false)
        }
    }

    if (success) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-cur-canvas p-4 font-sans text-cur-ink">
                <Card className="w-full max-w-md border border-cur-hairline bg-cur-card text-center py-10 rounded-[24px] shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                    <CardContent className="space-y-4 flex flex-col items-center">
                        <CheckCircle className="w-16 h-16 text-cur-success mb-2" />
                        <h2 className="text-[24px] font-normal text-cur-ink tracking-[-0.72px]">회원가입 완료!</h2>
                        <p className="text-[15px] text-cur-muted font-medium">성공적으로 계정이 생성되었습니다.<br/>잠시 후 로그인 페이지로 이동합니다.</p>
                        <Button variant="outline" className="mt-4 border-cur-hairline text-cur-ink hover:bg-cur-elevated rounded-[8px] h-12 px-6 font-medium" onClick={() => router.push("/login")}>
                            로그인 바로가기
                        </Button>
                    </CardContent>
                </Card>
            </div>
        )
    }

    const inputCls = "h-14 text-[16px] bg-cur-card border-cur-hairline rounded-[8px] focus-visible:ring-1 focus-visible:ring-cur-primary text-cur-ink placeholder:text-cur-muted-soft"

    return (
        <div className="min-h-screen flex items-center justify-center bg-cur-canvas p-4 font-sans text-cur-ink">
            <Card className="w-full max-w-md border border-cur-hairline bg-cur-card rounded-[24px] shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                <CardHeader className="space-y-4 text-center pb-4 pt-10">
                    <div className="mx-auto bg-cur-elevated w-16 h-16 rounded-[12px] flex items-center justify-center mb-2 border border-cur-hairline">
                        <HardHat className="w-8 h-8 text-cur-primary" />
                    </div>
                    <CardTitle className="text-[28px] font-normal text-cur-ink tracking-[-0.72px]">현장 계정 생성</CardTitle>
                    <CardDescription className="text-[15px] text-cur-muted font-medium">
                        {step === 1 && "로그인에 사용할 계정을 만들어주세요."}
                        {step === 2 && "현장 정보를 알려주세요. 맞춤 통계에 활용됩니다."}
                        {step === 3 && "입력하신 내용을 확인해주세요."}
                    </CardDescription>

                    {/* 단계 표시 */}
                    <div className="flex items-center justify-center gap-2 pt-2">
                        {STEPS.map((s, i) => (
                            <div key={s.no} className="flex items-center gap-2">
                                <div className={cn(
                                    "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-bold transition-colors",
                                    step === s.no ? "bg-cur-primary text-cur-on-primary"
                                        : step > s.no ? "bg-cur-primary/15 text-cur-primary"
                                        : "bg-cur-elevated text-cur-muted-soft"
                                )}>
                                    <span>{step > s.no ? "✓" : s.no}</span>
                                    <span>{s.label}</span>
                                </div>
                                {i < STEPS.length - 1 && <div className="w-4 h-px bg-cur-hairline-strong" />}
                            </div>
                        ))}
                    </div>
                </CardHeader>

                <CardContent className="px-8 pb-10 pt-4">
                    <div className="space-y-5">
                        {step === 1 && (
                            <>
                                <div className="space-y-2.5">
                                    <Label htmlFor="id" className="text-[15px] font-semibold text-cur-ink">사용할 아이디</Label>
                                    <Input id="id" type="text" placeholder="예: site01 (영문 소문자/숫자)" value={id} onChange={(e) => setId(e.target.value)} minLength={3} className={inputCls} autoComplete="off" />
                                </div>
                                <div className="space-y-2.5">
                                    <Label htmlFor="password" className="text-[15px] font-semibold text-cur-ink">비밀번호</Label>
                                    <Input id="password" type="password" placeholder="8자 이상 입력" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} className={inputCls} />
                                </div>
                                <div className="space-y-2.5">
                                    <Label htmlFor="passwordConfirm" className="text-[15px] font-semibold text-cur-ink">비밀번호 확인</Label>
                                    <Input id="passwordConfirm" type="password" placeholder="비밀번호 다시 입력" value={passwordConfirm} onChange={(e) => setPasswordConfirm(e.target.value)} minLength={8} className={inputCls} />
                                </div>
                            </>
                        )}

                        {step === 2 && (
                            <>
                                <div className="space-y-2.5">
                                    <Label htmlFor="siteName" className="text-[15px] font-semibold text-cur-ink">현장명 (회사명)</Label>
                                    <Input id="siteName" type="text" placeholder="소속 현장명 (또는 업체명)" value={siteName} onChange={(e) => setSiteName(e.target.value)} className={inputCls} />
                                </div>
                                <div className="space-y-2.5">
                                    <Label className="text-[15px] font-semibold text-cur-ink">업종</Label>
                                    <Select value={industry} onValueChange={(v) => { setIndustry(v); if (v !== "건설업") setWorkCategory("") }}>
                                        <SelectTrigger className="h-14 text-[16px] bg-cur-card border-cur-hairline rounded-[8px] text-cur-ink">
                                            <SelectValue placeholder="업종을 선택해주세요" />
                                        </SelectTrigger>
                                        <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                                            {INDUSTRIES.map((v) => <SelectItem key={v} value={v} className="text-[15px] py-2.5">{v}</SelectItem>)}
                                        </SelectContent>
                                    </Select>
                                </div>
                                {industry === "건설업" && (
                                    <div className="space-y-2.5 animate-in slide-in-from-top-2">
                                        <Label className="text-[15px] font-semibold text-cur-ink">공종</Label>
                                        <Select value={workCategory} onValueChange={setWorkCategory}>
                                            <SelectTrigger className="h-14 text-[16px] bg-cur-card border-cur-hairline rounded-[8px] text-cur-ink">
                                                <SelectValue placeholder="주력 공종을 선택해주세요" />
                                            </SelectTrigger>
                                            <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                                                {WORK_CATEGORIES.map((v) => <SelectItem key={v} value={v} className="text-[15px] py-2.5">{v}</SelectItem>)}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                )}
                            </>
                        )}

                        {step === 3 && (
                            <div className="rounded-[12px] border border-cur-hairline bg-cur-canvas-soft divide-y divide-cur-hairline">
                                {[
                                    ["아이디", id],
                                    ["현장명", siteName],
                                    ["업종", industry],
                                    ...(industry === "건설업" ? [["공종", workCategory]] : []),
                                ].map(([k, v]) => (
                                    <div key={k} className="flex justify-between items-center px-4 py-3.5">
                                        <span className="text-[14px] text-cur-muted">{k}</span>
                                        <span className="text-[15px] font-semibold text-cur-ink">{v}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {error && (
                            <div className="flex items-center gap-2 p-4 text-[14px] font-semibold text-cur-error bg-cur-error/5 rounded-[8px] border border-cur-error/20">
                                <AlertCircle className="w-5 h-5 shrink-0" />
                                {error}
                            </div>
                        )}

                        <div className="flex gap-2 mt-2">
                            {step > 1 && (
                                <Button type="button" variant="outline" onClick={goBack} disabled={loading} className="h-14 px-4 border-cur-hairline text-cur-ink rounded-[8px] font-medium">
                                    <ChevronLeft className="w-5 h-5" /> 이전
                                </Button>
                            )}
                            {step < 3 ? (
                                <Button type="button" onClick={goNext} className="flex-1 h-14 text-[16px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-[8px] font-medium transition-transform active:scale-[0.98]">
                                    다음
                                </Button>
                            ) : (
                                <Button type="button" onClick={handleSignup} disabled={loading} className="flex-1 h-14 text-[16px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-[8px] font-medium transition-transform active:scale-[0.98]">
                                    {loading ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : "회원가입 하기"}
                                </Button>
                            )}
                        </div>

                        <div className="text-center mt-8 text-[14px] font-medium text-cur-muted border-t border-cur-hairline pt-6">
                            이미 계정이 있으신가요?{" "}
                            <Link href="/login" className="font-semibold text-cur-primary hover:underline ml-1">
                                로그인 화면으로
                            </Link>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
