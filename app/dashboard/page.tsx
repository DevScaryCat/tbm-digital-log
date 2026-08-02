"use client"

/* Hallmark · component: page (출력 — 달력에서 날짜/기간을 잡아 문서를 뽑는 화면)
 * genre: modern-minimal · theme: DESIGN.md (Cursor DNA, locked)
 * states: loading · empty(미선택) · single-day · range · other-site(읽기전용) · pick
 * tokens only — hairline depth, card radius 12px
 */

// 선택 모델은 하나뿐이다(Chris): 모드 토글 없음.
//   1번 누름 → 그 날. 그 상태에서 다른 날을 누르면 → 그 기간.
//   한 번 더 누르면 → 거기서 새로 시작.
// 그 날 문서는 모달(드로어)이 아니라 달력 아래에 그대로 펼친다 — 모달은 "이건 딴 화면"이라고
// 말하는 표현인데, 여기서 날짜 선택과 문서 확인은 같은 한 가지 일이다.

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { fetchAllRows } from "@/lib/fetchAllRows"
import { useRequireSubscription } from "@/lib/useSubscription"
import { TBMHeader } from "@/components/TBMHeader"
import { format, parseISO, isSameDay, addDays, differenceInCalendarDays } from "date-fns"
import { ko } from "date-fns/locale"
import { DateRange } from "react-day-picker"
import { cn } from "@/lib/utils"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Plus, Printer, ChevronRight, Loader2, FileText, Building2, Sparkles } from "lucide-react"
import { useOrgContext } from "@/lib/useOrgContext"

export default function DashboardPage() {
    const router = useRouter()
    useRequireSubscription()
    const { ctx, loading: ctxLoading } = useOrgContext()
    const [logs, setLogs] = useState<any[]>([])
    const [loading, setLoading] = useState(true)

    // 현장은 한 번에 한 곳만 본다(Chris) — 여러 현장 합쳐보기는 실사용이 없어 걷어냈다.
    // 고르는 UI는 별도 화면이 아니라 셀렉트 하나(모든 현장 통계와 같은 모양).
    const [selfId, setSelfId] = useState<string | null>(null)
    const [memberSites, setMemberSites] = useState<{ userId: string; siteName: string }[]>([])
    const [sitesLoaded, setSitesLoaded] = useState(false)
    const [siteId, setSiteId] = useState<string | null>(null)
    const [pickErr, setPickErr] = useState<string | null>(null)
    // 내 현장일 때만 기존 경로(문서 열기·삭제·일괄 PDF). 다른 현장은 서버 경유 읽기 전용
    const selfMode = !siteId || siteId === selfId

    const [dateRange, setDateRange] = useState<DateRange | undefined>()
    const [dayDocs, setDayDocs] = useState<any[]>([])
    const [dayLoading, setDayLoading] = useState(false)
    const [rangeNote, setRangeNote] = useState<string | null>(null)

    const from = dateRange?.from
    const to = dateRange?.to
    // 끝점을 안 찍었거나 같은 날을 두 번 찍었으면 '하루' — 이때만 그 날 문서를 펼친다
    const singleDay = !!from && (!to || isSameDay(to, from))

    // 기간은 최대 1개월까지. rdp 표준 onSelect(단일 소스 제어)로 이중 하이라이트를 막고,
    // 클릭한 날(day) 기준으로 직접 판단: 시작 → 끝 → (다시 누르면) 새로 시작.
    const MAX_RANGE_DAYS = 31
    const handleSelect = (_range: DateRange | undefined, day: Date | undefined) => {
        if (!day) return
        if (dateRange?.from && !dateRange?.to) {
            // 끝점 선택 → 기간 완성 (앞뒤 순서 보정 + 1개월 초과 시 클램프)
            let a = dateRange.from
            let b = day
            if (b < a) { const t = a; a = b; b = t }
            if (differenceInCalendarDays(b, a) > MAX_RANGE_DAYS) {
                b = addDays(a, MAX_RANGE_DAYS)
                setRangeNote("기간은 최대 1개월까지 선택할 수 있어요. 1개월로 맞췄어요.")
            } else {
                setRangeNote(null)
            }
            setDateRange({ from: a, to: b })
        } else {
            // 비어있거나 이미 완성됨 → 이전 선택 풀고 이 날부터 새로 시작
            setDateRange({ from: day, to: undefined })
            setRangeNote(null)
        }
    }

    // 위험성평가/일괄 PDF에서 돌아온 경우: 직전 선택 범위 복원 (1회용)
    useEffect(() => {
        try {
            const saved = sessionStorage.getItem("dash_restore")
            if (saved) {
                sessionStorage.removeItem("dash_restore")
                const r = JSON.parse(saved)
                if (r?.from) setDateRange({ from: parseISO(r.from), to: r.to ? parseISO(r.to) : undefined })
            }
        } catch { /* 무시 */ }
    }, [])

    // 하루치 문서 상세는 온디맨드 조회 (본인=RLS 직조회 / 다른 현장=서버 경유)
    const fetchDayDetails = async (date: Date) => {
        const key = format(date, 'yyyy-MM-dd')
        if (!selfMode) {
            const { data: s } = await supabase.auth.getSession()
            const res = await fetch(`/api/org/site-docs?ids=${siteId}&day=${key}`, {
                headers: { Authorization: `Bearer ${s?.session?.access_token}` },
            })
            if (!res.ok) return []
            const j = await res.json()
            return (j.details ?? []) as any[]
        }
        const [{ data: logsData }, { data: minutesData }] = await Promise.all([
            supabase.from('tbm_logs').select('id, date, education_type, start_time, end_time, location, instructor_name').eq('date', key),
            supabase.from('tbm_minutes').select('id, date, start_time, end_time, location, leader_name').eq('date', key)
        ])
        const day: any[] = []
        if (logsData) day.push(...logsData.map(log => ({ ...log, type: 'log' })))
        if (minutesData) day.push(...minutesData.map(min => ({
            id: min.id,
            date: min.date,
            education_type: 'TBM 회의록',
            start_time: min.start_time,
            end_time: min.end_time,
            location: min.location,
            instructor_name: min.leader_name,
            type: 'minute'
        })))
        return day
    }

    // 하루를 고른 순간에만 상세를 불러온다 — 기간은 건수만 있으면 되므로 조회하지 않는다
    useEffect(() => {
        if (!from || !singleDay) { setDayDocs([]); return }
        if (!logs.some(l => isSameDay(parseISO(l.date), from))) { setDayDocs([]); return }
        let cancelled = false
        setDayLoading(true)
        ;(async () => {
            try {
                const d = await fetchDayDetails(from)
                if (!cancelled) setDayDocs(d)
            } catch {
                if (!cancelled) setDayDocs([])
            } finally {
                if (!cancelled) setDayLoading(false)
            }
        })()
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [from?.getTime(), singleDay, logs, siteId])

    // 본인 문서 로드 — 달력 점·기간 카운트는 id/date만
    const loadOwn = async () => {
        setLoading(true)
        try {
            const [logsData, minutesData] = await Promise.all([
                fetchAllRows<{ id: string; date: string }>((f, t) => supabase.from('tbm_logs').select('id, date').order('id').range(f, t)),
                fetchAllRows<{ id: string; date: string }>((f, t) => supabase.from('tbm_minutes').select('id, date').order('id').range(f, t))
            ])
            const combined: any[] = []
            combined.push(...logsData.map(log => ({ id: log.id, date: log.date, type: 'log' })))
            combined.push(...minutesData.map(min => ({ id: min.id, date: min.date, type: 'minute' })))
            combined.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
            setLogs(combined)
            return true
        } finally {
            setLoading(false)
        }
    }

    // 다른 현장 로드 — 서버 경유 읽기 전용
    const loadSites = async (id: string) => {
        setLoading(true)
        try {
            const { data: s } = await supabase.auth.getSession()
            const res = await fetch(`/api/org/site-docs?ids=${id}`, {
                headers: { Authorization: `Bearer ${s?.session?.access_token}` },
            })
            if (!res.ok) {
                const j = await res.json().catch(() => ({}))
                setPickErr(j.error || "문서를 불러오지 못했어요.")
                return false
            }
            const j = await res.json()
            setLogs(((j.docs ?? []) as any[]).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()))
            return true
        } finally {
            setLoading(false)
        }
    }

    // 진입 분기 — 감독자 포함 전원 내 현장 달력 직행(Chris). 현장 변경은 달력 안에서만.
    useEffect(() => {
        if (ctxLoading) return
        ;(async () => {
            const { data: { session } } = await supabase.auth.getSession()
            if (!session) { router.push("/login"); return }
            setSelfId(session.user.id)
            setSiteId(session.user.id)
            await loadOwn()
        })()
    }, [ctxLoading, router])

    // 소속 현장 명단은 뒤에서 미리 받아둔다 — 셀렉트를 열었을 때 '불러오는 중'을 보는 것이
    // 이 화면에서 유일하게 기다리는 구간이었다. 감독자가 아니면 셀렉트 자체가 없다.
    useEffect(() => {
        if (ctx?.kind === "owner") loadSiteOptions()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ctx?.kind])

    // 소속 현장 명단은 셀렉트를 처음 열 때만 불러온다 — 대부분은 내 현장만 보고 나간다
    const loadSiteOptions = async () => {
        if (sitesLoaded) return
        try {
            const { data: { session } } = await supabase.auth.getSession()
            const res = await fetch("/api/org/members", { headers: { Authorization: `Bearer ${session?.access_token}` } })
            const j = res.ok ? await res.json() : { members: [] }
            setMemberSites(
                ((j.members ?? []) as any[])
                    .filter((m) => m.status === "active")
                    .map((m) => ({ userId: m.userId, siteName: m.siteName || "현장명 미설정" }))
            )
        } catch { /* 목록이 비어도 '내 현장'은 항상 고를 수 있다 */ } finally {
            setSitesLoaded(true)
        }
    }

    // 고르는 즉시 적용. 로드에 실패하면 선택을 커밋하지 않는다 —
    // 셀렉트만 바뀌고 달력은 이전 현장 데이터인 어긋난 상태를 만들지 않기 위해.
    const pickSite = async (id: string) => {
        if (id === siteId) return
        setPickErr(null)
        const ok = id === selfId ? await loadOwn() : await loadSites(id)
        if (!ok) return
        setSiteId(id)
        setDateRange(undefined)
        setDayDocs([])
        setRangeNote(null)
    }

    const handleDelete = async (doc: any) => {
        const label = doc.type === 'minute' ? '회의록' : '교육일지'
        if (!confirm(`이 ${label}을(를) 삭제할까요?\n참석자·서명도 함께 삭제되며 되돌릴 수 없습니다.`)) return
        const table = doc.type === 'minute' ? 'tbm_minutes' : 'tbm_logs'
        const { error } = await supabase.from(table).delete().eq('id', doc.id)
        if (error) { alert('삭제 실패: ' + error.message); return }
        setLogs(prev => prev.filter(l => !(l.id === doc.id && l.type === doc.type)))
        setDayDocs(prev => prev.filter(l => !(l.id === doc.id && l.type === doc.type)))
    }

    // 선택 구간(하루면 그 하루) 안의 문서 id — PDF 일괄 저장용
    const inRange = (l: { date: string }) => {
        if (!from) return false
        const d = parseISO(l.date).getTime()
        return d >= from.getTime() && d <= (to ?? from).getTime()
    }
    const minutesInRange = from ? logs.filter(l => l.type === 'minute' && inRange(l)).length : 0
    const logsInRange = from ? logs.filter(l => l.type !== 'minute' && inRange(l)).length : 0

    const rangeKeys = () => ({
        from: format(from!, "yyyy-MM-dd"),
        to: format(to ?? from!, "yyyy-MM-dd"),
    })

    // 회의록+교육일지를 한 번에 — 문서 종류별 버튼 두 개는 "둘 다 받고 싶은" 대다수 상황에서 두 번 일하게 했다
    const batchDownloadAll = () => {
        if (!from) return
        const minuteIds = logs.filter(l => l.type === 'minute' && inRange(l)).map(l => l.id)
        const logIds = logs.filter(l => l.type !== 'minute' && inRange(l)).map(l => l.id)
        if (minuteIds.length === 0 && logIds.length === 0) return alert("선택한 날짜에 문서가 없습니다.")
        sessionStorage.setItem("dash_restore", JSON.stringify(rangeKeys()))
        localStorage.setItem("batch_minute_ids", JSON.stringify(minuteIds))
        localStorage.setItem("batch_print_ids", JSON.stringify(logIds))
        sessionStorage.setItem("batch_combined", "1") // 1회용 — batch 페이지가 읽고 지운다
        router.push("/report/batch")
    }

    // 선택 구간을 위험성평가 페이지의 기존 규약(ra_range)으로 넘겨 재선택 없이 바로 분석
    const goAnalysisReport = () => {
        if (!from) return
        const keys = rangeKeys()
        sessionStorage.setItem("dash_restore", JSON.stringify(keys))
        localStorage.setItem("ra_range", JSON.stringify(keys))
        router.push("/risk-assessment")
    }

    // 그 날짜에 교육일지(log) / 회의록(minute)이 있는지
    const hasLogOn = (date: Date) => logs.some(l => l.type !== 'minute' && isSameDay(parseISO(l.date), date))
    const hasMinuteOn = (date: Date) => logs.some(l => l.type === 'minute' && isSameDay(parseISO(l.date), date))

    const commonModifiers = {
        onlyLog: (date: Date) => hasLogOn(date) && !hasMinuteOn(date),
        onlyMinute: (date: Date) => hasMinuteOn(date) && !hasLogOn(date),
        bothDocs: (date: Date) => hasLogOn(date) && hasMinuteOn(date),
    }
    // 일지=주황 / 회의록=보라 / 둘다=보라+주황 나란히
    const commonModifiersClassNames = {
        onlyLog: "font-semibold relative after:content-[''] after:absolute after:bottom-1 after:left-1/2 after:-translate-x-1/2 after:w-[4px] after:h-[4px] after:rounded-full after:bg-cur-primary data-[selected=true]:after:bg-cur-card",
        onlyMinute: "font-semibold relative after:content-[''] after:absolute after:bottom-1 after:left-1/2 after:-translate-x-1/2 after:w-[4px] after:h-[4px] after:rounded-full after:bg-[#8145b5] data-[selected=true]:after:bg-cur-card",
        bothDocs: "font-semibold relative before:content-[''] before:absolute before:bottom-1 before:left-1/2 before:-translate-x-[5px] before:w-[4px] before:h-[4px] before:rounded-full before:bg-[#8145b5] after:content-[''] after:absolute after:bottom-1 after:left-1/2 after:translate-x-[1px] after:w-[4px] after:h-[4px] after:rounded-full after:bg-cur-primary data-[selected=true]:before:bg-cur-card data-[selected=true]:after:bg-cur-card",
    }
    const commonClassNames = {
        day_selected: "bg-cur-primary text-cur-on-primary hover:bg-cur-primary-active focus:bg-cur-primary rounded-[8px]",
        day_today: "bg-cur-canvas text-cur-ink font-semibold rounded-[8px]",
    }

    if (loading || ctxLoading) return <div className="min-h-screen flex justify-center items-center bg-cur-canvas"><Loader2 className="animate-spin w-10 h-10 text-cur-ink" /></div>

    return (
        <div className="min-h-screen bg-cur-canvas pb-24 font-sans text-cur-ink">
            <div className="max-w-lg mx-auto min-h-screen bg-cur-card shadow-sm border-x border-cur-hairline overflow-hidden relative flex flex-col">
                <div className="p-4 border-b border-cur-hairline bg-cur-card sticky top-0 z-10">
                    <TBMHeader title="출력" />
                </div>

                <div className="p-6 space-y-4 flex-1 bg-cur-canvas-soft">

                    {/* 감독자 — 볼 현장 하나 (모든 현장 통계와 같은 셀렉트 모양) */}
                    {ctx?.kind === "owner" && selfId && (
                        <div className="space-y-1.5">
                            <Select value={siteId ?? selfId} onValueChange={pickSite} onOpenChange={(open) => { if (open) loadSiteOptions() }}>
                                <SelectTrigger className="w-full h-14 px-4 text-[16px] font-bold border-cur-hairline rounded-[12px] bg-cur-card text-cur-ink shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                                    <span className="flex items-center gap-2.5 min-w-0">
                                        <Building2 className="w-5 h-5 text-cur-muted shrink-0" />
                                        <SelectValue />
                                    </span>
                                </SelectTrigger>
                                <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                                    <SelectItem value={selfId} className="text-[15px] py-3 font-semibold">내 현장</SelectItem>
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
                                    {!sitesLoaded && (
                                        <p className="px-8 py-2.5 text-[12px] text-cur-muted-soft">소속 현장 불러오는 중…</p>
                                    )}
                                </SelectContent>
                            </Select>
                            {pickErr && <p className="text-[12px] text-cur-error px-1">{pickErr}</p>}
                        </div>
                    )}

                    <div className="border border-cur-hairline rounded-[12px] p-2 sm:p-4 shadow-[0_4px_12px_rgba(0,0,0,0.02)] bg-cur-card flex justify-center overflow-x-auto">
                        <Calendar
                            mode="range"
                            selected={dateRange}
                            onSelect={handleSelect}
                            locale={ko}
                            className="w-full"
                            modifiers={commonModifiers}
                            modifiersClassNames={commonModifiersClassNames}
                            classNames={commonClassNames}
                        />
                    </div>

                    {!from ? (
                        <div className="text-center space-y-3 py-1">
                            <p className="text-[13px] text-cur-muted leading-relaxed">
                                날짜를 누르면 그 날 문서가 보이고,
                                <br />한 번 더 누르면 그 사이 기간으로 잡혀요.
                            </p>
                            <Button onClick={() => router.push('/')} className="w-full bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary h-12 text-[15px] font-medium rounded-[8px] shadow-[0_4px_12px_rgba(0,0,0,0.04)] transition-colors">
                                <Plus className="mr-2 w-5 h-5" /> 오늘 일지 작성하기
                            </Button>
                        </div>
                    ) : (
                        <div className="bg-cur-card border border-cur-hairline p-4 rounded-[12px] space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-200 motion-reduce:animate-none">
                            <div className="flex justify-between items-center gap-2">
                                <div className="font-semibold text-[15px] text-cur-ink">
                                    {singleDay
                                        ? format(from, "M월 d일 (EEE)", { locale: ko })
                                        : `${format(from, "MM.dd")} ~ ${format(to!, "MM.dd")}`}
                                </div>
                                <span className="text-[12px] text-cur-muted shrink-0">회의록 {minutesInRange}건 · 교육일지 {logsInRange}건</span>
                            </div>

                            {rangeNote && (
                                <p className="text-[12px] text-amber-600 bg-amber-50 rounded-[8px] px-3 py-2 -mt-1">{rangeNote}</p>
                            )}

                            {/* 하루를 골랐을 때만 그 날 문서를 펼친다 (기간은 건수로 충분) */}
                            {singleDay && (
                                dayLoading ? (
                                    <div className="py-6 flex justify-center"><Loader2 className="animate-spin w-5 h-5 text-cur-muted-soft" /></div>
                                ) : dayDocs.length === 0 ? (
                                    <div className="py-6 flex flex-col items-center text-cur-muted-soft">
                                        <FileText className="w-9 h-9 mb-2 opacity-25" />
                                        <p className="text-[13px]">이 날에는 작성된 문서가 없어요.</p>
                                    </div>
                                ) : (
                                    <div className="rounded-[8px] border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                                        {dayDocs.map((doc) => {
                                            // 본인 문서만 열람·삭제 가능 — 다른 현장 문서는 정보 행으로만 (서버 문서 뷰 미지원)
                                            const mine = selfMode || doc.siteId === selfId
                                            const isMinute = doc.type === 'minute'
                                            return (
                                                <div key={`${doc.type}-${doc.id}`} className="flex items-stretch bg-cur-card">
                                                    <span className={cn("w-[3px] shrink-0", isMinute ? "bg-[#8145b5]" : "bg-cur-primary")} />
                                                    <button
                                                        type="button"
                                                        disabled={!mine}
                                                        onClick={() => router.push(isMinute ? `/report/minutes/${doc.id}` : `/report/${doc.id}`)}
                                                        className="flex-1 min-w-0 text-left px-3 py-3 enabled:hover:bg-cur-elevated/60 enabled:active:bg-cur-elevated transition-colors disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-inset"
                                                    >
                                                        <span className="flex items-center gap-1.5 flex-wrap mb-1">
                                                            <span className={cn("text-[11px] font-medium text-cur-on-primary px-1.5 py-0.5 rounded-[4px]", isMinute ? "bg-[#8145b5]" : "bg-cur-primary")}>
                                                                {isMinute ? 'TBM 회의록' : '안전보건교육일지'}
                                                            </span>
                                                            {!selfMode && doc.siteName && (
                                                                <span className="text-[11px] font-semibold text-cur-ink bg-cur-elevated border border-cur-hairline px-1.5 py-0.5 rounded-[4px]">{doc.siteName}</span>
                                                            )}
                                                            <span className="text-[11px] text-cur-muted font-mono bg-cur-elevated px-1.5 py-0.5 rounded-[4px]">
                                                                {doc.start_time?.slice(0, 5)} ~ {doc.end_time?.slice(0, 5)}
                                                            </span>
                                                        </span>
                                                        <span className="block text-[14px] font-semibold text-cur-ink truncate">{doc.location}</span>
                                                        {doc.instructor_name && doc.instructor_name !== 'TBM (자율)' && (
                                                            <span className="block text-[12px] text-cur-muted-soft mt-0.5 truncate">
                                                                {isMinute ? '작성자' : '강사'}: {doc.instructor_name}
                                                            </span>
                                                        )}
                                                    </button>
                                                    {mine && (
                                                        <div className="flex items-center gap-0.5 pr-2 shrink-0">
                                                            <button
                                                                type="button"
                                                                onClick={() => handleDelete(doc)}
                                                                className="text-[12px] text-cur-muted hover:text-cur-error px-2 py-1 rounded-[6px] hover:bg-cur-error/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                                                            >
                                                                삭제
                                                            </button>
                                                            <ChevronRight className="text-cur-muted-soft w-4 h-4" />
                                                        </div>
                                                    )}
                                                </div>
                                            )
                                        })}
                                    </div>
                                )
                            )}

                            {/* 출력·분석 — 하루든 기간이든 같은 자리에서 같은 버튼으로 */}
                            {selfMode ? (
                                <div className="space-y-2">
                                    <Button
                                        onClick={batchDownloadAll}
                                        disabled={minutesInRange === 0 && logsInRange === 0}
                                        className="w-full bg-cur-primary text-cur-on-primary hover:bg-cur-primary-active h-11 text-[14px] font-bold rounded-[8px] disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        <Printer className="mr-2 w-4 h-4" /> 문서 PDF 저장 (회의록·교육일지)
                                    </Button>
                                    {/* member는 분석 대상이 아니다(/risk-assessment가 홈으로 돌려보냄) — 막다른 버튼을 아예 감춘다 */}
                                    {ctx && ctx.kind !== "member" && (
                                        <>
                                            <button
                                                type="button"
                                                onClick={goAnalysisReport}
                                                disabled={minutesInRange === 0}
                                                className="w-full h-10 rounded-[8px] border border-cur-hairline bg-cur-elevated text-[13px] font-semibold text-cur-ink hover:border-cur-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                                            >
                                                <Sparkles className="mr-2 w-4 h-4" /> 분석보고서 생성
                                            </button>
                                            {minutesInRange === 0 && (
                                                <p className="text-[12px] text-cur-muted-soft text-center">회의록이 있는 날짜·기간을 고르면 분석보고서를 만들 수 있어요</p>
                                            )}
                                        </>
                                    )}
                                    {dayDocs.length === 0 && singleDay && (
                                        <Button
                                            variant="outline"
                                            onClick={() => router.push('/')}
                                            className="w-full h-10 border-cur-hairline text-cur-ink text-[13px] font-semibold rounded-[8px]"
                                        >
                                            <Plus className="mr-2 w-4 h-4" /> 이 날짜에 작성하기
                                        </Button>
                                    )}
                                </div>
                            ) : (
                                /* 다른 현장 문서의 일괄 PDF는 서버 문서 뷰가 없어 아직 미지원 — 건수 확인용 */
                                <p className="text-[12px] text-cur-muted-soft text-center">
                                    PDF 저장·분석보고서는 내 현장을 볼 때 제공돼요.
                                </p>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
