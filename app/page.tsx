// app/page.tsx
"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { useRequireSubscription } from "@/lib/useSubscription"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { HardHat, Mic, MessageSquareWarning, LogOut, UserCircle, Loader2, FileText, Users, ChevronRight, ShieldCheck } from "lucide-react"
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

  const [showOnboarding, setShowOnboarding] = useState(false)
  const [companyInput, setCompanyInput] = useState("")
  const [workerType, setWorkerType] = useState("현장 근로자 (비사무직)")
  const [isUpdating, setIsUpdating] = useState(false)
  const [privacyAgreed, setPrivacyAgreed] = useState(false)

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
      const { data: tbmLogs } = await supabase.from('tbm_logs').select('id, date, start_time, end_time').eq('user_id', userId)
      const { data: minutesLogs } = await supabase.from('tbm_minutes').select('id, date, start_time, end_time').eq('user_id', userId)

      setTbmCount(tbmLogs?.length || 0)
      setTbmMinutesCount(minutesLogs?.length || 0)

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

  const handleKakaoLogin = async () => {
    setIsLoading(true)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'kakao',
      options: { redirectTo: `${window.location.origin}/` }
    })
    if (error) {
      alert("카카오 로그인 에러: " + error.message)
      setIsLoading(false)
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
  const maxScale = rawPercent > 100 ? 150 : 100
  const fillWidth = Math.min(100, (rawPercent / maxScale) * 100)
  const tickPosition = (100 / maxScale) * 100

  if (isLoading || checking) return <div className="min-h-screen flex items-center justify-center bg-cur-canvas"><Loader2 className="w-10 h-10 text-cur-primary animate-spin" /></div>

  if (!user) {
    return (
      <div className="min-h-screen bg-cur-canvas flex flex-col relative overflow-hidden font-sans">
        <div className="absolute top-0 left-0 right-0 h-[50vh] bg-gradient-to-b from-cur-primary/10 via-cur-primary/5 to-transparent -z-10"></div>

        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-700 max-w-lg mx-auto w-full">
          <div className="space-y-6 flex flex-col items-center">
            <Logo size="lg" />

            <div className="space-y-3">
              <p className="text-cur-muted text-[16px] sm:text-[18px]">
                더 많은 대화로 더 안전한 현장을
              </p>
            </div>
          </div>

          <div className="w-full space-y-5 bg-cur-card p-6 rounded-[12px] border border-cur-hairline">
            <div className="flex items-start gap-3 bg-cur-elevated rounded-[8px] p-4 text-left">
              <Checkbox
                id="privacy-agree"
                checked={privacyAgreed}
                onCheckedChange={(checked) => setPrivacyAgreed(checked === true)}
                className="mt-0.5 border-cur-muted data-[state=checked]:bg-cur-primary data-[state=checked]:text-cur-on-primary rounded-[4px]"
              />
              <label htmlFor="privacy-agree" className="text-[14px] text-cur-body leading-[1.5] cursor-pointer">
                <a href="/privacy" target="_blank" className="text-cur-primary font-medium hover:underline">개인정보처리방침</a> 및{" "}
                <a href="/terms" target="_blank" className="text-cur-primary font-medium hover:underline">서비스 이용약관</a>에 동의합니다.
              </label>
            </div>

            <Button
              onClick={handleKakaoLogin}
              disabled={!privacyAgreed}
              className="w-full h-12 bg-[#FEE500] hover:bg-[#FEE500]/90 text-[#000000] text-[15px] font-semibold rounded-[6px] flex items-center justify-center transition-all disabled:opacity-30"
            >
              <MessageSquareWarning className="w-5 h-5 mr-2 fill-black" /> 카카오 계정으로 시작
            </Button>

            <Button
              onClick={() => router.push('/login')}
              disabled={!privacyAgreed}
              variant="outline"
              className="w-full h-12 bg-cur-elevated border border-cur-hairline hover:bg-cur-elevated/80 text-cur-body text-[15px] font-semibold rounded-[6px] flex items-center justify-center transition-all disabled:opacity-30"
            >
              <UserCircle className="w-5 h-5 mr-2" /> 일반 계정으로 시작
            </Button>
          </div>
        </div>
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
          <div className="bg-cur-card rounded-[12px] p-5 border border-cur-hairline">
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-[15px] font-semibold text-cur-ink flex items-center gap-2 tracking-[-0.11px]">
                법정 의무 교육 진행도
                <span className="bg-cur-primary/15 px-2 py-0.5 rounded-[4px] text-[11px] text-cur-primary font-semibold">
                  {user?.user_metadata?.worker_type || '현장 근로자 (비사무직)'}
                </span>
              </h3>
            </div>

            <div className="relative mt-2 mb-8">
              {/* Text above the bar */}
              <div
                className="absolute -top-7 text-[13px] font-bold text-cur-primary font-mono whitespace-nowrap"
                style={
                  fillWidth > 85
                    ? { right: '0%' }
                    : { left: `${fillWidth}%`, transform: 'translateX(-50%)' }
                }
              >
                {statsLoading ? <Loader2 className="w-4 h-4 animate-spin inline-block text-cur-primary" /> : `${totalEducationHours} / ${requiredHours} (시간)`}
              </div>

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

                {/* Filled bar */}
                <div
                  className="h-full bg-gradient-to-r from-cur-primary-active to-cur-primary rounded-full transition-all duration-1000 ease-out absolute left-0 top-0"
                  style={{ width: `${fillWidth}%` }}
                />
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
              {user?.user_metadata?.worker_type === '사무직 / 판매직'
                ? '반기별 6시간 이상 (정기교육 TBM 대체 가능)'
                : '반기별 12시간 이상 (정기교육 TBM 대체 가능)'}
            </p>
          </div>

          <div className="rounded-[12px] flex text-center divide-x divide-cur-hairline border border-cur-hairline bg-cur-card overflow-hidden">
            <div onClick={() => router.push('/analytics')} className="flex-1 py-5 px-2 cursor-pointer hover:bg-cur-elevated transition-colors">
              <div className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.88px] mb-1">TBM 회의록</div>
              <div className="text-[28px] font-bold text-cur-ink font-mono">
                {statsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-cur-muted" /> : tbmMinutesCount}
              </div>
            </div>
            <div onClick={() => router.push('/analytics')} className="flex-1 py-5 px-2 cursor-pointer hover:bg-cur-elevated transition-colors">
              <div className="text-[11px] text-cur-muted font-semibold uppercase tracking-[0.88px] mb-1">TBM 일지</div>
              <div className="text-[28px] font-bold text-cur-ink font-mono">
                {statsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-cur-muted" /> : tbmCount}
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
            onClick={() => router.push('/tbm')}
            className="border border-cur-hairline bg-cur-card hover:border-cur-primary/40 transition-all cursor-pointer rounded-[12px] group"
          >
            <div className="p-5 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="bg-cur-elevated w-12 h-12 rounded-[8px] flex items-center justify-center text-cur-ink group-hover:bg-cur-primary/15 group-hover:text-cur-primary transition-colors">
                  <HardHat className="w-6 h-6" />
                </div>
                <div className="space-y-0.5">
                  <h3 className="text-[16px] font-semibold text-cur-ink">안전보건교육일지 작성</h3>
                  <p className="text-cur-muted text-[14px]">정기 교육일지 등을 AI로 똑똑하게 기록 관리</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-cur-muted group-hover:text-cur-primary transition-colors" />
            </div>
          </div>

          <div
            onClick={() => router.push('/risk-assessment')}
            className="border border-cur-hairline bg-cur-card hover:border-cur-primary/40 transition-all cursor-pointer rounded-[12px] group"
          >
            <div className="p-5 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="bg-cur-elevated w-12 h-12 rounded-[8px] flex items-center justify-center text-cur-ink group-hover:bg-cur-primary/15 group-hover:text-cur-primary transition-colors">
                  <ShieldCheck className="w-6 h-6" />
                </div>
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[16px] font-semibold text-cur-ink">위험성평가 자동 생성</h3>
                    <span className="bg-cur-primary/15 text-cur-primary text-[10px] font-bold px-1.5 py-0.5 rounded-[4px] tracking-wide">PRO</span>
                  </div>
                  <p className="text-cur-muted text-[14px]">작업만 입력하면 AI가 위험성평가표 작성</p>
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