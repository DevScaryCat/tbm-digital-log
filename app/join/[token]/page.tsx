"use client"

// 초대 링크 가입 — 조직(안전관리자) 하위 관리감독자(현장) 계정 생성.
// 개인 결제·무료체험 없음: 좌석은 조직이 결제. 휴대폰 인증(켜져 있으면) + 실이메일 인증.
import { useEffect, useState, use as usePromise } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, CheckCircle2, Building2 } from "lucide-react"
import { Logo } from "@/components/Logo"

const inputCls =
    "h-12 rounded-[8px] bg-cur-elevated border-cur-hairline text-[16px] md:text-[16px] font-medium text-cur-ink placeholder:text-cur-muted-soft focus-visible:ring-1 focus-visible:ring-cur-primary"

export default function JoinOrgPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = usePromise(params)
    const router = useRouter()

    const [info, setInfo] = useState<{ valid: boolean; orgName?: string; seatsLeft?: number; error?: string } | null>(null)
    const [phoneEnabled, setPhoneEnabled] = useState<boolean | null>(null)
    const [hasSession, setHasSession] = useState<boolean | null>(null)

    const [loginId, setLoginId] = useState("")
    const [idChecked, setIdChecked] = useState<null | boolean>(null)
    const [checkingId, setCheckingId] = useState(false)
    const [password, setPassword] = useState("")
    const [siteName, setSiteName] = useState("")
    const [managerName, setManagerName] = useState("")
    const [realEmail, setRealEmail] = useState("")

    // 휴대폰 인증 (솔라피 게이트 켜져 있을 때만)
    const [phone, setPhone] = useState("")
    const [code, setCode] = useState("")
    const [codeSent, setCodeSent] = useState(false)
    const [sending, setSending] = useState(false)
    const [verificationId, setVerificationId] = useState<string | null>(null)

    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        fetch(`/api/org/join?token=${encodeURIComponent(token)}`)
            .then((r) => r.json())
            .then(setInfo)
            .catch(() => setInfo({ valid: false, error: "초대 정보를 불러오지 못했습니다." }))
        fetch("/api/auth/phone/status")
            .then((r) => r.json())
            .then((j) => setPhoneEnabled(j.enabled === true))
            .catch(() => setPhoneEnabled(false))
        // 카카오 등 기존 세션이 있으면 안내 (초대 가입은 새 계정 생성 경로)
        supabase.auth.getSession().then(({ data }) => setHasSession(!!data.session))
    }, [token])

    const checkId = async () => {
        const id = loginId.trim().toLowerCase()
        if (!/^[a-z0-9_]{3,20}$/.test(id)) { setError("아이디는 영문 소문자·숫자·밑줄 3~20자입니다."); return }
        setCheckingId(true)
        setError(null)
        try {
            const res = await fetch("/api/auth/check-id", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id }),
            })
            const j = await res.json()
            setIdChecked(res.ok && j.available === true)
            if (!(res.ok && j.available === true)) setError("이미 사용 중인 아이디입니다. 기존 계정이라면 안전관리자에게 '기존 계정 편입'을 요청하세요.")
        } finally {
            setCheckingId(false)
        }
    }

    const sendCode = async () => {
        const digits = phone.replace(/\D/g, "")
        if (!/^01\d{8,9}$/.test(digits)) { setError("휴대폰 번호를 확인해주세요."); return }
        setSending(true)
        setError(null)
        try {
            const res = await fetch("/api/auth/phone/send", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: digits }),
            })
            const j = await res.json()
            if (!res.ok) { setError(j.error || "인증번호 발송에 실패했습니다."); return }
            setCodeSent(true)
        } finally {
            setSending(false)
        }
    }

    const verifyCode = async () => {
        if (!/^\d{6}$/.test(code.trim())) { setError("인증번호 6자리를 입력해주세요."); return }
        setError(null)
        const res = await fetch("/api/auth/phone/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone: phone.replace(/\D/g, ""), code: code.trim() }),
        })
        const j = await res.json()
        if (!res.ok) { setError(j.error || "인증에 실패했습니다."); return }
        setVerificationId(j.verificationId)
    }

    const submit = async () => {
        setError(null)
        if (idChecked !== true) { setError("아이디 중복확인을 해주세요."); return }
        if (password.length < 8) { setError("비밀번호는 8자 이상 입력해주세요."); return }
        if (!siteName.trim()) { setError("현장명을 입력해주세요."); return }
        if (!realEmail.trim()) { setError("보고서를 받을 이메일을 입력해주세요."); return }
        if (phoneEnabled && !verificationId) { setError("휴대폰 인증을 완료해주세요."); return }
        setLoading(true)
        try {
            const res = await fetch("/api/signup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    id: loginId.trim().toLowerCase(),
                    password,
                    siteName: siteName.trim(),
                    managerName: managerName.trim(),
                    realEmail: realEmail.trim(),
                    inviteToken: token,
                    ...(phoneEnabled ? { phone: phone.replace(/\D/g, ""), verificationId } : {}),
                }),
            })
            const j = await res.json()
            if (!res.ok) { setError(j.error || "가입에 실패했습니다."); return }
            // 기존 세션(카카오 등)이 남아 있으면 정리 후 새 계정으로 로그인
            await supabase.auth.signOut()
            const { error: loginErr } = await supabase.auth.signInWithPassword({
                email: `${loginId.trim().toLowerCase()}@tbm.com`,
                password,
            })
            if (loginErr) { router.replace("/login"); return }
            router.replace("/tutorial")
        } finally {
            setLoading(false)
        }
    }

    if (!info || phoneEnabled === null) {
        return (
            <div className="min-h-screen bg-cur-canvas flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-cur-muted" />
            </div>
        )
    }

    if (!info.valid) {
        return (
            <div className="min-h-screen bg-cur-canvas flex items-center justify-center px-6">
                <div className="w-full max-w-sm bg-cur-card border border-cur-hairline rounded-2xl p-8 text-center space-y-3">
                    <div className="text-[36px]">⚠️</div>
                    <h1 className="text-[17px] font-bold text-cur-ink">초대 링크가 유효하지 않아요</h1>
                    <p className="text-[13px] text-cur-muted leading-relaxed">{info.error || "만료되었거나 잘못된 링크입니다. 안전관리자에게 재발급을 요청하세요."}</p>
                </div>
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-cur-canvas font-sans">
            <div className="max-w-md mx-auto px-5 py-8 space-y-5">
                <div className="flex flex-col items-center gap-3 pt-2">
                    <Logo size="md" />
                    <div className="flex items-center gap-2 bg-cur-primary/[0.08] border border-cur-primary/25 rounded-xl px-4 py-3 w-full">
                        <Building2 className="w-5 h-5 text-cur-primary shrink-0" />
                        <p className="text-[14px] text-cur-ink leading-snug">
                            <b>{info.orgName}</b>의 관리감독자(현장 담당)로 가입합니다
                        </p>
                    </div>
                    {hasSession && (
                        <p className="text-[12px] text-cur-muted bg-cur-elevated rounded-lg px-3 py-2 w-full text-center">
                            현재 다른 계정으로 로그인돼 있어요. 가입을 완료하면 새 계정으로 전환됩니다.
                        </p>
                    )}
                </div>

                {error && <div className="text-[13px] rounded-lg p-3 bg-cur-error/10 text-cur-error">{error}</div>}

                <div className="bg-cur-card rounded-2xl border border-cur-hairline p-5 space-y-4">
                    <div className="space-y-1.5">
                        <Label className="text-[14px] font-semibold text-cur-ink">아이디</Label>
                        <div className="flex gap-2">
                            <Input value={loginId} onChange={(e) => { setLoginId(e.target.value); setIdChecked(null) }} placeholder="영문 소문자·숫자 3~20자" className={inputCls + " flex-1"} />
                            <Button onClick={checkId} disabled={checkingId || !loginId.trim()} className="h-12 px-4 rounded-[8px] bg-cur-ink text-white font-bold shrink-0">
                                {checkingId ? <Loader2 className="w-4 h-4 animate-spin" /> : idChecked === true ? <CheckCircle2 className="w-4 h-4" /> : "중복확인"}
                            </Button>
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-[14px] font-semibold text-cur-ink">비밀번호</Label>
                        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="8자 이상" className={inputCls} />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-[14px] font-semibold text-cur-ink">현장명</Label>
                        <Input value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="예: OO물류센터 신축현장" className={inputCls} />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-[14px] font-semibold text-cur-ink">담당자 이름</Label>
                        <Input value={managerName} onChange={(e) => setManagerName(e.target.value)} placeholder="현장 담당자 성함 (나중에 변경 가능)" className={inputCls} />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-[14px] font-semibold text-cur-ink">이메일</Label>
                        <Input type="email" value={realEmail} onChange={(e) => setRealEmail(e.target.value)} placeholder="매달 1일 월간 보고서를 받을 주소" className={inputCls} />
                        <p className="text-[12px] text-cur-muted-soft">가입 후 인증 메일이 발송돼요. 인증하면 매달 우리 현장 보고서가 이 주소로 옵니다.</p>
                    </div>

                    {phoneEnabled && (
                        <div className="space-y-2 pt-1 border-t border-cur-hairline">
                            <Label className="text-[14px] font-semibold text-cur-ink pt-2 block">휴대폰 인증</Label>
                            <div className="flex gap-2">
                                <Input type="tel" inputMode="numeric" placeholder="01012345678" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={!!verificationId} className={inputCls + " flex-1"} />
                                <Button onClick={sendCode} disabled={sending || !!verificationId} className="h-12 px-3 rounded-[8px] bg-cur-ink text-white text-[13px] font-bold shrink-0">
                                    {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : codeSent ? "재발송" : "인증번호"}
                                </Button>
                            </div>
                            {codeSent && !verificationId && (
                                <div className="flex gap-2">
                                    <Input inputMode="numeric" placeholder="인증번호 6자리" value={code} onChange={(e) => setCode(e.target.value)} className={inputCls + " flex-1"} />
                                    <Button onClick={verifyCode} className="h-12 px-4 rounded-[8px] bg-cur-primary text-white font-bold shrink-0">확인</Button>
                                </div>
                            )}
                            {verificationId && (
                                <p className="text-[13px] text-cur-primary flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> 인증이 완료되었습니다.</p>
                            )}
                        </div>
                    )}

                    <Button onClick={submit} disabled={loading} className="w-full h-12 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90">
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "가입하고 시작하기"}
                    </Button>
                    <p className="text-[12px] text-cur-muted-soft text-center leading-relaxed">
                        이용 요금은 회사(안전관리자)가 결제해요. 별도 결제·무료체험이 없습니다.
                    </p>
                </div>
            </div>
        </div>
    )
}
