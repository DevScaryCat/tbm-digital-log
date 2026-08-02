"use client"

/* Hallmark · component: page (현장 통계) · genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * states: loading · scope(전체/현장 — 같은 UI, 데이터만 범위별) · empty-risk(예시) · error(재시도)
 * tokens only — hairline depth, card radius 12px
 */

// 현장 통계 (감독자 전용) — 헤더 '모든 현장 통계' 버튼으로 진입하는 전용 대시보드.
// 전체·현장 선택은 같은 UI를 쓴다(Chris): 셀렉트는 데이터 범위만 바꾸고 화면 구조는 그대로.
// 셀렉트에 '내 현장'은 없다 — 본인 기록은 홈이 이미 보여주므로, 여기 목록은 소속 현장만.
// '전체' 합산에는 감독자 본인 현장도 포함한다(월간 보고서·청구 계정 수와 같은 기준).
import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useOrgContext } from "@/lib/useOrgContext"
import { secondsToHours, formatHoursProgress } from "@/lib/educationHours"
import { Loader2, Building2 } from "lucide-react"

interface DailyPoint { date: string; minutes: number; logs: number }
// items는 구버전 응답(statsCache 잔존)에 없을 수 있어 optional — 접근은 항상 ?? [] 가드
interface KwOccurrence { date: string; minuteId: string; siteId: string; factor: string }
interface RiskAgg { levels: { high: number; mid: number; low: number }; keywords: { word: string; count: number; items?: KwOccurrence[] }[] }

interface SiteRow {
    userId: string
    siteName: string
    /** 법정 정기교육 의무시간 분기 키 — 구형 캐시 응답엔 없을 수 있어 optional */
    workerType?: string
    status: "active" | "detached"
    isSelf: boolean
    todayDone: boolean
    monthMinutes: number
    monthLogs: number
    totalMinutes: number
    totalLogs: number
    suggestions: number
    daily: DailyPoint[]
    risk: RiskAgg
}

interface Overview {
    kind: "owner" | "member" | "solo"
    todayDoneCount: number
    today: string
    sites: SiteRow[]
    daily?: DailyPoint[]
    risk?: RiskAgg
}

// 현장별 법정 정기교육 진행도 — 반기 구간 조회라 overview와 분리해 늦게 불러온다
interface EduData { half: string; seconds: Record<string, number> }

// 한 번에 보여줄 현장 수. 넘치면 '더 보기'가 화면에 들어오는 순간 자동으로 다음 묶음을 편다.
const SITES_PAGE = 8

// 재진입 시 풀 로딩(수 초)을 없애는 SWR 캐시 — 캐시로 즉시 그리고 뒤에서 조용히 갱신
let statsCache: { userId: string; data: Overview } | null = null
let eduCache: { userId: string; data: EduData } | null = null
if (typeof window !== "undefined") {
    supabase.auth.onAuthStateChange((event) => {
        if (event === "SIGNED_OUT" || event === "SIGNED_IN") { statsCache = null; eduCache = null }
    })
}

export default function OrgStatsPage() {
    const router = useRouter()
    const { ctx, loading: ctxLoading } = useOrgContext()
    const [data, setData] = useState<Overview | null>(statsCache?.data ?? null)
    const [loading, setLoading] = useState(!statsCache)
    // "all" 또는 소속 현장 userId — 내 현장은 목록에 없다
    const [sel, setSel] = useState<string>("all")
    // 펼쳐진 위험 키워드 (김대리 제안: 키워드 → 날짜·근거 → 회의록 딥링크) — 한 번에 하나만
    const [openKw, setOpenKw] = useState<string | null>(null)
    // 교육 진행도 — 화면 아래 카드라 첫 렌더를 막지 않고 따로 불러온다
    const [edu, setEdu] = useState<EduData | null>(eduCache?.data ?? null)
    const [eduLoading, setEduLoading] = useState(!eduCache)
    const [visibleSites, setVisibleSites] = useState(SITES_PAGE)

    // 실패 판정은 '로딩 끝났는데 data 없음' — 캐시가 있으면 조용한 갱신 실패는 화면을 건드리지 않는다
    const load = useCallback(async () => {
        try {
            const { data: s } = await supabase.auth.getSession()
            const uid = s?.session?.user?.id
            if (!uid) return
            if (statsCache && statsCache.userId !== uid) {
                statsCache = null
                setData(null)
                setLoading(true)
            }
            const res = await fetch("/api/org/overview", { headers: { Authorization: `Bearer ${s?.session?.access_token}` } })
            if (!res.ok) return
            const j = (await res.json()) as Overview
            setData(j)
            statsCache = { userId: uid, data: j }
        } catch { /* 아래 !data 카드가 재시도를 제공 */ } finally {
            setLoading(false)
        }
    }, [])

    // 데이터 로드는 역할 판정과 병렬로 시작 — 직렬 대기(ctx → fetch)가 첫 진입을 느리게 했다
    useEffect(() => { load() }, [load])

    // 교육 진행도 — 실패해도 위쪽 통계는 그대로 살아있어야 하므로 이 카드 안에서만 상태를 말한다
    useEffect(() => {
        let cancelled = false
        ;(async () => {
            try {
                const { data: s } = await supabase.auth.getSession()
                const uid = s?.session?.user?.id
                if (!uid) return
                if (eduCache && eduCache.userId !== uid) { eduCache = null; setEdu(null) }
                const res = await fetch("/api/org/education", { headers: { Authorization: `Bearer ${s?.session?.access_token}` } })
                if (!res.ok) return
                const j = (await res.json()) as EduData
                if (cancelled) return
                setEdu(j)
                eduCache = { userId: uid, data: j }
            } catch { /* 카드가 '불러오지 못했어요'를 대신 말한다 */ } finally {
                if (!cancelled) setEduLoading(false)
            }
        })()
        return () => { cancelled = true }
    }, [])

    // 회의록에서 뒤로 돌아온 경우 직전 범위·펼친 키워드 복원 (1회용 — dash_restore와 같은 규약).
    // 근거 여러 건을 하나씩 확인하는 루프에서 매번 현장 재선택+키워드 재펼침을 반복하지 않게.
    useEffect(() => {
        try {
            const saved = sessionStorage.getItem("stats_restore")
            if (saved) {
                sessionStorage.removeItem("stats_restore")
                const { sel: s, openKw: k } = JSON.parse(saved)
                if (typeof s === "string") setSel(s)
                if (typeof k === "string") setOpenKw(k)
            }
        } catch { /* 무시 */ }
    }, [])
    useEffect(() => {
        if (!ctxLoading && (!ctx || ctx.kind !== "owner")) router.replace("/")
    }, [ctx, ctxLoading, router])

    const activeSites = (data?.sites ?? []).filter((s) => s.status === "active")
    const memberSites = activeSites.filter((s) => !s.isSelf)
    const selected = sel === "all" ? null : memberSites.find((s) => s.userId === sel) ?? null

    // 선택 현장이 해제 등으로 사라지면 전체로 복귀 (셀렉트 빈 값 방지)
    useEffect(() => {
        if (sel !== "all" && data && !memberSites.some((s) => s.userId === sel)) setSel("all")
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data, sel])

    // ── 범위 뷰모델 — 전체/현장이 같은 UI를 쓰고 여기 값만 달라진다 ──
    const scopeSites = selected ? [selected] : activeSites
    const todayCount = selected ? (selected.todayDone ? 1 : 0) : (data?.todayDoneCount ?? 0)
    const mMinutes = scopeSites.reduce((a, x) => a + x.monthMinutes, 0)
    const mLogs = scopeSites.reduce((a, x) => a + x.monthLogs, 0)
    const tMinutes = scopeSites.reduce((a, x) => a + x.totalMinutes, 0)
    const tLogs = scopeSites.reduce((a, x) => a + x.totalLogs, 0)
    const tSuggestions = scopeSites.reduce((a, x) => a + x.suggestions, 0)
    const daily = (selected ? selected.daily : data?.daily) ?? []
    const risk = selected ? selected.risk : data?.risk
    const riskTotal = risk ? risk.levels.high + risk.levels.mid + risk.levels.low : 0
    // 펼친 키워드의 근거 목록 — 구형 캐시(items 없음)나 범위 전환으로 사라진 단어면 빈 배열
    const openItems = (openKw ? risk?.keywords.find((k) => k.word === openKw)?.items : null) ?? []

    const dow = ["일", "월", "화", "수", "목", "금", "토"]
    const hasWeekData = daily.some((d) => d.minutes + d.logs > 0)
    const maxDay = Math.max(1, ...daily.map((d) => d.minutes + d.logs))

    // ── 법정 의무 교육 진행도 ── 홈·교육 진행도 화면과 같은 규칙(lib/educationHours)으로 계산한다
    const requiredHoursOf = (wt?: string) => (wt === "사무직 / 판매직" ? 6 : 12)
    const eduRows = scopeSites.map((s) => {
        const sec = edu?.seconds?.[s.userId] ?? 0
        const req = requiredHoursOf(s.workerType)
        const pct = req > 0 ? (secondsToHours(sec) / req) * 100 : 0
        return { userId: s.userId, siteName: s.siteName, isSelf: s.isSelf, workerType: s.workerType, sec, req, pct, done: pct >= 100 }
    })
    // 덜 채운 현장이 위로 — 목록을 잘라 보여주므로 순서가 곧 우선순위다.
    // 감독자가 이 목록을 여는 이유는 "누가 아직 안 했나"이지 알파벳 순서가 아니다.
    const eduSorted = [...eduRows].sort((a, b) => a.pct - b.pct)
    const eduDone = eduRows.filter((r) => r.done).length

    // '더 보기'가 화면에 들어오면 자동으로 다음 묶음을 편다(무한 스크롤) — 버튼은 그대로 눌러도 된다
    const moreRef = useRef<HTMLButtonElement | null>(null)
    useEffect(() => {
        const el = moreRef.current
        if (!el) return
        const io = new IntersectionObserver(
            (entries) => { if (entries.some((e) => e.isIntersecting)) setVisibleSites((v) => v + SITES_PAGE) },
            { rootMargin: "80px" },
        )
        io.observe(el)
        return () => io.disconnect()
    }, [visibleSites, eduLoading, sel, data])

    return (
        <div className="min-h-screen bg-cur-canvas font-sans">
            <div className="max-w-lg mx-auto px-4 pt-4">
                <TBMHeader title="현장 통계" backHref="/" />
            </div>
            <main className="max-w-lg mx-auto px-5 py-6 space-y-4 pb-16">
                {loading || ctxLoading ? (
                    <div className="py-24 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-cur-muted" /></div>
                ) : !data ? (
                    <div className="bg-cur-card rounded-[12px] border border-cur-hairline px-4 py-3.5 flex items-center justify-between gap-3">
                        <p className="text-[13px] text-cur-muted">통계를 불러오지 못했어요.</p>
                        <button
                            type="button"
                            onClick={() => { setLoading(true); load() }}
                            className="shrink-0 h-8 px-3 rounded-[8px] border border-cur-hairline bg-cur-elevated text-[12px] font-semibold text-cur-ink hover:border-cur-primary/40 transition-colors"
                        >
                            다시 시도
                        </button>
                    </div>
                ) : (
                    <>
                        {/* 현장 선택 — 데이터 범위만 바꾼다. 전체와 현장 목록은 구분선+라벨로 구획.
                            범위가 바뀌면 키워드 펼침도 접는다 — 다른 범위의 근거가 남아 보이면 오해를 산다 */}
                        <Select value={sel} onValueChange={(v) => { setSel(v); setOpenKw(null); setVisibleSites(SITES_PAGE) }}>
                            <SelectTrigger className="w-full h-14 px-4 text-[16px] font-bold border-cur-hairline rounded-[12px] bg-cur-card text-cur-ink shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                                <span className="flex items-center gap-2.5 min-w-0">
                                    <Building2 className="w-5 h-5 text-cur-muted shrink-0" />
                                    <SelectValue />
                                </span>
                            </SelectTrigger>
                            <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                                <SelectItem value="all" className="text-[15px] py-3 font-semibold">전체</SelectItem>
                                {memberSites.length > 0 && (
                                    <>
                                        <SelectSeparator className="bg-cur-hairline" />
                                        <SelectGroup>
                                            <SelectLabel className="text-[11px] font-semibold text-cur-muted-soft px-8 pt-1.5">소속 현장</SelectLabel>
                                            {memberSites.map((s) => (
                                                <SelectItem key={s.userId} value={s.userId} className="text-[15px] py-3">{s.siteName}</SelectItem>
                                            ))}
                                        </SelectGroup>
                                    </>
                                )}
                            </SelectContent>
                        </Select>

                        {/* 활동 기록 — 이번 달 3타일 + 7일 차트 + 누적 한 줄 (전체/현장 공통 UI) */}
                        <section className="bg-cur-card rounded-[12px] border border-cur-hairline p-5 space-y-4">
                            <div className="flex items-center justify-between gap-3">
                                <h2 className="text-[14px] font-bold text-cur-ink truncate">{selected ? selected.siteName : "활동 기록"}</h2>
                                <span className="text-[12px] text-cur-muted-soft shrink-0">이번 달 · 차트는 최근 7일</span>
                            </div>
                            <div className="grid grid-cols-3 gap-px bg-cur-hairline border border-cur-hairline rounded-[12px] overflow-hidden text-center">
                                <div className="bg-cur-card py-3.5">
                                    <p className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1">오늘 실시</p>
                                    <p className="text-[24px] leading-none font-bold font-mono">
                                        <span className={todayCount > 0 ? "text-cur-success" : "text-cur-primary"}>{todayCount}</span>
                                        <span className="text-[15px] text-cur-muted">/{scopeSites.length}</span>
                                    </p>
                                </div>
                                <div className="bg-cur-card py-3.5">
                                    <p className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1">TBM 회의록</p>
                                    <p className="text-[24px] leading-none font-bold text-cur-ink font-mono">{mMinutes}</p>
                                </div>
                                <div className="bg-cur-card py-3.5">
                                    <p className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.6px] mb-1">교육일지</p>
                                    <p className="text-[24px] leading-none font-bold text-cur-ink font-mono">{mLogs}</p>
                                </div>
                            </div>
                            {hasWeekData ? (
                                <div className="flex items-end justify-between gap-1.5 h-20 pt-1" aria-label="최근 7일 기록 수">
                                    {daily.map((d) => {
                                        const v = d.minutes + d.logs
                                        const [dy, dm, dd] = d.date.split("-").map(Number)
                                        const kstDow = new Date(dy, dm - 1, dd).getDay()
                                        const isToday = d.date === data.today
                                        return (
                                            <div key={d.date} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                                                <span className={`text-[10px] leading-none font-mono ${v > 0 ? "text-cur-body font-semibold" : "text-cur-muted-soft"}`}>{v > 0 ? v : ""}</span>
                                                <div className="w-full h-12 flex items-end">
                                                    <div
                                                        className={`w-full rounded-t-[4px] ${v > 0 ? "bg-cur-primary" : "bg-cur-elevated"}`}
                                                        style={{ height: v > 0 ? `${Math.max(14, Math.round((v / maxDay) * 100))}%` : "4px" }}
                                                    />
                                                </div>
                                                <span className={`text-[10px] leading-none ${isToday ? "font-bold text-cur-ink" : "text-cur-muted-soft"}`}>{isToday ? "오늘" : dow[kstDow]}</span>
                                            </div>
                                        )
                                    })}
                                </div>
                            ) : (
                                /* 빈 차트 영역을 그대로 두면 화면이 횅해진다 — 자리 대신 상태를 말한다 */
                                <p className="text-[12px] text-cur-muted-soft text-center rounded-[8px] border border-dashed border-cur-hairline-strong py-4">
                                    최근 7일 기록이 없어요 — 기록이 쌓이면 요일별 차트가 채워집니다
                                </p>
                            )}
                            <div className="pt-3 border-t border-cur-hairline flex items-center justify-between gap-3 text-[12px]">
                                <span className="text-cur-muted font-semibold shrink-0">누적 · 전체 기간</span>
                                <span className="text-cur-body text-right">
                                    회의록 <b className="text-cur-ink font-mono">{tMinutes}</b> · 일지 <b className="text-cur-ink font-mono">{tLogs}</b> · 제안 <b className="text-cur-ink font-mono">{tSuggestions}</b>
                                </span>
                            </div>
                        </section>

                        {/* 이번 달 위험요인 — 데이터 없으면 예시 스켈레톤 (전체/현장 공통 UI) */}
                        <section className="bg-cur-card rounded-[12px] border border-cur-hairline p-5 space-y-4">
                            <div className="flex items-center justify-between">
                                <h2 className="text-[14px] font-bold text-cur-ink">이번 달 위험요인</h2>
                                {riskTotal > 0 ? (
                                    <span className="text-[12px] text-cur-muted-soft">{riskTotal}건 식별</span>
                                ) : (
                                    <span className="text-[10px] font-bold text-cur-muted bg-cur-elevated border border-cur-hairline rounded-full px-2 py-0.5">예시</span>
                                )}
                            </div>
                            {riskTotal === 0 ? (
                                <div className="relative">
                                    <div aria-hidden className="space-y-4 opacity-40 grayscale-[0.3] select-none pointer-events-none">
                                        <div className="space-y-2">
                                            <div className="flex h-2.5 rounded-full overflow-hidden bg-cur-elevated">
                                                <div className="bg-cur-error" style={{ width: "22%" }} />
                                                <div className="bg-cur-primary" style={{ width: "50%" }} />
                                                <div className="bg-cur-success" style={{ width: "28%" }} />
                                            </div>
                                            <div className="flex items-center gap-4 text-[12px]">
                                                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-cur-error" /><span className="text-cur-body">상 <b className="text-cur-ink">2</b></span></span>
                                                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-cur-primary" /><span className="text-cur-body">중 <b className="text-cur-ink">5</b></span></span>
                                                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-cur-success" /><span className="text-cur-body">하 <b className="text-cur-ink">3</b></span></span>
                                            </div>
                                        </div>
                                        <div className="space-y-1.5">
                                            <p className="text-[12px] font-semibold text-cur-muted">자주 나온 위험 키워드</p>
                                            <div className="flex flex-wrap gap-1.5">
                                                {[["추락", 4], ["끼임", 3], ["지게차", 3], ["개구부", 2], ["감전", 1]].map(([w, c]) => (
                                                    <span key={String(w)} className="text-[12px] font-medium text-cur-ink bg-cur-elevated border border-cur-hairline rounded-full px-2.5 py-1">
                                                        {w} <span className="text-cur-muted-soft">{c}</span>
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                    <p className="text-[12px] text-cur-muted mt-3">TBM 회의록이 쌓이면 실제 데이터로 채워져요.</p>
                                </div>
                            ) : (
                                <>
                                    <div className="space-y-2">
                                        <div className="flex h-2.5 rounded-full overflow-hidden bg-cur-elevated">
                                            {risk!.levels.high > 0 && <div className="bg-cur-error" style={{ width: `${(risk!.levels.high / riskTotal) * 100}%` }} />}
                                            {risk!.levels.mid > 0 && <div className="bg-cur-primary" style={{ width: `${(risk!.levels.mid / riskTotal) * 100}%` }} />}
                                            {risk!.levels.low > 0 && <div className="bg-cur-success" style={{ width: `${(risk!.levels.low / riskTotal) * 100}%` }} />}
                                        </div>
                                        <div className="flex items-center gap-4 text-[12px]">
                                            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-cur-error" /><span className="text-cur-body">상 <b className="text-cur-ink">{risk!.levels.high}</b></span></span>
                                            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-cur-primary" /><span className="text-cur-body">중 <b className="text-cur-ink">{risk!.levels.mid}</b></span></span>
                                            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-cur-success" /><span className="text-cur-body">하 <b className="text-cur-ink">{risk!.levels.low}</b></span></span>
                                        </div>
                                    </div>
                                    {risk!.keywords.length > 0 && (
                                        <div className="space-y-1.5">
                                            <p className="text-[12px] font-semibold text-cur-muted">자주 나온 위험 키워드</p>
                                            <div className="flex flex-wrap gap-1.5">
                                                {risk!.keywords.map((k) => {
                                                    // 구형 캐시 응답엔 items가 없다 — 펼칠 게 없으면 종전처럼 정적 칩
                                                    if ((k.items ?? []).length === 0) return (
                                                        <span key={k.word} className="text-[12px] font-medium text-cur-ink bg-cur-elevated border border-cur-hairline rounded-full px-2.5 py-1">
                                                            {k.word} <span className="text-cur-muted-soft">{k.count}</span>
                                                        </span>
                                                    )
                                                    const active = openKw === k.word
                                                    return (
                                                        <button
                                                            key={k.word}
                                                            type="button"
                                                            aria-expanded={active}
                                                            onClick={() => setOpenKw(active ? null : k.word)}
                                                            className={`text-[12px] font-medium rounded-full px-2.5 py-1 border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary ${
                                                                active
                                                                    ? "border-cur-primary/40 bg-cur-primary/10 text-cur-primary"
                                                                    : "text-cur-ink bg-cur-elevated border-cur-hairline hover:border-cur-primary/40"
                                                            }`}
                                                        >
                                                            {k.word} <span className={active ? "text-cur-primary/70" : "text-cur-muted-soft"}>{k.count}</span>
                                                        </button>
                                                    )
                                                })}
                                            </div>
                                            {openItems.length > 0 && (
                                                <div className="pt-1 space-y-1.5">
                                                    <p className="text-[11px] text-cur-muted-soft">기록을 누르면 그날의 TBM 회의록이 열립니다</p>
                                                    <div className="rounded-[8px] border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                                                        {openItems.map((it, i) => {
                                                            const site = data.sites.find((s) => s.userId === it.siteId)
                                                            return (
                                                                <button
                                                                    key={`${it.minuteId}-${i}`}
                                                                    type="button"
                                                                    onClick={() => {
                                                                        // 뒤로가기 복원용 스냅샷 — 리마운트로 sel/openKw가 초기화되는 것 방지
                                                                        try { sessionStorage.setItem("stats_restore", JSON.stringify({ sel, openKw })) } catch { /* 무시 */ }
                                                                        router.push(`/report/minutes/${it.minuteId}`)
                                                                    }}
                                                                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-cur-elevated/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-inset"
                                                                >
                                                                    <span className="text-[12px] font-mono text-cur-muted shrink-0">{it.date.slice(5).replace("-", ".")}</span>
                                                                    <span className="flex-1 min-w-0 text-[13px] text-cur-body truncate">{it.factor}</span>
                                                                    {/* 현장명 배지는 전체 스코프에서만 — 현장을 이미 골랐으면 중복 정보 */}
                                                                    {!selected && site && (
                                                                        <span className="shrink-0 max-w-[104px] truncate text-[10px] font-semibold text-cur-muted bg-cur-elevated border border-cur-hairline rounded-full px-2 py-0.5">
                                                                            {site.isSelf ? "내 현장" : site.siteName}
                                                                        </span>
                                                                    )}
                                                                </button>
                                                            )
                                                        })}
                                                    </div>
                                                    {/* 근거는 최신 20건에서 절단(서버) — 표시가 전부라는 오해 방지 */}
                                                    {openItems.length >= 20 && (
                                                        <p className="text-[11px] text-cur-muted-soft">최근 기록 20건까지만 표시돼요</p>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </>
                            )}
                        </section>

                        {/* 법정 의무 교육 진행도 — 위험요인 바로 아래(Chris).
                            현장을 고르면 그 현장 한 줄, 전체면 현장 목록 전부를 막대로. */}
                        <section className="bg-cur-card rounded-[12px] border border-cur-hairline p-5 space-y-4">
                            <div className="flex items-center justify-between gap-3">
                                <h2 className="text-[14px] font-bold text-cur-ink">법정 의무 교육 진행도</h2>
                                <span className="text-[12px] text-cur-muted-soft shrink-0">{edu?.half ? `${edu.half} 기준` : "이번 반기"}</span>
                            </div>

                            {eduLoading ? (
                                <div className="py-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-cur-muted-soft" /></div>
                            ) : !edu ? (
                                <p className="text-[12px] text-cur-muted-soft text-center rounded-[8px] border border-dashed border-cur-hairline-strong py-4">
                                    교육 진행도를 불러오지 못했어요.
                                </p>
                            ) : (
                                <>
                                    {/* 전체일 때만 요약 한 줄 — 현장 하나를 보고 있으면 아래 막대가 이미 전부다 */}
                                    {!selected && (
                                        <p className="text-[12px] text-cur-muted">
                                            {eduRows.length}곳 중 <b className="text-cur-ink">{eduDone}곳</b> 이수 완료 · 덜 채운 현장이 위에 옵니다
                                        </p>
                                    )}
                                    <div className="space-y-3.5">
                                        {eduSorted.slice(0, selected ? 1 : visibleSites).map((r) => (
                                            <div key={r.userId} className="space-y-1.5">
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className="flex items-center gap-2 min-w-0">
                                                        <span className="text-[13px] font-semibold text-cur-ink truncate">{r.isSelf ? "내 현장" : r.siteName}</span>
                                                        {selected && (
                                                            <span className="shrink-0 bg-cur-primary/15 px-2 py-0.5 rounded-[4px] text-[11px] text-cur-primary font-semibold">
                                                                {r.workerType || "현장 근로자 (비사무직)"}
                                                            </span>
                                                        )}
                                                    </span>
                                                    <span className="text-[12px] font-mono whitespace-nowrap shrink-0">
                                                        <span className={r.done ? "text-cur-success font-bold" : "text-cur-body font-bold"}>{formatHoursProgress(r.sec)}</span>
                                                        <span className="text-cur-muted-soft"> / {r.req}시간</span>
                                                        <span className={`ml-1.5 font-bold ${r.done ? "text-cur-success" : "text-cur-primary"}`}>{Math.floor(r.pct)}%</span>
                                                    </span>
                                                </div>
                                                <div className="w-full h-2 bg-cur-elevated rounded-full overflow-hidden">
                                                    <div
                                                        className={`h-full rounded-full transition-[width] duration-700 ease-out ${r.done ? "bg-cur-success" : "bg-cur-primary"}`}
                                                        style={{ width: `${Math.min(100, r.pct)}%` }}
                                                    />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                    {!selected && visibleSites < eduSorted.length && (
                                        <button
                                            ref={moreRef}
                                            type="button"
                                            onClick={() => setVisibleSites((v) => v + SITES_PAGE)}
                                            className="w-full h-9 rounded-[8px] border border-cur-hairline bg-cur-elevated text-[12px] font-semibold text-cur-ink hover:border-cur-primary/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                                        >
                                            남은 {eduSorted.length - visibleSites}곳 더 보기
                                        </button>
                                    )}
                                </>
                            )}

                            <p className="text-[12px] text-cur-muted leading-relaxed">
                                반기별 12시간 이상(사무직·판매직 6시간) · 정기교육은 <span className="font-semibold text-cur-body">TBM으로 대체 가능</span>합니다(고용노동부 지침).
                            </p>
                        </section>
                    </>
                )}
            </main>
        </div>
    )
}
