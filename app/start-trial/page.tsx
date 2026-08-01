"use client"

// 무료체험 온보딩 — 구독 행 없이 시작한 계정(카카오 OAuth, 구 무인증 가입) 전용.
// 아이디 가입 위저드가 가입 시점에 주는 것과 동일한 카드 없는 1개월 체험을,
// 동일한 규칙(휴대폰 인증 · 번호당 1회)으로 로그인 후에 받게 한다.
// useRequireSubscription이 "구독 행 없음" 계정을 /pricing 대신 여기로 보낸다.
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { fetchOrgContext } from "@/lib/useOrgContext"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, CheckCircle2 } from "lucide-react"
import { Logo } from "@/components/Logo"
import { InAppBrowserNotice } from "@/components/InAppBrowserNotice"

const inputCls =
    "h-12 rounded-[8px] bg-cur-elevated border-cur-hairline text-[16px] md:text-[16px] font-medium text-cur-ink placeholder:text-cur-muted-soft focus-visible:ring-1 focus-visible:ring-cur-primary"

export default function StartTrialPage() {
    const router = useRouter()
    const [checking, setChecking] = useState(true)
    const [phoneEnabled, setPhoneEnabled] = useState<boolean | null>(null)

    const [companyName, setCompanyName] = useState("")
    const [hadCompany, setHadCompany] = useState(false)

    // 휴대폰 인증 (게이트 켜져 있을 때만) — 초대 가입 페이지와 동일 플로우
    const [phone, setPhone] = useState("")
    const [code, setCode] = useState("")
    const [codeSent, setCodeSent] = useState(false)
    const [sending, setSending] = useState(false)
    const [verificationId, setVerificationId] = useState<string | null>(null)

    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // 번호 소진(409) — 결제 등록 경로를 따로 안내한다
    const [redeemed, setRedeemed] = useState(false)
    // 미러 구독이 누락된 회사 소속 계정 — 홈으로 돌려보내면 게이트가 다시 여기로 보내
    // 무한 리다이렉트가 되므로, 여기서 안내 화면으로 멈춘다
    const [memberBlocked, setMemberBlocked] = useState(false)

    useEffect(() => {
        ;(async () => {
            const { data: { session } } = await supabase.auth.getSession()
            if (!session) { router.replace("/login"); return }
            // 이미 구독이 있으면 여기 올 이유가 없다(만료 계정 포함 — 홈 게이트가 /pricing으로 보낸다)
            const { data: sub } = await supabase
                .from("subscriptions").select("user_id").maybeSingle()
            if (sub) { router.replace("/"); return }
            // 회사 소속 현장 계정은 감독자 구독으로 이용 — 개인 체험 대상 아님
            const ctx = await fetchOrgContext()
            if (ctx?.kind === "member") { setMemberBlocked(true); setChecking(false); return }

            const meta = session.user.user_metadata ?? {}
            const existing = String(meta.company_name ?? "").trim()
            setCompanyName(existing)
            setHadCompany(!!existing)

            try {
                const res = await fetch("/api/auth/phone/status")
                const j = await res.json()
                setPhoneEnabled(j.enabled === true)
            } catch {
                setPhoneEnabled(false)
            }
            setChecking(false)
        })()
    }, [router])

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

    const claim = async () => {
        setError(null)
        if (!companyName.trim()) { setError("현장명(또는 업체명)을 입력해주세요."); return }
        if (phoneEnabled && !verificationId) { setError("휴대폰 인증을 완료해주세요."); return }
        setLoading(true)
        try {
            const { data: { session } } = await supabase.auth.getSession()
            const res = await fetch("/api/auth/claim-trial", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
                body: JSON.stringify({
                    companyName: companyName.trim(),
                    ...(phoneEnabled ? { phone: phone.replace(/\D/g, ""), verificationId } : {}),
                }),
            })
            const j = await res.json().catch(() => ({}))
            if (!res.ok) {
                if (res.status === 409 && String(j.error ?? "").includes("무료체험")) setRedeemed(true)
                setError(j.error || "체험 개시에 실패했습니다.")
                return
            }
            // 세션 스냅샷에 새 메타데이터(현장명 등)가 반영되도록 갱신 후 홈으로
            await supabase.auth.refreshSession().catch(() => null)
            router.replace("/")
        } finally {
            setLoading(false)
        }
    }

    if (checking) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-cur-canvas">
                <Loader2 className="w-10 h-10 text-cur-primary animate-spin" />
            </div>
        )
    }

    if (memberBlocked) {
        return (
            <div className="min-h-screen bg-cur-canvas font-sans text-cur-ink flex items-center justify-center px-5">
                <div className="w-full max-w-sm bg-cur-card rounded-[12px] border border-cur-hairline p-8 text-center space-y-3">
                    <p className="text-[16px] font-bold">회사 소속 계정이에요</p>
                    <p className="text-[13px] text-cur-muted leading-relaxed">
                        이 계정은 회사 감독자의 구독으로 이용해요.
                        <br />이용에 문제가 있다면 회사 감독자에게 문의해주세요.
                    </p>
                    <Button
                        onClick={async () => { await supabase.auth.signOut(); router.replace("/login") }}
                        variant="outline"
                        className="w-full h-11 rounded-[8px] border-cur-hairline bg-cur-elevated text-[13px] font-semibold text-cur-ink hover:border-cur-primary/40"
                    >
                        다른 계정으로 로그인
                    </Button>
                </div>
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-cur-canvas font-sans text-cur-ink">
            <InAppBrowserNotice />
            <div className="max-w-md mx-auto px-5 py-10 space-y-6">
                <div className="flex flex-col items-center gap-4">
                    <Logo size="md" />
                    <div className="text-center space-y-1.5">
                        <h1 className="text-[22px] font-bold tracking-[-0.02em]">첫 달 무료로 시작해요</h1>
                        <p className="text-[13px] text-cur-muted leading-relaxed">
                            휴대폰 인증만 하면 한 달간 모든 기능을 무료로 쓸 수 있어요.
                            <br />결제수단을 등록하기 전에는 요금이 청구되지 않습니다.
                        </p>
                    </div>
                </div>

                {error && (
                    <div className="text-[13px] rounded-[8px] px-3 py-2 bg-cur-error/5 border border-cur-error/20 text-cur-error">{error}</div>
                )}

                <div className="bg-cur-card rounded-[12px] border border-cur-hairline p-5 space-y-4">
                    <div className="space-y-1.5">
                        <Label className="text-[14px] font-semibold text-cur-ink">현장명 (또는 업체명)</Label>
                        <Input
                            value={companyName}
                            onChange={(e) => setCompanyName(e.target.value)}
                            placeholder="예: OO물류센터 신축현장"
                            className={inputCls}
                        />
                        {!hadCompany && (
                            <p className="text-[12px] text-cur-muted-soft">문서와 보고서에 표시되는 이름이에요. 나중에 내 정보에서 바꿀 수 있어요.</p>
                        )}
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

                    <Button
                        onClick={claim}
                        disabled={loading}
                        className="w-full h-12 rounded-[8px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[15px] font-bold"
                    >
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "무료체험 시작하기"}
                    </Button>

                    {redeemed && (
                        <Button
                            onClick={() => router.push("/pricing")}
                            variant="outline"
                            className="w-full h-10 rounded-[8px] border-cur-hairline bg-cur-elevated text-[13px] font-semibold text-cur-ink hover:border-cur-primary/40"
                        >
                            결제수단 등록하고 이용하기
                        </Button>
                    )}

                    <p className="text-[12px] text-cur-muted-soft text-center leading-relaxed">
                        체험 종료 후에도 결제수단을 등록하기 전에는 자동으로 결제되지 않아요.
                        <br />월 3,900원 · 언제든 해지 가능
                    </p>
                </div>
            </div>
        </div>
    )
}
