"use client"

// 좌석·계정 관리 (안전관리자 전용) — 하위 현장 계정 발급/초대/편입/해제 + 좌석 증감.
import { useEffect, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, Copy, KeyRound, UserMinus, Plus, Link2, UserPlus2 } from "lucide-react"
import { useOrgContext } from "@/lib/useOrgContext"

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
    const [seatCount, setSeatCount] = useState(0)
    const [pendingSeat, setPendingSeat] = useState<number | null>(null)
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState<string | null>(null)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)

    // 직접 발급 폼
    const [showCreate, setShowCreate] = useState(false)
    const [newId, setNewId] = useState("")
    const [newPw, setNewPw] = useState("")
    const [newSite, setNewSite] = useState("")
    const [newManager, setNewManager] = useState("")
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
                setSeatCount(j.seatCount ?? 0)
                setPendingSeat(j.pendingSeatCount ?? null)
            }
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        if (ctxLoading) return
        if (!ctx || ctx.kind !== "owner") { router.replace("/"); return }
        load()
    }, [ctx, ctxLoading, router, load])

    const activeCount = members.filter((m) => m.status === "active").length
    const seatsLeft = Math.max(0, seatCount - activeCount)

    const createMember = async () => {
        setMsg(null)
        setBusy("create")
        try {
            const res = await fetch("/api/org/members", {
                method: "POST",
                headers: await authHeaders(),
                body: JSON.stringify({ loginId: newId, password: newPw, siteName: newSite, managerName: newManager }),
            })
            const j = await res.json()
            if (!res.ok) { setMsg({ type: "err", text: j.error || "발급 실패" }); return }
            setMsg({ type: "ok", text: `계정이 만들어졌어요. 아이디 [${j.loginId}] 와 비밀번호를 현장 담당자에게 전달하세요.` })
            setNewId(""); setNewPw(""); setNewSite(""); setNewManager(""); setShowCreate(false)
            await load()
        } finally {
            setBusy(null)
        }
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
        if (!window.confirm(`[${siteName}] 현장을 좌석에서 해제할까요?\n계정과 기록은 남지만, 해제 즉시 그 계정은 회사 이용권을 잃습니다.`)) return
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

    const changeSeats = async (action: "increase" | "decrease" | "cancel_decrease") => {
        setMsg(null)
        let body: Record<string, unknown> = { action }
        if (action === "increase") {
            const n = Number(window.prompt("몇 좌석을 추가할까요? (잔여 기간 일할 요금이 즉시 결제됩니다)", "1"))
            if (!Number.isFinite(n) || n < 1) return
            body = { action, add: Math.floor(n) }
        }
        if (action === "decrease") {
            const n = Number(window.prompt(`몇 좌석으로 줄일까요? (현재 ${seatCount}석 · 다음 결제일부터 적용)`, String(Math.max(1, seatCount - 1))))
            if (!Number.isFinite(n) || n < 1) return
            body = { action, to: Math.floor(n) }
        }
        setBusy("seats")
        try {
            const res = await fetch("/api/org/seats", { method: "POST", headers: await authHeaders(), body: JSON.stringify(body) })
            const j = await res.json()
            if (!res.ok) { setMsg({ type: "err", text: j.error || "좌석 변경 실패" }); return }
            if (action === "increase") setMsg({ type: "ok", text: `좌석을 추가했어요 (일할 ${Number(j.charged).toLocaleString()}원 결제).` })
            if (action === "decrease") setMsg({ type: "ok", text: "다음 결제일부터 좌석이 줄어들어요." })
            if (action === "cancel_decrease") setMsg({ type: "ok", text: "좌석 축소 예약을 취소했어요." })
            await load()
        } finally {
            setBusy(null)
        }
    }

    return (
        <div className="min-h-screen bg-cur-canvas font-sans">
            <TBMHeader title="좌석·계정 관리" backHref="/" />
            <main className="max-w-2xl mx-auto px-5 py-6 space-y-5 pb-16">
                {msg && (
                    <div className={`text-[13px] rounded-lg p-3 ${msg.type === "ok" ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-error/10 text-cur-error"}`}>{msg.text}</div>
                )}

                {/* 좌석 현황 */}
                <section className="bg-cur-card rounded-2xl border border-cur-hairline p-5 space-y-3">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-[13px] text-cur-muted">좌석</p>
                            <p className="text-[20px] font-bold text-cur-ink">{activeCount} / {seatCount} 사용</p>
                            {pendingSeat != null && (
                                <p className="text-[12px] text-cur-muted mt-0.5">
                                    다음 결제일부터 {pendingSeat}석으로 변경 예약
                                    <button onClick={() => changeSeats("cancel_decrease")} className="ml-2 text-cur-primary font-semibold">취소</button>
                                </p>
                            )}
                        </div>
                        <div className="flex gap-2">
                            <Button onClick={() => changeSeats("increase")} disabled={busy === "seats"} className="h-10 px-3 rounded-lg bg-cur-ink text-white text-[13px] font-bold">좌석 추가</Button>
                            {seatCount > 1 && (
                                <Button onClick={() => changeSeats("decrease")} disabled={busy === "seats"} variant="outline" className="h-10 px-3 rounded-lg border-cur-hairline text-cur-muted text-[13px] font-semibold">축소</Button>
                            )}
                        </div>
                    </div>
                    <p className="text-[12px] text-cur-muted-soft">좌석당 월 4,900원. 추가는 즉시(잔여기간 일할 결제), 축소는 다음 결제일부터 적용돼요.</p>
                </section>

                {/* 현장 계정 추가 (3경로) */}
                <section className="bg-cur-card rounded-2xl border border-cur-hairline p-5 space-y-4">
                    <div className="flex items-center justify-between">
                        <h2 className="text-[15px] font-bold text-cur-ink">현장 계정 추가</h2>
                        <span className="text-[12px] text-cur-muted">남은 좌석 {seatsLeft}개</span>
                    </div>

                    {/* ① 직접 발급 (메인) */}
                    {!showCreate ? (
                        <Button onClick={() => setShowCreate(true)} disabled={seatsLeft <= 0} className="w-full h-12 rounded-xl bg-cur-primary text-white font-bold hover:opacity-90">
                            <UserPlus2 className="w-4 h-4 mr-2" /> 계정 만들어서 전달하기
                        </Button>
                    ) : (
                        <div className="rounded-xl border border-cur-hairline p-4 space-y-3">
                            <div className="grid grid-cols-2 gap-2">
                                <div className="space-y-1"><Label className="text-[12px]">아이디</Label><Input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="영문·숫자 3~20자" className={inputCls} /></div>
                                <div className="space-y-1"><Label className="text-[12px]">비밀번호</Label><Input value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="8자 이상" className={inputCls} /></div>
                            </div>
                            <div className="space-y-1"><Label className="text-[12px]">현장명</Label><Input value={newSite} onChange={(e) => setNewSite(e.target.value)} placeholder="예: OO물류센터 신축현장" className={inputCls} /></div>
                            <div className="space-y-1"><Label className="text-[12px]">담당자 이름 (선택)</Label><Input value={newManager} onChange={(e) => setNewManager(e.target.value)} placeholder="현장 관리감독자 성함" className={inputCls} /></div>
                            <div className="flex gap-2">
                                <Button onClick={() => setShowCreate(false)} variant="outline" className="flex-1 h-11 rounded-lg border-cur-hairline text-cur-muted font-semibold">취소</Button>
                                <Button onClick={createMember} disabled={busy === "create" || !newId || !newPw || !newSite} className="flex-1 h-11 rounded-lg bg-cur-primary text-white font-bold">
                                    {busy === "create" ? <Loader2 className="w-4 h-4 animate-spin" /> : "만들기"}
                                </Button>
                            </div>
                        </div>
                    )}

                    {/* ② 초대 링크 (보조) */}
                    <div className="space-y-2">
                        <button onClick={createInviteLink} disabled={busy === "link" || seatsLeft <= 0} className="text-[13px] font-semibold text-cur-primary flex items-center gap-1.5 disabled:opacity-40">
                            <Link2 className="w-4 h-4" /> {busy === "link" ? "생성 중…" : "초대 링크 만들기 (14일 유효)"}
                        </button>
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
                    </div>

                    {/* ③ 기존 계정 편입 */}
                    <div className="pt-3 border-t border-cur-hairline space-y-2">
                        <Label className="text-[13px] font-semibold text-cur-ink">이미 안톡을 쓰던 현장이 있나요?</Label>
                        <p className="text-[12px] text-cur-muted-soft">그 계정의 아이디를 입력하면 편입 초대가 가요. 기존 기록은 그대로 유지됩니다.</p>
                        <div className="flex gap-2">
                            <Input value={attachId} onChange={(e) => setAttachId(e.target.value)} placeholder="기존 계정 아이디" className={inputCls + " flex-1"} />
                            <Button onClick={requestAttach} disabled={busy === "attach" || !attachId.trim() || seatsLeft <= 0} className="h-11 px-4 rounded-lg bg-cur-ink text-white text-[13px] font-bold shrink-0">
                                {busy === "attach" ? <Loader2 className="w-4 h-4 animate-spin" /> : "편입 초대"}
                            </Button>
                        </div>
                    </div>
                </section>

                {/* 현장 목록 */}
                <section className="space-y-2">
                    <h2 className="text-[14px] font-bold text-cur-ink px-1">연결된 현장</h2>
                    {loading ? (
                        <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-cur-muted" /></div>
                    ) : members.length === 0 ? (
                        <p className="text-[13px] text-cur-muted-soft text-center py-8">아직 연결된 현장이 없어요.</p>
                    ) : (
                        <div className="bg-cur-card rounded-2xl border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                            {members.map((m) => (
                                <div key={m.userId} className="flex items-center gap-3 p-4">
                                    <div className="flex-1 min-w-0">
                                        <p className={`text-[14px] font-semibold truncate ${m.status === "active" ? "text-cur-ink" : "text-cur-muted-soft line-through"}`}>{m.siteName || "현장명 미설정"}</p>
                                        <p className="text-[12px] text-cur-muted mt-0.5">
                                            {m.managerName && `${m.managerName} · `}
                                            {m.status === "active" ? `연결 ${m.joinedAt?.slice(0, 10)}` : "해제됨"}
                                        </p>
                                    </div>
                                    {m.status === "active" && (
                                        <>
                                            <button onClick={() => resetPassword(m.userId, m.siteName)} disabled={busy === m.userId} aria-label="비밀번호 변경" className="h-9 w-9 rounded-lg flex items-center justify-center text-cur-muted hover:text-cur-ink hover:bg-cur-elevated transition-colors">
                                                <KeyRound className="w-4 h-4" />
                                            </button>
                                            <button onClick={() => detach(m.userId, m.siteName)} disabled={busy === m.userId} aria-label="좌석 해제" className="h-9 w-9 rounded-lg flex items-center justify-center text-cur-muted hover:text-cur-error hover:bg-cur-error/5 transition-colors">
                                                <UserMinus className="w-4 h-4" />
                                            </button>
                                        </>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            </main>
        </div>
    )
}
