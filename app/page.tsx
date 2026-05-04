"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { HardHat, Mic, MessageSquareWarning, LogOut, UserCircle, Loader2, FileText, Users, ChevronRight } from "lucide-react"
import { TBMHeader } from "@/components/TBMHeader"

export default function MainPage() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(true)
  const [user, setUser] = useState<any>(null)

  const [tbmCount, setTbmCount] = useState(0)
  const [tbmMinutesCount, setTbmMinutesCount] = useState(0)
  const [statsLoading, setStatsLoading] = useState(true)
  const [totalEducationHours, setTotalEducationHours] = useState("0.0")
  const [requiredHours, setRequiredHours] = useState(16)

  const [showOnboarding, setShowOnboarding] = useState(false)
  const [companyInput, setCompanyInput] = useState("")
  const [workerType, setWorkerType] = useState("관리감독자")
  const [isUpdating, setIsUpdating] = useState(false)
  const [privacyAgreed, setPrivacyAgreed] = useState(false)

  useEffect(() => {
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        const currentUser = session.user
        setUser(currentUser)

        if (!currentUser.user_metadata?.company_name || !currentUser.user_metadata?.worker_type) {
          setWorkerType(currentUser.user_metadata?.worker_type || "관리감독자")
          if (currentUser.user_metadata?.company_name) setCompanyInput(currentUser.user_metadata.company_name)
          setShowOnboarding(true)
        }

        fetchUserStats(currentUser.id, currentUser.user_metadata?.worker_type || "관리감독자")
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
      if (currentWorkerType === '관리감독자') {
        validLogs = [...(tbmLogs||[]), ...(minutesLogs||[])].filter(log => log.date?.startsWith(`${currentYear}`))
        setRequiredHours(16)
      } else if (currentWorkerType === '현장 근로자 (비사무직)') {
        validLogs = [...(tbmLogs||[]), ...(minutesLogs||[])].filter(log => {
          if (!log.date) return false
          const month = parseInt(log.date.split('-')[1], 10)
          return log.date.startsWith(`${currentYear}`) && (isFirstHalf ? month <= 6 : month > 6)
        })
        setRequiredHours(12)
      } else { // 사무직 / 판매직
        validLogs = [...(tbmLogs||[]), ...(minutesLogs||[])].filter(log => {
          if (!log.date) return false
          const month = parseInt(log.date.split('-')[1], 10)
          return log.date.startsWith(`${currentYear}`) && (isFirstHalf ? month <= 6 : month > 6)
        })
        setRequiredHours(6)
      }

      let totalMins = 0
      validLogs.forEach(log => {
        if (log.start_time && log.end_time) {
          const [sh, sm] = log.start_time.split(':').map(Number)
          const [eh, em] = log.end_time.split(':').map(Number)
          let diff = (eh * 60 + em) - (sh * 60 + sm)
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

  if (isLoading) return <div className="min-h-screen flex items-center justify-center bg-expo-canvas"><Loader2 className="w-10 h-10 text-expo-ink animate-spin" /></div>

  // [화면 1] 비로그인 상태
  if (!user) {
    return (
      <div className="min-h-screen bg-expo-canvas flex flex-col relative overflow-hidden font-sans text-expo-ink">
        {/* Soft Sky-blue wash behind hero */}
        <div className="absolute top-0 left-0 right-0 h-[60vh] bg-gradient-to-b from-[#cfe7ff] via-[#a8c8e8]/30 to-expo-canvas -z-10"></div>
        
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-700 max-w-lg mx-auto w-full">
          <div className="space-y-6 flex flex-col items-center">
            <div className="bg-expo-surface-dark p-5 rounded-[16px] shadow-sm flex items-center justify-center w-20 h-20">
              <HardHat className="w-10 h-10 text-white" />
            </div>
            
            <div className="space-y-3">
              <h1 className="text-[36px] sm:text-[48px] font-semibold text-expo-ink tracking-[-1.44px] leading-[1.1]">
                안전톡톡
              </h1>
              <p className="text-expo-body text-[16px] sm:text-[18px]">
                TBM부터 AI 제안까지 한 번에
              </p>
            </div>
          </div>

          <div className="w-full space-y-5 bg-white p-6 rounded-[16px] shadow-[0_4px_12px_rgba(0,0,0,0.04)] border border-expo-hairline">
            <div className="flex items-start gap-3 bg-expo-surface-strong/50 rounded-[8px] p-4 text-left">
              <Checkbox
                id="privacy-agree"
                checked={privacyAgreed}
                onCheckedChange={(checked) => setPrivacyAgreed(checked === true)}
                className="mt-0.5 border-expo-hairline-strong data-[state=checked]:bg-expo-primary data-[state=checked]:text-white rounded-[4px]"
              />
              <label htmlFor="privacy-agree" className="text-[14px] text-expo-body leading-[1.5] cursor-pointer">
                <a href="/privacy" target="_blank" className="text-expo-text-link font-medium">개인정보처리방침</a> 및{" "}
                <a href="/terms" target="_blank" className="text-expo-text-link font-medium">서비스 이용약관</a>에 동의합니다.
              </label>
            </div>
            
            <Button 
              onClick={handleKakaoLogin} 
              disabled={!privacyAgreed} 
              className="w-full h-12 bg-[#FEE500] hover:bg-[#FEE500]/90 text-[#000000] text-[15px] font-medium rounded-[8px] shadow-sm flex items-center justify-center transition-all disabled:opacity-50"
            >
              <MessageSquareWarning className="w-5 h-5 mr-2 fill-black" /> 카카오 계정으로 시작
            </Button>
            
            <Button 
              onClick={() => router.push('/login')} 
              disabled={!privacyAgreed} 
              variant="outline" 
              className="w-full h-12 bg-white border border-expo-hairline-strong hover:bg-expo-surface-strong text-expo-ink text-[15px] font-medium rounded-[8px] flex items-center justify-center transition-all disabled:opacity-50"
            >
              <UserCircle className="w-5 h-5 mr-2" /> 일반 계정으로 시작
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-expo-surface-strong min-h-screen sm:py-8 flex sm:block items-center justify-center font-sans text-expo-ink pb-20">
      <div className="max-w-lg w-full mx-auto bg-white sm:shadow-[0_8px_32px_rgba(0,0,0,0.04)] sm:rounded-[24px] relative flex flex-col min-h-[100dvh] sm:min-h-[85vh] border-x sm:border border-expo-hairline mb-[env(safe-area-inset-bottom)] overflow-hidden">

        {/* 헤더 */}
        <div className="p-4 bg-white border-b border-expo-hairline sticky top-0 z-50">
          <TBMHeader title="안전톡톡" onLogout={handleLogout} />
        </div>

        <div className="p-4 sm:p-6">
          {/* ⭐️ 교육 현황 진행도 카드 (New) */}
          <div className="bg-white rounded-[12px] p-5 border border-expo-hairline shadow-[0_4px_12px_rgba(0,0,0,0.02)] mb-6">
            <div className="flex justify-between items-center mb-3">
              <h3 className="text-[15px] font-semibold text-expo-ink flex items-center gap-2">
                법정 의무 교육 진행도
                <span className="bg-expo-canvas-soft px-2 py-0.5 rounded-[4px] text-[11px] text-expo-muted font-medium">
                  {user?.user_metadata?.worker_type || '관리감독자'}
                </span>
              </h3>
              <div className="text-[14px] font-semibold text-expo-primary">
                {statsLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : `${totalEducationHours} / ${requiredHours}시간`}
              </div>
            </div>
            <div className="w-full h-2.5 bg-expo-canvas-soft rounded-full overflow-hidden">
              <div 
                className="h-full bg-expo-primary rounded-full transition-all duration-1000 ease-out" 
                style={{ width: `${Math.min(100, (parseFloat(totalEducationHours) / requiredHours) * 100)}%` }} 
              />
            </div>
            <p className="text-[12px] text-expo-muted mt-3 leading-relaxed">
              {user?.user_metadata?.worker_type === '관리감독자' 
                ? '연간 16시간 이상 (정기교육 TBM 대체 가능)' 
                : '반기별 기준 (정기교육 TBM 대체 가능)'}
            </p>
          </div>

          {/* ⭐️ 현황 요약 카드 */}
          <div className="bg-expo-surface-card rounded-[12px] flex text-center divide-x divide-expo-hairline border border-expo-hairline shadow-[0_4px_12px_rgba(0,0,0,0.02)]">
            <div onClick={() => router.push('/analytics')} className="flex-1 py-4 px-2 cursor-pointer hover:bg-expo-canvas-soft transition-colors rounded-l-[12px]">
              <div className="text-[11px] text-expo-muted font-semibold uppercase tracking-[0.88px] mb-1">TBM 회의록</div>
              <div className="text-[28px] font-semibold text-expo-ink">
                {statsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-expo-muted" /> : tbmMinutesCount}
              </div>
            </div>
            <div onClick={() => router.push('/analytics')} className="flex-1 py-4 px-2 cursor-pointer hover:bg-expo-canvas-soft transition-colors rounded-r-[12px]">
              <div className="text-[11px] text-expo-muted font-semibold uppercase tracking-[0.88px] mb-1">TBM 일지</div>
              <div className="text-[28px] font-semibold text-expo-ink">
                {statsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-expo-muted" /> : tbmCount}
              </div>
            </div>
          </div>
        </div>

        {/* 핵심 기능 메뉴 */}
        <div className="flex-1 p-6 bg-white space-y-4">
          
          <Card 
            onClick={() => router.push('/tbm-minutes')} 
            className="border border-expo-hairline bg-white hover:shadow-[0_4px_12px_rgba(0,0,0,0.04)] hover:border-expo-hairline-strong transition-all cursor-pointer rounded-[12px] group"
          >
            <CardContent className="p-6 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="bg-expo-surface-strong w-12 h-12 rounded-[8px] flex items-center justify-center text-expo-ink group-hover:bg-expo-ink group-hover:text-white transition-colors">
                  <Users className="w-6 h-6" />
                </div>
                <div className="space-y-0.5">
                  <h3 className="text-[16px] font-semibold text-expo-ink">TBM 회의록 작성</h3>
                  <p className="text-expo-body text-[14px]">안전보건관련 논의 및 회의 기록 작성</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-expo-muted-soft group-hover:text-expo-ink transition-colors" />
            </CardContent>
          </Card>

          <Card 
            onClick={() => router.push('/tbm')} 
            className="border border-expo-hairline bg-white hover:shadow-[0_4px_12px_rgba(0,0,0,0.04)] hover:border-expo-hairline-strong transition-all cursor-pointer rounded-[12px] group"
          >
            <CardContent className="p-6 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="bg-expo-surface-strong w-12 h-12 rounded-[8px] flex items-center justify-center text-expo-ink group-hover:bg-expo-ink group-hover:text-white transition-colors">
                  <HardHat className="w-6 h-6" />
                </div>
                <div className="space-y-0.5">
                  <h3 className="text-[16px] font-semibold text-expo-ink">TBM 일지 작성</h3>
                  <p className="text-expo-body text-[14px]">작업 전 안전점검 목록 및 사진 등 기록</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-expo-muted-soft group-hover:text-expo-ink transition-colors" />
            </CardContent>
          </Card>

        </div>
      </div>

      {/* 온보딩 팝업 */}
      {showOnboarding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-[16px] p-8 w-full max-w-sm shadow-xl animate-in zoom-in-95 duration-200 border border-expo-hairline">
            <h3 className="text-[22px] font-semibold text-expo-ink mb-2 tracking-tight">환영합니다!</h3>
            <p className="text-expo-body text-[14px] mb-6 leading-[1.5]">원활한 일지 작성을 위해<br />기본 정보를 설정해주세요.</p>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[13px] font-medium text-expo-ink">소속 현장명 (또는 업체명)</label>
                <Input 
                  value={companyInput} 
                  onChange={(e) => setCompanyInput(e.target.value)} 
                  placeholder="소속 현장명 (또는 업체명)" 
                  className="h-11 text-[14px] border-expo-hairline-strong rounded-[8px] focus:border-expo-ink focus:ring-1 focus:ring-expo-ink bg-white" 
                />
              </div>
              <div className="space-y-2">
                <label className="text-[13px] font-medium text-expo-ink">근로자 구분 (교육시간 산정용)</label>
                <Select value={workerType} onValueChange={setWorkerType}>
                  <SelectTrigger className="w-full h-11 text-[14px] border-expo-hairline-strong rounded-[8px] bg-white focus:ring-1 focus:ring-expo-ink">
                    <SelectValue placeholder="직군 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="관리감독자">관리감독자 (연간 16시간)</SelectItem>
                    <SelectItem value="현장 근로자 (비사무직)">현장 근로자 (비사무직) (반기 12시간)</SelectItem>
                    <SelectItem value="사무직 / 판매직">사무직 / 판매직 (반기 6시간)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button 
                onClick={handleSaveCompany} 
                disabled={isUpdating} 
                className="w-full h-11 mt-4 text-[14px] font-medium bg-expo-primary hover:bg-expo-primary-active text-white rounded-[8px]"
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