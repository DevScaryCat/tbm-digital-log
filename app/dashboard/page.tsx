"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { format, parseISO, isSameDay } from "date-fns"
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
import { Plus, Printer, ChevronRight, Loader2, Calendar as CalendarIcon, CheckCircle2, FileText } from "lucide-react"

export default function DashboardPage() {
    const router = useRouter()
    const [logs, setLogs] = useState<any[]>([])
    const [loading, setLoading] = useState(true)

    const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date())
    const [dateRange, setDateRange] = useState<DateRange | undefined>()
    const [isRangeMode, setIsRangeMode] = useState(false)
    const [isDrawerOpen, setIsDrawerOpen] = useState(false)
    const [selectedLogs, setSelectedLogs] = useState<any[]>([])

    useEffect(() => {
        const loadData = async () => {
            const { data: { session } } = await supabase.auth.getSession()
            if (!session) { router.push("/login"); return }

            const [{ data: logsData }, { data: minutesData }] = await Promise.all([
                supabase.from('tbm_logs').select('id, date, education_type, start_time, end_time, location, instructor_name').order('date', { ascending: false }),
                supabase.from('tbm_minutes').select('id, date, process_name, start_time, end_time, location, leader_name').order('date', { ascending: false })
            ])

            const combinedLogs: any[] = []
            
            if (logsData) {
                combinedLogs.push(...logsData.map(log => ({
                    ...log,
                    type: 'log',
                    display_type: log.education_type || 'TBM'
                })))
            }

            if (minutesData) {
                combinedLogs.push(...minutesData.map(min => ({
                    id: min.id,
                    date: min.date,
                    education_type: 'TBM 회의록',
                    display_type: min.process_name || 'TBM 회의록',
                    start_time: min.start_time,
                    end_time: min.end_time,
                    location: min.location,
                    instructor_name: min.leader_name,
                    type: 'minute'
                })))
            }

            combinedLogs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

            setLogs(combinedLogs)
            const todayLogs = combinedLogs.filter(log => isSameDay(parseISO(log.date), new Date()))
            if (todayLogs.length > 0) setSelectedLogs(todayLogs)
            setLoading(false)
        }
        loadData()
    }, [router])

    const handleDayClick = (date: Date) => {
        if (isRangeMode) return;

        setSelectedDate(date)
        const logsOnDay = logs.filter(log => isSameDay(parseISO(log.date), date))

        setSelectedLogs(logsOnDay)
        setIsDrawerOpen(true)
    }

    const handleBatchDownload = () => {
        if (!dateRange?.from || !dateRange?.to) return alert("기간을 선택해주세요.")

        const from = dateRange.from.getTime()
        const to = dateRange.to.getTime()

        const targetLogs = logs.filter(log => {
            if (log.type === 'minute') return false; 
            const d = parseISO(log.date).getTime()
            return d >= from && d <= to
        })

        if (targetLogs.length === 0) return alert("선택된 기간에 작성된 일지가 없습니다.")

        const ids = targetLogs.map(l => l.id)
        localStorage.setItem("batch_print_ids", JSON.stringify(ids))
        router.push("/report/batch")
    }

    const rangeCount = dateRange?.from && dateRange?.to ? logs.filter(log => {
        const d = parseISO(log.date).getTime()
        return d >= dateRange!.from!.getTime() && d <= dateRange!.to!.getTime()
    }).length : 0;

    const hasLogMatcher = (date: Date) => {
        return logs.some(log => isSameDay(parseISO(log.date), date))
    }

    const commonModifiers = { hasLog: hasLogMatcher }
    const commonModifiersClassNames = {
        hasLog: "font-semibold relative after:content-[''] after:absolute after:bottom-1 after:left-1/2 after:-translate-x-1/2 after:w-[4px] after:h-[4px] after:bg-expo-primary after:rounded-full data-[selected=true]:after:bg-white"
    }
    const commonClassNames = {
        day_selected: "bg-expo-primary text-white hover:bg-expo-primary-active focus:bg-expo-primary rounded-[8px]",
        day_today: "bg-expo-surface-strong text-expo-ink font-semibold rounded-[8px]",
    }

    if (loading) return <div className="min-h-screen flex justify-center items-center bg-expo-canvas"><Loader2 className="animate-spin w-10 h-10 text-expo-ink" /></div>

    return (
        <div className="min-h-screen bg-expo-surface-strong pb-24 font-sans text-expo-ink">
            <div className="max-w-md mx-auto min-h-screen bg-white shadow-sm border-x border-expo-hairline overflow-hidden relative flex flex-col">
                <div className="p-4 border-b border-expo-hairline bg-white sticky top-0 z-10"><TBMHeader title="일지 달력보기" /></div>

                <div className="p-6 space-y-6 flex-1 bg-expo-canvas-soft">

                    <div className="space-y-3">
                        <div 
                            className={cn("flex items-center justify-between bg-white p-4 rounded-[12px] border shadow-[0_4px_12px_rgba(0,0,0,0.02)] cursor-pointer transition-all", !isRangeMode ? "border-expo-ink ring-1 ring-expo-ink" : "border-expo-hairline")}
                            onClick={() => {
                                setIsRangeMode(false);
                                setDateRange(undefined);
                                setSelectedDate(new Date());
                            }}
                        >
                            <div className="flex items-center gap-3">
                                <div className={cn("p-2 rounded-[8px] transition-colors", !isRangeMode ? "bg-expo-surface-dark text-white" : "bg-expo-surface-strong text-expo-ink")}>
                                    <CalendarIcon className="w-5 h-5" />
                                </div>
                                <div className="flex flex-col">
                                    <Label className="font-semibold text-expo-ink text-[15px] cursor-pointer pointer-events-none">
                                        일별 보기
                                    </Label>
                                    <span className="text-[13px] text-expo-body">
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

                        <div 
                            className={cn("flex items-center justify-between bg-white p-4 rounded-[12px] border shadow-[0_4px_12px_rgba(0,0,0,0.02)] cursor-pointer transition-all", isRangeMode ? "border-expo-ink ring-1 ring-expo-ink" : "border-expo-hairline")}
                            onClick={() => {
                                setIsRangeMode(true);
                                setDateRange(undefined);
                                setSelectedDate(new Date());
                            }}
                        >
                            <div className="flex items-center gap-3">
                                <div className={cn("p-2 rounded-[8px] transition-colors", isRangeMode ? "bg-expo-surface-dark text-white" : "bg-expo-surface-strong text-expo-ink")}>
                                    <Printer className="w-5 h-5" />
                                </div>
                                <div className="flex flex-col">
                                    <Label className="font-semibold text-expo-ink text-[15px] cursor-pointer pointer-events-none">
                                        기간 다운로드
                                    </Label>
                                    <span className="text-[13px] text-expo-body">
                                        시작일과 종료일을 선택하세요
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
                    </div>

                    <div className="border border-expo-hairline rounded-[12px] p-4 shadow-[0_4px_12px_rgba(0,0,0,0.02)] bg-white flex justify-center">
                        {isRangeMode ? (
                            <Calendar
                                mode="range"
                                selected={dateRange}
                                onSelect={setDateRange}
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
                        <div className="bg-expo-surface-dark p-5 rounded-[12px] shadow-[0_4px_12px_rgba(0,0,0,0.08)] text-white animate-in slide-in-from-bottom-4">
                            <div className="flex justify-between items-center mb-4">
                                <div className="font-semibold text-[16px]">
                                    {format(dateRange.from, "MM.dd")} ~ {dateRange.to ? format(dateRange.to, "MM.dd") : "-"}
                                </div>
                                <Badge variant="secondary" className="bg-[#1a1a1a] text-white border border-[#333] hover:bg-[#1a1a1a] px-2 py-0.5 text-[11px] font-semibold tracking-wide">
                                    {rangeCount}개 선택됨
                                </Badge>
                            </div>
                            <Button onClick={handleBatchDownload} className="w-full bg-white text-expo-ink hover:bg-expo-surface-strong h-10 text-[14px] font-medium rounded-[8px]">
                                <Printer className="mr-2 w-4 h-4" /> 일괄 다운로드 (PDF)
                            </Button>
                        </div>
                    )}

                    {!isRangeMode && (
                        <Button onClick={() => router.push('/')} className="w-full bg-expo-primary hover:bg-expo-primary-active text-white h-12 text-[15px] font-medium rounded-[8px] shadow-[0_4px_12px_rgba(0,0,0,0.04)] mt-2 transition-all">
                            <Plus className="mr-2 w-5 h-5" /> 오늘 일지 작성하기
                        </Button>
                    )}
                </div>
            </div>

            <Drawer open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
                <DrawerContent className="bg-white border-t border-expo-hairline">
                    <DrawerHeader className="border-b border-expo-hairline pb-4">
                        <DrawerTitle className="text-center text-[18px] font-semibold flex items-center justify-center gap-2 text-expo-ink">
                            {selectedDate && format(selectedDate, "yyyy년 MM월 dd일")}
                            <Badge variant="outline" className="ml-1 border-expo-hairline-strong text-expo-body px-2 py-0.5 text-[11px] font-semibold tracking-wide rounded-[4px]">{selectedLogs.length}건</Badge>
                        </DrawerTitle>
                    </DrawerHeader>

                    <div className="p-6 space-y-4 bg-expo-canvas-soft min-h-[300px] max-h-[60vh] overflow-y-auto">
                        {selectedLogs.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-expo-muted py-10">
                                <FileText className="w-12 h-12 mb-3 opacity-20" />
                                <p className="text-[14px]">작성된 일지가 없습니다.</p>
                            </div>
                        ) : (
                            selectedLogs.map((log) => (
                                <Card key={log.id} onClick={() => router.push(log.type === 'minute' ? `/report/minutes/${log.id}` : `/report/${log.id}`)} className="cursor-pointer active:scale-[0.98] transition-all border border-expo-hairline shadow-[0_4px_12px_rgba(0,0,0,0.02)] hover:shadow-[0_4px_12px_rgba(0,0,0,0.06)] hover:border-expo-hairline-strong rounded-[12px] overflow-hidden bg-white">
                                    <div className={cn("h-1 w-full", log.type === 'minute' ? "bg-[#8145b5]" : "bg-expo-primary")} />
                                    <CardContent className="p-5 flex items-center justify-between">
                                        <div>
                                            <div className="flex items-center gap-2 mb-2">
                                                <Badge className={cn("text-white font-medium text-[11px] px-2 py-0.5 rounded-[4px] border-none shadow-none hover:opacity-90", log.type === 'minute' ? "bg-[#8145b5]" : "bg-expo-surface-dark")}>{log.education_type}</Badge>
                                                <span className="text-[12px] text-expo-body font-mono bg-expo-surface-strong px-2 py-0.5 rounded-[4px]">
                                                    {log.start_time?.slice(0, 5)} ~ {log.end_time?.slice(0, 5)}
                                                </span>
                                            </div>
                                            <div className="font-semibold text-expo-ink text-[16px] mb-1">{log.location}</div>
                                            <div className="text-[13px] text-expo-body flex items-center gap-1.5">
                                                <CheckCircle2 className="w-3.5 h-3.5" /> 강사: {log.instructor_name}
                                            </div>
                                        </div>
                                        <ChevronRight className="text-expo-muted-soft w-5 h-5" />
                                    </CardContent>
                                </Card>
                            ))
                        )}
                    </div>

                    <DrawerFooter className="bg-white border-t border-expo-hairline pt-4 pb-8">
                        <Button onClick={() => router.push('/')} className="w-full h-12 text-[14px] font-medium bg-expo-primary hover:bg-expo-primary-active text-white rounded-[8px]">
                            <Plus className="mr-2 w-4 h-4" /> 이 날짜에 추가 작성
                        </Button>
                        <DrawerClose asChild>
                            <Button variant="outline" className="h-12 border-expo-hairline-strong text-expo-ink font-medium rounded-[8px]">닫기</Button>
                        </DrawerClose>
                    </DrawerFooter>
                </DrawerContent>
            </Drawer>
        </div>
    )
}  