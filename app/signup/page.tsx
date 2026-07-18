// app/signup/page.tsx — 가입 위저드
// ① 계정 ② 현장 정보(업종·공종 — 데이터 분석용) ③ 휴대폰 인증(솔라피 OTP, 켜져 있을 때만) ④ 확인·가입
// 휴대폰 인증이 켜져 있으면(서버 env) 가입 즉시 카드 없이 Pro 1개월 무료체험이 시작된다.
// 꺼져 있으면 기존 흐름(가입 → 카드 등록 시 체험) 그대로 3단계로 동작한다.
"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AlertCircle, Loader2, HardHat, CheckCircle, CheckCircle2, ChevronLeft } from "lucide-react"
import { cn } from "@/lib/utils"
import { supabase } from "@/lib/supabaseClient"
import Link from "next/link"

const INDUSTRIES = ["건설업", "제조업", "물류·운수업", "조선·플랜트", "전기·정보통신공사", "시설관리·서비스업", "기타"]
const WORK_CATEGORIES = ["건축", "토목", "전기", "기계설비", "소방", "정보통신", "조경", "철근콘크리트", "도장·방수", "실내건축(인테리어)", "기타"]

type StepKey = "account" | "site" | "phone" | "confirm"
const STEP_LABEL: Record<StepKey, string> = { account: "계정", site: "현장 정보", phone: "휴대폰 인증", confirm: "확인" }

export default function SignupPage() {
    const router = useRouter()
    // 휴대폰 인증 게이트 활성화 여부(서버 env 기준) — 로딩 전엔 null
    const [phoneEnabled, setPhoneEnabled] = useState<boolean | null>(null)
    const [stepIdx, setStepIdx] = useState(0)
    const [id, setId] = useState("")
    const [password, setPassword] = useState("")
    const [passwordConfirm, setPasswordConfirm] = useState("")
    const [siteName, setSiteName] = useState("")
    const [industry, setIndustry] = useState("")
    const [workCategory, setWorkCategory] = useState("")
    // 근로자 구분 — 교육시간 산정용(기본값 프리셋, 별도 검증 불필요)
    const [workerType, setWorkerType] = useState("현장 근로자 (비사무직)")
    // 휴대폰 인증 상태
    const [phone, setPhone] = useState("")
    const [code, setCode] = useState("")
    const [codeSent, setCodeSent] = useState(false)
    const [cooldown, setCooldown] = useState(0)
    const [sending, setSending] = useState(false)
    const [verifying, setVerifying] = useState(false)
    const [verificationId, setVerificationId] = useState<string | null>(null)
    const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null)

    const [loading, setLoading] = useState(false)
    const [checkingId, setCheckingId] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState(false)
    const [trialStarted, setTrialStarted] = useState(false)
    // 가입 직후 자동 로그인 성공 여부 — 실패 시 기존처럼 로그인 페이지로 유도
    const [autoLoggedIn, setAutoLoggedIn] = useState(false)

    useEffect(() => {
        fetch("/api/auth/phone/status")
            .then((r) => r.json())
            .then((j) => setPhoneEnabled(!!j.enabled))
            .catch(() => setPhoneEnabled(false))
        return () => { if (cooldownTimer.current) clearInterval(cooldownTimer.current) }
    }, [])

    const stepKeys: StepKey[] = phoneEnabled
        ? ["account", "site", "phone", "confirm"]
        : ["account", "site", "confirm"]
    const stepKey = stepKeys[stepIdx]

    const startCooldown = (sec: number) => {
        setCooldown(sec)
        if (cooldownTimer.current) clearInterval(cooldownTimer.current)
        cooldownTimer.current = setInterval(() => {
            setCooldown((c) => {
                if (c <= 1) { if (cooldownTimer.current) clearInterval(cooldownTimer.current); return 0 }
                return c - 1
            })
        }, 1000)
    }

    const handleSendCode = async () => {
        const digits = phone.replace(/\D/g, "")
        if (!/^010\d{8}$/.test(digits)) { setError("올바른 휴대폰 번호(010)를 입력해주세요."); return }
        setError(null)
        setSending(true)
        try {
            const res = await fetch("/api/auth/phone/send", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: digits }),
            })
            const j = await res.json()
            if (!res.ok) { setError(j.error || "발송에 실패했습니다."); return }
            setCodeSent(true)
            setCode("")
            startCooldown(60)
        } catch {
            setError("발송에 실패했습니다. 잠시 후 다시 시도해주세요.")
        } finally {
            setSending(false)
        }
    }

    const handleVerifyCode = async () => {
        if (!/^\d{6}$/.test(code.trim())) { setError("인증번호 6자리를 입력해주세요."); return }
        setError(null)
        setVerifying(true)
        try {
            const res = await fetch("/api/auth/phone/verify", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: phone.replace(/\D/g, ""), code: code.trim() }),
            })
            const j = await res.json()
            if (!res.ok) { setError(j.error || "인증에 실패했습니다."); return }
            setVerificationId(j.verificationId)
        } catch {
            setError("인증 확인에 실패했습니다. 잠시 후 다시 시도해주세요.")
        } finally {
            setVerifying(false)
        }
    }

    const validateStep = (key: StepKey): string | null => {
        if (key === "account") {
            if (!/^[a-z0-9_]{3,20}$/.test(id)) return "아이디는 영문 소문자·숫자·밑줄 3~20자로 입력해주세요."
            if (password.length < 8) return "비밀번호는 8자 이상 입력해주세요."
            if (password !== passwordConfirm) return "비밀번호가 일치하지 않습니다."
        }
        if (key === "site") {
            if (!siteName.trim()) return "현장명(회사명)을 입력해주세요."
            if (!industry) return "업종을 선택해주세요."
            if (industry === "건설업" && !workCategory) return "공종을 선택해주세요."
        }
        if (key === "phone") {
            if (!verificationId) return "휴대폰 인증을 완료해주세요."
        }
        return null
    }

    const goNext = async () => {
        const err = validateStep(stepKey)
        if (err) { setError(err); return }
        setError(null)
        // 계정 단계: 아이디 중복을 여기서 즉시 확인(최종 제출까지 미루지 않음)
        if (stepKey === "account") {
            setCheckingId(true)
            try {
                const res = await fetch("/api/auth/check-id", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id }),
                })
                const j = await res.json()
                if (!res.ok) { setError(j.error || "아이디 확인에 실패했습니다."); return }
                if (!j.available) { setError("이미 사용 중인 아이디입니다. 다른 아이디를 입력해주세요."); return }
            } catch {
                setError("아이디 확인에 실패했습니다. 잠시 후 다시 시도해주세요."); return
            } finally {
                setCheckingId(false)
            }
        }
        setStepIdx((s) => Math.min(stepKeys.length - 1, s + 1))
    }
    const goBack = () => { setError(null); setStepIdx((s) => Math.max(0, s - 1)) }

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
                    workerType,
                    ...(phoneEnabled ? { phone: phone.replace(/\D/g, ""), verificationId } : {}),
                })
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || "회원가입에 실패했습니다.")
            setTrialStarted(!!data.trialStarted)
            // 가입 직후 자동 로그인 — 실패해도 가입 자체는 완료이므로 기존 흐름(로그인 페이지)으로 폴백
            const { error: loginError } = await supabase.auth.signInWithPassword({
                email: `${id}@tbm.com`,
                password,
            })
            if (!loginError) {
                setAutoLoggedIn(true)
                setSuccess(true)
                setTimeout(() => { router.push("/") }, 1800)
            } else {
                setSuccess(true)
                setTimeout(() => { router.push("/login") }, 4000)
            }
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
                        {trialStarted ? (
                            <p className="text-[15px] text-cur-muted font-medium">
                                <b className="text-cur-primary">Pro 1개월 무료체험</b>이 시작되었습니다. 🎉<br />
                                모든 기능을 자유롭게 써보세요.<br />
                                {autoLoggedIn ? "잠시 후 메인 화면으로 이동합니다." : "잠시 후 로그인 페이지로 이동합니다."}
                            </p>
                        ) : (
                            <p className="text-[15px] text-cur-muted font-medium">
                                성공적으로 계정이 생성되었습니다.<br />
                                {autoLoggedIn ? "잠시 후 메인 화면으로 이동합니다." : "잠시 후 로그인 페이지로 이동합니다."}
                            </p>
                        )}
                        <Button variant="outline" className="mt-4 border-cur-hairline text-cur-ink hover:bg-cur-elevated rounded-[8px] h-12 px-6 font-medium" onClick={() => router.push(autoLoggedIn ? "/" : "/login")}>
                            {autoLoggedIn ? "바로 시작하기" : "로그인 바로가기"}
                        </Button>
                    </CardContent>
                </Card>
            </div>
        )
    }

    const inputCls = "h-14 text-[16px] bg-cur-card border-cur-hairline rounded-[8px] focus-visible:ring-1 focus-visible:ring-cur-primary text-cur-ink placeholder:text-cur-muted-soft"

    if (phoneEnabled === null) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-cur-canvas">
                <Loader2 className="w-8 h-8 text-cur-muted animate-spin" />
            </div>
        )
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-cur-canvas p-4 font-sans text-cur-ink">
            <Card className="w-full max-w-md border border-cur-hairline bg-cur-card rounded-[24px] shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                <CardHeader className="space-y-4 text-center pb-4 pt-10">
                    <div className="mx-auto bg-cur-elevated w-16 h-16 rounded-[12px] flex items-center justify-center mb-2 border border-cur-hairline">
                        <HardHat className="w-8 h-8 text-cur-primary" />
                    </div>
                    <CardTitle className="text-[28px] font-normal text-cur-ink tracking-[-0.72px]">현장 계정 생성</CardTitle>
                    <CardDescription className="text-[15px] text-cur-muted font-medium">
                        {stepKey === "account" && "로그인에 사용할 계정을 만들어주세요."}
                        {stepKey === "site" && "현장 정보를 알려주세요. 맞춤 통계에 활용됩니다."}
                        {stepKey === "phone" && "본인 확인 후 1개월 무료체험이 시작됩니다."}
                        {stepKey === "confirm" && "입력하신 내용을 확인해주세요."}
                    </CardDescription>

                    {/* 단계 표시 */}
                    <div className="flex items-center justify-center gap-1.5 pt-2 flex-wrap">
                        {stepKeys.map((k, i) => (
                            <div key={k} className="flex items-center gap-1.5">
                                <div className={cn(
                                    "flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] font-bold transition-colors",
                                    stepIdx === i ? "bg-cur-primary text-cur-on-primary"
                                        : stepIdx > i ? "bg-cur-primary/15 text-cur-primary"
                                        : "bg-cur-elevated text-cur-muted-soft"
                                )}>
                                    <span>{stepIdx > i ? "✓" : i + 1}</span>
                                    <span>{STEP_LABEL[k]}</span>
                                </div>
                                {i < stepKeys.length - 1 && <div className="w-3 h-px bg-cur-hairline-strong" />}
                            </div>
                        ))}
                    </div>
                </CardHeader>

                <CardContent className="px-8 pb-10 pt-4">
                    <div className="space-y-5">
                        {stepKey === "account" && (
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

                        {stepKey === "site" && (
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
                                <div className="space-y-2.5">
                                    <Label className="text-[15px] font-semibold text-cur-ink">근로자 구분 (교육시간 산정용)</Label>
                                    <Select value={workerType} onValueChange={setWorkerType}>
                                        <SelectTrigger className="h-14 text-[16px] bg-cur-card border-cur-hairline rounded-[8px] text-cur-ink">
                                            <SelectValue placeholder="근로자 구분을 선택해주세요" />
                                        </SelectTrigger>
                                        <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                                            <SelectItem value="현장 근로자 (비사무직)" className="text-[15px] py-2.5">현장 근로자 (비사무직) (반기 12시간)</SelectItem>
                                            <SelectItem value="사무직 / 판매직" className="text-[15px] py-2.5">사무직 / 판매직 (반기 6시간)</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            </>
                        )}

                        {stepKey === "phone" && (
                            <>
                                <div className="space-y-2.5">
                                    <Label htmlFor="phone" className="text-[15px] font-semibold text-cur-ink">휴대폰 번호</Label>
                                    <div className="flex gap-2">
                                        <Input id="phone" type="tel" inputMode="numeric" placeholder="01012345678" value={phone}
                                            onChange={(e) => setPhone(e.target.value)} disabled={!!verificationId} className={cn(inputCls, "flex-1")} />
                                        <Button type="button" variant="outline" onClick={handleSendCode}
                                            disabled={sending || cooldown > 0 || !!verificationId}
                                            className="h-14 px-4 border-cur-hairline-strong text-cur-ink rounded-[8px] font-semibold whitespace-nowrap">
                                            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : cooldown > 0 ? `재발송 ${cooldown}s` : codeSent ? "재발송" : "인증번호 받기"}
                                        </Button>
                                    </div>
                                </div>
                                {codeSent && !verificationId && (
                                    <div className="space-y-2.5 animate-in slide-in-from-top-2">
                                        <Label htmlFor="code" className="text-[15px] font-semibold text-cur-ink">인증번호</Label>
                                        <div className="flex gap-2">
                                            <Input id="code" type="text" inputMode="numeric" maxLength={6} placeholder="6자리 입력" value={code}
                                                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className={cn(inputCls, "flex-1 tracking-[0.3em] font-bold")} />
                                            <Button type="button" onClick={handleVerifyCode} disabled={verifying || code.length !== 6}
                                                className="h-14 px-5 bg-cur-ink hover:bg-cur-ink/80 text-white rounded-[8px] font-semibold">
                                                {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : "확인"}
                                            </Button>
                                        </div>
                                        <p className="text-[12px] text-cur-muted-soft">문자가 오지 않으면 60초 후 재발송할 수 있어요. (유효시간 5분)</p>
                                    </div>
                                )}
                                {verificationId && (
                                    <div className="flex items-center gap-2 p-4 text-[14px] font-semibold text-cur-success bg-cur-success/5 rounded-[8px] border border-cur-success/20 animate-in fade-in">
                                        <CheckCircle2 className="w-5 h-5 shrink-0" /> 인증이 완료되었습니다.
                                    </div>
                                )}
                            </>
                        )}

                        {stepKey === "confirm" && (
                            <div className="rounded-[12px] border border-cur-hairline bg-cur-canvas-soft divide-y divide-cur-hairline">
                                {[
                                    ["아이디", id],
                                    ["현장명", siteName],
                                    ["업종", industry],
                                    ...(industry === "건설업" ? [["공종", workCategory]] : []),
                                    ["근로자 구분", workerType],
                                    ...(phoneEnabled ? [["휴대폰", phone.replace(/\D/g, "").replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3")]] : []),
                                ].map(([k, v]) => (
                                    <div key={k} className="flex justify-between items-center px-4 py-3.5">
                                        <span className="text-[14px] text-cur-muted">{k}</span>
                                        <span className="text-[15px] font-semibold text-cur-ink">{v}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {stepKey === "confirm" && phoneEnabled && (
                            <p className="text-[13px] text-cur-muted bg-cur-primary/5 border border-cur-primary/20 rounded-[8px] p-3.5 leading-5">
                                가입과 동시에 <b className="text-cur-primary">Pro 1개월 무료체험</b>이 시작됩니다. 체험이 끝나면 결제수단 등록 후 베이직/Pro 중 선택해 이어서 이용할 수 있어요.
                            </p>
                        )}

                        {error && (
                            <div className="flex items-center gap-2 p-4 text-[14px] font-semibold text-cur-error bg-cur-error/5 rounded-[8px] border border-cur-error/20">
                                <AlertCircle className="w-5 h-5 shrink-0" />
                                {error}
                            </div>
                        )}

                        <div className="flex gap-2 mt-2">
                            {stepIdx > 0 && (
                                <Button type="button" variant="outline" onClick={goBack} disabled={loading} className="h-14 px-4 border-cur-hairline text-cur-ink rounded-[8px] font-medium">
                                    <ChevronLeft className="w-5 h-5" /> 이전
                                </Button>
                            )}
                            {stepKey !== "confirm" ? (
                                <Button type="button" onClick={goNext} disabled={checkingId} className="flex-1 h-14 text-[16px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-[8px] font-medium transition-transform active:scale-[0.98]">
                                    {checkingId ? <Loader2 className="h-5 w-5 animate-spin" /> : "다음"}
                                </Button>
                            ) : (
                                <Button type="button" onClick={handleSignup} disabled={loading} className="flex-1 h-14 text-[16px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-[8px] font-medium transition-transform active:scale-[0.98]">
                                    {loading ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : phoneEnabled ? "가입하고 무료체험 시작" : "회원가입 하기"}
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
