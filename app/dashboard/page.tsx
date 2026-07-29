"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { fetchAllRows } from "@/lib/fetchAllRows"
import { useRequireSubscription } from "@/lib/useSubscription"
import { TBMHeader } from "@/components/TBMHeader"
import { format, parseISO, isSameDay, addDays, differenceInCalendarDays } from "date-fns"
import { ko } from "date-fns/locale"
import { DateRange } from "react-day-picker"
import { cn } from "@/lib/utils"

import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter, DrawerClose } from "@/components/ui/drawer"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Plus, Printer, ChevronRight, Loader2, Calendar as CalendarIcon, CheckCircle2, FileText, Circle, Building2 } from "lucide-react"
import { useOrgContext } from "@/lib/useOrgContext"

export default function DashboardPage() {
    const router = useRouter()
    useRequireSubscription()
    const { ctx, loading: ctxLoading } = useOrgContext()
    const [logs, setLogs] = useState<any[]>([])
    const [loading, setLoading] = useState(true)

    // 감독자: 현장을 먼저 고르고(최대 3곳 — 많이 고르면 로드가 길어진다) 달력으로 진행 (Chris)
    const [stage, setStage] = useState<"pick" | "cal">("cal")
    const [selfId, setSelfId] = useState<string | null>(null)
    const [siteOptions, setSiteOptions] = useState<{ userId: string; siteName: string; isSelf: boolean }[]>([])
    const [picked, setPicked] = useState<string[]>([])
    const [pickErr, setPickErr] = useState<string | null>(null)
    // 본인 현장만 볼 때(true)는 기존 경로(문서 열기·삭제·일괄 PDF) 그대로,
    // 다른 현장이 섞이면 서버 경유 읽기 전용 모드
    const [selfMode, setSelfMode] = useState(true)
    const [siteNameOf, setSiteNameOf] = useState<Map<string, string>>(new Map())
    const MAX_SITES = 3

    const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date())
    const [dateRange, setDateRange] = useState<DateRange | undefined>()
    const [isRangeMode, setIsRangeMode] = useState(true)
    const [isDrawerOpen, setIsDrawerOpen] = useState(false)
    const [selectedLogs, setSelectedLogs] = useState<any[]>([])
    const [drawerLoading, setDrawerLoading] = useState(false)
    const [rangeNote, setRangeNote] = useState<string | null>(null)

    // 기간 선택은 최대 1개월까지. rdp 표준 onSelect(단일 소스 제어)로 이중 하이라이트를 막고,
    // 클릭한 날(day) 기준으로 직접 판단: 시작 → 끝 → (다시 누르면) 새로 시작.
    // 이미 완성된 범위에서 다른 날(다른 달 포함)을 누르면 이전 범위를 풀고 그 날부터 새 범위를 시작한다.
    const MAX_RANGE_DAYS = 31
    const handleRangeSelect = (_range: DateRange | undefined, day: Date | undefined) => {
        if (!day) return
        if (dateRange?.from && !dateRange?.to) {
            // 끝점 선택 → 범위 완성 (앞뒤 순서 보정 + 1개월 초과 시 클램프)
            let from = dateRange.from
            let to = day
            if (to < from) { const t = from; from = to; to = t }
            if (differenceInCalendarDays(to, from) > MAX_RANGE_DAYS) {
                to = addDays(from, MAX_RANGE_DAYS)
                setRangeNote("기간은 최대 1개월까지 선택할 수 있어요. 1개월로 맞췄어요.")
            } else {
                setRangeNote(null)
            }
            setDateRange({ from, to })
        } else {
            // 비어있거나 이미 완성됨 → 이전 선택 풀고 이 날부터 새로 시작
            setDateRange({ from: day, to: undefined })
            setRangeNote(null)
        }
    }

    // 위험성평가/일괄 PDF에서 돌아온 경우: 직전 선택 범위 복원 (1회용).
    // 감독자 진입 분기가 이 플래그를 봐야 하므로(픽커를 건너뛰고 내 달력으로 직행) ref에 남긴다.
    const restoredRef = useRef(false)
    useEffect(() => {
        try {
            const saved = sessionStorage.getItem("dash_restore")
            if (saved) {
                sessionStorage.removeItem("dash_restore")
                const { from, to } = JSON.parse(saved)
                if (from) {
                    restoredRef.current = true
                    setIsRangeMode(true)
                    setDateRange({ from: parseISO(from), to: to ? parseISO(to) : parseISO(from) })
                }
            }
        } catch { /* 무시 */ }
    }, [])

    // 드로어용: 해당 날짜의 문서 상세만 온디맨드 조회 (본인=RLS 직조회 / 다현장=서버 경유)
    // forceSelf: setState 직후 stale 클로저를 피해야 하는 호출자(loadOwn)용
    const fetchDayDetails = async (date: Date, forceSelf?: boolean) => {
        const key = format(date, 'yyyy-MM-dd')
        if (!(forceSelf ?? selfMode)) {
            const { data: s } = await supabase.auth.getSession()
            const res = await fetch(`/api/org/site-docs?ids=${picked.join(",")}&day=${key}`, {
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

    // 본인 문서 로드 — 기존 경로 그대로 (달력 점·기간 카운트는 id/date만)
    const loadOwn = async () => {
        setLoading(true)
        const [logsData, minutesData] = await Promise.all([
            fetchAllRows<{ id: string; date: string }>((f, t) => supabase.from('tbm_logs').select('id, date').order('id').range(f, t)),
            fetchAllRows<{ id: string; date: string }>((f, t) => supabase.from('tbm_minutes').select('id, date').order('id').range(f, t))
        ])
        const combinedLogs: any[] = []
        combinedLogs.push(...logsData.map(log => ({ id: log.id, date: log.date, type: 'log' })))
        combinedLogs.push(...minutesData.map(min => ({ id: min.id, date: min.date, type: 'minute' })))
        combinedLogs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        setSelfMode(true)
        setLogs(combinedLogs)
        setLoading(false)
        if (combinedLogs.some(log => isSameDay(parseISO(log.date), new Date()))) {
            try { setSelectedLogs(await fetchDayDetails(new Date(), true)) } catch { /* 무시: 드로어 오픈 시 재조회됨 */ }
        }
    }

    // 감독자 다현장 로드 — 서버 경유 읽기 전용
    const loadSites = async (ids: string[]) => {
        setLoading(true)
        try {
            const { data: s } = await supabase.auth.getSession()
            const res = await fetch(`/api/org/site-docs?ids=${ids.join(",")}`, {
                headers: { Authorization: `Bearer ${s?.session?.access_token}` },
            })
            if (!res.ok) {
                const j = await res.json().catch(() => ({}))
                setPickErr(j.error || "문서를 불러오지 못했어요.")
                setStage("pick")
                return
            }
            const j = await res.json()
            setSiteNameOf(new Map((j.sites ?? []).map((x: any) => [x.userId, x.siteName])))
            setSelfMode(false)
            setLogs(((j.docs ?? []) as any[]).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()))
        } finally {
            setLoading(false)
        }
    }

    // 진입 분기 — 감독자는 현장 선택부터, 그 외는 바로 본인 달력
    useEffect(() => {
        if (ctxLoading) return
        ;(async () => {
            const { data: { session } } = await supabase.auth.getSession()
            if (!session) { router.push("/login"); return }
            const uid = session.user.id
            setSelfId(uid)
            if (ctx?.kind === "owner") {
                // 일괄 PDF에서 복귀한 경우 — 배치는 내 현장 전용이라 픽커를 다시 묻지 않고
                // 복원된 기간 그대로 내 달력으로 직행 (아니면 복원한 범위가 픽커에서 지워진다)
                if (restoredRef.current) { await loadOwn(); return }
                const meta = session.user.user_metadata ?? {}
                const selfName = String(meta.site_name ?? "").trim() || "내 현장"
                try {
                    const res = await fetch("/api/org/members", { headers: { Authorization: `Bearer ${session.access_token}` } })
                    const j = res.ok ? await res.json() : { members: [] }
                    setSiteOptions([
                        { userId: uid, siteName: selfName, isSelf: true },
                        ...((j.members ?? []) as any[])
                            .filter((m) => m.status === "active")
                            .map((m) => ({ userId: m.userId, siteName: m.siteName || "현장명 미설정", isSelf: false })),
                    ])
                } catch {
                    setSiteOptions([{ userId: uid, siteName: selfName, isSelf: true }])
                }
                setPicked([uid])
                setStage("pick")
                setLoading(false)
                return
            }
            await loadOwn()
        })()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ctxLoading, ctx?.kind, router])

    const togglePick = (id: string) => {
        setPickErr(null)
        setPicked((prev) => {
            if (prev.includes(id)) return prev.filter((x) => x !== id)
            if (prev.length >= MAX_SITES) {
                setPickErr(`현장은 최대 ${MAX_SITES}곳까지 볼 수 있어요.`)
                return prev
            }
            return [...prev, id]
        })
    }

    const startCalendar = async () => {
        if (picked.length === 0) { setPickErr("현장을 하나 이상 선택해주세요."); return }
        setStage("cal")
        setDateRange(undefined)
        setSelectedDate(new Date())
        if (picked.length === 1 && picked[0] === selfId) await loadOwn()
        else await loadSites(picked)
    }

    const handleDayClick = async (date: Date) => {
        if (isRangeMode) return;

        setSelectedDate(date)
        setIsDrawerOpen(true)
        // 점 없는 날은 조회 생략(빈 상태 즉시 표시)
        if (!logs.some(log => isSameDay(parseISO(log.date), date))) {
            setSelectedLogs([])
            return
        }
        setDrawerLoading(true)
        try { setSelectedLogs(await fetchDayDetails(date)) }
        catch { setSelectedLogs([]) }
        finally { setDrawerLoading(false) }
    }

    const handleDelete = async (log: any) => {
        const label = log.type === 'minute' ? '회의록' : '교육일지'
        if (!confirm(`이 ${label}을(를) 삭제할까요?\n참석자·서명도 함께 삭제되며 되돌릴 수 없습니다.`)) return
        const table = log.type === 'minute' ? 'tbm_minutes' : 'tbm_logs'
        const { error } = await supabase.from(table).delete().eq('id', log.id)
        if (error) { alert('삭제 실패: ' + error.message); return }
        setLogs(prev => prev.filter(l => !(l.id === log.id && l.type === log.type)))
        setSelectedLogs(prev => prev.filter(l => !(l.id === log.id && l.type === log.type)))
    }

    // 기간 내 특정 타입(log=교육일지 / minute=회의록) 문서를 별도 PDF로 일괄 저장
    // 회의록+교육일지를 한 번에 — 문서 종류별 버튼 두 개는 "둘 다 받고 싶은" 대다수 상황에서 두 번 일하게 했다
    const batchDownloadAll = () => {
        if (!dateRange?.from) return alert("기간을 선택해주세요.")
        const from = dateRange.from.getTime()
        const to = (dateRange.to ?? dateRange.from).getTime()
        const inRange = (l: { date: string }) => { const d = parseISO(l.date).getTime(); return d >= from && d <= to }
        const minuteIds = logs.filter(l => l.type === 'minute' && inRange(l)).map(l => l.id)
        const logIds = logs.filter(l => l.type !== 'minute' && inRange(l)).map(l => l.id)
        if (minuteIds.length === 0 && logIds.length === 0) return alert("선택된 기간에 문서가 없습니다.")
        sessionStorage.setItem("dash_restore", JSON.stringify({
            from: format(dateRange.from, "yyyy-MM-dd"),
            to: format(dateRange.to ?? dateRange.from, "yyyy-MM-dd"),
        }))
        localStorage.setItem("batch_minute_ids", JSON.stringify(minuteIds))
        localStorage.setItem("batch_print_ids", JSON.stringify(logIds))
        sessionStorage.setItem("batch_combined", "1") // 1회용 — batch 페이지가 읽고 지운다
        router.push("/report/batch")
    }

    // 선택 기간에 포함된 회의록/교육일지 수 (위험성평가는 회의록만 분석)
    const minutesInRange = dateRange?.from ? logs.filter(log => {
        if (log.type !== 'minute') return false
        const d = parseISO(log.date).getTime()
        return d >= dateRange!.from!.getTime() && d <= (dateRange.to ?? dateRange.from)!.getTime()
    }).length : 0;
    const logsInRange = dateRange?.from ? logs.filter(log => {
        if (log.type === 'minute') return false
        const d = parseISO(log.date).getTime()
        return d >= dateRange!.from!.getTime() && d <= (dateRange.to ?? dateRange.from)!.getTime()
    }).length : 0;

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

    // 감독자 1단계 — 어떤 현장을 볼지 먼저 (최대 3곳)
    if (stage === "pick") {
        return (
            <div className="min-h-screen bg-cur-canvas font-sans text-cur-ink">
                <div className="max-w-lg mx-auto px-4 pt-4">
                    <TBMHeader title="보고서" backHref="/" />
                </div>
                <main className="max-w-lg mx-auto px-5 py-6 space-y-4 pb-16">
                    <div className="bg-cur-card rounded-[12px] border border-cur-hairline p-5 space-y-3">
                        <div>
                            <h2 className="text-[15px] font-bold text-cur-ink">어떤 현장을 볼까요?</h2>
                            <p className="text-[12px] text-cur-muted mt-1 leading-relaxed">
                                한 번에 최대 {MAX_SITES}곳까지 — 많이 고르면 로드가 길어져요.
                            </p>
                        </div>
                        <div className="rounded-xl border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                            {siteOptions.map((s) => {
                                const on = picked.includes(s.userId)
                                return (
                                    <button
                                        key={s.userId}
                                        type="button"
                                        onClick={() => togglePick(s.userId)}
                                        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-cur-elevated/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-inset"
                                    >
                                        {on ? (
                                            <CheckCircle2 className="w-5 h-5 text-cur-primary shrink-0" />
                                        ) : (
                                            <Circle className="w-5 h-5 text-cur-muted-soft shrink-0" />
                                        )}
                                        <span className="flex-1 min-w-0 text-[14px] font-semibold text-cur-ink truncate">{s.siteName}</span>
                                        {s.isSelf && (
                                            <span className="shrink-0 text-[10px] font-bold text-cur-primary bg-cur-primary/10 px-1.5 py-0.5 rounded-[4px]">내 현장</span>
                                        )}
                                    </button>
                                )
                            })}
                        </div>
                        {pickErr && <p className="text-[12px] text-cur-error">{pickErr}</p>}
                        <Button
                            onClick={startCalendar}
                            disabled={picked.length === 0}
                            className="w-full h-11 rounded-[8px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[14px] font-bold disabled:opacity-40"
                        >
                            선택한 {picked.length}곳 달력 보기
                        </Button>
                    </div>
                </main>
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-cur-canvas pb-24 font-sans text-cur-ink">
            <div className="max-w-lg mx-auto min-h-screen bg-cur-card shadow-sm border-x border-cur-hairline overflow-hidden relative flex flex-col">
                <div className="p-4 border-b border-cur-hairline bg-cur-card sticky top-0 z-10">
                    <TBMHeader title="보고서" />
                </div>

                <div className="p-6 space-y-6 flex-1 bg-cur-canvas-soft">

                    {/* 감독자 — 지금 보고 있는 현장들 + 다시 선택 */}
                    {ctx?.kind === "owner" && (
                        <button
                            type="button"
                            onClick={() => setStage("pick")}
                            className="w-full flex items-center gap-2.5 bg-cur-card px-4 py-3 rounded-[12px] border border-cur-hairline hover:border-cur-primary/40 transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                        >
                            <Building2 className="w-4 h-4 text-cur-muted shrink-0" />
                            <span className="flex-1 min-w-0 text-[13px] font-semibold text-cur-ink truncate">
                                {selfMode
                                    ? "내 현장"
                                    : picked.map((id) => siteNameOf.get(id) ?? "현장").join(" · ")}
                            </span>
                            <span className="shrink-0 text-[12px] text-cur-primary font-semibold">현장 다시 선택</span>
                        </button>
                    )}

                    <div className="space-y-3">
                        <div
                            className={cn("flex items-center justify-between bg-cur-card p-4 rounded-[12px] border shadow-[0_4px_12px_rgba(0,0,0,0.02)] cursor-pointer transition-all", isRangeMode ? "border-cur-primary ring-1 ring-cur-primary" : "border-cur-hairline")}
                            onClick={() => {
                                setIsRangeMode(true);
                                setDateRange(undefined);
                                setSelectedDate(new Date());
                            }}
                        >
                            <div className="flex items-center gap-3">
                                <div className={cn("p-2 rounded-[8px] transition-colors", isRangeMode ? "bg-cur-primary text-cur-on-primary" : "bg-cur-elevated text-cur-ink")}>
                                    <Printer className="w-5 h-5" />
                                </div>
                                <div className="flex flex-col">
                                    <Label className="font-semibold text-cur-ink text-[15px] cursor-pointer pointer-events-none">
                                        기간 선택
                                    </Label>
                                    <span className="text-[13px] text-cur-muted-soft">
                                        일괄 PDF · AI 분석 보고서 생성
                                    </span>
                                </div>
                            </div>
                            <Switch
                                checked={isRangeMode}
                                onCheckedChange={() => {
                                    setIsRangeMode(true);
                                    setDateRange(undefined);
                                    setSelectedDate(new Date());
                                }}
                            />
                        </div>

                        <div
                            className={cn("flex items-center justify-between bg-cur-card p-4 rounded-[12px] border shadow-[0_4px_12px_rgba(0,0,0,0.02)] cursor-pointer transition-all", !isRangeMode ? "border-cur-primary ring-1 ring-cur-primary" : "border-cur-hairline")}
                            onClick={() => {
                                setIsRangeMode(false);
                                setDateRange(undefined);
                                setSelectedDate(new Date());
                            }}
                        >
                            <div className="flex items-center gap-3">
                                <div className={cn("p-2 rounded-[8px] transition-colors", !isRangeMode ? "bg-cur-primary text-cur-on-primary" : "bg-cur-elevated text-cur-ink")}>
                                    <CalendarIcon className="w-5 h-5" />
                                </div>
                                <div className="flex flex-col">
                                    <Label className="font-semibold text-cur-ink text-[15px] cursor-pointer pointer-events-none">
                                        일별 보기
                                    </Label>
                                    <span className="text-[13px] text-cur-muted-soft">
                                        날짜를 눌러 내용을 확인하세요
                                    </span>
                                </div>
                            </div>
                            <Switch
                                checked={!isRangeMode}
                                onCheckedChange={() => {
                                    setIsRangeMode(false);
                                    setDateRange(undefined);
                                    setSelectedDate(new Date());
                                }}
                            />
                        </div>
                    </div>

                    <div className="border border-cur-hairline rounded-[12px] p-2 sm:p-4 shadow-[0_4px_12px_rgba(0,0,0,0.02)] bg-cur-card flex justify-center overflow-x-auto">
                        {isRangeMode ? (
                            <Calendar
                                mode="range"
                                selected={dateRange}
                                onSelect={handleRangeSelect}
                                locale={ko}
                                className="w-full"
                                modifiers={commonModifiers}
                                modifiersClassNames={commonModifiersClassNames}
                                classNames={commonClassNames}
                            />
                        ) : (
                            <Calendar
                                mode="single"
                                selected={selectedDate}
                                onDayClick={handleDayClick}
                                locale={ko}
                                className="w-full"
                                modifiers={commonModifiers}
                                modifiersClassNames={commonModifiersClassNames}
                                classNames={commonClassNames}
                            />
                        )}
                    </div>

                    {isRangeMode && dateRange?.from && (
                        <div className="bg-cur-card border border-cur-hairline p-4 rounded-[12px] animate-in slide-in-from-bottom-4 space-y-3">
                            <div className="flex justify-between items-center">
                                <div className="font-semibold text-[15px] text-cur-ink">
                                    {format(dateRange.from, "MM.dd")} ~ {dateRange.to ? format(dateRange.to, "MM.dd") : "-"}
                                </div>
                                <span className="text-[12px] text-cur-muted shrink-0">회의록 {minutesInRange}건 · 교육일지 {logsInRange}건</span>
                            </div>
                            {rangeNote && (
                                <p className="text-[12px] text-amber-600 bg-amber-50 rounded-[8px] px-3 py-2 -mt-1">{rangeNote}</p>
                            )}
                            {selfMode ? (
                                <Button onClick={batchDownloadAll} disabled={minutesInRange === 0 && logsInRange === 0} className="w-full bg-cur-primary text-white hover:bg-cur-primary-active h-11 text-[14px] font-bold rounded-[8px] disabled:opacity-50 disabled:cursor-not-allowed">
                                    문서 PDF 저장 (회의록·교육일지)
                                </Button>
                            ) : (
                                /* 다현장 문서의 일괄 PDF는 서버 문서 뷰가 없어 아직 미지원 — 건수 확인용 */
                                <p className="text-[12px] text-cur-muted-soft text-center">
                                    일괄 PDF 저장은 내 현장만 선택했을 때 제공돼요.
                                </p>
                            )}
                        </div>
                    )}

                    {!isRangeMode && (
                        <Button onClick={() => router.push('/')} className="w-full bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary h-12 text-[15px] font-medium rounded-[8px] shadow-[0_4px_12px_rgba(0,0,0,0.04)] mt-2 transition-all">
                            <Plus className="mr-2 w-5 h-5" /> 오늘 일지 작성하기
                        </Button>
                    )}
                </div>
            </div>

            <Drawer open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
                <DrawerContent className="bg-cur-card border-t border-cur-hairline">
                    <DrawerHeader className="border-b border-cur-hairline pb-4">
                        <DrawerTitle className="text-center text-[18px] font-semibold flex items-center justify-center gap-2 text-cur-ink">
                            {selectedDate && format(selectedDate, "yyyy년 MM월 dd일")}
                            <Badge variant="outline" className="ml-1 border-cur-hairline text-cur-muted-soft px-2 py-0.5 text-[11px] font-semibold tracking-wide rounded-[4px]">{drawerLoading ? '…' : `${selectedLogs.length}건`}</Badge>
                        </DrawerTitle>
                    </DrawerHeader>

                    <div className="p-6 space-y-4 bg-cur-canvas-soft min-h-[300px] max-h-[60vh] overflow-y-auto">
                        {drawerLoading ? (
                            <div className="h-full flex items-center justify-center py-10">
                                <Loader2 className="animate-spin w-6 h-6 text-cur-muted" />
                            </div>
                        ) : selectedLogs.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-cur-muted py-10">
                                <FileText className="w-12 h-12 mb-3 opacity-20" />
                                <p className="text-[14px]">작성된 일지가 없습니다.</p>
                            </div>
                        ) : (
                            selectedLogs.map((log) => {
                                // 본인 문서만 열람·삭제 가능 — 다른 현장 문서는 정보 카드로만 (서버 문서 뷰 미지원)
                                const mine = selfMode || log.siteId === selfId
                                return (
                                <Card key={log.id} onClick={() => { if (mine) router.push(log.type === 'minute' ? `/report/minutes/${log.id}` : `/report/${log.id}`) }} className={cn("transition-all border border-cur-hairline shadow-[0_4px_12px_rgba(0,0,0,0.02)] rounded-[12px] overflow-hidden bg-cur-card", mine && "cursor-pointer active:scale-[0.98] hover:shadow-[0_4px_12px_rgba(0,0,0,0.06)]")}>
                                    <div className={cn("h-1 w-full", log.type === 'minute' ? "bg-[#8145b5]" : "bg-cur-primary")} />
                                    <CardContent className="p-5 flex items-center justify-between">
                                        <div>
                                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                                                <Badge className={cn("text-cur-on-primary font-medium text-[11px] px-2 py-0.5 rounded-[4px] border-none shadow-none hover:opacity-90", log.type === 'minute' ? "bg-[#8145b5]" : "bg-cur-primary")}>{log.type === 'minute' ? 'TBM 회의록' : '안전보건교육일지'}</Badge>
                                                {!selfMode && log.siteName && (
                                                    <span className="text-[11px] font-semibold text-cur-ink bg-cur-elevated border border-cur-hairline px-2 py-0.5 rounded-[4px]">{log.siteName}</span>
                                                )}
                                                {log.type !== 'minute' && log.education_type && (
                                                    <span className="text-[11px] text-cur-muted bg-cur-elevated px-2 py-0.5 rounded-[4px]">{log.education_type}</span>
                                                )}
                                                <span className="text-[12px] text-cur-muted font-mono bg-cur-elevated px-2 py-0.5 rounded-[4px]">
                                                    {log.start_time?.slice(0, 5)} ~ {log.end_time?.slice(0, 5)}
                                                </span>
                                            </div>
                                            <div className="font-semibold text-cur-ink text-[16px] mb-1">{log.location}</div>
                                            {log.instructor_name && log.instructor_name !== 'TBM (자율)' && (
                                                <div className="text-[13px] text-cur-muted-soft flex items-center gap-1.5">
                                                    <CheckCircle2 className="w-3.5 h-3.5" /> {log.type === 'minute' ? '작성자' : '강사'}: {log.instructor_name}
                                                </div>
                                            )}
                                        </div>
                                        {mine && (
                                            <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                                                <button
                                                    onClick={() => handleDelete(log)}
                                                    className="text-[12px] text-cur-muted hover:text-cur-error px-2 py-1 rounded-[6px] hover:bg-cur-error/10"
                                                >
                                                    삭제
                                                </button>
                                                <ChevronRight className="text-cur-muted w-5 h-5" />
                                            </div>
                                        )}
                                    </CardContent>
                                </Card>
                                )
                            })
                        )}
                    </div>

                    <DrawerFooter className="bg-cur-card border-t border-cur-hairline pt-4 pb-8">
                        <Button onClick={() => router.push('/')} className="w-full h-12 text-[14px] font-medium bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-[8px]">
                            <Plus className="mr-2 w-4 h-4" /> 이 날짜에 추가 작성
                        </Button>
                        <DrawerClose asChild>
                            <Button variant="outline" className="h-12 border-cur-hairline text-cur-ink font-medium rounded-[8px]">닫기</Button>
                        </DrawerClose>
                    </DrawerFooter>
                </DrawerContent>
            </Drawer>
        </div>
    )
}