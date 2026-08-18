// app/signup/page.tsx — 가입 위저드
// ① 계정 ② 현장 정보(업종·공종 — 데이터 분석용) ③ 휴대폰 인증(솔라피 OTP, 켜져 있을 때만) ④ 확인·가입
// 휴대폰 인증이 켜져 있으면(서버 env) 가입 즉시 카드 없이 7일 무료체험이 시작된다.
// 꺼져 있으면 기존 흐름(가입 → 카드 등록 시 체험) 그대로 3단계로 동작한다.
"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AlertCircle, Loader2, CheckCircle, CheckCircle2, ChevronLeft } from "lucide-react"
import { cn } from "@/lib/utils"
import { supabase } from "@/lib/supabaseClient"
import Link from "next/link"
import { KSIC_MAJORS, findKsicMajor, isSingleSameMinor } from "@/lib/ksic"
import { Logo } from "@/components/Logo"
import { Checkbox } from "@/components/ui/checkbox"

type StepKey = "account" | "site" | "phone" | "confirm"
const STEP_LABEL: Record<StepKey, string> = { account: "계정", site: "현장 정보", phone: "휴대폰 인증", confirm: "확인" }

export default function SignupPage() {
    const router = useRouter()
    // 사용 형태 선택(가입 첫 단계). 두 선택지 모두 같은 계정을 만들고, 가입 후 열리는
    // 탭만 달라진다 — 회사를 만드는 시점은 "첫 현장 계정을 발급할 때"다.
    // 신규 가입에만 해당하므로 /start(로그인 진입)가 아니라 여기서 묻는다.
    const [roleChosen, setRoleChosen] = useState(false)
    // 약관·개인정보처리방침 동의 — 가입 시점에 매번 받는다. 브라우저에 남은 이전 동의를
    // 재사용하면 공용 PC의 다음 사람이 약관을 보지도 않고 동의한 것으로 기록된다.
    const [agreed, setAgreed] = useState(false)
    // 휴대폰 인증 게이트 활성화 여부(서버 env 기준) — 로딩 전엔 null
    const [phoneEnabled, setPhoneEnabled] = useState<boolean | null>(null)
    const [stepIdx, setStepIdx] = useState(0)
    const [id, setId] = useState("")
    const [password, setPassword] = useState("")
    const [passwordConfirm, setPasswordConfirm] = useState("")
    const [siteName, setSiteName] = useState("")
    const [industry, setIndustry] = useState("")
    const [workCategory, setWorkCategory] = useState("")
    // 근로자 구분은 여기서 받지 않는다 — 첫 로그인 온보딩 모달이 받는다(서버 기본값 비사무직)
    // 출력 형식·이메일은 가입에서 받지 않는다(Chris) — 첫 로그인 온보딩 모달(OnboardingModal)이 받는다.
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
        // 로그인한 채로 가입을 끝내면 signInWithPassword가 기존 세션을 새 계정으로 갈아치워
        // 결제·체험이 걸린 원래 계정이 사라진 것처럼 보인다 (/start·/login과 동일한 가드)
        supabase.auth.getSession().then(({ data }) => { if (data.session) router.replace("/") })
        fetch("/api/auth/phone/status")
            .then((r) => r.json())
            .then((j) => setPhoneEnabled(!!j.enabled))
            .catch(() => setPhoneEnabled(false))
        return () => { if (cooldownTimer.current) clearInterval(cooldownTimer.current) }
    }, [router])

    const stepKeys: StepKey[] = phoneEnabled
        ? ["account", "site", "phone", "confirm"]
        : ["account", "site", "confirm"]
    const stepKey = stepKeys[stepIdx]

    // 단계별 필수 입력이 모두 채워졌는지 — 비어 있으면 "다음" 비활성화 (형식 검증은 클릭 시 메시지로)
    const stepFilled =
        stepKey === "account" ? !!(id.trim() && password && passwordConfirm)
        : stepKey === "site" ? !!(siteName.trim() && industry && workCategory)
        : stepKey === "phone" ? !!verificationId
        : true

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
            if (!industry) return "업종(대분류)를 선택해주세요."
            if (!workCategory) return "업종(중분류)를 선택해주세요."
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
                    workCategory,
                    // 동의 증빙은 서버가 남긴다 — 브라우저 localStorage는 증거가 되지 못한다
                    agreedToTerms: agreed,
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
                setTimeout(() => { router.push("/") }, 1800) // 홈 온보딩 모달이 이어받는다
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
                <Card className="w-full max-w-md border border-cur-hairline bg-cur-card text-center py-10 rounded-[12px]">
                    <CardContent className="space-y-4 flex flex-col items-center">
                        <CheckCircle className="w-16 h-16 text-cur-success mb-2" />
                        <h2 className="text-[24px] font-normal text-cur-ink tracking-[-0.72px]">회원가입 완료!</h2>
                        {trialStarted ? (
                            <p className="text-[15px] text-cur-muted font-medium">
                                <b className="text-cur-primary">7일 무료체험</b>이 시작되었습니다. 🎉<br />
                                모든 기능을 자유롭게 써보세요.<br />
                                {autoLoggedIn ? "잠시 후 홈으로 이동합니다." : "잠시 후 로그인 페이지로 이동합니다."}
                            </p>
                        ) : (
                            <p className="text-[15px] text-cur-muted font-medium">
                                성공적으로 계정이 생성되었습니다.<br />
                                {autoLoggedIn ? "잠시 후 1분 사용법 안내로 이동합니다." : "잠시 후 로그인 페이지로 이동합니다."}
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

    // 조용한 필드: 면(elevated)으로 구분, 포커스에서만 카드색+링 — 로그인·작성 화면과 동일 문법
    const inputCls = "h-12 px-4 text-[16px] md:text-[16px] bg-cur-elevated border-0 shadow-none rounded-[10px] text-cur-ink placeholder:text-cur-muted-soft focus:bg-cur-card focus-visible:ring-1 focus-visible:ring-cur-primary focus-visible:border-0"
    const selectCls = "h-12 px-4 text-[16px] bg-cur-elevated border-0 shadow-none rounded-[10px] text-cur-ink focus:ring-1 focus:ring-cur-primary"

    if (phoneEnabled === null) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-cur-canvas">
                <Loader2 className="w-8 h-8 text-cur-muted animate-spin" />
            </div>
        )
    }

    // 가입 첫 단계: 약관 동의만. 사용 형태(혼자/여러 현장)는 여기서 묻지 않는다 —
    // 가입 직후 첫 온보딩에서 물어야 계정 만들기 전에 이탈할 결정을 강요하지 않는다.
    if (!roleChosen) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-cur-canvas p-4 font-sans text-cur-ink">
                <Card className="w-full max-w-md border border-cur-hairline bg-cur-card rounded-[12px]">
                    <CardHeader className="space-y-3 text-center pb-2 pt-9">
                        <div className="mx-auto"><Logo size="md" /></div>
                        <CardTitle className="text-[22px] font-bold text-cur-ink tracking-[-0.02em] pt-1">회원가입</CardTitle>
                        <CardDescription className="text-[15px] text-cur-muted font-medium">
                            1분이면 끝나요
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3 pb-10 pt-4">
                        {/* 약관 동의 — 가입 시점 필수 */}
                        <div className="flex items-start gap-3 bg-cur-elevated rounded-[10px] p-3.5 text-left">
                            <Checkbox
                                id="signup-agree"
                                checked={agreed}
                                onCheckedChange={(c) => setAgreed(c === true)}
                                className="mt-0.5 border-cur-muted data-[state=checked]:bg-cur-primary data-[state=checked]:text-cur-on-primary rounded-[4px]"
                            />
                            <label htmlFor="signup-agree" className="text-[13px] text-cur-body leading-[1.5] cursor-pointer">
                                <a href="/privacy" target="_blank" rel="noopener noreferrer" className="text-cur-primary font-medium hover:underline">개인정보처리방침</a> 및{" "}
                                <a href="/terms" target="_blank" rel="noopener noreferrer" className="text-cur-primary font-medium hover:underline">서비스 이용약관</a>에 동의합니다.
                            </label>
                        </div>

                        <Button
                            onClick={() => setRoleChosen(true)}
                            disabled={!agreed}
                            className="w-full h-12 rounded-[8px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[15px] font-bold disabled:opacity-40"
                        >
                            가입 시작하기
                        </Button>
                        <p className="text-[12px] text-cur-muted-soft text-center leading-relaxed pt-1">
                            회사에서 초대 링크를 받았다면 그 링크로 가입하세요.
                        </p>
                        <p className="text-center text-[14px] text-cur-muted pt-2">
                            이미 계정이 있으신가요?
                            <Link href="/login" className="font-semibold text-cur-primary hover:underline ml-1">로그인</Link>
                        </p>
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-cur-canvas p-4 font-sans text-cur-ink">
            <Card className="w-full max-w-md border border-cur-hairline bg-cur-card rounded-[12px]">
                <CardHeader className="space-y-3 text-center pb-4 pt-9">
                    <div className="mx-auto"><Logo size="md" /></div>
                    <CardTitle className="text-[22px] font-bold text-cur-ink tracking-[-0.02em] pt-1">현장 계정 만들기</CardTitle>
                    <CardDescription className="text-[13px] text-cur-muted font-medium">
                        {stepKey === "account" && "로그인에 사용할 계정을 만들어주세요"}
                        {stepKey === "site" && "현장 정보를 알려주세요 — 맞춤 통계에 활용돼요"}
                        {stepKey === "phone" && "본인 확인 후 7일 무료체험이 시작됩니다"}
                        {stepKey === "confirm" && "입력하신 내용을 확인해주세요"}
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
                                    <Label htmlFor="id" className="text-[13px] font-medium text-cur-body">사용할 아이디</Label>
                                    <Input id="id" type="text" placeholder="예: site01 (영문 소문자/숫자)" value={id} onChange={(e) => setId(e.target.value)} minLength={3} className={inputCls} autoComplete="off" />
                                </div>
                                <div className="space-y-2.5">
                                    <Label htmlFor="password" className="text-[13px] font-medium text-cur-body">비밀번호</Label>
                                    <Input id="password" type="password" placeholder="8자 이상 입력" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} className={inputCls} />
                                </div>
                                <div className="space-y-2.5">
                                    <Label htmlFor="passwordConfirm" className="text-[13px] font-medium text-cur-body">비밀번호 확인</Label>
                                    <Input id="passwordConfirm" type="password" placeholder="비밀번호 다시 입력" value={passwordConfirm} onChange={(e) => setPasswordConfirm(e.target.value)} minLength={8} className={inputCls} />
                                </div>
                            </>
                        )}

                        {stepKey === "site" && (
                            <>
                                <div className="space-y-2.5">
                                    <Label htmlFor="siteName" className="text-[13px] font-medium text-cur-body">현장명 (회사명)</Label>
                                    <Input id="siteName" type="text" placeholder="소속 현장명 (또는 업체명)" value={siteName} onChange={(e) => setSiteName(e.target.value)} className={inputCls} />
                                </div>
                                <div className="space-y-2.5">
                                    <Label className="text-[13px] font-medium text-cur-body">업종(대분류)</Label>
                                    <Select value={industry} onValueChange={(v) => {
                                        setIndustry(v)
                                        // 중분류가 하나뿐인 업종(전기·가스, 부동산 등)은 공종을 자동 선택
                                        const minors = findKsicMajor(v)?.minors ?? []
                                        setWorkCategory(minors.length === 1 ? minors[0].name : "")
                                    }}>
                                        <SelectTrigger className={selectCls}>
                                            <SelectValue placeholder="업종(대분류)를 선택해주세요" />
                                        </SelectTrigger>
                                        <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                                            {KSIC_MAJORS.map((m) => <SelectItem key={m.code} value={m.name} className="text-[15px] py-2.5">{m.name}</SelectItem>)}
                                        </SelectContent>
                                    </Select>
                                </div>
                                {/* 중분류가 대분류와 같은 단일 항목(전기·가스, 기타)이면 이미 자동 선택됨 — 같은 이름을 두 번 고르게 하지 않는다 */}
                                {industry && !isSingleSameMinor(industry) && (
                                    <div className="space-y-2.5 animate-in slide-in-from-top-2">
                                        <Label className="text-[13px] font-medium text-cur-body">업종(중분류)</Label>
                                        <Select value={workCategory} onValueChange={setWorkCategory}>
                                            <SelectTrigger className={selectCls}>
                                                <SelectValue placeholder="업종(중분류)를 선택해주세요" />
                                            </SelectTrigger>
                                            <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                                                {(findKsicMajor(industry)?.minors ?? []).map((mi) => <SelectItem key={mi.code} value={mi.name} className="text-[15px] py-2.5">{mi.name}</SelectItem>)}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                )}
                            </>
                        )}

                        {stepKey === "phone" && (
                            <>
                                <div className="space-y-2.5">
                                    <Label htmlFor="phone" className="text-[13px] font-medium text-cur-body">휴대폰 번호</Label>
                                    <div className="flex gap-2">
                                        <Input id="phone" type="tel" inputMode="numeric" placeholder="01012345678" value={phone}
                                            onChange={(e) => setPhone(e.target.value)} disabled={!!verificationId} className={cn(inputCls, "flex-1")} />
                                        <Button type="button" variant="outline" onClick={handleSendCode}
                                            disabled={sending || cooldown > 0 || !!verificationId}
                                            className="h-12 px-4 border-cur-hairline-strong text-cur-ink rounded-[10px] font-semibold whitespace-nowrap">
                                            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : cooldown > 0 ? `재발송 ${cooldown}s` : codeSent ? "재발송" : "인증번호 받기"}
                                        </Button>
                                    </div>
                                </div>
                                {codeSent && !verificationId && (
                                    <div className="space-y-2.5 animate-in slide-in-from-top-2">
                                        <Label htmlFor="code" className="text-[13px] font-medium text-cur-body">인증번호</Label>
                                        <div className="flex gap-2">
                                            <Input id="code" type="text" inputMode="numeric" maxLength={6} placeholder="6자리 입력" value={code}
                                                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className={cn(inputCls, "flex-1 tracking-[0.3em] font-bold")} />
                                            <Button type="button" onClick={handleVerifyCode} disabled={verifying || code.length !== 6}
                                                className="h-12 px-5 bg-cur-ink hover:bg-cur-ink/80 text-white rounded-[10px] font-semibold">
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
                                    // 업종=공종 동일 문자열이면 한 줄로 — 같은 값이 두 줄 반복되면 오타처럼 읽힌다
                                    ...(isSingleSameMinor(industry)
                                        ? [["업종(대분류·중분류)", industry]]
                                        : [["업종(대분류)", industry], ["업종(중분류)", workCategory]]),
                                    ...(phoneEnabled ? [["휴대폰", phone.replace(/\D/g, "").replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3")]] : []),
                                ].map(([k, v]) => (
                                    <div key={k} className="flex justify-between items-center px-4 py-3.5">
                                        <span className="text-[14px] text-cur-muted">{k}</span>
                                        <span className="text-[13px] font-medium text-cur-body">{v}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {stepKey === "confirm" && phoneEnabled && (
                            <p className="text-[13px] text-cur-muted bg-cur-primary/5 border border-cur-primary/20 rounded-[8px] p-3.5 leading-5">
                                가입과 동시에 <b className="text-cur-primary">7일 무료체험</b>이 시작됩니다. 체험이 끝나면 결제수단을 등록해 월 3,900원으로 이어서 이용할 수 있어요.
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
                                <Button type="button" variant="outline" onClick={goBack} disabled={loading} className="h-12 px-4 border-cur-hairline text-cur-ink rounded-[8px] font-medium">
                                    <ChevronLeft className="w-5 h-5" /> 이전
                                </Button>
                            )}
                            {stepKey !== "confirm" ? (
                                <Button type="button" onClick={goNext} disabled={checkingId || !stepFilled} className="flex-1 h-12 text-[15px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-[8px] font-bold transition-transform active:scale-[0.99] disabled:opacity-40">
                                    {checkingId ? <Loader2 className="h-5 w-5 animate-spin" /> : "다음"}
                                </Button>
                            ) : (
                                <Button type="button" onClick={handleSignup} disabled={loading} className="flex-1 h-12 text-[15px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-[8px] font-bold transition-transform active:scale-[0.99]">
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
