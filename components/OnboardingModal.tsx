"use client"

/* Hallmark · component: modal (첫 로그인 온보딩 — 사용 형태 · 내 이메일 · 출력 형식)
 * genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * states: step1(usage) · step2(email, 스킵 가능) · step3(format) · saving · error
 * tokens only — hairline depth, card radius 12px
 */

// 가입 위저드에서 출력 형식·이메일을 뺐다(Chris) — 가입은 계정 만들기까지만 하고,
// 서비스 설정은 첫 로그인에서 묻는다. 트리거는 preferred_export_format 부재이므로
// 카카오(/start-trial에서 수집)·기존 계정에는 뜨지 않는다.

import { useState } from "react"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ExportFormatPicker } from "@/components/ExportFormatPicker"
import { type ExportFormat } from "@/lib/exportFormats"
import { Loader2, User, Building2, ChevronRight } from "lucide-react"

// 저장 값은 교육시간 분기 키(웹·앱·DB 트리거 공유)라 그대로 두고, 화면 라벨만 사무직/비사무직으로 줄인다
const WORKER_OPTIONS = [
    { value: "현장 근로자 (비사무직)", label: "비사무직", desc: "현장 근로자 — 정기교육 반기 12시간" },
    { value: "사무직 / 판매직", label: "사무직", desc: "사무·판매 — 정기교육 반기 6시간" },
] as const

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function OnboardingModal({ onDone }: { onDone: (updatedUser: unknown) => void }) {
    const [step, setStep] = useState<1 | 2 | 3 | 4>(1)
    const [workerType, setWorkerType] = useState<string | null>(null)
    const [usage, setUsage] = useState<"solo" | "multi" | null>(null)
    const [email, setEmail] = useState("")
    const [format, setFormat] = useState<ExportFormat | null>(null)
    const [saving, setSaving] = useState(false)
    const [err, setErr] = useState<string | null>(null)

    const pickUsage = (u: "solo" | "multi") => {
        setUsage(u)
        // '여러 현장'은 기존 홈 유도(현장 계정 추가하기 입구)와 같은 마커를 쓴다
        if (u === "multi") { try { window.localStorage.setItem("antok_hint_add_site", "1") } catch { /* 무시 */ } }
        else { try { window.localStorage.removeItem("antok_hint_add_site") } catch { /* 무시 */ } }
        setStep(2)
    }

    const goFormat = (skipEmail: boolean) => {
        if (!skipEmail) {
            const v = email.trim()
            if (!v) { setErr("이메일을 입력하거나 '나중에 할게요'를 눌러주세요."); return }
            if (!EMAIL_RE.test(v)) { setErr("이메일 형식이 올바르지 않습니다."); return }
        } else {
            setEmail("")
        }
        setErr(null)
        setStep(4)
    }

    const save = async () => {
        if (!format) { setErr("출력 형식을 선택해주세요."); return }
        setSaving(true)
        setErr(null)
        try {
            const { data: s } = await supabase.auth.getSession()
            const res = await fetch("/api/onboarding", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${s?.session?.access_token}` },
                body: JSON.stringify({ usage, workerType, email: email.trim() || undefined, exportFormat: format }),
            })
            const j = await res.json().catch(() => ({}))
            if (!res.ok) { setErr(j.error || "저장에 실패했어요. 다시 시도해주세요."); return }
            // 서버가 admin API로 바꾼 메타데이터는 로컬 세션 스냅샷에 없다 — 서버 기준으로 다시 읽는다
            const { data: fresh } = await supabase.auth.getUser()
            onDone(fresh?.user ?? null)
        } catch {
            setErr("네트워크 오류로 저장하지 못했어요.")
        } finally {
            setSaving(false)
        }
    }

    const stepDot = (n: number) => (
        <span key={n} className={`h-1.5 rounded-full transition-all ${step === n ? "w-6 bg-cur-primary" : step > n ? "w-1.5 bg-cur-primary/50" : "w-1.5 bg-cur-hairline-strong"}`} />
    )

    return (
        <div role="dialog" aria-modal="true" aria-label="시작 설정" className="fixed inset-0 z-[150] flex items-end sm:items-center justify-center p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] bg-cur-ink/40">
            <div className="w-full max-w-md bg-cur-card rounded-[16px] border border-cur-hairline shadow-[0_12px_40px_rgba(0,0,0,0.16)] p-6 space-y-5">
                <div className="flex items-center gap-1.5">{[1, 2, 3, 4].map(stepDot)}</div>

                {step === 1 && (
                    <div className="space-y-4">
                        <div>
                            <h2 className="text-[18px] font-bold text-cur-ink">어떻게 사용하시나요?</h2>
                            <p className="text-[13px] text-cur-muted mt-1">나중에 언제든 바꿀 수 있어요.</p>
                        </div>
                        <div className="space-y-2.5">
                            <button
                                type="button"
                                onClick={() => pickUsage("solo")}
                                className="w-full flex items-center gap-3.5 p-4 rounded-[12px] border border-cur-hairline bg-cur-card text-left hover:border-cur-primary/40 hover:bg-cur-elevated/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                            >
                                <span className="w-11 h-11 shrink-0 rounded-[10px] bg-cur-elevated flex items-center justify-center"><User className="w-5 h-5 text-cur-ink" /></span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-[15px] font-bold text-cur-ink">제 현장 하나만 관리해요</span>
                                    <span className="block text-[12px] text-cur-body mt-0.5">이 계정 하나로 기록하고 출력합니다</span>
                                </span>
                                <ChevronRight className="w-4 h-4 shrink-0 text-cur-muted-soft" />
                            </button>
                            <button
                                type="button"
                                onClick={() => pickUsage("multi")}
                                className="w-full flex items-center gap-3.5 p-4 rounded-[12px] border border-cur-hairline bg-cur-card text-left hover:border-cur-primary/40 hover:bg-cur-elevated/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                            >
                                <span className="w-11 h-11 shrink-0 rounded-[10px] bg-cur-primary/10 flex items-center justify-center"><Building2 className="w-5 h-5 text-cur-primary" /></span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-[15px] font-bold text-cur-ink">여러 현장을 관리해요</span>
                                    <span className="block text-[12px] text-cur-body mt-0.5">현장마다 계정을 만들어 연결하고, 이 계정이 감독자가 됩니다</span>
                                </span>
                                <ChevronRight className="w-4 h-4 shrink-0 text-cur-muted-soft" />
                            </button>
                        </div>
                    </div>
                )}

                {step === 2 && (
                    <div className="space-y-4">
                        <div>
                            <h2 className="text-[18px] font-bold text-cur-ink">내 근로자 구분을 알려주세요</h2>
                            <p className="text-[13px] text-cur-body mt-1.5 leading-relaxed">
                                {usage === "multi"
                                    ? <>연결된 현장 전체 설정이 아니에요 — 감독자인 나도 TBM·교육일지를 쓰니, <b className="text-cur-ink">내 기록의 법정 교육시간 기준</b>이 되는 구분이에요.</>
                                    : <><b className="text-cur-ink">내 법정 교육시간의 기준</b>이 되는 구분이에요. 내 정보 수정에서 언제든 바꿀 수 있어요.</>}
                            </p>
                        </div>
                        <div className="space-y-2.5">
                            {WORKER_OPTIONS.map((o) => (
                                <button
                                    key={o.value}
                                    type="button"
                                    onClick={() => { setWorkerType(o.value); setStep(3) }}
                                    className="w-full flex items-center gap-3.5 p-4 rounded-[12px] border border-cur-hairline bg-cur-card text-left hover:border-cur-primary/40 hover:bg-cur-elevated/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                                >
                                    <span className="flex-1 min-w-0">
                                        <span className="block text-[15px] font-bold text-cur-ink">{o.label}</span>
                                        <span className="block text-[12px] text-cur-body mt-0.5">{o.desc}</span>
                                    </span>
                                    <ChevronRight className="w-4 h-4 shrink-0 text-cur-muted-soft" />
                                </button>
                            ))}
                        </div>
                        <button
                            type="button"
                            onClick={() => setStep(1)}
                            className="w-full h-9 text-[13px] font-medium text-cur-muted hover:text-cur-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary rounded-[6px]"
                        >
                            이전
                        </button>
                    </div>
                )}

                {step === 3 && (
                    <div className="space-y-4">
                        <div>
                            <h2 className="text-[18px] font-bold text-cur-ink">이메일 주소를 적어주세요</h2>
                            <p className="text-[13px] text-cur-body mt-1.5 leading-relaxed">
                                주간·월간 안전 보고서가 이 주소로 발송되고,
                                <b className="text-cur-ink"> 비밀번호를 잊었을 때 계정을 되찾는 수단</b>도 이 주소예요.
                                별도 인증 절차가 없으니 <b className="text-cur-ink">정확하게</b> 적어주세요.
                            </p>
                        </div>
                        <Input
                            type="email"
                            inputMode="email"
                            autoComplete="email"
                            placeholder="name@company.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") goFormat(false) }}
                            className="h-12 text-[16px] md:text-[16px] rounded-[10px]"
                        />
                        {err && <p className="text-[12px] text-cur-error">{err}</p>}
                        <div className="space-y-2">
                            <Button onClick={() => goFormat(false)} className="w-full h-12 rounded-[10px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary font-bold">
                                다음
                            </Button>
                            <button
                                type="button"
                                onClick={() => goFormat(true)}
                                className="w-full h-9 text-[13px] font-medium text-cur-muted hover:text-cur-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary rounded-[6px]"
                            >
                                이메일이 없어요 — 나중에 할게요
                            </button>
                        </div>
                    </div>
                )}

                {step === 4 && (
                    <div className="space-y-4">
                        <div>
                            <h2 className="text-[18px] font-bold text-cur-ink">
                                {usage === "multi" ? "출력물은 어떤 형식으로 받을까요?" : "출력받을 형식을 지정하세요"}
                            </h2>
                            <p className="text-[13px] text-cur-body mt-1.5 leading-relaxed">
                                {usage === "multi"
                                    ? "회의록·교육일지 문서의 기본 형식이에요. 연결된 현장 모두에 적용됩니다."
                                    : "회의록·교육일지를 내려받을 때 쓰는 기본 형식이에요. 나중에 바꿀 수 있어요."}
                            </p>
                        </div>
                        <ExportFormatPicker value={format} onChange={setFormat} />
                        {err && <p className="text-[12px] text-cur-error">{err}</p>}
                        <div className="flex gap-2">
                            <Button variant="outline" onClick={() => { setErr(null); setStep(3) }} className="flex-1 h-12 rounded-[10px] border-cur-hairline text-cur-ink font-semibold hover:bg-cur-elevated">
                                이전
                            </Button>
                            <Button onClick={save} disabled={saving || !format} className="flex-[2] h-12 rounded-[10px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary font-bold disabled:opacity-40">
                                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "시작하기"}
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
