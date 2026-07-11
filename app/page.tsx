// app/page.tsx
"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { useRequireSubscription } from "@/lib/useSubscription"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { HardHat, Mic, LogOut, Loader2, FileText, Users, ChevronRight, CalendarDays } from "lucide-react"
import { TBMHeader } from "@/components/TBMHeader"
import { Logo } from "@/components/Logo"
import { NoticeBanner } from "@/components/NoticeBanner"

export default function MainPage() {
  const router = useRouter()
  const { checking } = useRequireSubscription()
  const [isLoading, setIsLoading] = useState(true)
  const [user, setUser] = useState<any>(null)

  const [tbmCount, setTbmCount] = useState(0)
  const [tbmMinutesCount, setTbmMinutesCount] = useState(0)
  const [statsLoading, setStatsLoading] = useState(true)
  const [totalEducationHours, setTotalEducationHours] = useState("0.0")
  const [requiredHours, setRequiredHours] = useState(16)
  // 진행도 바 순차 애니메이션: 진한 바(0~100%) 먼저 → 초과분 이어서
  const [animBase, setAnimBase] = useState(0)
  const [animOver, setAnimOver] = useState(0)

  // 월별 건수 필터용 원본(날짜만) + 선택 월("all" = 전체)
  const [logDates, setLogDates] = useState<string[]>([])
  const [minuteDates, setMinuteDates] = useState<string[]>([])
  const [selectedMonth, setSelectedMonth] = useState("all")

  const [showOnboarding, setShowOnboarding] = useState(false)
  const [companyInput, setCompanyInput] = useState("")
  const [workerType, setWorkerType] = useState("현장 근로자 (비사무직)")
  const [isUpdating, setIsUpdating] = useState(false)

  useEffect(() => {
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        const currentUser = session.user
        setUser(currentUser)

        if (!currentUser.user_metadata?.company_name || !currentUser.user_metadata?.worker_type) {
          setWorkerType(currentUser.user_metadata?.worker_type || "현장 근로자 (비사무직)")
          if (currentUser.user_metadata?.company_name) setCompanyInput(currentUser.user_metadata.company_name)
          setShowOnboarding(true)
        }

        fetchUserStats(currentUser.id, currentUser.user_metadata?.worker_type || "현장 근로자 (비사무직)")
      }
      setIsLoading(false)
    }
    checkSession()
  }, [])

  const fetchUserStats = async (userId: string, currentWorkerType: string) => {
    setStatsLoading(true)
    try {
      // 독립 쿼리 2개를 병렬로(워터폴 제거)
      const [{ data: tbmLogs }, { data: minutesLogs }] = await Promise.all([
        supabase.from('tbm_logs').select('id, date, start_time, end_time').eq('user_id', userId),
        supabase.from('tbm_minutes').select('id, date, start_time, end_time').eq('user_id', userId),
      ])

      setTbmCount(tbmLogs?.length || 0)
      setTbmMinutesCount(minutesLogs?.length || 0)
      setLogDates((tbmLogs || []).map(l => l.date).filter(Boolean))
      setMinuteDates((minutesLogs || []).map(l => l.date).filter(Boolean))

      const now = new Date()
      const currentYear = now.getFullYear()
      const isFirstHalf = now.getMonth() < 6

      let validLogs = []
      if (currentWorkerType === '사무직 / 판매직') {
        validLogs = [...(tbmLogs || []), ...(minutesLogs || [])].filter(log => {
          if (!log.date) return false
          const month = parseInt(log.date.split('-')[1], 10)
          return log.date.startsWith(`${currentYear}`) && (isFirstHalf ? month <= 6 : month > 6)
        })
        setRequiredHours(6)
      } else {
        // 기본값: 현장 근로자
        validLogs = [...(tbmLogs || []), ...(minutesLogs || [])].filter(log => {
          if (!log.date) return false
          const month = parseInt(log.date.split('-')[1], 10)
          return log.date.startsWith(`${currentYear}`) && (isFirstHalf ? month <= 6 : month > 6)
        })
        setRequiredHours(12)
      }

      let totalMins = 0
      validLogs.forEach(log => {
        if (log.start_time && log.end_time) {
          const [sh, sm] = log.start_time.split(':').map(Number)
          const [eh, em] = log.end_time.split(':').map(Number)
          let diff = (eh * 60 + em) - (sh * 60 + sm)
          if (diff < 0) diff += 1440 // 자정을 넘긴 경우(예: 23:50~00:10)
          if (diff > 0) totalMins += diff
        }
      })

      setTotalEducationHours((totalMins / 60).toFixed(1))
    } catch (e) {
      console.error("통계 에러:", e)
    } finally {
      setStatsLoading(false)
    }
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    setUser(null)
    setTbmCount(0)
    setTbmMinutesCount(0)
  }

  const handleSaveCompany = async () => {
    if (!companyInput.trim()) return alert("현장명(업체명)을 입력해주세요.")
    setIsUpdating(true)
    const { data, error } = await supabase.auth.updateUser({
      data: {
        company_name: companyInput.trim(),
        worker_type: workerType
      }
    })
    if (error) { alert("저장 실패: " + error.message); setIsUpdating(false); return; }
    setUser(data.user)
    setShowOnboarding(false)
    setIsUpdating(false)
    fetchUserStats(data.user.id, workerType)
  }

  const rawPercent = (parseFloat(totalEducationHours) / requiredHours) * 100
  // 현재 반기 라벨 (반기별로 0에서 새로 누적 — 상반기 1~6월 / 하반기 7~12월)
  const halfLabel = (() => { const d = new Date(); return `${d.getFullYear()} ${d.getMonth() < 6 ? '상반기' : '하반기'}` })()
  const maxScale = rawPercent > 100 ? 150 : 100
  const fillWidth = Math.min(100, (rawPercent / maxScale) * 100)
  const tickPosition = (100 / maxScale) * 100
  // 100% 초과 시: 0~100%는 진한 오렌지, 초과분은 연한 오렌지로 구분
  const isOver = rawPercent > 100
  const baseFill = isOver ? tickPosition : fillWidth
  const overFill = isOver ? Math.max(0, fillWidth - tickPosition) : 0

  // 100%까지 진한 바가 먼저 차고, 다 찬 뒤(1초 후) 초과분을 이어서 채운다
  useEffect(() => {
    if (statsLoading) return
    setAnimBase(0)
    setAnimOver(0)
    const t1 = setTimeout(() => setAnimBase(baseFill), 80)
    const t2 = setTimeout(() => setAnimOver(overFill), 80 + 1000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [statsLoading, baseFill, overFill])

  // 월 선택 옵션(데이터가 있는 달, 최신순) + 선택 월 기준 건수
  const monthOptions = [...new Set([...logDates, ...minuteDates].map(d => d.slice(0, 7)))].sort().reverse()
  const countInMonth = (dates: string[]) => selectedMonth === "all" ? dates.length : dates.filter(d => d.startsWith(selectedMonth)).length
  const shownMinutes = countInMonth(minuteDates)
  const shownLogs = countInMonth(logDates)
  const monthLabel = (m: string) => `${m.slice(0, 4)}년 ${parseInt(m.slice(5, 7), 10)}월`

  if (isLoading || checking) return <div className="min-h-screen flex items-center justify-center bg-cur-canvas"><Loader2 className="w-10 h-10 text-cur-primary animate-spin" /></div>

  if (!user) {
    const features = [
      { n: "01", t: "스마트 안전보건교육일지·회의록", d: "현장에서 말하면 AI가 안전보건교육일지·회의록으로 자동 정리합니다. 녹음·음성 입력 지원." },
      { n: "02", t: "AI 분석 보고서 자동 생성", d: "기간만 고르면 그 기간 TBM을 분석해 유해위험요인·감소대책 평가표를 만들어줍니다." },
      { n: "03", t: "월간 안전 보고서 자동 발송", d: "한 달 안전활동을 분석한 보고서를 사장·안전관리자에게 매달 자동으로 메일 발송." },
    ]
    return (
      <div className="min-h-screen bg-cur-canvas font-sans text-cur-body">
        {/* 상단 네비 */}
        <header className="sticky top-0 z-20 bg-cur-canvas/80 backdrop-blur-sm border-b border-cur-hairline">
          <div className="max-w-6xl mx-auto px-5 sm:px-8 h-16 flex items-center justify-between">
            <Logo size="sm" />
            <Button
              onClick={() => router.push("/start")}
              className="h-10 px-5 bg-cur-ink hover:opacity-90 text-white text-[14px] font-semibold rounded-[8px]"
            >
              시작하기
            </Button>
          </div>
        </header>

        {/* 히어로 */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-[70%] bg-gradient-to-b from-cur-primary/10 via-cur-primary/5 to-transparent -z-10" />
          <div className="max-w-5xl mx-auto px-5 sm:px-8 py-20 sm:py-28 lg:py-36 text-center flex flex-col items-center gap-6 sm:gap-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <span className="text-[12px] sm:text-[13px] font-semibold text-cur-primary bg-cur-primary/10 px-3 py-1.5 rounded-full">
              현장 안전관리 AI · 안전톡톡e
            </span>
            <h1 className="text-[34px] sm:text-[56px] lg:text-[68px] font-bold text-cur-ink leading-[1.08] tracking-tight">
              현장의 안전을<br className="hidden sm:block" /> 더 쉽고 똑똑하게
            </h1>
            <p className="text-cur-muted text-[16px] sm:text-[19px] leading-relaxed max-w-2xl">
              TBM 일지부터 AI 분석 보고서, 월간 안전 보고서까지 — AI로 한 번에.
              더 많은 대화로 더 안전한 현장을 만드세요.
            </p>
            <div className="flex flex-col items-center gap-3 w-full sm:w-auto pt-2">
              <div className="flex flex-col sm:flex-row gap-3 w-full sm:w-auto">
                <Button
                  onClick={() => router.push("/start")}
                  className="h-12 px-8 bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[16px] font-bold rounded-[8px]"
                >
                  첫 달 무료로 시작하기
                </Button>
                <Button
                  variant="outline"
                  onClick={() => router.push("/start")}
                  className="h-12 px-8 border-cur-hairline text-cur-ink hover:bg-cur-elevated text-[16px] font-semibold rounded-[8px]"
                >
                  로그인
                </Button>
              </div>
              <p className="text-[13px] text-cur-muted-soft">첫 달 무료 체험 · 이후 월 1,900원 (Pro 4,900원)</p>
            </div>
          </div>
        </section>

        {/* 기능 소개 */}
        <section className="max-w-6xl mx-auto px-5 sm:px-8 pb-24 sm:pb-32">
          <div className="grid gap-4 sm:gap-5 sm:grid-cols-3">
            {features.map((f) => (
              <div
                key={f.n}
                className="bg-cur-card border border-cur-hairline rounded-[16px] p-6 sm:p-7 flex flex-col gap-3 hover:border-cur-primary/40 transition-colors"
              >
                <span className="text-[13px] font-mono font-bold text-cur-primary">{f.n}</span>
                <h3 className="font-bold text-[18px] sm:text-[19px] text-cur-ink leading-snug">{f.t}</h3>
                <p className="text-[14px] sm:text-[15px] text-cur-muted-soft leading-relaxed">{f.d}</p>
              </div>
            ))}
          </div>

          {/* 하단 CTA */}
          <div className="mt-16 sm:mt-20 bg-cur-ink rounded-[20px] px-6 sm:px-12 py-12 sm:py-16 text-center flex flex-col items-center gap-5">
            <h2 className="text-[24px] sm:text-[34px] font-bold text-white leading-tight tracking-tight">
              첫 달 무료로 시작하세요
            </h2>
            <p className="text-white/70 text-[15px] sm:text-[16px] max-w-xl">
              복잡한 설치 없이 카카오/일반 계정으로 바로 시작. 첫 달은 무료 체험이고, 이후 월 1,900원(Pro 4,900원)이에요. 언제든 해지할 수 있습니다.
            </p>
            <Button
              onClick={() => router.push("/start")}
              className="h-12 px-8 bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[16px] font-bold rounded-[8px] mt-1"
            >
              첫 달 무료로 시작하기
            </Button>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="bg-cur-canvas min-h-screen sm:py-8 flex sm:block items-center justify-center font-sans text-cur-body pb-20">
      <div className="max-w-lg w-full mx-auto bg-cur-card sm:rounded-[12px] relative flex flex-col min-h-[100dvh] sm:min-h-[85vh] border-x sm:border border-cur-hairline mb-[env(safe-area-inset-bottom)] overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.04)]">

        <div className="p-4 bg-cur-card/90 backdrop-blur-sm border-b border-cur-hairline sticky top-0 z-50">
          <TBMHeader title="안전톡톡e" onLogout={handleLogout} />
        </div>

        <div className="p-4 sm:p-6 space-y-5">
          <NoticeBanner />
          <div
            onClick={() => router.push('/education-progress')}
            className="bg-cur-card rounded-[12px] p-5 border border-cur-hairline cursor-pointer hover:border-cur-primary/40 active:bg-cur-elevated/40 transition-all group"
          >
            <div className="flex items-center justify-between gap-3 mb-8">
              <h3 className="text-[15px] font-semibold text-cur-ink flex items-center gap-2 flex-wrap tracking-[-0.11px] min-w-0">
                법정 의무 교육 진행도
                <span className="bg-cur-primary/15 px-2 py-0.5 rounded-[4px] text-[11px] text-cur-primary font-semibold shrink-0">
                  {user?.user_metadata?.worker_type || '현장 근로자 (비사무직)'}
                </span>
              </h3>
              <span className="flex items-center gap-1 whitespace-nowrap shrink-0">
                <span className="text-[14px] font-bold text-cur-primary font-mono">
                  {statsLoading ? <Loader2 className="w-4 h-4 animate-spin inline-block" /> : `${totalEducationHours} / ${requiredHours} (시간)`}
                </span>
                <ChevronRight className="w-4 h-4 text-cur-muted group-hover:text-cur-primary transition-colors" />
              </span>
            </div>

            <div className="relative mt-2 mb-8">
              {/* Progress bar container */}
              <div className="w-full h-2 bg-cur-elevated rounded-full relative">
                {/* 100% Tick Mark */}
                <div
                  className="absolute top-0 bottom-0 w-[2px] bg-cur-card z-10"
                  style={{ left: `${tickPosition}%` }}
                />

                {/* 100% Label below the tick */}
                <div
                  className="absolute top-3 text-[11px] font-medium text-cur-muted"
                  style={
                    tickPosition > 90
                      ? { right: '0%' }
                      : { left: `${tickPosition}%`, transform: 'translateX(-50%)' }
                  }
                >
                  100%
                </div>

                {/* Filled bar — 0~100% 구간(진한 정상 오렌지) */}
                <div
                  className={`h-full bg-gradient-to-r from-cur-primary-active to-cur-primary transition-all duration-1000 ease-out absolute left-0 top-0 ${isOver ? 'rounded-l-full' : 'rounded-full'}`}
                  style={{ width: `${animBase}%` }}
                />
                {/* 100% 초과분 (연한 오렌지) — 진한 바가 다 찬 뒤 이어서 채워짐 */}
                {isOver && (
                  <div
                    className="h-full bg-[#ff9a5c] rounded-r-full transition-all duration-1000 ease-out absolute top-0"
                    style={{ left: `${tickPosition}%`, width: `${animOver}%` }}
                  />
                )}
              </div>

              {/* Current Percentage Label below the right end of the filled bar */}
              <div
                className="absolute top-3 text-[12px] font-bold text-cur-primary"
                style={
                  fillWidth > 90
                    ? { right: '0%' }
                    : { left: `${fillWidth}%`, transform: 'translateX(-50%)' }
                }
              >
                {Math.floor(rawPercent)}%
              </div>
            </div>
            <p className="text-[12px] text-cur-muted mt-3 leading-relaxed">
              <span className="font-semibold text-cur-body">{halfLabel}</span> 기준 ·{' '}
              {user?.user_metadata?.worker_type === '사무직 / 판매직'
                ? '반기별 6시간 이상 (정기교육 TBM 대체 가능)'
                : '반기별 12시간 이상 (정기교육 TBM 대체 가능)'}
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-[13px] font-semibold text-cur-ink">활동 현황</h3>
              <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                <SelectTrigger className="h-8 w-auto gap-1 text-[13px] border-cur-hairline rounded-[8px] bg-cur-card text-cur-ink px-3 focus:ring-1 focus:ring-cur-primary">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-cur-card border-cur-hairline text-cur-body">
                  <SelectItem value="all">전체</SelectItem>
                  {monthOptions.map(m => (
                    <SelectItem key={m} value={m}>{monthLabel(m)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-[12px] flex text-center divide-x divide-cur-hairline border border-cur-hairline bg-cur-card overflow-hidden">
              <div onClick={() => router.push('/analytics')} className="relative flex-1 py-5 px-2 cursor-pointer hover:bg-cur-elevated active:bg-cur-elevated transition-colors">
                <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft absolute bottom-2 right-2" />
                <div className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.88px] mb-1">TBM 회의록</div>
                <div className="text-[28px] font-bold text-cur-ink font-mono">
                  {statsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-cur-muted" /> : shownMinutes}
                </div>
              </div>
              <div onClick={() => router.push('/analytics/education')} className="relative flex-1 py-5 px-2 cursor-pointer hover:bg-cur-elevated active:bg-cur-elevated transition-colors">
                <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft absolute bottom-2 right-2" />
                <div className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.88px] mb-1">안전보건교육일지</div>
                <div className="text-[28px] font-bold text-cur-ink font-mono">
                  {statsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-cur-muted" /> : shownLogs}
                </div>
              </div>
              <div onClick={() => router.push('/dashboard')} className="relative flex-1 py-5 px-2 cursor-pointer hover:bg-cur-elevated active:bg-cur-elevated transition-colors flex flex-col items-center justify-center">
                <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft absolute bottom-2 right-2" />
                <div className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.88px] mb-1">안전문서 달력</div>
                <div className="bg-cur-elevated w-10 h-10 rounded-[8px] flex items-center justify-center text-cur-ink mx-auto">
                  <CalendarDays className="w-5 h-5" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 p-6 space-y-4">

          <div
            onClick={() => router.push('/tbm-minutes')}
            className="border border-cur-hairline bg-cur-card hover:border-cur-primary/40 transition-all cursor-pointer rounded-[12px] group"
          >
            <div className="p-5 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="bg-cur-elevated w-12 h-12 rounded-[8px] flex items-center justify-center text-cur-ink group-hover:bg-cur-primary/15 group-hover:text-cur-primary transition-colors">
                  <Users className="w-6 h-6" />
                </div>
                <div className="space-y-0.5">
                  <h3 className="text-[16px] font-semibold text-cur-ink">TBM 회의록 작성</h3>
                  <p className="text-cur-muted text-[14px]">현장과의 더많은 소통으로 사전에 위험을 통제하세요</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-cur-muted group-hover:text-cur-primary transition-colors" />
            </div>
          </div>

          <div
            onClick={() => router.push('/safety-log')}
            className="border border-cur-hairline bg-cur-card hover:border-cur-primary/40 transition-all cursor-pointer rounded-[12px] group"
          >
            <div className="p-5 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="bg-cur-elevated w-12 h-12 rounded-[8px] flex items-center justify-center text-cur-ink group-hover:bg-cur-primary/15 group-hover:text-cur-primary transition-colors">
                  <HardHat className="w-6 h-6" />
                </div>
                <div className="space-y-0.5">
                  <h3 className="text-[16px] font-semibold text-cur-ink">안전보건교육일지 작성</h3>
                  <p className="text-cur-muted text-[14px]">TBM·정기교육 등 안전보건교육일지를 AI로 기록 관리</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-cur-muted group-hover:text-cur-primary transition-colors" />
            </div>
          </div>

        </div>
      </div>

      {showOnboarding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-cur-card rounded-[12px] p-8 w-full max-w-sm shadow-[0_16px_48px_rgba(0,0,0,0.1)] animate-in zoom-in-95 duration-200 border border-cur-hairline">
            <h3 className="text-[22px] font-bold text-cur-ink mb-2 tracking-tight">환영합니다!</h3>
            <p className="text-cur-muted text-[14px] mb-6 leading-[1.5]">원활한 일지 작성을 위해<br />기본 정보를 설정해주세요.</p>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[13px] font-medium text-cur-body">소속 현장명 (또는 업체명)</label>
                <Input
                  value={companyInput}
                  onChange={(e) => setCompanyInput(e.target.value)}
                  placeholder="소속 현장명 (또는 업체명)"
                  className="h-11 text-[14px] border-cur-hairline rounded-[6px] focus:border-cur-primary focus:ring-1 focus:ring-cur-primary bg-cur-elevated text-cur-ink placeholder:text-cur-muted"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[13px] font-medium text-cur-body">근로자 구분 (교육시간 산정용)</label>
                <Select value={workerType} onValueChange={setWorkerType}>
                  <SelectTrigger className="w-full h-11 text-[14px] border-cur-hairline rounded-[6px] bg-cur-elevated text-cur-ink focus:ring-1 focus:ring-cur-primary">
                    <SelectValue placeholder="직군 선택" />
                  </SelectTrigger>
                  <SelectContent className="bg-cur-card border-cur-hairline text-cur-body">

                    <SelectItem value="현장 근로자 (비사무직)">현장 근로자 (비사무직) (반기 12시간)</SelectItem>
                    <SelectItem value="사무직 / 판매직">사무직 / 판매직 (반기 6시간)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={handleSaveCompany}
                disabled={isUpdating}
                className="w-full h-11 mt-4 text-[14px] font-semibold bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-[6px]"
              >
                {isUpdating ? <Loader2 className="animate-spin mr-2 w-4 h-4" /> : null} 저장하고 시작하기
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}