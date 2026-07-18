// app/page.tsx
"use client"

import { useState, useEffect, useRef, type KeyboardEvent } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { fetchAllRows } from "@/lib/fetchAllRows"
import { useRequireSubscription } from "@/lib/useSubscription"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { HardHat, Loader2, Users, ChevronRight, CalendarDays } from "lucide-react"
import { TBMHeader } from "@/components/TBMHeader"
import { Logo } from "@/components/Logo"
import { NoticeBanner } from "@/components/NoticeBanner"
import { totalSeconds, secondsToHours, formatDuration } from "@/lib/educationHours"
import { type ExportFormat } from "@/lib/exportFormats"
import { ExportFormatPicker } from "@/components/ExportFormatPicker"
import { cn } from "@/lib/utils"

// created_at(타임스탬프)을 로컬 기준 YYYY-MM-DD로 변환 — tbm_logs/minutes의 date 컬럼과 같은 기준으로 월 집계
const toLocalDateStr = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export default function MainPage() {
  const router = useRouter()
  const { checking } = useRequireSubscription()
  const [isLoading, setIsLoading] = useState(true)
  const [user, setUser] = useState<any>(null)

  const [tbmCount, setTbmCount] = useState(0)
  const [tbmMinutesCount, setTbmMinutesCount] = useState(0)
  const [statsLoading, setStatsLoading] = useState(true)
  const [totalEducationSeconds, setTotalEducationSeconds] = useState(0)
  const [requiredHours, setRequiredHours] = useState(16)
  // 진행도 바 순차 애니메이션: 진한 바(0~100%) 먼저 → 초과분 이어서
  const [animBase, setAnimBase] = useState(0)
  const [animOver, setAnimOver] = useState(0)

  // 월별 건수 필터용 원본(날짜만) + 선택 월("all" = 전체)
  const [logDates, setLogDates] = useState<string[]>([])
  const [minuteDates, setMinuteDates] = useState<string[]>([])
  const [suggestionDates, setSuggestionDates] = useState<string[]>([])
  const [unreadSuggestions, setUnreadSuggestions] = useState(0)
  const [selectedMonth, setSelectedMonth] = useState("all")

  // 문서 출력 형식 최초 설정 모달 (user_metadata.preferred_export_format 없을 때 1회)
  // 구 가입 플로우 유저는 worker_type도 없을 수 있어(온보딩 모달 제거로 유도 경로 상실) 같은 모달에서 함께 수집한다.
  const [showFormatModal, setShowFormatModal] = useState(false)
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat | null>(null)
  const [needsWorkerType, setNeedsWorkerType] = useState(false)
  const [workerTypeInput, setWorkerTypeInput] = useState("현장 근로자 (비사무직)")
  const [isSavingFormat, setIsSavingFormat] = useState(false)
  const formatModalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        const currentUser = session.user
        setUser(currentUser)

        const meta = currentUser.user_metadata
        if (!meta?.preferred_export_format || !meta?.worker_type) {
          if (meta?.preferred_export_format) setSelectedFormat(meta.preferred_export_format)
          setNeedsWorkerType(!meta?.worker_type)
          setShowFormatModal(true)
        }

        fetchUserStats(currentUser.id, currentUser.user_metadata?.worker_type || "현장 근로자 (비사무직)")
      }
      setIsLoading(false)
    }
    checkSession()
  }, [])

  // 모달이 뜨면 대화상자로 초점 이동 (배경 카드들이 tabIndex를 가져 오버레이 뒤로 초점이 새는 것 방지)
  useEffect(() => {
    if (showFormatModal) formatModalRef.current?.focus()
  }, [showFormatModal])

  const fetchUserStats = async (userId: string, currentWorkerType: string) => {
    setStatsLoading(true)
    try {
      const now = new Date()
      const currentYear = now.getFullYear()
      const isFirstHalf = now.getMonth() < 6
      // 이수시간은 당해 반기 문서만 계산 대상 → 시간 컬럼은 반기 창으로 한정 조회.
      // 전체 이력은 날짜만(카운트·월 옵션용) — 이력이 몇 년치 쌓여도 페이로드 상한 유지.
      const halfStart = `${currentYear}-${isFirstHalf ? '01' : '07'}-01`
      const halfEnd = `${currentYear}-${isFirstHalf ? '06-30' : '12-31'}`

      // fetchAllRows = PostgREST 1000행 침묵 절단 방지 (장기 사용자도 카운트·월 옵션 정확)
      const [logDateRows, minuteDateRows, logTimeRows, minuteTimeRows, suggestionRows] = await Promise.all([
        fetchAllRows<{ date: string | null }>((f, t) => supabase.from('tbm_logs').select('date').eq('user_id', userId).order('id').range(f, t)),
        fetchAllRows<{ date: string | null }>((f, t) => supabase.from('tbm_minutes').select('date').eq('user_id', userId).order('id').range(f, t)),
        fetchAllRows<{ start_time: string | null; end_time: string | null }>((f, t) => supabase.from('tbm_logs').select('start_time, end_time').eq('user_id', userId).gte('date', halfStart).lte('date', halfEnd).order('id').range(f, t)),
        fetchAllRows<{ start_time: string | null; end_time: string | null }>((f, t) => supabase.from('tbm_minutes').select('start_time, end_time').eq('user_id', userId).gte('date', halfStart).lte('date', halfEnd).order('id').range(f, t)),
        // 제안함은 RLS로 소유자 범위 한정(suggestions 페이지와 동일) — 실패해도 다른 통계는 유지
        fetchAllRows<{ created_at: string | null; is_read: boolean | null }>((f, t) => supabase.from('worker_suggestions').select('created_at, is_read').order('id').range(f, t)).catch(() => []),
      ])

      setTbmCount(logDateRows.length)
      setTbmMinutesCount(minuteDateRows.length)
      setLogDates(logDateRows.map(l => l.date).filter(Boolean) as string[])
      setMinuteDates(minuteDateRows.map(l => l.date).filter(Boolean) as string[])
      // created_at은 UTC 타임스탬프 → 로컬 날짜로 변환해야 tbm_logs/minutes(date 컬럼)와 월 기준이 맞음
      setSuggestionDates(suggestionRows.map(s => s.created_at ? toLocalDateStr(s.created_at) : null).filter(Boolean) as string[])
      setUnreadSuggestions(suggestionRows.filter(s => s.is_read === false).length)

      setRequiredHours(currentWorkerType === '사무직 / 판매직' ? 6 : 12)

      const validLogs = [...(logTimeRows || []), ...(minuteTimeRows || [])]
      setTotalEducationSeconds(totalSeconds(validLogs))
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
    setSuggestionDates([])
    setUnreadSuggestions(0)
  }

  // 출력 형식(+구 유저의 근로자 구분) 저장 → user_metadata (내 정보 수정에서 언제든 변경 가능)
  const handleSaveFormat = async () => {
    if (!selectedFormat) return
    setIsSavingFormat(true)
    const { data, error } = await supabase.auth.updateUser({
      data: {
        preferred_export_format: selectedFormat,
        ...(needsWorkerType ? { worker_type: workerTypeInput } : {}),
      }
    })
    if (error) { alert("저장 실패: " + error.message); setIsSavingFormat(false); return; }
    setUser(data.user)
    if (needsWorkerType) setRequiredHours(workerTypeInput === '사무직 / 판매직' ? 6 : 12)
    setShowFormatModal(false)
    setIsSavingFormat(false)
  }

  const rawPercent = (secondsToHours(totalEducationSeconds) / requiredHours) * 100
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

  // 월 선택 옵션(데이터가 있는 달, 최신순 — 제안만 있는 달도 포함) + 선택 월 기준 건수
  const monthOptions = [...new Set([...logDates, ...minuteDates, ...suggestionDates].map(d => d.slice(0, 7)))].sort().reverse()
  const countInMonth = (dates: string[]) => selectedMonth === "all" ? dates.length : dates.filter(d => d.startsWith(selectedMonth)).length
  const shownMinutes = countInMonth(minuteDates)
  const shownLogs = countInMonth(logDates)
  const shownSuggestions = countInMonth(suggestionDates)
  const monthLabel = (m: string) => `${m.slice(0, 4)}년 ${parseInt(m.slice(5, 7), 10)}월`

  // 활동 현황 카드 키보드 접근성: Enter/Space가 onClick과 동일하게 동작
  const cardKeyDown = (go: () => void) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go() }
  }

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

            {/* gap-px + bg-cur-hairline 트릭: 모바일 2×2, sm 4열 양방향 hairline 구분선 */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-cur-hairline border border-cur-hairline rounded-[12px] overflow-hidden text-center">
              <div onClick={() => router.push('/analytics')} role="button" tabIndex={0} aria-label="TBM 회의록 목록 보기" onKeyDown={cardKeyDown(() => router.push('/analytics'))} className="relative py-5 px-2 cursor-pointer bg-cur-card hover:bg-cur-elevated active:bg-cur-elevated transition-colors">
                <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft absolute bottom-2 right-2" />
                <div className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.88px] mb-1">TBM 회의록</div>
                <div className="text-[28px] font-bold text-cur-ink font-mono">
                  {statsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-cur-muted" /> : shownMinutes}
                </div>
              </div>
              <div onClick={() => router.push('/analytics/education')} role="button" tabIndex={0} aria-label="안전보건교육일지 목록 보기" onKeyDown={cardKeyDown(() => router.push('/analytics/education'))} className="relative py-5 px-2 cursor-pointer bg-cur-card hover:bg-cur-elevated active:bg-cur-elevated transition-colors">
                <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft absolute bottom-2 right-2" />
                <div className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.88px] mb-1">안전보건교육일지</div>
                <div className="text-[28px] font-bold text-cur-ink font-mono">
                  {statsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-cur-muted" /> : shownLogs}
                </div>
              </div>
              <div onClick={() => router.push('/suggestions')} role="button" tabIndex={0} aria-label="근로자 제안함 보기" onKeyDown={cardKeyDown(() => router.push('/suggestions'))} className="relative py-5 px-2 cursor-pointer bg-cur-card hover:bg-cur-elevated active:bg-cur-elevated transition-colors">
                {!statsLoading && unreadSuggestions > 0 && (
                  <span className="absolute top-2 right-2 bg-cur-primary text-cur-on-primary text-[10px] font-bold px-1.5 py-0.5 rounded-full">{unreadSuggestions}</span>
                )}
                <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft absolute bottom-2 right-2" />
                <div className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.88px] mb-1">근로자 제안함</div>
                <div className="text-[28px] font-bold text-cur-ink font-mono">
                  {statsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-cur-muted" /> : shownSuggestions}
                </div>
              </div>
              <div onClick={() => router.push('/dashboard')} role="button" tabIndex={0} aria-label="안전문서 달력 보기" onKeyDown={cardKeyDown(() => router.push('/dashboard'))} className="relative py-5 px-2 cursor-pointer bg-cur-card hover:bg-cur-elevated active:bg-cur-elevated transition-colors flex flex-col items-center justify-center">
                <ChevronRight className="w-3.5 h-3.5 text-cur-muted-soft absolute bottom-2 right-2" />
                <div className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.88px] mb-1">안전문서 달력</div>
                <div className="bg-cur-elevated w-10 h-10 rounded-[8px] flex items-center justify-center text-cur-ink mx-auto">
                  <CalendarDays className="w-5 h-5" />
                </div>
              </div>
            </div>
          </div>

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
                  {statsLoading ? <Loader2 className="w-4 h-4 animate-spin inline-block" /> : `${formatDuration(totalEducationSeconds)} / ${requiredHours}시간`}
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

      {/* 출력 형식 최초 설정 모달 — preferred_export_format이 없을 때 1회 표시 */}
      {showFormatModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div
            ref={formatModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="format-modal-title"
            tabIndex={-1}
            className="bg-cur-card rounded-[12px] p-8 w-full max-w-sm shadow-[0_16px_48px_rgba(0,0,0,0.1)] animate-in zoom-in-95 duration-200 border border-cur-hairline outline-none"
          >
            <h3 id="format-modal-title" className="text-[22px] font-bold text-cur-ink mb-2 tracking-tight">문서 출력 형식</h3>
            <p className="text-cur-muted text-[14px] mb-6 leading-[1.5]">회의록·일지 등 결과물을 어떤 형식으로 받을지 선택하세요. 내 정보 수정에서 언제든 바꿀 수 있어요.</p>
            <ExportFormatPicker value={selectedFormat} onChange={setSelectedFormat} />
            <p className="text-[12px] text-cur-muted-soft mt-3 leading-relaxed">PDF는 편집이 불가능한 출력 전용 형식입니다.</p>
            {needsWorkerType && (
              <div className="mt-5 space-y-2">
                <label className="text-[13px] font-medium text-cur-body">근로자 구분 (교육시간 산정용)</label>
                <Select value={workerTypeInput} onValueChange={setWorkerTypeInput}>
                  <SelectTrigger className="w-full h-11 text-[14px] border-cur-hairline rounded-[8px] bg-cur-elevated text-cur-ink focus:ring-1 focus:ring-cur-primary">
                    <SelectValue placeholder="직군 선택" />
                  </SelectTrigger>
                  <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                    <SelectItem value="현장 근로자 (비사무직)">현장 근로자 (비사무직) (반기 12시간)</SelectItem>
                    <SelectItem value="사무직 / 판매직">사무직 / 판매직 (반기 6시간)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <Button
              onClick={handleSaveFormat}
              disabled={!selectedFormat || isSavingFormat}
              className="w-full h-12 mt-5 text-[15px] font-bold bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-[8px]"
            >
              {isSavingFormat ? <Loader2 className="animate-spin mr-2 w-4 h-4" /> : null} 저장하고 시작하기
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}