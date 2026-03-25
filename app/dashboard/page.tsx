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

            const { data } = await supabase.from('tbm_logs').select('id, date, education_type, start_time, end_time, location, instructor_name').order('date', { ascending: false })
            if (data) {
                setLogs(data)
                const todayLogs = data.filter(log => isSameDay(parseISO(log.date), new Date()))
                if (todayLogs.length > 0) setSelectedLogs(todayLogs)
            }
            setLoading(false)
        }
        loadData()
    }, [router])

    const handleDayClick = (date: Date) => {
        // Range 모드일 때는 클릭 이벤트 무시 (선택 로직이 다름)
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

    // ⭐️ 공통으로 사용할 Modifiers 설정
    const commonModifiers = { hasLog: hasLogMatcher }
    const commonModifiersClassNames = {
        hasLog: "font-extrabold relative after:content-[''] after:absolute after:bottom-1 after:left-1/2 after:-translate-x-1/2 after:w-1.5 after:h-1.5 after:bg-slate-900 after:rounded-full data-[selected=true]:after:bg-white"
    }
    const commonClassNames = {
        day_selected: "bg-slate-900 text-white hover:bg-slate-800 focus:bg-slate-900",
        day_today: "bg-slate-100 text-slate-900 font-bold",
    }

    if (loading) return <div className="min-h-screen flex justify-center items-center bg-slate-50"><Loader2 className="animate-spin w-10 h-10 text-slate-500" /></div>

    return (
        <div className="min-h-screen bg-slate-50 pb-24">
            <div className="max-w-md mx-auto min-h-screen bg-white shadow-lg overflow-hidden relative">
                <div className="p-4 border-b bg-white sticky top-0 z-10"><TBMHeader /></div>

                <div className="p-4 space-y-6">

                    <div className="flex items-center justify-between bg-slate-100 p-4 rounded-xl border border-slate-200">
                        <div className="flex items-center gap-2">
                            <CalendarIcon className="w-5 h-5 text-slate-600" />
                            <div className="flex flex-col">
                                <Label htmlFor="mode-switch" className="font-bold text-slate-800 text-base">
                                    {isRangeMode ? "기간 다운로드 모드" : "일별 보기 모드"}
                                </Label>
                                <span className="text-xs text-slate-500">
                                    {isRangeMode ? "시작일과 종료일을 선택하세요" : "날짜를 눌러 내용을 확인하세요"}
                                </span>
                            </div>
                        </div>
                        <Switch
                            id="mode-switch"
                            checked={isRangeMode}
                            onCheckedChange={(chk) => {
                                setIsRangeMode(chk);
                                setDateRange(undefined);
                                setSelectedDate(new Date());
                            }}
                        />
                    </div>

                    <div className="border border-slate-200 rounded-xl p-2 shadow-sm bg-white flex justify-center">
                        {/* ⭐️ [수정] 모드에 따라 Calendar 컴포넌트를 분리하여 렌더링 (타입 에러 해결) */}
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
                        <div className="bg-slate-900 p-4 rounded-xl shadow-lg text-white animate-in slide-in-from-bottom-2">
                            <div className="flex justify-between items-center mb-3">
                                <div className="font-bold text-lg">
                                    {format(dateRange.from, "MM.dd")} ~ {dateRange.to ? format(dateRange.to, "MM.dd") : "-"}
                                </div>
                                <Badge variant="secondary" className="bg-slate-700 text-white border-0">
                                    {rangeCount}개 선택됨
                                </Badge>
                            </div>
                            <Button onClick={handleBatchDownload} className="w-full bg-white text-slate-900 hover:bg-slate-100 h-12 text-lg font-bold">
                                <Printer className="mr-2 w-5 h-5" /> 일괄 다운로드 (PDF)
                            </Button>
                        </div>
                    )}

                    {!isRangeMode && (
                        <Button onClick={() => router.push('/')} className="w-full bg-slate-900 hover:bg-slate-800 text-white h-14 text-lg rounded-xl shadow-lg mt-2">
                            <Plus className="mr-2 w-5 h-5" /> 오늘 일지 작성하기
                        </Button>
                    )}
                </div>
            </div>

            <Drawer open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
                <DrawerContent>
                    <DrawerHeader>
                        <DrawerTitle className="text-center text-xl pb-2 border-b flex items-center justify-center gap-2">
                            {selectedDate && format(selectedDate, "yyyy년 MM월 dd일")}
                            <Badge variant="outline" className="ml-2">{selectedLogs.length}건</Badge>
                        </DrawerTitle>
                    </DrawerHeader>

                    <div className="p-4 space-y-3 bg-slate-50 min-h-[300px] max-h-[60vh] overflow-y-auto">
                        {selectedLogs.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-slate-400 py-10">
                                <FileText className="w-12 h-12 mb-2 opacity-20" />
                                <p>작성된 일지가 없습니다.</p>
                            </div>
                        ) : (
                            selectedLogs.map((log) => (
                                <Card key={log.id} onClick={() => router.push(`/report/${log.id}`)} className="cursor-pointer active:scale-[0.98] transition-transform border-l-4 border-l-slate-900 shadow-sm hover:shadow-md">
                                    <CardContent className="p-4 flex items-center justify-between">
                                        <div>
                                            <div className="flex items-center gap-2 mb-1">
                                                <Badge className="bg-slate-900 hover:bg-slate-800">{log.education_type}</Badge>
                                                <span className="text-xs text-slate-500 font-mono bg-slate-100 px-1.5 py-0.5 rounded">
                                                    {log.start_time?.slice(0, 5)} ~ {log.end_time?.slice(0, 5)}
                                                </span>
                                            </div>
                                            <div className="font-bold text-slate-800 text-lg">{log.location}</div>
                                            <div className="text-sm text-slate-500 flex items-center gap-1">
                                                <CheckCircle2 className="w-3 h-3" /> 강사: {log.instructor_name}
                                            </div>
                                        </div>
                                        <ChevronRight className="text-slate-300 w-6 h-6" />
                                    </CardContent>
                                </Card>
                            ))
                        )}
                    </div>

                    <DrawerFooter>
                        <Button onClick={() => router.push('/')} className="w-full h-12 text-lg bg-slate-900 hover:bg-slate-800 text-white">
                            <Plus className="mr-2 w-4 h-4" /> 이 날짜에 추가 작성
                        </Button>
                        <DrawerClose asChild>
                            <Button variant="outline" className="h-12 border-slate-300">닫기</Button>
                        </DrawerClose>
                    </DrawerFooter>
                </DrawerContent>
            </Drawer>
        </div>
    )
}  