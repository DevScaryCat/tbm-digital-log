"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { HardHat, Mic, MessageSquareWarning, LogOut, UserCircle, Loader2 } from "lucide-react"

export default function MainPage() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(true)
  const [user, setUser] = useState<any>(null)

  // 진짜 데이터를 담을 상태(State) 3가지
  const [tbmCount, setTbmCount] = useState(0)
  const [suggestionCount, setSuggestionCount] = useState(0)
  const [statsLoading, setStatsLoading] = useState(true)

  const [showOnboarding, setShowOnboarding] = useState(false)
  const [companyInput, setCompanyInput] = useState("")
  const [isUpdating, setIsUpdating] = useState(false)
  const [privacyAgreed, setPrivacyAgreed] = useState(false)

  // 로그인 상태 확인 및 데이터 불러오기
  useEffect(() => {
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        const currentUser = session.user
        setUser(currentUser)

        if (!currentUser.user_metadata?.company_name) {
          setShowOnboarding(true)
        }

        fetchUserStats(currentUser.id)
      }
      setIsLoading(false)
    }
    checkSession()
  }, [])

  // Supabase에서 내가 작성한 데이터 개수 가져오기 (인덱스 활용)
  const fetchUserStats = async (userId: string) => {
    setStatsLoading(true)
    try {
      // 1. TBM 개수 - user_id 인덱스 활용
      const { count: tbm } = await supabase.from('tbm_logs').select('id', { count: 'exact', head: true }).eq('user_id', userId)
      if (tbm !== null) setTbmCount(tbm)

      // 2. 제안 개수 - user_id 인덱스 활용
      const { count: sug } = await supabase.from('suggestions').select('id', { count: 'exact', head: true }).eq('user_id', userId)
      if (sug !== null) setSuggestionCount(sug)
    } catch (e) {
      console.error("통계 에러:", e)
    } finally {
      setStatsLoading(false)
    }
  }

  // 카카오 로그인
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

  // 로그아웃
  const handleLogout = async () => {
    await supabase.auth.signOut()
    setUser(null)
    setTbmCount(0)
    setSuggestionCount(0)
  }

  // 온보딩 현장명 저장
  const handleSaveCompany = async () => {
    if (!companyInput.trim()) return alert("현장명(업체명)을 입력해주세요.")
    setIsUpdating(true)
    const { data, error } = await supabase.auth.updateUser({ data: { company_name: companyInput.trim() } })
    if (error) { alert("저장 실패: " + error.message); setIsUpdating(false); return; }
    setUser(data.user)
    setShowOnboarding(false)
    setIsUpdating(false)
  }

  if (isLoading) return <div className="min-h-screen flex items-center justify-center bg-slate-900"><Loader2 className="w-12 h-12 text-white animate-spin" /></div>

  // [화면 1] 비로그인 상태
  if (!user) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6 relative overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-orange-500/20 rounded-full blur-3xl"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-96 h-96 bg-blue-500/20 rounded-full blur-3xl"></div>

        <div className="z-10 w-full max-w-lg flex flex-col items-center text-center space-y-8 animate-in fade-in slide-in-from-bottom-8 duration-700">
          <div className="bg-orange-500 p-5 rounded-3xl shadow-2xl shadow-orange-500/30">
            <HardHat className="w-16 h-16 text-white" />
          </div>

          <div className="space-y-2">
            <h1 className="text-4xl font-extrabold text-white tracking-tight">현장 혁신 플랫폼</h1>
            <p className="text-slate-400 text-lg">TBM부터 AI 제안까지 한 번에</p>
          </div>

          <div className="w-full space-y-4 pt-8">
            <div className="flex items-start gap-3 bg-white/10 backdrop-blur-sm rounded-xl p-4">
              <Checkbox
                id="privacy-agree"
                checked={privacyAgreed}
                onCheckedChange={(checked) => setPrivacyAgreed(checked === true)}
                className="mt-0.5 border-white/50 data-[state=checked]:bg-orange-500 data-[state=checked]:border-orange-500"
              />
              <label htmlFor="privacy-agree" className="text-sm text-slate-300 leading-relaxed cursor-pointer">
                <a href="/privacy" target="_blank" className="text-orange-400 underline underline-offset-2 font-semibold">개인정보처리방침</a> 및{" "}
                <a href="/terms" target="_blank" className="text-orange-400 underline underline-offset-2 font-semibold">서비스 이용약관</a>에 동의합니다.
              </label>
            </div>
            <Button onClick={handleKakaoLogin} disabled={!privacyAgreed} className="w-full h-16 bg-[#FEE500] hover:bg-[#FEE500]/90 text-black text-xl font-bold rounded-2xl shadow-lg flex items-center justify-center transition-transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed">
              <MessageSquareWarning className="w-6 h-6 mr-2 fill-black" /> 카카오 계정으로 로그인
            </Button>
            <Button onClick={() => router.push('/login')} disabled={!privacyAgreed} variant="outline" className="w-full h-16 bg-white border-2 border-slate-200 hover:bg-slate-50 text-slate-800 text-xl font-bold rounded-2xl flex items-center justify-center transition-transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed">
              <UserCircle className="w-6 h-6 mr-2 text-slate-800" /> 일반 계정으로 로그인
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // [화면 2] 메인 대시보드
  return (
    <div className="min-h-screen bg-slate-50 pb-20 relative">
      <div className="max-w-lg mx-auto min-h-screen bg-white shadow-xl relative flex flex-col">

        {/* 헤더 */}
        <div className="p-6 bg-slate-900 text-white rounded-b-3xl shadow-md">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h2 className="text-2xl font-extrabold">환영합니다!</h2>
              <p className="text-slate-300 mt-1">
                {user?.user_metadata?.company_name || user?.user_metadata?.full_name || '사용자'}님, 안전한 하루 되세요.
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={handleLogout} className="text-slate-400 hover:text-white">
              <LogOut className="w-6 h-6" />
            </Button>
          </div>

          {/* ⭐️ 현황 요약 카드 (3칸으로 분할 및 링크 연결 완료) */}
          <div className="bg-slate-800 rounded-2xl flex text-center divide-x divide-slate-700 border border-slate-700 shadow-inner overflow-hidden">
            <div onClick={() => router.push('/history/tbm')} className="flex-1 p-3 cursor-pointer hover:bg-slate-700/50 active:bg-slate-700 transition-colors">
              <div className="text-[11px] text-slate-400 font-medium mb-1">TBM 완료</div>
              <div className="text-lg font-bold text-green-400">{statsLoading ? <Loader2 className="w-5 h-5 animate-spin inline-block text-green-400" /> : `${tbmCount}건`}</div>
            </div>
            <div onClick={() => router.push('/history/suggestion')} className="flex-1 p-3 cursor-pointer hover:bg-slate-700/50 active:bg-slate-700 transition-colors">
              <div className="text-[11px] text-slate-400 font-medium mb-1">현장 제안</div>
              <div className="text-lg font-bold text-orange-400">{statsLoading ? <Loader2 className="w-5 h-5 animate-spin inline-block text-orange-400" /> : `${suggestionCount}건`}</div>
            </div>
          </div>
        </div>

        {/* 핵심 3대 기능 버튼 */}
        <div className="flex-1 p-4 space-y-4 mt-4 overflow-y-auto">
          <Card onClick={() => router.push('/tbm')} className="border-0 bg-gradient-to-br from-blue-600 to-blue-800 text-white shadow-lg hover:shadow-xl transition-all cursor-pointer active:scale-[0.98] overflow-hidden group">
            <CardContent className="p-8 flex items-center justify-between relative">
              <div className="z-10"><h3 className="text-3xl font-extrabold mb-2">TBM 작성</h3><p className="text-blue-200 text-base font-medium">오늘의 작업 전 안전점검 (필수)</p></div>
              <div className="bg-white/20 p-4 rounded-full z-10 backdrop-blur-sm group-hover:scale-110 transition-transform"><HardHat className="w-10 h-10 text-white" /></div>
              <div className="absolute -right-6 -top-6 text-blue-500/30"><HardHat className="w-40 h-40" /></div>
            </CardContent>
          </Card>

          <Card onClick={() => router.push('/suggestion')} className="border-0 bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-lg hover:shadow-xl transition-all cursor-pointer active:scale-[0.98] overflow-hidden group">
            <CardContent className="p-8 flex items-center justify-between relative">
              <div className="z-10"><h3 className="text-3xl font-extrabold mb-2">현장 제안함</h3><p className="text-emerald-100 text-base font-medium">말로 하는 민원 및 위험요소 신고</p></div>
              <div className="bg-white/20 p-4 rounded-full z-10 backdrop-blur-sm group-hover:scale-110 transition-transform"><Mic className="w-10 h-10 text-white" /></div>
              <div className="absolute -right-6 -top-6 text-emerald-400/30"><Mic className="w-40 h-40" /></div>
            </CardContent>
          </Card>

        </div>
      </div>

      {/* 온보딩 팝업 */}
      {showOnboarding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl animate-in zoom-in duration-300">
            <h3 className="text-2xl font-bold text-slate-900 mb-2">환영합니다! 🎉</h3>
            <p className="text-slate-500 text-sm mb-6 leading-relaxed">원활한 일지 작성을 위해<br />현재 소속된 <b>현장명(또는 업체명)</b>을 입력해주세요.</p>
            <div className="space-y-4">
              <Input value={companyInput} onChange={(e) => setCompanyInput(e.target.value)} placeholder="예: 무신사 로지스틱스 1센터" className="h-14 text-lg border-slate-300" />
              <Button onClick={handleSaveCompany} disabled={isUpdating} className="w-full h-14 text-lg font-bold bg-slate-900 hover:bg-slate-800 text-white rounded-xl">
                {isUpdating ? <Loader2 className="animate-spin mr-2" /> : null} 저장하고 시작하기
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}