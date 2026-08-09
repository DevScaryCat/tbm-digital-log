"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Mail, CheckCircle2 } from "lucide-react"
import { showAlert } from "@/lib/uiDialog"
// 가입 위저드(app/signup)와 동일한 KSIC 기반 옵션 — 여기서 기존 유저가 나중에 편집/백필한다.
import { KSIC_MAJORS, findKsicMajor } from "@/lib/ksic"
import { fetchOrgContext, type ClientOrgContext } from "@/lib/useOrgContext"

export default function ProfilePage() {
    const router = useRouter()
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
    // 보고서 수신 이메일 — 값 자체는 인증 링크를 눌러야 바뀐다(가입 때와 같은 경로).
    // 인증이 끝나면 출력/발송 설정의 '내 이메일' 수신처도 자동으로 새 주소로 옮겨간다.
    const [reportEmail, setReportEmail] = useState<string | null>(null)
    const [pendingEmail, setPendingEmail] = useState<string | null>(null)
    const [emailInput, setEmailInput] = useState("")
    const [emailBusy, setEmailBusy] = useState(false)
    const [emailMsg, setEmailMsg] = useState<string | null>(null)
    const [emailLoaded, setEmailLoaded] = useState(false)

    const authHeaders = async () => {
        const { data } = await supabase.auth.getSession()
        return { "Content-Type": "application/json", Authorization: `Bearer ${data?.session?.access_token}` }
    }
    const loadEmail = useCallback(async () => {
        try {
            const res = await fetch("/api/auth/email", { headers: await authHeaders() })
            if (!res.ok) return
            const j = await res.json()
            setReportEmail(j.email ?? null)
            setPendingEmail(j.pending ?? null)
            setEmailInput(j.email ?? j.pending ?? "")
            setEmailLoaded(true)
        } catch { /* 이 카드만 비어 보인다 */ }
    }, [])
    useEffect(() => { loadEmail() }, [loadEmail])

    const sendEmailVerify = async () => {
        const v = emailInput.trim()
        if (!v) return
        setEmailBusy(true); setEmailMsg(null)
        try {
            const res = await fetch("/api/auth/email", { method: "POST", headers: await authHeaders(), body: JSON.stringify({ email: v }) })
            const j = await res.json().catch(() => ({}))
            if (!res.ok) { setEmailMsg(j.error || "인증 메일을 보내지 못했어요."); return }
            setPendingEmail(v)
            showAlert(`${v} 로 인증 메일을 보냈어요.\n메일함에서 링크를 눌러야 변경이 확정됩니다.`, { title: "인증 메일을 보냈어요" })
        } catch {
            setEmailMsg("네트워크 오류로 보내지 못했어요.")
        } finally {
            setEmailBusy(false)
        }
    }
    // 역할 판정 — member는 업종·공종만 보기 전용, owner는 저장 시 그 둘을 현장 계정에 전파.
    // 훅 대신 직접 호출: 판정 실패(null)를 화면에 드러내고 재시도할 수 있어야 한다.
    const [ctx, setCtx] = useState<ClientOrgContext | null>(null)
    const [ctxLoading, setCtxLoading] = useState(true)
    const loadCtx = useCallback(async (force = false) => {
        setCtxLoading(true)
        setCtx(await fetchOrgContext(force))
        setCtxLoading(false)
    }, [])
    useEffect(() => { loadCtx() }, [loadCtx])

    const [fullName, setFullName] = useState("")
    const [companyName, setCompanyName] = useState("")
    const [workerType, setWorkerType] = useState("현장 근로자 (비사무직)")
    const [industry, setIndustry] = useState("")
    const [workCategory, setWorkCategory] = useState("")
    // 저장 활성화 판정용 초기 스냅샷 — 아무것도 안 바꿨는데 '저장'이 눌리면 이상하다
    const [initial, setInitial] = useState<string>("")

    const snapshot = (v: { fullName: string; companyName: string; workerType: string; industry: string; workCategory: string }) =>
        JSON.stringify(v)

    useEffect(() => {
        ;(async () => {
            const {
                data: { session },
            } = await supabase.auth.getSession()
            if (!session) {
                router.replace("/login")
                return
            }
            const meta = session.user.user_metadata ?? {}
            setFullName(meta.full_name ?? "")
            setCompanyName(meta.company_name ?? "")
            setWorkerType(meta.worker_type ?? "현장 근로자 (비사무직)")
            setIndustry(meta.industry ?? "")
            // 저장 키는 snake_case(work_category) — 가입 API와 동일
            setWorkCategory(meta.work_category ?? "")
            setInitial(snapshot({
                fullName: meta.full_name ?? "",
                companyName: meta.company_name ?? "",
                workerType: meta.worker_type ?? "현장 근로자 (비사무직)",
                industry: meta.industry ?? "",
                workCategory: meta.work_category ?? "",
            }))
            setLoading(false)
        })()
    }, [router])

    // KSIC 개편 이전에 저장된 구 값(예: "물류·운수업", "건축")은 목록에 없어도 선택 상태로 보이게 항목을 덧붙인다.
    const selectedMajor = industry ? findKsicMajor(industry) : undefined
    const isLegacyIndustry = !!industry && !selectedMajor
    const minors = selectedMajor?.minors ?? []
    const isLegacyWorkCategory = !!workCategory && !minors.some((mi) => mi.name === workCategory)

    const dirty = initial !== snapshot({ fullName, companyName, workerType, industry, workCategory })

    const isMember = ctx?.kind === "member"
    // 성명·소속 현장명·근로자 구분은 사람과 현장마다 다른 값이라 본인이 고친다(현장 계정 포함).
    // 회사 공통으로 남는 건 업종·공종뿐 — 이건 fail-closed로 owner/solo 확정 시에만 열고,
    // 판정 실패(null)에서는 잠근다(아래 재시도 카드로 복구).
    const ownEditable = !ctxLoading
    const companyEditable = ctx?.kind === "owner" || ctx?.kind === "solo"

    const handleSave = async () => {
        if (!fullName.trim()) {
            setMsg({ type: "err", text: "성명을 입력해주세요." })
            return
        }
        if (!companyName.trim()) {
            setMsg({ type: "err", text: "소속 현장명(또는 업체명)을 입력해주세요." })
            return
        }
        setSaving(true)
        setMsg(null)
        try {
            const { data, error } = await supabase.auth.updateUser({
                data: {
                    full_name: fullName.trim(),
                    company_name: companyName.trim(),
                    worker_type: workerType,
                    industry: industry || null,
                    work_category: workCategory || null,
                },
            })
            if (error) throw error
            const savedWorkCategory = data.user.user_metadata.work_category ?? ""
            setWorkCategory(savedWorkCategory)

            // owner: 회사 공통 2필드(업종·공종)만 현장 계정 전체에 전파.
            // 성명·현장명·근로자 구분은 각자의 것이라 전파하지 않는다 — 덮어쓰면 현장 계정이
            // 스스로 고친 값이 감독자 저장 때마다 되돌아간다.
            let propagated: number | null = null
            if (ctx?.kind === "owner") {
                const { data: sess } = await supabase.auth.getSession()
                const token = sess?.session?.access_token
                const res = await fetch("/api/org/profile", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: JSON.stringify({
                        industry: industry || null,
                        workCategory: savedWorkCategory || null,
                    }),
                }).catch(() => null)
                const j = res?.ok ? await res.json().catch(() => null) : null
                // 부분 실패(updated < total)를 성공으로 넘기면 어긋난 현장이 무기한 남는다
                if (!j || (typeof j.total === "number" && j.updated < j.total)) {
                    // 본인 저장은 이미 성공 — 스냅샷을 갱신하지 않아 '저장'을 살려 두면
                    // 같은 값으로 다시 저장하는 것이 곧 전파 재시도가 된다
                    setMsg({ type: "err", text: "저장은 됐지만 일부 현장 계정 적용에 실패했어요. 잠시 후 다시 저장하면 재시도됩니다." })
                    return
                }
                propagated = Number(j.updated) || 0
            }

            setInitial(snapshot({
                fullName: fullName.trim(), companyName: companyName.trim(), workerType,
                industry, workCategory: savedWorkCategory,
            }))
            setMsg({
                type: "ok",
                text: propagated ? `내 정보가 저장되었습니다. 현장 계정 ${propagated}곳에도 적용됐어요.` : "내 정보가 저장되었습니다.",
            })
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : "알 수 없는 오류"
            setMsg({ type: "err", text: "저장 실패: " + errMsg })
        } finally {
            setSaving(false)
        }
    }

    if (loading)
        return (
            <div className="min-h-screen flex items-center justify-center bg-cur-canvas">
                <Loader2 className="w-10 h-10 text-cur-primary animate-spin" />
            </div>
        )

    return (
        <div className="min-h-screen bg-cur-canvas flex flex-col font-sans text-cur-body">
            <div className="w-full max-w-lg mx-auto px-4 pt-4">
                <TBMHeader title="내 정보 수정" backHref="/" />
            </div>
            <div className="flex-1 w-full max-w-lg mx-auto px-4 py-6 pb-16 space-y-4">
                {msg && (
                    <div
                        className={`text-[13px] rounded-lg p-3 ${
                            msg.type === "ok" ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-error/10 text-cur-error"
                        }`}
                    >
                        {msg.text}
                    </div>
                )}

                {/* 역할 판정 실패 — fail-closed로 잠겨 있으니 복구 수단을 화면에 준다 */}
                {!ctxLoading && !ctx && (
                    <div className="bg-cur-card rounded-2xl border border-cur-hairline px-4 py-3.5 flex items-center justify-between gap-3">
                        <p className="text-[13px] text-cur-muted">역할 확인에 실패해 업종·공종 수정이 잠겨 있어요.</p>
                        <button
                            type="button"
                            onClick={() => loadCtx(true)}
                            className="shrink-0 h-8 px-3 rounded-[8px] border border-cur-hairline bg-cur-elevated text-[12px] font-semibold text-cur-ink hover:border-cur-primary/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                        >
                            다시 시도
                        </button>
                    </div>
                )}

                <div className="bg-cur-card rounded-2xl p-5 border border-cur-hairline space-y-4">
                    {isMember && (
                        <p className="text-[12px] text-cur-muted">
                            업종·공종은 회사 공통 설정이라 감독자가 관리해요. 나머지는 직접 수정하실 수 있어요.
                        </p>
                    )}
                    <div className="space-y-2">
                        <Label className="text-[13px] font-medium text-cur-body">성명</Label>
                        <Input
                            value={fullName}
                            onChange={(e) => setFullName(e.target.value)}
                            placeholder="성명을 입력하세요"
                            className="h-11"
                            disabled={!ownEditable}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label className="text-[13px] font-medium text-cur-body">소속 현장명 (또는 업체명)</Label>
                        <Input
                            value={companyName}
                            onChange={(e) => setCompanyName(e.target.value)}
                            placeholder="소속 현장명 (또는 업체명)"
                            className="h-11"
                            disabled={!ownEditable}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label className="text-[13px] font-medium text-cur-body">근로자 구분 (교육시간 산정용)</Label>
                        <Select value={workerType} onValueChange={setWorkerType} disabled={!ownEditable}>
                            <SelectTrigger className="w-full h-11 text-[14px]">
                                <SelectValue placeholder="직군 선택" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="현장 근로자 (비사무직)">비사무직 (반기 12시간)</SelectItem>
                                <SelectItem value="사무직 / 판매직">사무직 (반기 6시간)</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-2">
                        <Label className="text-[13px] font-medium text-cur-body">업종 (대분류)</Label>
                        <Select
                            value={industry}
                            onValueChange={(v) => {
                                setIndustry(v)
                                // 중분류가 하나뿐인 업종은 공종을 자동 선택 (가입 위저드와 동일 규칙)
                                const next = findKsicMajor(v)?.minors ?? []
                                setWorkCategory(next.length === 1 ? next[0].name : "")
                            }}
                            disabled={!companyEditable}
                        >
                            <SelectTrigger className="w-full h-11 text-[14px]">
                                <SelectValue placeholder="업종 선택" />
                            </SelectTrigger>
                            <SelectContent>
                                {KSIC_MAJORS.map((m) => (
                                    <SelectItem key={m.code} value={m.name}>
                                        {m.name}
                                    </SelectItem>
                                ))}
                                {isLegacyIndustry && (
                                    <SelectItem value={industry}>{industry} (이전 항목)</SelectItem>
                                )}
                            </SelectContent>
                        </Select>
                    </div>
                    {industry && (
                        <div className="space-y-2">
                            <Label className="text-[13px] font-medium text-cur-body">공종 (중분류)</Label>
                            <Select value={workCategory} onValueChange={setWorkCategory} disabled={!companyEditable}>
                                <SelectTrigger className="w-full h-11 text-[14px]">
                                    <SelectValue placeholder="공종 선택" />
                                </SelectTrigger>
                                <SelectContent>
                                    {minors.map((mi) => (
                                        <SelectItem key={mi.code} value={mi.name}>
                                            {mi.name}
                                        </SelectItem>
                                    ))}
                                    {isLegacyWorkCategory && (
                                        <SelectItem value={workCategory}>{workCategory} (이전 항목)</SelectItem>
                                    )}
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                    {/* solo에게는 숨김 — 아직 자식 현장이 없어 '모든 현장 계정' 문구가 혼란만 준다 */}
                    {ctx?.kind === "owner" && (
                        <p className="text-[12px] text-cur-muted">
                            업종·공종은 회사 공통 설정이에요 — 저장하면 모든 현장 계정에 함께 적용됩니다.
                            성명·현장명·근로자 구분은 각 현장 계정이 직접 수정해요.
                        </p>
                    )}
                    {/* 문서 출력 형식은 여기서 뺐다(Chris) — 보고서 설정 > 문서 형식 탭이 단일 창구 */}
                </div>

                {/* 복구용 이메일 = 보고서 수신 이메일 — '내 이메일'의 단일 창구.
                    입력창을 따로 만들지 않는다: 비밀번호 재설정 메일도 여기서 인증한 주소로만 나간다
                    (lib/accountRecovery.ts). 홈 배너의 '등록해주세요'가 이 카드로 내려온다(#recovery-email). */}
                <div id="recovery-email" className="scroll-mt-4 bg-cur-card rounded-2xl p-5 border border-cur-hairline space-y-3">
                    <div className="flex items-center gap-2">
                        <Mail className="w-4 h-4 text-cur-muted shrink-0" />
                        <Label className="text-[13px] font-medium text-cur-body">복구용 이메일</Label>
                        {/* 조회 전에는 아무 배지도 띄우지 않는다 — 인증된 계정에 '미등록'이 한 번 번쩍이면 거짓말이 된다 */}
                        {emailLoaded && (
                            reportEmail ? (
                                <span className="ml-auto flex items-center gap-1 text-[11px] font-semibold text-cur-success shrink-0">
                                    <CheckCircle2 className="w-3.5 h-3.5" /> 인증됨
                                </span>
                            ) : pendingEmail ? (
                                <span className="ml-auto text-[11px] font-semibold text-cur-primary shrink-0">인증 대기</span>
                            ) : (
                                <span className="ml-auto text-[11px] font-semibold text-cur-error shrink-0">미등록</span>
                            )
                        )}
                    </div>
                    <p className="text-[12px] text-cur-body leading-relaxed">
                        비밀번호를 잊으면 이 주소로만 되찾을 수 있어요. 보고서 받을 주소로도 함께 쓰입니다.
                    </p>
                    <div className="flex gap-2">
                        <Input
                            type="email"
                            value={emailInput}
                            onChange={(e) => setEmailInput(e.target.value)}
                            placeholder="name@company.com"
                            className="h-11"
                        />
                        <Button
                            onClick={sendEmailVerify}
                            disabled={emailBusy || !emailInput.trim() || emailInput.trim() === reportEmail}
                            className="h-11 px-4 rounded-xl bg-cur-ink text-white font-bold hover:opacity-90 shrink-0 disabled:opacity-40"
                        >
                            {emailBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : "인증 메일"}
                        </Button>
                    </div>
                    {pendingEmail && pendingEmail !== reportEmail && (
                        <p className="text-[12px] text-cur-primary leading-relaxed">
                            <b>{pendingEmail}</b> 인증 대기 중 — 메일함의 링크를 눌러야 바뀝니다.
                        </p>
                    )}
                    <p className="text-[12px] text-cur-muted-soft leading-relaxed">
                        주소를 바꾸면 출력/발송 설정의 받는 사람도 새 주소로 함께 옮겨져요.
                    </p>
                    {emailMsg && <p className="text-[12px] text-cur-error">{emailMsg}</p>}
                </div>

                <Button
                    onClick={handleSave}
                    disabled={saving || !dirty || !ownEditable}
                    className="w-full h-12 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90"
                >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "저장"}
                </Button>
            </div>
        </div>
    )
}
