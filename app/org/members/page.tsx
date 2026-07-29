"use client"

// 현장 계정 관리 (감독자 전용) — 계정 발급/초대/편입/해제.
// 좌석 선구매는 없앴다 — 계정을 만들면 그 자리에서 일할 청구되고, 다음 주기부터 계정 수만큼 청구된다.
import { useEffect, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, Copy, KeyRound, UserMinus, Plus, Minus, Link2, UserPlus2, CheckCircle2, ChevronRight } from "lucide-react"
import { useOrgContext } from "@/lib/useOrgContext"
import { suggestIdStems, suggestInitialPassword, sanitizeStem, STEM_RE } from "@/lib/romanize"
import { fetchSubscription, type SubscriptionRow } from "@/lib/useSubscription"

const inputCls =
    "h-11 rounded-[8px] bg-cur-elevated border-cur-hairline text-[15px] font-medium text-cur-ink placeholder:text-cur-muted-soft focus-visible:ring-1 focus-visible:ring-cur-primary"

interface MemberRow {
    userId: string
    siteName: string
    managerName: string
    status: "active" | "detached"
    joinedAt: string
}

export default function OrgMembersPage() {
    const router = useRouter()
    const { ctx, loading: ctxLoading } = useOrgContext()
    const [members, setMembers] = useState<MemberRow[]>([])
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState<string | null>(null)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)

    // 일괄 발급 폼 — 시드 + 개수 + 공용 초기 비밀번호. 현장명·새 비밀번호는
    // 담당자가 첫 로그인 온보딩에서 직접 정한다.
    // 추가 마법사: count(몇 개) → method(방식 선택) → direct(직접 발급) | link(초대 링크)
    const [addStep, setAddStep] = useState<null | "count" | "method" | "direct" | "link">(null)
    const [stem, setStem] = useState("")
    const [count, setCount] = useState(1)
    const [initPw, setInitPw] = useState("")
    const [formErr, setFormErr] = useState<string | null>(null)
    const [createdIds, setCreatedIds] = useState<string[] | null>(null)
    // 청구 미리보기용 구독 정보 (체험 여부·다음 결제일)
    const [sub, setSub] = useState<SubscriptionRow | null>(null)
    // 편입 폼
    const [attachId, setAttachId] = useState("")
    // 초대 링크
    const [inviteUrl, setInviteUrl] = useState<string | null>(null)

    const authHeaders = async () => {
        const { data } = await supabase.auth.getSession()
        return { "Content-Type": "application/json", Authorization: `Bearer ${data?.session?.access_token}` }
    }

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch("/api/org/members", { headers: await authHeaders() })
            if (res.ok) {
                const j = await res.json()
                setMembers(j.members ?? [])
            }
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        if (ctxLoading) return
        // 아직 회사가 없는 단독 계정도 들어와야 한다 — 첫 현장을 만드는 화면이 여기다.
        if (!ctx || ctx.kind === "member") { router.replace("/"); return }
        load()
    }, [ctx, ctxLoading, router, load])

    // 첫 진입 온보딩("현장 계정 만들기")에서 넘어온 경우 발급 폼을 바로 펼친다.
    // useSearchParams는 정적 렌더에서 Suspense를 요구해 window로 직접 읽는다.
    useEffect(() => {
        if (typeof window === "undefined") return
        const sp = new URLSearchParams(window.location.search)
        if (sp.get("new") !== "1") return
        // /org/setup에서 이미 고른 개수·방식은 다시 묻지 않고 해당 단계로 직행
        const c = Math.floor(Number(sp.get("count")))
        if (Number.isFinite(c) && c >= 1 && c <= 20) setCount(c)
        const m = sp.get("method")
        setAddStep(m === "direct" ? "direct" : m === "link" ? "method" : "count")
    }, [])

    // 아이디 시드 추천 — 회사명 로마자 (예: '하이' → hai01, hai02…)
    useEffect(() => {
        ;(async () => {
            const { data } = await supabase.auth.getUser()
            const name = String(data?.user?.user_metadata?.company_name ?? "")
            // 추천 칩은 없앴다(혼란) — 회사명 로마자를 입력칸 기본값으로만 깔아준다
            const sugg = suggestIdStems(name)
            setStem((cur) => cur || sugg[0] || "")
            setInitPw((cur) => cur || suggestInitialPassword())
            setSub(await fetchSubscription())
        })()
    }, [])

    const activeCount = members.filter((m) => m.status === "active").length

    // 한글·띄어쓰기를 입력해도 아이디 규칙으로 자동 변환 ("하이 물류" → hai_mulryu)
    const effStem = sanitizeStem(stem)

    const createBulk = async () => {
        setFormErr(null)
        setMsg(null)
        if (!STEM_RE.test(effStem)) { setFormErr("아이디로 만들 수 있는 글자가 부족해요. 영문·숫자·한글 2자 이상 입력해주세요."); return }
        if (initPw.length < 8) { setFormErr("초기 비밀번호는 8자 이상이어야 해요."); return }
        setBusy("create")
        try {
            const res = await fetch("/api/org/members/bulk", {
                method: "POST",
                headers: await authHeaders(),
                body: JSON.stringify({ stem: effStem, count, password: initPw }),
            })
            const j = await res.json()
            if (!res.ok) { setFormErr(j.error || "발급 실패") ; return }
            setCreatedIds(j.created ?? [])
            await load()
        } finally {
            setBusy(null)
        }
    }

    const copyCreated = async () => {
        if (!createdIds) return
        const text = [
            "[안톡] 현장 계정 안내",
            ...createdIds.map((id) => `아이디: ${id}`),
            `초기 비밀번호: ${initPw}`,
            "",
            "safetalk.kr 에 로그인하면 첫 화면에서 새 비밀번호와 현장명을 설정하게 됩니다.",
        ].join("\n")
        try { await navigator.clipboard.writeText(text); setMsg({ type: "ok", text: "계정 목록을 복사했어요. 담당자들에게 전달하세요." }) } catch { /* 무시 */ }
    }

    const createInviteLink = async () => {
        setMsg(null)
        setBusy("link")
        try {
            const res = await fetch("/api/org/invites", {
                method: "POST",
                headers: await authHeaders(),
                body: JSON.stringify({ kind: "link" }),
            })
            const j = await res.json()
            if (!res.ok) { setMsg({ type: "err", text: j.error || "링크 생성 실패" }); return }
            setAddStep("link")
            setInviteUrl(`${window.location.origin}/join/${j.token}`)
        } finally {
            setBusy(null)
        }
    }

    const requestAttach = async () => {
        setMsg(null)
        setBusy("attach")
        try {
            const res = await fetch("/api/org/invites", {
                method: "POST",
                headers: await authHeaders(),
                body: JSON.stringify({ kind: "attach", loginId: attachId }),
            })
            const j = await res.json()
            if (!res.ok) { setMsg({ type: "err", text: j.error || "편입 초대 실패" }); return }
            setMsg({ type: "ok", text: `편입 초대를 보냈어요. [${attachId}] 계정이 다음 로그인 때 수락하면 연결됩니다.` })
            setAttachId("")
        } finally {
            setBusy(null)
        }
    }

    const resetPassword = async (userId: string, siteName: string) => {
        const pw = window.prompt(`[${siteName}] 새 비밀번호 (8자 이상)\n담당자가 바뀌었을 때 사용하세요.`)
        if (!pw) return
        setBusy(userId)
        setMsg(null)
        try {
            const res = await fetch("/api/org/members", {
                method: "PATCH",
                headers: await authHeaders(),
                body: JSON.stringify({ userId, newPassword: pw }),
            })
            const j = await res.json()
            setMsg(res.ok ? { type: "ok", text: "비밀번호를 변경했어요. 새 담당자에게 전달하세요." } : { type: "err", text: j.error || "변경 실패" })
        } finally {
            setBusy(null)
        }
    }

    const detach = async (userId: string, siteName: string) => {
        if (!window.confirm(`[${siteName}] 현장을 해제할까요?\n계정과 기록은 남지만, 해제 즉시 그 계정은 회사 이용권을 잃고 다음 결제부터 요금에서 빠집니다.`)) return
        setBusy(userId)
        setMsg(null)
        try {
            const res = await fetch(`/api/org/members?userId=${encodeURIComponent(userId)}`, {
                method: "DELETE",
                headers: await authHeaders(),
            })
            const j = await res.json()
            if (!res.ok) { setMsg({ type: "err", text: j.error || "해제 실패" }); return }
            await load()
        } finally {
            setBusy(null)
        }
    }


    return (
        <div className="min-h-screen bg-cur-canvas font-sans">
            <div className="max-w-lg mx-auto px-4 pt-4">
                <TBMHeader title="현장 계정 관리" backHref="/" />
            </div>
            <main className="max-w-lg mx-auto px-5 py-6 space-y-5 pb-16">
                {msg && (
                    <div className={`text-[13px] rounded-lg p-3 ${msg.type === "ok" ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-error/10 text-cur-error"}`}>{msg.text}</div>
                )}

                {/* 이 화면은 계정 관리 하나만 한다 (Chris) — 요금 계산기·별도 추가 카드는 삭제,
                    목록(수정·삭제) + 목록 끝의 추가 행으로 통합. 요금 얘기는 구독 및 결제가 담당.
                    위저드는 추가 행을 눌렀을 때만 나타난다. */}
                {(addStep !== null || createdIds) && (
                <section className="bg-cur-card rounded-2xl border border-cur-hairline p-5 space-y-4">
                    <h2 className="text-[15px] font-bold text-cur-ink">현장 계정 추가</h2>
                    {ctx?.kind === "solo" && addStep !== null && !createdIds && (
                        <div className="rounded-xl bg-cur-primary/[0.06] border border-cur-primary/25 px-4 py-3 space-y-1">
                            <p className="text-[13px] font-bold text-cur-primary">첫 현장 계정을 만들면 이 계정이 회사 감독자가 돼요</p>
                            <p className="text-[12px] text-cur-muted leading-relaxed">
                                문서 출력 형식 같은 회사 공통 설정을 이 계정이 정하고, 모든 현장 계정이 따르게 됩니다.
                                현장별 기록·보고서도 여기서 모아 봐요.
                            </p>
                        </div>
                    )}

                    {/* ① 일괄 발급 (메인) — 시드+개수+초기 비밀번호. 현장명·새 비밀번호는 담당자 첫 로그인 때 */}
                    {createdIds ? (
                        <div className="rounded-xl border border-cur-success/30 bg-cur-success/5 p-4 space-y-3">
                            <p className="flex items-center gap-1.5 text-[14px] font-bold text-cur-success">
                                <CheckCircle2 className="w-4 h-4" /> 계정 {createdIds.length}개를 만들었어요
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                                {createdIds.map((id) => (
                                    <span key={id} className="text-[13px] font-mono font-semibold text-cur-ink bg-cur-card border border-cur-hairline rounded-[6px] px-2 py-1">{id}</span>
                                ))}
                            </div>
                            <p className="text-[12px] text-cur-muted leading-relaxed">
                                초기 비밀번호는 전부 <b className="text-cur-ink font-mono">{initPw}</b> 예요.
                                담당자가 처음 로그인하면 새 비밀번호와 현장명을 직접 설정합니다.
                            </p>
                            <div className="flex gap-2">
                                <Button onClick={copyCreated} className="flex-1 h-11 rounded-lg bg-cur-ink text-white text-[13px] font-bold">
                                    <Copy className="w-4 h-4 mr-1.5" /> 계정 목록 복사
                                </Button>
                                <Button onClick={() => { setCreatedIds(null); setAddStep(null) }} variant="outline" className="h-11 px-4 rounded-lg border-cur-hairline text-cur-muted font-semibold">닫기</Button>
                            </div>
                        </div>
                    ) : addStep === "count" ? (
                        /* 1단계 — 몇 개? */
                        <div className="rounded-xl border border-cur-hairline p-4 space-y-4">
                            <p className="text-[14px] font-semibold text-cur-ink">몇 개 현장을 추가할까요?</p>
                            <div className="flex items-center justify-center gap-5">
                                <button onClick={() => setCount((c) => Math.max(1, c - 1))} disabled={count <= 1} aria-label="줄이기"
                                    className="w-11 h-11 rounded-[8px] border border-cur-hairline bg-cur-elevated text-cur-ink flex items-center justify-center disabled:opacity-40"><Minus className="w-4 h-4" /></button>
                                <span className="w-12 text-center text-[28px] font-bold tabular-nums">{count}</span>
                                <button onClick={() => setCount((c) => Math.min(20, c + 1))} aria-label="늘리기"
                                    className="w-11 h-11 rounded-[8px] border border-cur-hairline bg-cur-elevated text-cur-ink flex items-center justify-center"><Plus className="w-4 h-4" /></button>
                            </div>
                            {/* 요금 계산기 카드가 사라진 자리 — 청구 규칙 한 줄만 남긴다 */}
                            <p className="text-[12px] text-cur-muted-soft text-center leading-relaxed">
                                계정 1개당 월 3,900원 · {sub?.status === "trialing" ? "무료체험 중엔 결제되지 않아요" : "추가는 남은 기간만큼 즉시 결제"}
                            </p>
                            <div className="flex gap-2">
                                <Button onClick={() => setAddStep(null)} variant="outline" className="flex-1 h-11 rounded-lg border-cur-hairline text-cur-muted font-semibold">취소</Button>
                                <Button onClick={() => setAddStep("method")} className="flex-[2] h-11 rounded-lg bg-cur-primary text-white font-bold">다음</Button>
                            </div>
                        </div>
                    ) : addStep === "method" ? (
                        /* 2단계 — 계정을 누가 만들까? */
                        <div className="rounded-xl border border-cur-hairline p-4 space-y-3">
                            <p className="text-[14px] font-semibold text-cur-ink">계정 {count}개, 어떻게 만들까요?</p>
                            <button
                                onClick={() => setAddStep("direct")}
                                className="w-full flex items-center gap-3.5 p-4 rounded-[12px] border border-cur-hairline bg-cur-elevated hover:border-cur-primary/40 text-left transition-all"
                            >
                                <span className="w-10 h-10 shrink-0 rounded-[8px] bg-cur-primary/10 text-cur-primary flex items-center justify-center"><KeyRound className="w-5 h-5" /></span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-[14px] font-bold text-cur-ink">내가 만들어서 전달할래요</span>
                                    <span className="block text-[12px] text-cur-body mt-0.5 leading-snug">아이디·초기 비밀번호를 한 번에 만들어 담당자에게 알려줘요</span>
                                </span>
                                <ChevronRight className="w-4 h-4 shrink-0 text-cur-muted-soft" />
                            </button>
                            <button
                                onClick={createInviteLink}
                                disabled={busy === "link"}
                                className="w-full flex items-center gap-3.5 p-4 rounded-[12px] border border-cur-hairline bg-cur-elevated hover:border-cur-primary/40 text-left transition-all disabled:opacity-60"
                            >
                                <span className="w-10 h-10 shrink-0 rounded-[8px] bg-cur-ink/8 text-cur-ink flex items-center justify-center">
                                    {busy === "link" ? <Loader2 className="w-5 h-5 animate-spin" /> : <Link2 className="w-5 h-5" />}
                                </span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-[14px] font-bold text-cur-ink">담당자가 직접 만들게 할래요</span>
                                    <span className="block text-[12px] text-cur-body mt-0.5 leading-snug">초대 링크를 보내면 담당자가 스스로 가입해요</span>
                                </span>
                                <ChevronRight className="w-4 h-4 shrink-0 text-cur-muted-soft" />
                            </button>
                            <button onClick={() => setAddStep("count")} className="w-full h-9 text-[13px] font-medium text-cur-muted hover:text-cur-ink">이전</button>
                        </div>
                    ) : addStep === "link" ? (
                        /* 초대 링크 결과 */
                        <div className="rounded-xl border border-cur-hairline p-4 space-y-3">
                            <p className="text-[14px] font-semibold text-cur-ink">초대 링크가 준비됐어요</p>
                            {inviteUrl && (
                                <div className="flex items-center gap-2 rounded-lg bg-cur-elevated p-2.5">
                                    <span className="text-[12px] text-cur-body truncate flex-1 min-w-0">{inviteUrl}</span>
                                    <button
                                        onClick={() => { navigator.clipboard?.writeText(inviteUrl); setMsg({ type: "ok", text: "초대 링크를 복사했어요. 현장 담당자에게 보내세요." }) }}
                                        className="shrink-0 h-8 px-2.5 rounded-md bg-cur-card border border-cur-hairline text-[12px] font-semibold text-cur-ink flex items-center gap-1"
                                    >
                                        <Copy className="w-3.5 h-3.5" /> 복사
                                    </button>
                                </div>
                            )}
                            <p className="text-[12px] text-cur-muted leading-relaxed">
                                링크 하나로 여러 담당자가 가입할 수 있어요 (14일 유효).
                                가입이 끝나면 아래 목록에 자동으로 나타납니다.
                            </p>
                            {/* 편입은 드문 일이라(기존 안톡 계정 데려오기) 상시 노출하지 않고 여기서만 */}
                            <details className="group">
                                <summary className="text-[13px] font-medium text-cur-muted cursor-pointer list-none hover:text-cur-ink">
                                    이미 안톡을 쓰던 계정을 데려오려면 →
                                </summary>
                                <div className="flex gap-2 mt-2">
                                    <Input value={attachId} onChange={(e) => setAttachId(e.target.value)} placeholder="기존 계정 아이디" className={inputCls + " flex-1"} />
                                    <Button onClick={requestAttach} disabled={busy === "attach" || !attachId.trim()} className="h-11 px-4 rounded-lg bg-cur-ink text-white text-[13px] font-bold shrink-0">
                                        {busy === "attach" ? <Loader2 className="w-4 h-4 animate-spin" /> : "편입 초대"}
                                    </Button>
                                </div>
                                <p className="text-[11px] text-cur-muted-soft mt-1.5">그 계정이 다음 로그인 때 수락하면 편입돼요. 기존 기록은 그대로 유지됩니다.</p>
                            </details>
                            <Button onClick={() => setAddStep(null)} variant="outline" className="w-full h-11 rounded-lg border-cur-hairline text-cur-muted font-semibold">완료</Button>
                        </div>
                    ) : (
                        /* 직접 발급 — 아이디 규칙 설명을 눈앞에서 예시로 */
                        <div className="rounded-xl border border-cur-hairline p-4 space-y-4">
                            <div className="space-y-1.5">
                                <Label className="text-[12px]">아이디 앞부분</Label>
                                <p className="text-[12px] text-cur-muted leading-relaxed">
                                    이 글자 뒤에 01, 02… 번호가 붙어 현장 계정 아이디가 돼요.<br />
                                    한글로 적으면 영문으로 바꿔드려요.
                                </p>
                                <Input value={stem} onChange={(e) => setStem(e.target.value)} placeholder="예: 무신사 또는 musinsa" className={inputCls} />
                                {stem && effStem && sanitizeStem(stem) !== stem.toLowerCase() && (
                                    <p className="text-[12px] text-cur-muted">아이디로는 <b className="font-mono text-cur-ink">{effStem}</b> 를 사용해요</p>
                                )}
                            </div>
                            {STEM_RE.test(effStem) && (
                                <p className="text-[12px] text-cur-muted bg-cur-elevated rounded-[8px] px-3 py-2 font-mono">
                                    {Array.from({ length: Math.min(count, 3) }, (_, i) => `${effStem}${String(i + 1).padStart(2, "0")}`).join(", ")}{count > 3 ? ` … ${effStem}${String(count).padStart(2, "0")}` : ""} 로 만들어져요
                                </p>
                            )}
                            <div className="space-y-1">
                                <Label className="text-[12px]">공용 초기 비밀번호</Label>
                                <Input value={initPw} onChange={(e) => setInitPw(e.target.value)} className={inputCls + " font-mono"} />
                                <p className="text-[11px] text-cur-muted-soft">담당자가 처음 로그인하면 반드시 새 비밀번호로 바꾸게 돼요.</p>
                            </div>
                            {formErr && (
                                <p className="text-[13px] font-medium text-cur-error bg-cur-error/5 border border-cur-error/20 rounded-[8px] px-3 py-2">{formErr}</p>
                            )}
                            <div className="flex gap-2">
                                <Button onClick={() => { setAddStep("method"); setFormErr(null) }} variant="outline" className="flex-1 h-11 rounded-lg border-cur-hairline text-cur-muted font-semibold">이전</Button>
                                <Button onClick={createBulk} disabled={busy === "create" || !STEM_RE.test(effStem) || !initPw} className="flex-[2] h-11 rounded-lg bg-cur-primary text-white font-bold">
                                    {busy === "create" ? <Loader2 className="w-4 h-4 animate-spin" /> : `${count}개 만들기`}
                                </Button>
                            </div>
                        </div>
                    )}

                </section>
                )}

                {/* 현장 목록 — 수정(비번)·삭제(해제)·추가가 전부 이 카드 하나에서 */}
                <section className="space-y-2">
                    <h2 className="text-[14px] font-bold text-cur-ink px-1">
                        연결된 현장{activeCount > 0 && <span className="text-cur-muted-soft font-medium ml-1.5">{activeCount}곳</span>}
                    </h2>
                    {loading ? (
                        <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-cur-muted" /></div>
                    ) : (
                        <div className="bg-cur-card rounded-2xl border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                            {members.length === 0 && (
                                <p className="text-[13px] text-cur-muted-soft text-center py-6">아직 연결된 현장이 없어요.</p>
                            )}
                            {members.map((m) => (
                                <div key={m.userId} className="flex items-center gap-3 p-4">
                                    {/* 현장 목록 카드가 홈에서 빠지면서 여기가 현장 상세(/org/sites)의 입구가 됐다 */}
                                    <button
                                        type="button"
                                        disabled={m.status !== "active"}
                                        onClick={() => router.push(`/org/sites/${m.userId}`)}
                                        className="flex-1 min-w-0 text-left rounded-[8px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary disabled:cursor-default"
                                    >
                                        <p className={`text-[14px] font-semibold truncate ${m.status === "active" ? "text-cur-ink" : "text-cur-muted-soft line-through"}`}>{m.siteName || "현장명 미설정"}</p>
                                        <p className="text-[12px] text-cur-muted mt-0.5">
                                            {m.managerName && `${m.managerName} · `}
                                            {m.status === "active" ? `연결 ${m.joinedAt?.slice(0, 10)} · 기록 보기` : "해제됨"}
                                        </p>
                                    </button>
                                    {m.status === "active" && (
                                        <>
                                            <button onClick={() => resetPassword(m.userId, m.siteName)} disabled={busy === m.userId} aria-label="비밀번호 변경" className="h-9 w-9 rounded-lg flex items-center justify-center text-cur-muted hover:text-cur-ink hover:bg-cur-elevated transition-colors">
                                                <KeyRound className="w-4 h-4" />
                                            </button>
                                            <button onClick={() => detach(m.userId, m.siteName)} disabled={busy === m.userId} aria-label="현장 해제" className="h-9 w-9 rounded-lg flex items-center justify-center text-cur-muted hover:text-cur-error hover:bg-cur-error/5 transition-colors">
                                                <UserMinus className="w-4 h-4" />
                                            </button>
                                        </>
                                    )}
                                </div>
                            ))}
                            {/* 추가는 목록의 마지막 행 — 별도 카드 대신 (Chris 스케치) */}
                            <button
                                type="button"
                                onClick={() => { setCreatedIds(null); setAddStep("count") }}
                                className="w-full flex items-center gap-3 p-4 text-left hover:bg-cur-elevated/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-inset"
                            >
                                <span className="w-9 h-9 rounded-full border border-dashed border-cur-hairline-strong text-cur-muted flex items-center justify-center shrink-0">
                                    <UserPlus2 className="w-4 h-4" />
                                </span>
                                <span className="flex-1 min-w-0 text-[14px] font-semibold text-cur-body">현장 계정 추가하기</span>
                                <ChevronRight className="w-4 h-4 text-cur-muted-soft shrink-0" />
                            </button>
                        </div>
                    )}
                </section>

            </main>
        </div>
    )
}
