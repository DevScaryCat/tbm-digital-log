"use client"

// 안전관리자 가입 위저드 — ① 계정 ② 회사·좌석 ③ 결제 (체험 없음, 좌석 × 4,900 즉시 청구)
// 결제 이탈 후 재방문(로그인 상태 + 조직 없음)이면 ②부터 재개한다.
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, CheckCircle2, Minus, Plus, Building2 } from "lucide-react"
import { Logo } from "@/components/Logo"
import { OrgCheckoutButtons } from "@/components/OrgCheckoutButtons"
import { BillingRedirectHandler } from "@/components/BillingRedirectHandler"
import { fetchSubscription, isAllowed } from "@/lib/useSubscription"

const SEAT_PRICE = 4900
const inputCls =
    "h-12 rounded-[8px] bg-cur-elevated border-cur-hairline text-[16px] md:text-[16px] font-medium text-cur-ink placeholder:text-cur-muted-soft focus-visible:ring-1 focus-visible:ring-cur-primary"

type Step = 1 | 2 | 3

export default function ManagerSignupPage() {
    const router = useRouter()
    const [step, setStep] = useState<Step>(1)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // ① 계정
    const [loginId, setLoginId] = useState("")
    const [password, setPassword] = useState("")
    const [password2, setPassword2] = useState("")
    const [idChecked, setIdChecked] = useState<null | boolean>(null)
    const [checkingId, setCheckingId] = useState(false)
    const [existingSession, setExistingSession] = useState(false)

    // ② 회사·좌석
    const [orgName, setOrgName] = useState("")
    const [seats, setSeats] = useState(3)

    // 재개: 로그인 상태면 계정 단계 생략.
    // - owner + 구독 유효 → 홈 / owner + 구독 무효(해지·만료) → 재결제 단계(③)로 재개
    //   (org 재활성 UI가 여기뿐이라 이 경로가 없으면 만료된 안전관리자는 영구 막다른 길 — 리뷰 F)
    // - member → 홈 / 조직 없음 → 회사 정보(②)부터
    useEffect(() => {
        ;(async () => {
            const { data: { session } } = await supabase.auth.getSession()
            if (!session) return
            const res = await fetch("/api/org/context", { headers: { Authorization: `Bearer ${session.access_token}` } })
            if (res.ok) {
                const ctx = await res.json()
                if (ctx.kind === "member") { router.replace("/"); return }
                if (ctx.kind === "owner") {
                    const sub = await fetchSubscription()
                    if (isAllowed(sub)) { router.replace("/"); return }
                    // 해지·만료된 회사 플랜 → 회사명·좌석 프리필 후 재결제 단계
                    setExistingSession(true)
                    if (ctx.org?.name) setOrgName(ctx.org.name)
                    if (ctx.org?.seatCount) setSeats(ctx.org.seatCount)
                    setStep(3)
                    return
                }
            }
            // 로그인은 돼 있는데 조직이 없음 → 계정 단계 생략하고 회사 정보부터
            setExistingSession(true)
            setStep(2)
        })()
    }, [router])

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
            if (!(res.ok && j.available === true)) setError("이미 사용 중인 아이디입니다.")
        } finally {
            setCheckingId(false)
        }
    }

    const goStep2 = () => {
        setError(null)
        if (idChecked !== true) { setError("아이디 중복확인을 해주세요."); return }
        if (password.length < 8) { setError("비밀번호는 8자 이상 입력해주세요."); return }
        if (password !== password2) { setError("비밀번호가 서로 다릅니다."); return }
        setStep(2)
    }

    const goStep3 = async () => {
        setError(null)
        if (!orgName.trim()) { setError("회사명을 입력해주세요."); return }
        if (existingSession) { setStep(3); return }
        // 계정 생성 → 자동 로그인 → 결제 단계 (결제는 로그인된 user id로 빌링키를 발급해야 함)
        setLoading(true)
        try {
            const res = await fetch("/api/signup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mode: "manager", id: loginId.trim().toLowerCase(), password, siteName: orgName.trim() }),
            })
            const j = await res.json()
            if (!res.ok) { setError(j.error || "가입에 실패했습니다."); return }
            const { error: loginErr } = await supabase.auth.signInWithPassword({
                email: `${loginId.trim().toLowerCase()}@tbm.com`,
                password,
            })
            if (loginErr) { setError("계정은 만들어졌지만 로그인에 실패했습니다. 로그인 후 다시 방문해주세요."); return }
            setExistingSession(true)
            setStep(3)
        } finally {
            setLoading(false)
        }
    }

    const total = seats * SEAT_PRICE

    return (
        <div className="min-h-screen bg-cur-canvas font-sans">
            <div className="max-w-md mx-auto px-5 py-8 space-y-6">
                <div className="flex flex-col items-center gap-3 pt-2">
                    <Logo size="md" />
                    <div className="text-center">
                        <h1 className="text-[20px] font-bold text-cur-ink">안전관리자로 시작하기</h1>
                        <p className="text-[13px] text-cur-muted mt-1">
                            여러 현장의 TBM을 한눈에 관제하고, 보고서를 한 곳에서 관리합니다
                        </p>
                    </div>
                </div>

                {/* 단계 표시 */}
                <div className="flex items-center gap-1.5 justify-center">
                    {["계정", "회사·좌석", "결제"].map((l, i) => {
                        const n = (i + 1) as Step
                        const active = step === n
                        const done = step > n
                        return (
                            <div key={l} className="flex items-center gap-1.5">
                                <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[12px] font-semibold ${active ? "bg-cur-primary text-white" : done ? "bg-cur-primary/15 text-cur-primary" : "bg-cur-elevated text-cur-muted"}`}>
                                    <span className={`w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] ${active ? "bg-white/25" : done ? "bg-cur-primary/20" : "bg-cur-hairline"}`}>{n}</span>
                                    {l}
                                </div>
                                {i < 2 && <span className="text-cur-muted-soft text-[12px]">›</span>}
                            </div>
                        )
                    })}
                </div>

                <BillingRedirectHandler />

                {error && <div className="text-[13px] rounded-lg p-3 bg-cur-error/10 text-cur-error">{error}</div>}

                {/* ① 계정 */}
                {step === 1 && (
                    <div className="bg-cur-card rounded-2xl border border-cur-hairline p-5 space-y-4">
                        <div className="space-y-1.5">
                            <Label className="text-[14px] font-semibold text-cur-ink">아이디</Label>
                            <div className="flex gap-2">
                                <Input value={loginId} onChange={(e) => { setLoginId(e.target.value); setIdChecked(null) }} placeholder="영문 소문자·숫자 3~20자" className={inputCls + " flex-1"} />
                                <Button onClick={checkId} disabled={checkingId || !loginId.trim()} className="h-12 px-4 rounded-[8px] bg-cur-ink text-white font-bold shrink-0">
                                    {checkingId ? <Loader2 className="w-4 h-4 animate-spin" /> : idChecked === true ? <CheckCircle2 className="w-4 h-4" /> : "중복확인"}
                                </Button>
                            </div>
                            {idChecked === true && <p className="text-[12px] text-cur-primary flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> 사용 가능한 아이디입니다.</p>}
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-[14px] font-semibold text-cur-ink">비밀번호</Label>
                            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="8자 이상" className={inputCls} />
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-[14px] font-semibold text-cur-ink">비밀번호 확인</Label>
                            <Input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} placeholder="한 번 더 입력" className={inputCls} />
                        </div>
                        {/* 빈 칸이면 비활성 (검증 실패 사유는 클릭 시 메시지로 — 기존 가입 위저드와 동일 규칙) */}
                        <Button
                            onClick={goStep2}
                            disabled={!loginId.trim() || !password || !password2}
                            className="w-full h-12 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90 disabled:opacity-40"
                        >
                            다음
                        </Button>
                        <p className="text-[12px] text-cur-muted-soft text-center leading-relaxed">
                            안전관리자 계정은 관리 전용이라 TBM 작성 기능이 없어요.<br />현장 기록은 관리감독자 계정에서 합니다.
                        </p>
                    </div>
                )}

                {/* ② 회사·좌석 */}
                {step === 2 && (
                    <div className="bg-cur-card rounded-2xl border border-cur-hairline p-5 space-y-5">
                        <div className="space-y-1.5">
                            <Label className="text-[14px] font-semibold text-cur-ink">회사명</Label>
                            <Input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="예: OO건설" className={inputCls} />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-[14px] font-semibold text-cur-ink">관리감독자 계정 수 (현장 수)</Label>
                            <div className="flex items-center justify-between bg-cur-elevated rounded-xl p-2">
                                <button onClick={() => setSeats((s) => Math.max(1, s - 1))} aria-label="좌석 줄이기" className="w-11 h-11 rounded-lg bg-cur-card border border-cur-hairline flex items-center justify-center text-cur-ink"><Minus className="w-4 h-4" /></button>
                                <div className="text-center">
                                    <div className="text-[24px] font-bold text-cur-ink leading-none">{seats}<span className="text-[14px] font-semibold text-cur-muted ml-1">명</span></div>
                                </div>
                                <button onClick={() => setSeats((s) => Math.min(100, s + 1))} aria-label="좌석 늘리기" className="w-11 h-11 rounded-lg bg-cur-card border border-cur-hairline flex items-center justify-center text-cur-ink"><Plus className="w-4 h-4" /></button>
                            </div>
                            <p className="text-[12px] text-cur-muted-soft">현장(관리감독자) 1곳당 1계정이에요. 나중에 언제든 추가·축소할 수 있어요.</p>
                        </div>
                        <div className="rounded-xl bg-cur-primary/[0.06] border border-cur-primary/25 p-4 flex items-center justify-between">
                            <span className="text-[13px] text-cur-muted">월 이용요금</span>
                            <span className="text-[18px] font-bold text-cur-ink">{total.toLocaleString()}원<span className="text-[12px] font-medium text-cur-muted ml-1">/ 월 (VAT 포함)</span></span>
                        </div>
                        <Button onClick={goStep3} disabled={loading || !orgName.trim()} className="w-full h-12 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90 disabled:opacity-40">
                            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "결제하고 시작하기"}
                        </Button>
                    </div>
                )}

                {/* ③ 결제 */}
                {step === 3 && (
                    <div className="bg-cur-card rounded-2xl border border-cur-hairline p-5 space-y-4">
                        <div className="flex items-start gap-3 rounded-xl bg-cur-elevated p-4">
                            <Building2 className="w-5 h-5 text-cur-primary shrink-0 mt-0.5" />
                            <div className="text-[13px] leading-relaxed">
                                <p className="font-semibold text-cur-ink">{orgName || "회사"}</p>
                                <p className="text-cur-muted">관리감독자 {seats}명 · 월 {total.toLocaleString()}원</p>
                            </div>
                        </div>
                        <OrgCheckoutButtons
                            seatCount={seats}
                            orgName={orgName.trim()}
                            onSuccess={() => { setTimeout(() => router.replace("/"), 800) }}
                        />
                        <button onClick={() => setStep(2)} className="w-full text-[13px] text-cur-muted hover:text-cur-ink transition-colors">← 좌석 수 다시 고르기</button>
                    </div>
                )}
            </div>
        </div>
    )
}
