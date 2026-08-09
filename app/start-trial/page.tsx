"use client"

// 가입 마무리 화면 — 구독 행 없이 시작한 계정(카카오 OAuth, 구 무인증 가입) 전용.
// 아이디 가입 위저드가 가입 시점에 받는 것(약관 동의·현장명·업종·공종·근로자 구분)에
// 성명·출력 형식까지 한 화면에서 받고, 동일한 규칙(휴대폰 인증 · 번호당 1회)으로 카드 없는
// 1개월 체험을 발급한다. 이 값들이 비면 문서에 카톡 닉네임이 업체명으로 인쇄되고,
// 회의록 진행자 칸에도 닉네임이 들어가며, 교육시간 목표가 12시간으로 단정되고, 출력은
// PDF로 고정된다.
// useRequireSubscription이 "구독 행 없음" 계정을 /pricing 대신 여기로 보낸다.
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { fetchOrgContext } from "@/lib/useOrgContext"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, CheckCircle2, User, Building2 } from "lucide-react"
import { Logo } from "@/components/Logo"
import { InAppBrowserNotice } from "@/components/InAppBrowserNotice"
import { ExportFormatPicker } from "@/components/ExportFormatPicker"
import type { ExportFormat } from "@/lib/exportFormats"
import { KSIC_MAJORS, findKsicMajor, isSingleSameMinor } from "@/lib/ksic"
// 클라이언트에서는 "@/lib/consent"가 아니라 이쪽 — 저쪽은 nodemailer를 끌어와 브라우저 번들이 깨진다
import { isConsentCurrent } from "@/lib/consentTerms"

const inputCls =
    "h-12 rounded-[8px] bg-cur-elevated border-cur-hairline text-[16px] md:text-[16px] font-medium text-cur-ink placeholder:text-cur-muted-soft focus-visible:ring-1 focus-visible:ring-cur-primary"
// w-full이 없으면 선택한 값 길이에 따라 트리거 폭이 매번 달라진다
const selectCls =
    "w-full h-12 rounded-[8px] bg-cur-elevated border-cur-hairline text-[16px] font-medium text-cur-ink focus:ring-1 focus:ring-cur-primary"
const cardCls = "bg-cur-card rounded-[12px] border border-cur-hairline p-5 space-y-4"

export default function StartTrialPage() {
    const router = useRouter()
    const [checking, setChecking] = useState(true)
    const [phoneEnabled, setPhoneEnabled] = useState<boolean | null>(null)

    // 성명(full_name) — 회의록 진행자 칸·화면 표시 이름·조직 현장담당자 이름이 전부 이 키에서 나온다.
    // 카카오 계정은 이 값이 카톡 닉네임으로 차 있어, 안 받으면 닉네임이 문서에 인쇄된다.
    const [fullName, setFullName] = useState("")
    const [companyName, setCompanyName] = useState("")
    // 사용 형태(usage_type) — 카카오 가입자는 온보딩 모달이 안 떠서(트리거=출력 형식 부재,
    // 이 화면이 출력 형식을 채움) 이 값을 받을 자리가 여기뿐이다. 홈 유도·헤더 점이 여기서 파생된다.
    const [usage, setUsage] = useState<"solo" | "multi" | null>(null)
    const [industry, setIndustry] = useState("")
    const [workCategory, setWorkCategory] = useState("")
    // 기본값 프리셋 — 가입 위저드와 동일 (별도 검증 불필요)
    const [workerType, setWorkerType] = useState("현장 근로자 (비사무직)")
    // 기본값을 미리 고르지 않는다 — 고를 기회가 없어 PDF로 굳어버린 계정이 실재한다
    const [exportFormat, setExportFormat] = useState<ExportFormat | null>(null)

    // 약관·개인정보처리방침 — 서버에 현행 버전 기록이 없을 때만 묻는다.
    // 초기값은 항상 unchecked (localStorage 프리체크 금지 — 동의는 이번 행동으로 받는다)
    const [needsConsent, setNeedsConsent] = useState(false)
    const [agreed, setAgreed] = useState(false)

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
    // 구독 조회 자체가 실패한 경우 — 이미 구독 중인데도 이 화면에 남아 있을 수 있다
    const [subCheckFailed, setSubCheckFailed] = useState(false)
    // 서버가 "이미 구독 있음"(409)으로 막은 경우 — 여기서 할 일이 없으니 홈으로 보낸다
    const [alreadySubscribed, setAlreadySubscribed] = useState(false)

    useEffect(() => {
        ;(async () => {
            const { data: { session } } = await supabase.auth.getSession()
            if (!session) { router.replace("/login"); return }
            // 이미 구독이 있으면 여기 올 이유가 없다(만료 계정 포함 — 홈 게이트가 /pricing으로 보낸다)
            const { data: sub, error: subErr } = await supabase
                .from("subscriptions").select("user_id").maybeSingle()
            if (sub) { router.replace("/"); return }
            // 조회가 실패했을 뿐인데 "구독 없음"으로 단정하면, 이미 구독 중인 사람이 폼을 다 채우고
            // 409를 맞은 뒤에야 막힌다 — 잠그지 말고 사정을 알리고 나갈 문을 같이 띄운다
            if (subErr) setSubCheckFailed(true)
            // 회사 소속 현장 계정은 감독자 구독으로 이용 — 개인 체험 대상 아님
            const ctx = await fetchOrgContext()
            if (ctx?.kind === "member") { setMemberBlocked(true); setChecking(false); return }

            // 이미 가진 값은 다시 묻지 않고 채워둔다 — 카카오 계정은 대체로 전부 비어 있다
            const meta = session.user.user_metadata ?? {}
            setCompanyName(String(meta.company_name ?? "").trim())
            // 성명 프리필은 가려서 한다 — 카카오 계정의 full_name은 카톡 닉네임(아이덴티티 원본과
            // 동일)이고, 구 무인증 가입은 현장명 복사값(company_name과 동일)이다. 둘 다 성명이
            // 아니라서 미리 채우면 그대로 제출돼 회의록 진행자 칸에 닉네임이 인쇄된다.
            // 이 화면에서 저장까지 마치고 409(번호 소진)로 되돌아온 계정의 진짜 성명만 되살린다.
            const metaName = String(meta.full_name ?? "").trim()
            const identityNames = (session.user.identities ?? [])
                .map((i) => String((i.identity_data as Record<string, unknown> | undefined)?.full_name ?? "").trim())
                .filter(Boolean)
            if (metaName && metaName !== String(meta.company_name ?? "").trim() && !identityNames.includes(metaName)) {
                setFullName(metaName)
            }
            if (meta.usage_type === "solo" || meta.usage_type === "multi") setUsage(meta.usage_type)
            setIndustry(String(meta.industry ?? "").trim())
            setWorkCategory(String(meta.work_category ?? "").trim())
            if (meta.worker_type) setWorkerType(String(meta.worker_type))
            if (meta.preferred_export_format) setExportFormat(meta.preferred_export_format as ExportFormat)
            setNeedsConsent(!isConsentCurrent(meta))

            // 동의 여부는 서버 기준으로 덮어쓴다 — 세션 스냅샷은 토큰 갱신(~1시간)까지 낡아,
            // 다른 화면·다른 기기에서 이미 동의한 사람에게 체크박스가 또 뜬다
            let enabled = false
            try {
                const res = await fetch("/api/auth/claim-trial", {
                    headers: { Authorization: `Bearer ${session.access_token}` },
                })
                if (!res.ok) throw new Error("status")
                const j = await res.json()
                enabled = j.phoneEnabled === true
                setNeedsConsent(j.needsConsent !== false)
            } catch {
                // 동의는 위에서 세션 기준으로 이미 판정했으니 그대로 둔다. 인증 게이트만은
                // 공개 엔드포인트로 다시 확인한다 — false로 굳으면 인증칸 없이 제출해 서버 400을
                // 맞고, 고칠 방법이 화면에 없는 또 다른 갇힘이 된다.
                try {
                    const r = await fetch("/api/auth/phone/status")
                    const j = await r.json()
                    enabled = j.enabled === true
                } catch {
                    enabled = false
                }
            }
            setPhoneEnabled(enabled)
            setChecking(false)
        })()
    }, [router])

    const signOut = async () => {
        await supabase.auth.signOut()
        router.replace("/login")
    }

    const sendCode = async () => {
        // 동의 전에는 번호를 서버로 보내지 않는다 — 발송 순간 phone_otps에 저장되고 SMS가 나간다
        if (needsConsent && !agreed) { setError("먼저 약관에 동의해주세요."); return }
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
        if (needsConsent && !agreed) { setError("약관 및 개인정보처리방침에 동의해주세요."); return }
        if (!usage) { setError("사용 형태를 선택해주세요."); return }
        if (!fullName.trim()) { setError("성명을 입력해주세요."); return }
        if (!companyName.trim()) { setError("현장명(또는 업체명)을 입력해주세요."); return }
        if (!industry) { setError("업종을 선택해주세요."); return }
        if (!workCategory) { setError("공종을 선택해주세요."); return }
        if (!exportFormat) { setError("문서 출력 형식을 선택해주세요."); return }
        if (phoneEnabled && !verificationId) { setError("휴대폰 인증을 완료해주세요."); return }
        setLoading(true)
        try {
            const { data: { session } } = await supabase.auth.getSession()
            const res = await fetch("/api/auth/claim-trial", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
                body: JSON.stringify({
                    name: fullName.trim(),
                    companyName: companyName.trim(),
                    usage,
                    industry,
                    workCategory,
                    workerType,
                    exportFormat,
                    agreedToTerms: needsConsent ? agreed : false,
                    ...(phoneEnabled ? { phone: phone.replace(/\D/g, ""), verificationId } : {}),
                }),
            })
            const j = await res.json().catch(() => ({}))
            if (!res.ok) {
                if (res.status === 409) {
                    // 번호 소진이면 결제 경로로, 이미 구독 중이면 홈으로 — 둘 다 출구를 띄운다
                    if (String(j.error ?? "").includes("무료체험")) setRedeemed(true)
                    else setAlreadySubscribed(true)
                }
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
                        onClick={signOut}
                        variant="outline"
                        className="w-full h-12 rounded-[8px] border-cur-hairline bg-cur-elevated text-[13px] font-semibold text-cur-ink hover:border-cur-primary/40 focus-visible:ring-2 focus-visible:ring-cur-primary"
                    >
                        다른 계정으로 로그인
                    </Button>
                </div>
            </div>
        )
    }

    const minors = industry ? (findKsicMajor(industry)?.minors ?? []) : []
    // 동의 전에는 개인정보(휴대폰 번호)를 받는 칸을 아예 열지 않는다
    const consentPending = needsConsent && !agreed

    return (
        <div className="min-h-screen bg-cur-canvas font-sans text-cur-ink">
            <InAppBrowserNotice />
            <div className="max-w-md mx-auto px-5 py-10 space-y-5">
                <div className="flex flex-col items-center gap-4">
                    <Logo size="md" />
                    <div className="text-center space-y-1.5">
                        <h1 className="text-[22px] font-bold tracking-[-0.02em]">첫 달 무료로 시작해요</h1>
                        <p className="text-[13px] text-cur-muted leading-relaxed">
                            한 달간 모든 기능이 무료예요.
                            <br />결제수단을 등록하기 전에는 요금이 청구되지 않습니다.
                        </p>
                    </div>
                </div>

                {error && (
                    <div className="text-[13px] rounded-[8px] px-3 py-2 bg-cur-error/5 border border-cur-error/20 text-cur-error">{error}</div>
                )}

                {subCheckFailed && (
                    <div className="text-[13px] rounded-[8px] px-3 py-2 bg-cur-elevated border border-cur-hairline text-cur-body leading-relaxed">
                        구독 정보를 확인하지 못했어요. 이미 이용 중인 계정이라면 아래 &lsquo;홈으로 가기&rsquo;를 눌러주세요.
                    </div>
                )}

                {/* 1 — 동의. 개인정보를 한 글자라도 받기 전에 먼저 묻는다 (이미 동의한 계정에는 안 뜬다) */}
                {needsConsent && (
                    <div className={cardCls}>
                        <h2 className="text-[14px] font-bold text-cur-ink">약관 동의</h2>
                        <div className="flex items-start gap-3 bg-cur-elevated rounded-[8px] p-3.5">
                            <Checkbox
                                id="st-agree"
                                checked={agreed}
                                onCheckedChange={(c) => setAgreed(c === true)}
                                className="mt-0.5 border-cur-muted data-[state=checked]:bg-cur-primary data-[state=checked]:text-cur-on-primary rounded-[4px] focus-visible:ring-2 focus-visible:ring-cur-primary"
                            />
                            <label htmlFor="st-agree" className="text-[13px] text-cur-body leading-[1.5] cursor-pointer">
                                <a href="/privacy" target="_blank" className="text-cur-primary font-medium hover:underline rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary">개인정보처리방침</a> 및{" "}
                                <a href="/terms" target="_blank" className="text-cur-primary font-medium hover:underline rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary">서비스 이용약관</a>에 동의합니다.
                            </label>
                        </div>
                    </div>
                )}

                {/* 2 — 사용 형태. 온보딩 모달 step1과 같은 질문 — 카카오 경로는 모달이 안 떠서 여기서 받는다 */}
                <div className={cardCls}>
                    <h2 className="text-[14px] font-bold text-cur-ink">어떻게 사용하시나요?</h2>
                    <div className="space-y-2.5">
                        <button
                            type="button"
                            onClick={() => setUsage("solo")}
                            aria-pressed={usage === "solo"}
                            className={`w-full flex items-center gap-3.5 p-4 rounded-[12px] border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary ${
                                usage === "solo" ? "border-cur-primary bg-cur-primary/5" : "border-cur-hairline bg-cur-card hover:border-cur-primary/40"
                            }`}
                        >
                            <span className="w-10 h-10 shrink-0 rounded-[10px] bg-cur-elevated flex items-center justify-center"><User className="w-5 h-5 text-cur-ink" /></span>
                            <span className="flex-1 min-w-0">
                                <span className="block text-[15px] font-bold text-cur-ink">제 현장 하나만 관리해요</span>
                                <span className="block text-[12px] text-cur-body mt-0.5">이 계정 하나로 기록하고 출력합니다</span>
                            </span>
                            {usage === "solo" && <CheckCircle2 className="w-4 h-4 shrink-0 text-cur-primary" />}
                        </button>
                        <button
                            type="button"
                            onClick={() => setUsage("multi")}
                            aria-pressed={usage === "multi"}
                            className={`w-full flex items-center gap-3.5 p-4 rounded-[12px] border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary ${
                                usage === "multi" ? "border-cur-primary bg-cur-primary/5" : "border-cur-hairline bg-cur-card hover:border-cur-primary/40"
                            }`}
                        >
                            <span className="w-10 h-10 shrink-0 rounded-[10px] bg-cur-primary/10 flex items-center justify-center"><Building2 className="w-5 h-5 text-cur-primary" /></span>
                            <span className="flex-1 min-w-0">
                                <span className="block text-[15px] font-bold text-cur-ink">여러 현장을 관리해요</span>
                                <span className="block text-[12px] text-cur-body mt-0.5">현장마다 계정을 만들어 연결하고, 이 계정이 감독자가 됩니다</span>
                            </span>
                            {usage === "multi" && <CheckCircle2 className="w-4 h-4 shrink-0 text-cur-primary" />}
                        </button>
                    </div>
                    <p className="text-[13px] text-cur-muted leading-relaxed">내 정보 수정에서 언제든 바꿀 수 있어요.</p>
                </div>

                {/* 3 — 현장 정보. 여기 값이 문서·보고서에 그대로 인쇄되고 교육시간 목표를 정한다 */}
                <div className={cardCls}>
                    <h2 className="text-[14px] font-bold text-cur-ink">현장 정보</h2>

                    <div className="space-y-1.5">
                        <Label htmlFor="st-name" className="text-[13px] font-medium text-cur-body">성명</Label>
                        <Input
                            id="st-name"
                            value={fullName}
                            onChange={(e) => setFullName(e.target.value)}
                            placeholder="성명을 입력하세요"
                            maxLength={30}
                            className={inputCls}
                        />
                        <p className="text-[13px] text-cur-muted leading-relaxed">
                            회의록의 진행자 칸에 인쇄돼요.
                        </p>
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="st-company" className="text-[13px] font-medium text-cur-body">현장명 (또는 업체명)</Label>
                        <Input
                            id="st-company"
                            value={companyName}
                            onChange={(e) => setCompanyName(e.target.value)}
                            placeholder="예: OO물류센터 신축현장"
                            className={inputCls}
                        />
                        <p className="text-[13px] text-cur-muted leading-relaxed">
                            문서의 업체명 칸에 인쇄돼요.
                        </p>
                    </div>

                    <div className="space-y-1.5">
                        <Label className="text-[13px] font-medium text-cur-body">업종 (대분류)</Label>
                        <Select
                            value={industry}
                            onValueChange={(v) => {
                                setIndustry(v)
                                // 중분류가 하나뿐인 업종(전기·가스, 부동산 등)은 공종을 자동 선택
                                const list = findKsicMajor(v)?.minors ?? []
                                setWorkCategory(list.length === 1 ? list[0].name : "")
                            }}
                        >
                            <SelectTrigger className={selectCls}>
                                <SelectValue placeholder="업종을 선택해주세요" />
                            </SelectTrigger>
                            <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                                {KSIC_MAJORS.map((m) => (
                                    <SelectItem key={m.code} value={m.name} className="text-[15px] py-2.5">{m.name}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    {/* 중분류가 대분류와 같은 단일 항목(전기·가스, 기타)이면 이미 자동 선택됨 — 같은 이름을 두 번 고르게 하지 않는다 */}
                    {industry && !isSingleSameMinor(industry) && (
                        <div className="space-y-1.5">
                            <Label className="text-[13px] font-medium text-cur-body">공종 (중분류)</Label>
                            <Select value={workCategory} onValueChange={setWorkCategory}>
                                <SelectTrigger className={selectCls}>
                                    <SelectValue placeholder="주력 공종을 선택해주세요" />
                                </SelectTrigger>
                                <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                                    {minors.map((mi) => (
                                        <SelectItem key={mi.code} value={mi.name} className="text-[15px] py-2.5">{mi.name}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    )}

                    <div className="space-y-1.5">
                        <Label className="text-[13px] font-medium text-cur-body">근로자 구분 (교육시간 산정용)</Label>
                        <Select value={workerType} onValueChange={setWorkerType}>
                            <SelectTrigger className={selectCls}>
                                <SelectValue placeholder="근로자 구분을 선택해주세요" />
                            </SelectTrigger>
                            <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                                <SelectItem value="현장 근로자 (비사무직)" className="text-[15px] py-2.5">비사무직 (반기 12시간)</SelectItem>
                                <SelectItem value="사무직 / 판매직" className="text-[15px] py-2.5">사무직 (반기 6시간)</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                {/* 4 — 출력 형식. 고를 기회가 없으면 PDF로 굳어 한글 양식을 쓰는 현장이 손으로 옮겨 적는다 */}
                <div className={cardCls}>
                    <h2 className="text-[14px] font-bold text-cur-ink">문서 출력 형식</h2>
                    <ExportFormatPicker value={exportFormat} onChange={setExportFormat} />
                    <p className="text-[13px] text-cur-muted leading-relaxed">
                        회의록·교육일지를 내려받을 때 쓰는 기본 형식이에요. PDF는 편집할 수 없어요.
                    </p>
                </div>

                {/* 5 — 휴대폰 인증 (게이트가 켜져 있을 때만). 동의 전에는 잠가둔다 */}
                {phoneEnabled && (
                    <div className={cardCls}>
                        <h2 className="text-[14px] font-bold text-cur-ink">휴대폰 인증</h2>
                        <div className="space-y-2">
                            <div className="flex gap-2">
                                <Input type="tel" inputMode="numeric" placeholder="01012345678" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={consentPending || !!verificationId} className={inputCls + " flex-1 min-w-0"} />
                                <Button onClick={sendCode} disabled={consentPending || sending || !!verificationId} className="h-12 px-3 rounded-[8px] bg-cur-ink text-white text-[13px] font-bold shrink-0 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-cur-primary">
                                    {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : codeSent ? "재발송" : "인증번호"}
                                </Button>
                            </div>
                            {consentPending && (
                                <p className="text-[13px] text-cur-muted leading-relaxed">
                                    맨 위에서 약관에 동의하면 인증번호를 보내드려요.
                                </p>
                            )}
                            {codeSent && !verificationId && (
                                <div className="flex gap-2">
                                    <Input inputMode="numeric" placeholder="인증번호 6자리" value={code} onChange={(e) => setCode(e.target.value)} className={inputCls + " flex-1 min-w-0"} />
                                    <Button onClick={verifyCode} className="h-12 px-4 rounded-[8px] bg-cur-primary text-white font-bold shrink-0 focus-visible:ring-2 focus-visible:ring-cur-primary">확인</Button>
                                </div>
                            )}
                            {verificationId && (
                                <p className="text-[13px] text-cur-primary flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> 인증이 완료되었습니다.</p>
                            )}
                        </div>
                    </div>
                )}

                {/* 6 — 시작 */}
                <div className={cardCls}>
                    <Button
                        onClick={claim}
                        disabled={loading || (needsConsent && !agreed)}
                        className="w-full h-12 rounded-[8px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[15px] font-bold disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-cur-primary"
                    >
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "무료체험 시작하기"}
                    </Button>

                    {redeemed && (
                        <Button
                            onClick={() => router.push("/pricing")}
                            variant="outline"
                            className="w-full h-10 rounded-[8px] border-cur-hairline bg-cur-elevated text-[13px] font-semibold text-cur-ink hover:border-cur-primary/40 focus-visible:ring-2 focus-visible:ring-cur-primary"
                        >
                            결제수단 등록하고 이용하기
                        </Button>
                    )}

                    {(alreadySubscribed || subCheckFailed) && (
                        <Button
                            onClick={() => router.replace("/")}
                            variant="outline"
                            className="w-full h-10 rounded-[8px] border-cur-hairline bg-cur-elevated text-[13px] font-semibold text-cur-ink hover:border-cur-primary/40 focus-visible:ring-2 focus-visible:ring-cur-primary"
                        >
                            홈으로 가기
                        </Button>
                    )}

                    <p className="text-[13px] text-cur-muted text-center leading-relaxed">
                        체험 종료 후에도 결제수단을 등록하기 전에는 자동으로 결제되지 않아요.
                        <br />월 3,900원 · 언제든 해지 가능
                    </p>
                </div>

                {/* 나가는 문 — 이게 없으면 현장명을 안 넣은 계정은 홈에 갈 때마다 여기로 되돌아와 갇힌다 */}
                <button
                    type="button"
                    onClick={signOut}
                    className="mx-auto block px-3 py-2 rounded-[8px] text-[13px] font-medium text-cur-muted hover:text-cur-ink underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                >
                    로그아웃
                </button>
            </div>
        </div>
    )
}
