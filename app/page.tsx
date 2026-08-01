// app/page.tsx
"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { fetchAllRows } from "@/lib/fetchAllRows"
import { useRequireSubscription } from "@/lib/useSubscription"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { HardHat, Loader2, Users, ChevronRight, PlayCircle, X, Plus } from "lucide-react"
import { TBMHeader } from "@/components/TBMHeader"
import { Logo } from "@/components/Logo"
import { totalSeconds, secondsToHours, formatHoursProgress, isRegularEducationType } from "@/lib/educationHours"
import { fetchOrgContext, type ClientOrgContext } from "@/lib/useOrgContext"
import { KSIC_MAJORS, findKsicMajor } from "@/lib/ksic"
import { AttachInviteModal } from "@/components/AttachInviteModal"
import { HomeActivity } from "@/components/HomeActivity"

// 홈 화면 캐시 — 뒤로가기·탭 복귀 때마다 세션·통계·역할을 다시 기다리며 스피너를
// 띄우지 않기 위한 stale-while-revalidate. 화면은 캐시로 즉시 그리고, 데이터는
// 마운트 후 조용히 갱신된다. 계정이 바뀌면 무효.
interface HomeCache {
  userId: string
  user: any
  orgCtx: ClientOrgContext | null
  stats: {
    tbmCount: number; tbmMinutesCount: number; totalEducationSeconds: number
    requiredHours: number; logDates: string[]; minuteDates: string[]
    suggestionDates: string[]; unreadSuggestions: number
  } | null
}
let homeCache: HomeCache | null = null
if (typeof window !== "undefined") {
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" || event === "SIGNED_IN") homeCache = null
  })
}

// created_at(타임스탬프)을 로컬 기준 YYYY-MM-DD로 변환 — tbm_logs/minutes의 date 컬럼과 같은 기준으로 월 집계
const toLocalDateStr = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export default function MainPage() {
  const router = useRouter()
  const { checking } = useRequireSubscription()
  const cached = homeCache // 렌더 시점 스냅샷
  const [isLoading, setIsLoading] = useState(!cached)
  const [user, setUser] = useState<any>(cached?.user ?? null)

  const [tbmCount, setTbmCount] = useState(cached?.stats?.tbmCount ?? 0)
  const [tbmMinutesCount, setTbmMinutesCount] = useState(cached?.stats?.tbmMinutesCount ?? 0)
  const [statsLoading, setStatsLoading] = useState(!cached?.stats)
  const [totalEducationSeconds, setTotalEducationSeconds] = useState(cached?.stats?.totalEducationSeconds ?? 0)
  const [requiredHours, setRequiredHours] = useState(cached?.stats?.requiredHours ?? 16)
  // 진행도 바 순차 애니메이션: 진한 바(0~100%) 먼저 → 초과분 이어서
  const [animBase, setAnimBase] = useState(0)
  const [animOver, setAnimOver] = useState(0)

  // 월별 건수 필터용 원본(날짜만) + 선택 월("all" = 전체)
  const [logDates, setLogDates] = useState<string[]>(cached?.stats?.logDates ?? [])
  const [minuteDates, setMinuteDates] = useState<string[]>(cached?.stats?.minuteDates ?? [])
  const [suggestionDates, setSuggestionDates] = useState<string[]>(cached?.stats?.suggestionDates ?? [])
  const [unreadSuggestions, setUnreadSuggestions] = useState(cached?.stats?.unreadSuggestions ?? 0)

  // 문서 출력 형식 최초 설정 모달 (user_metadata.preferred_export_format 없을 때 1회)
  // 구 가입 플로우 유저는 worker_type도 없을 수 있어(온보딩 모달 제거로 유도 경로 상실) 같은 모달에서 함께 수집한다.
  const [showFormatModal, setShowFormatModal] = useState(false)
  const [needsWorkerType, setNeedsWorkerType] = useState(false)
  const [workerTypeInput, setWorkerTypeInput] = useState("현장 근로자 (비사무직)")
  const [isSavingFormat, setIsSavingFormat] = useState(false)
  const formatModalRef = useRef<HTMLDivElement>(null)

  // 역할 판정 — pendingAttach면 편입 수락 모달, owner면 활동 현황 옆 '통계 보기' 버튼 노출
  const [orgCtx, setOrgCtx] = useState<ClientOrgContext | null>(cached?.orgCtx ?? null)
  // 온보딩에서 '여러 현장'을 고르고 셋업을 건너뛴 솔로 — 홈에서 현장 추가 입구를 이어준다
  const [hintAddSite, setHintAddSite] = useState(false)
  useEffect(() => {
    try { setHintAddSite(window.localStorage.getItem("antok_hint_add_site") === "1") } catch { /* 무시 */ }
  }, [])
  // 일괄 발급된 현장 계정의 첫 로그인 — 새 비밀번호·현장명을 정하기 전엔 앱을 열지 않는다
  const [mustSetup, setMustSetup] = useState(false)
  const [setupPw, setSetupPw] = useState("")
  const [setupPw2, setSetupPw2] = useState("")
  const [setupSite, setSetupSite] = useState("")
  const [setupManager, setSetupManager] = useState("")
  // 현장 정보 — 발급 계정은 가입 위저드를 안 거치므로 여기서 수집 (아니면 영원히 null)
  const [setupIndustry, setSetupIndustry] = useState("")
  const [setupWorkCategory, setSetupWorkCategory] = useState("")
  const [setupErr, setSetupErr] = useState<string | null>(null)
  const [setupBusy, setSetupBusy] = useState(false)
  // 서버 기준 사용자 갱신의 순서 보장 — 늦게 도착한 낡은 응답이 방금 저장한 값을 덮지 않게
  const userWriteSeq = useRef(0)

  const refreshUserFromServer = async () => {
    const seq = userWriteSeq.current
    try {
      const { data: fresh } = await supabase.auth.getUser()
      // 대기 중 사용자가 직접 저장(updateUser)했다면 그 결과가 더 최신 — 이 응답은 버린다
      if (!fresh?.user || seq !== userWriteSeq.current) return
      setUser(fresh.user)
      if (homeCache?.userId === fresh.user.id) homeCache.user = fresh.user
    } catch { /* 배경 갱신 실패는 무시 — 다음 기회에 */ }
  }

  // 클라이언트에서 직접 메타데이터를 저장했을 때 호출 — 진행 중인 배경 갱신을 무효화한다
  const commitUser = (u: any) => {
    userWriteSeq.current += 1
    setUser(u)
    if (homeCache && u?.id && homeCache.userId === u.id) homeCache.user = u
  }

  useEffect(() => {
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        const currentUser = session.user
        // 다른 계정의 스냅샷은 폐기
        if (homeCache && homeCache.userId !== currentUser.id) {
          homeCache = null
          setStatsLoading(true)
        }
        setUser(currentUser)

        // 일괄 발급 계정의 첫 로그인 — 비밀번호·현장명 설정이 최우선 (다른 온보딩은 그 다음)
        if (currentUser.user_metadata?.must_set_password) {
          setMustSetup(true)
          setIsLoading(false)
          return
        }

        // 감독자도 TBM을 쓴다 — 역할과 무관하게 온보딩·통계를 동일하게 로드한다.
        // (관리 전용 시절엔 여기서 감독자를 건너뛰어, 출력 형식이 없어 hwpx/docx 설정이
        //  무시되고 PDF로 강제되는 구멍이 있었다)
        const hadCache = !!homeCache && homeCache.userId === currentUser.id
        homeCache = {
          userId: currentUser.id,
          user: currentUser,
          orgCtx: hadCache ? homeCache!.orgCtx : null,
          stats: hadCache ? homeCache!.stats : null,
        }

        // 서버 기준 최신 메타데이터로 배경 갱신 — 이메일 인증 완료·회사 형식 전파처럼
        // admin API로 바뀐 메타데이터는 로컬 세션 스냅샷(getSession)에 토큰 갱신(~1시간)까지
        // 반영되지 않아, 인증을 마쳐도 배너가 계속 남는 문제가 있었다.
        refreshUserFromServer()

        const meta = currentUser.user_metadata
        if (!meta?.preferred_export_format || !meta?.worker_type) {
          // 형식은 보고서 설정 위저드가 admin API로 저장해 로컬 세션 스냅샷이 낡을 수 있다 —
          // 모달 판정만은 서버 기준으로. 아니면 설정을 마치고 돌아와도 모달이 다시 떠서 깜빡인다.
          try {
            const { data: fresh } = await supabase.auth.getUser()
            const fm = (fresh?.user?.user_metadata ?? {}) as Record<string, unknown>
            if (fresh?.user && homeCache?.userId === fresh.user.id) {
              homeCache.user = fresh.user
              setUser(fresh.user)
            }
            if (!fm?.preferred_export_format || !fm?.worker_type) {
              // member(현장 계정)에게는 모달을 띄우지 않는다 — 형식·근로자 구분 모두 회사가
              // 관리하고 보고서 설정 페이지도 잠겨 있어, 띄우면 닫을 곳 없는 함정이 된다.
              // (fetchOrgContext는 세션 캐시라 추가 비용이 거의 없다)
              const ctx = await fetchOrgContext()
              if (ctx?.kind !== "member") {
                setNeedsWorkerType(!fm?.worker_type)
                setShowFormatModal(true)
              }
            }
          } catch {
            // 서버 확인 실패 — 첫 가입자가 모달을 못 보는 것보다 낡은 판정이 낫다
            setNeedsWorkerType(!meta?.worker_type)
            setShowFormatModal(true)
          }
        }
        // 캐시로 이미 그렸으면 통계는 조용히 갱신 (스피너 없이 숫자만 바뀐다)
        fetchUserStats(currentUser.id, meta?.worker_type || "현장 근로자 (비사무직)", hadCache)

        const ctx = await fetchOrgContext()
        setOrgCtx(ctx)
        if (homeCache?.userId === currentUser.id) homeCache.orgCtx = ctx
      }
      setIsLoading(false)
    }
    checkSession()
  }, [])

  // 모달이 뜨면 대화상자로 초점 이동 (배경 카드들이 tabIndex를 가져 오버레이 뒤로 초점이 새는 것 방지)
  useEffect(() => {
    if (showFormatModal) formatModalRef.current?.focus()
  }, [showFormatModal])

  // 메일 앱에서 인증을 마치고 돌아온 순간 배너가 스스로 사라지게 — 탭 복귀 시 서버 기준 재조회 (30초 스로틀)
  useEffect(() => {
    let last = 0
    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      const now = Date.now()
      if (now - last < 30_000) return
      last = now
      refreshUserFromServer()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [])

  const fetchUserStats = async (userId: string, currentWorkerType: string, silent = false) => {
    if (!silent) setStatsLoading(true)
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
        fetchAllRows<{ start_time: string | null; end_time: string | null; education_type: string | null }>((f, t) => supabase.from('tbm_logs').select('start_time, end_time, education_type').eq('user_id', userId).gte('date', halfStart).lte('date', halfEnd).order('id').range(f, t)),
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

      // 정기교육(반기 6/12h) 진행도에는 정기 인정 유형(TBM·정기 안전교육·레거시 미분류)만 합산 —
      // 특별·신규채용·작업내용변경 교육은 별개의 법정 의무라 여기 합산하면 과대표시가 된다.
      const validLogs = [
        ...(logTimeRows || []).filter(l => isRegularEducationType(l.education_type)),
        ...(minuteTimeRows || []),
      ]
      const totalEdu = totalSeconds(validLogs)
      setTotalEducationSeconds(totalEdu)

      // 다음 진입에서 즉시 그릴 수 있게 캐시에 적재
      if (homeCache?.userId === userId) {
        homeCache.stats = {
          tbmCount: logDateRows.length,
          tbmMinutesCount: minuteDateRows.length,
          totalEducationSeconds: totalEdu,
          requiredHours: currentWorkerType === '사무직 / 판매직' ? 6 : 12,
          logDates: logDateRows.map(l => l.date).filter(Boolean) as string[],
          minuteDates: minuteDateRows.map(l => l.date).filter(Boolean) as string[],
          suggestionDates: suggestionRows.map(sg => sg.created_at ? toLocalDateStr(sg.created_at) : null).filter(Boolean) as string[],
          unreadSuggestions: suggestionRows.filter(sg => sg.is_read === false).length,
        }
      }
    } catch (e) {
      console.error("통계 에러:", e)
    } finally {
      setStatsLoading(false)
    }
  }

  const handleLogout = async () => {
    homeCache = null
    await supabase.auth.signOut()
    setUser(null)
    setTbmCount(0)
    setTbmMinutesCount(0)
    setSuggestionDates([])
    setUnreadSuggestions(0)
  }

  // 근로자 구분 저장만 (형식 선택은 온보딩에서 제거 — 보고서 설정 위저드로 이동)
  const saveWorkerTypeIfNeeded = async (): Promise<boolean> => {
    if (!needsWorkerType) return true
    const { data, error } = await supabase.auth.updateUser({ data: { worker_type: workerTypeInput } })
    if (error) { alert("저장 실패: " + error.message); return false }
    commitUser(data.user)
    setRequiredHours(workerTypeInput === '사무직 / 판매직' ? 6 : 12)
    return true
  }

  // 근로자 구분만 없는 경우(소속 현장 계정 등) — 저장하고 시작
  const handleSaveWorkerType = async () => {
    setIsSavingFormat(true)
    try {
      if (await saveWorkerTypeIfNeeded()) setShowFormatModal(false)
    } finally {
      setIsSavingFormat(false)
    }
  }

  // 문서 형식이 없는 감독자/솔로 — 근로자 구분(있다면) 저장 후 보고서 설정 위저드로
  const handleGoReportSetup = async () => {
    setIsSavingFormat(true)
    try {
      if (!(await saveWorkerTypeIfNeeded())) return
      setShowFormatModal(false)
      router.push("/org/reports")
    } finally {
      setIsSavingFormat(false)
    }
  }

  // 온보딩 2단계: 사용 형태 선택 — 계정은 이미 같고, 여는 탭과 다음 안내만 달라진다
  // 일괄 발급 시 회사 공통 업종·공종을 이미 상속받았다면 첫 로그인 화면에서 다시 묻지 않는다 —
  // 여기서 강제로 다시 고르게 하면 상속값을 사용자 선택이 덮어써 회사 값과 어긋난다
  const setupInheritedProfile = !!user?.user_metadata?.industry
  // 첫 로그인 설정 저장 — 비밀번호 교체 + 현장명·담당자 확정
  const handleFirstSetup = async () => {
    setSetupErr(null)
    if (setupPw.length < 8) { setSetupErr("비밀번호는 8자 이상이어야 해요."); return }
    if (setupPw !== setupPw2) { setSetupErr("비밀번호가 서로 달라요. 다시 확인해주세요."); return }
    if (!setupSite.trim()) { setSetupErr("현장명을 입력해주세요."); return }
    if (!setupInheritedProfile && !setupIndustry) { setSetupErr("업종을 선택해주세요."); return }
    if (!setupInheritedProfile && !setupWorkCategory) { setSetupErr("공종을 선택해주세요."); return }
    setSetupBusy(true)
    try {
      const { error } = await supabase.auth.updateUser({
        password: setupPw,
        data: {
          company_name: setupSite.trim(),
          full_name: setupManager.trim() || setupSite.trim(),
          // 상속값이 있으면 건드리지 않는다 (회사 공통 — 감독자 저장 시 전파로만 바뀐다)
          ...(setupInheritedProfile ? {} : { industry: setupIndustry, work_category: setupWorkCategory }),
          must_set_password: null,
        },
      })
      if (error) {
        const msg = /weak|easy to guess/i.test(error.message)
          ? "너무 흔한 비밀번호예요. 숫자·문자를 섞어 다른 비밀번호를 정해주세요."
          : /should be different/i.test(error.message)
            ? "초기 비밀번호와 다른 비밀번호를 정해주세요."
            : "저장에 실패했어요: " + error.message
        setSetupErr(msg)
        return
      }
      window.location.reload() // 메타데이터·역할을 처음부터 다시 로드
    } finally {
      setSetupBusy(false)
    }
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

  const shownMinutes = minuteDates.length
  const shownLogs = logDates.length
  const shownSuggestions = suggestionDates.length

  // 신규 유저 빈 상태 — 기록 0건이면 0짜리 통계와 0% 진행도(숙제 고지서처럼 읽힌다) 대신
  // 첫 행동(작성)을 맨 위에 안내한다. 첫 기록이 저장되는 순간부터 평소 홈으로 전환.
  // 자식 현장을 거느린 감독자는 본인 기록이 없어도 신규가 아니다(관제 목적 사용) — 제외.
  const ownerWithSites = orgCtx?.kind === "owner" && (orgCtx.memberIds?.length ?? 0) > 0
  const isEmptyStart = !statsLoading && shownMinutes === 0 && shownLogs === 0 && !ownerWithSites

  // 작성 카드 2종 — 평소 홈(하단)과 빈 상태(최상단) 두 자리에서 같은 마크업을 쓴다
  const writeCards = (
    <div className="grid grid-cols-2 gap-3">
      <div
        onClick={() => router.push('/tbm-minutes')}
        className="border border-cur-hairline bg-cur-card hover:border-cur-primary/40 transition-all cursor-pointer rounded-[12px] group p-5 flex flex-col gap-3"
      >
        <div className="bg-cur-elevated w-12 h-12 rounded-[8px] flex items-center justify-center text-cur-ink group-hover:bg-cur-primary/15 group-hover:text-cur-primary transition-colors">
          <Users className="w-6 h-6" />
        </div>
        <div className="space-y-1 flex-1">
          <h3 className="text-[15px] font-semibold text-cur-ink leading-snug">TBM 회의록<br />작성</h3>
          <p className="text-cur-muted text-[12px] leading-snug">현장과의 더 많은 소통으로 사전에 위험을 통제하세요</p>
        </div>
        <ChevronRight className="w-4 h-4 text-cur-muted group-hover:text-cur-primary transition-colors self-end" />
      </div>

      <div
        onClick={() => router.push('/safety-log')}
        className="border border-cur-hairline bg-cur-card hover:border-cur-primary/40 transition-all cursor-pointer rounded-[12px] group p-5 flex flex-col gap-3"
      >
        <div className="bg-cur-elevated w-12 h-12 rounded-[8px] flex items-center justify-center text-cur-ink group-hover:bg-cur-primary/15 group-hover:text-cur-primary transition-colors">
          <HardHat className="w-6 h-6" />
        </div>
        <div className="space-y-1 flex-1">
          <h3 className="text-[15px] font-semibold text-cur-ink leading-snug">안전보건교육일지<br />작성</h3>
          <p className="text-cur-muted text-[12px] leading-snug">TBM·정기교육 등 안전보건교육일지를 AI로 기록 관리</p>
        </div>
        <ChevronRight className="w-4 h-4 text-cur-muted group-hover:text-cur-primary transition-colors self-end" />
      </div>
    </div>
  )

  if (isLoading || checking) return <div className="min-h-screen flex items-center justify-center bg-cur-canvas"><Loader2 className="w-10 h-10 text-cur-primary animate-spin" /></div>

  // 일괄 발급 계정의 첫 로그인 설정 — 이걸 끝내야 앱이 열린다
  if (user && mustSetup) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-cur-canvas p-4 font-sans text-cur-ink">
        <div className="w-full max-w-md bg-cur-card border border-cur-hairline rounded-[24px] shadow-[0_1px_3px_rgba(0,0,0,0.04)] px-6 py-9 sm:px-8 space-y-6">
          <div className="text-center space-y-2">
            <div className="mx-auto w-fit"><Logo size="md" /></div>
            <h1 className="text-[22px] font-bold tracking-[-0.02em]">처음 오셨네요!</h1>
            <p className="text-[14px] text-cur-body leading-relaxed">
              사용하실 비밀번호와 현장 정보를 정하면<br />바로 시작할 수 있어요.
            </p>
          </div>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-[13px] font-medium text-cur-body">새 비밀번호</label>
              <input type="password" value={setupPw} onChange={(e) => setSetupPw(e.target.value)} placeholder="8자 이상"
                className="w-full h-11 px-3 rounded-[8px] bg-cur-elevated border border-cur-hairline text-[15px] text-cur-ink placeholder:text-cur-muted-soft focus:outline-none focus:ring-1 focus:ring-cur-primary" />
            </div>
            <div className="space-y-1">
              <label className="text-[13px] font-medium text-cur-body">새 비밀번호 확인</label>
              <input type="password" value={setupPw2} onChange={(e) => setSetupPw2(e.target.value)} placeholder="한 번 더 입력"
                className="w-full h-11 px-3 rounded-[8px] bg-cur-elevated border border-cur-hairline text-[15px] text-cur-ink placeholder:text-cur-muted-soft focus:outline-none focus:ring-1 focus:ring-cur-primary" />
            </div>
            <div className="space-y-1">
              <label className="text-[13px] font-medium text-cur-body">현장명</label>
              <input value={setupSite} onChange={(e) => setSetupSite(e.target.value)} placeholder="예: OO물류센터 신축현장"
                className="w-full h-11 px-3 rounded-[8px] bg-cur-elevated border border-cur-hairline text-[15px] text-cur-ink placeholder:text-cur-muted-soft focus:outline-none focus:ring-1 focus:ring-cur-primary" />
            </div>
            {/* 업종·공종은 발급 시 회사 공통 값을 상속받았으면 묻지 않는다 (레거시 계정만 수집) */}
            {!setupInheritedProfile && (
              <div className="space-y-1">
                <label className="text-[13px] font-medium text-cur-body">업종</label>
                <Select value={setupIndustry} onValueChange={(v) => {
                  setSetupIndustry(v)
                  // 중분류가 하나뿐인 업종은 공종을 자동 선택 (가입 위저드와 동일 규칙)
                  const minors = findKsicMajor(v)?.minors ?? []
                  setSetupWorkCategory(minors.length === 1 ? minors[0].name : "")
                }}>
                  <SelectTrigger className="w-full h-11 text-[15px] border-cur-hairline rounded-[8px] bg-cur-elevated text-cur-ink focus:ring-1 focus:ring-cur-primary">
                    <SelectValue placeholder="업종을 선택해주세요" />
                  </SelectTrigger>
                  <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                    {KSIC_MAJORS.map((m) => <SelectItem key={m.code} value={m.name} className="text-[15px] py-2.5">{m.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            {!setupInheritedProfile && setupIndustry && (
              <div className="space-y-1 animate-in slide-in-from-top-2">
                <label className="text-[13px] font-medium text-cur-body">공종</label>
                <Select value={setupWorkCategory} onValueChange={setSetupWorkCategory}>
                  <SelectTrigger className="w-full h-11 text-[15px] border-cur-hairline rounded-[8px] bg-cur-elevated text-cur-ink focus:ring-1 focus:ring-cur-primary">
                    <SelectValue placeholder="주력 공종을 선택해주세요" />
                  </SelectTrigger>
                  <SelectContent className="bg-cur-card border-cur-hairline rounded-[12px]">
                    {(findKsicMajor(setupIndustry)?.minors ?? []).map((mi) => <SelectItem key={mi.code} value={mi.name} className="text-[15px] py-2.5">{mi.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <label className="text-[13px] font-medium text-cur-body">담당자 이름 (선택)</label>
              <input value={setupManager} onChange={(e) => setSetupManager(e.target.value)} placeholder="본인 성함"
                className="w-full h-11 px-3 rounded-[8px] bg-cur-elevated border border-cur-hairline text-[15px] text-cur-ink placeholder:text-cur-muted-soft focus:outline-none focus:ring-1 focus:ring-cur-primary" />
            </div>
          </div>
          {setupErr && (
            <p className="text-[13px] font-medium text-cur-error bg-cur-error/5 border border-cur-error/20 rounded-[8px] px-3 py-2">{setupErr}</p>
          )}
          <Button onClick={handleFirstSetup} disabled={setupBusy || !setupPw || !setupPw2 || !setupSite.trim() || (!setupInheritedProfile && (!setupIndustry || !setupWorkCategory))}
            className="w-full h-12 rounded-[8px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[15px] font-bold disabled:opacity-40">
            {setupBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : "설정하고 시작하기"}
          </Button>
        </div>
      </div>
    )
  }

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
            {/* 기존 회원은 /start(약관 동의 게이트)를 거치지 않고 바로 로그인 */}
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                onClick={() => router.push("/login")}
                className="h-10 px-4 text-[14px] font-semibold text-cur-body hover:text-cur-ink hover:bg-cur-elevated rounded-[8px]"
              >
                로그인
              </Button>
              <Button
                onClick={() => router.push("/start")}
                className="h-10 px-5 bg-cur-ink hover:opacity-90 text-white text-[14px] font-semibold rounded-[8px]"
              >
                시작하기
              </Button>
            </div>
          </div>
        </header>

        {/* 히어로 */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-[70%] bg-gradient-to-b from-cur-primary/10 via-cur-primary/5 to-transparent -z-10" />
          <div className="max-w-5xl mx-auto px-5 sm:px-8 py-20 sm:py-28 lg:py-36 text-center flex flex-col items-center gap-6 sm:gap-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <span className="text-[12px] sm:text-[13px] font-semibold text-cur-primary bg-cur-primary/10 px-3 py-1.5 rounded-full">
              현장 안전관리 AI · 안톡
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
                  onClick={() => router.push("/login")}
                  className="h-12 px-8 border-cur-hairline text-cur-ink hover:bg-cur-elevated text-[16px] font-semibold rounded-[8px]"
                >
                  로그인
                </Button>
              </div>
              <p className="text-[13px] text-cur-muted-soft">첫 달 무료 체험 · 이후 계정 1개당 월 3,900원</p>
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
              복잡한 설치 없이 카카오/일반 계정으로 바로 시작. 첫 달은 무료 체험이고, 이후 계정 1개당 월 3,900원이에요. 현장이 여러 곳이면 계정을 추가한 만큼만 더 내면 됩니다. 언제든 해지할 수 있습니다.
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
    <div className="bg-cur-canvas min-h-screen sm:py-8 flex sm:block items-center justify-center font-sans text-cur-body pb-8">
      <div className="max-w-lg w-full mx-auto bg-cur-card sm:rounded-[12px] relative flex flex-col min-h-[100dvh] sm:min-h-[85vh] border-x sm:border border-cur-hairline mb-[env(safe-area-inset-bottom)] overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.04)]">

        <div className="p-4 bg-cur-card/90 backdrop-blur-sm border-b border-cur-hairline sticky top-0 z-50">
          <TBMHeader title="안톡" onLogout={handleLogout} />
        </div>

        {/* 조직 편입(attach) 초대 — 기존 계정 앞으로 온 초대가 있으면 수락/거절 모달 (탭 무관) */}
        {user && orgCtx?.pendingAttach && (
          <AttachInviteModal
            orgName={orgCtx.pendingAttach.orgName}
            token={orgCtx.pendingAttach.token}
            onDone={() => setOrgCtx(orgCtx ? { ...orgCtx, pendingAttach: null } : null)}
          />
        )}

        {/* ── 단일 홈 — 탭 없이 한 스크롤: (감독자) 관제 → 내 기록 → 작성 ── */}
        <div className="p-4 sm:p-6 space-y-5">
          {/* 조직 소속인데 실이메일 미인증 — 월간 보고서 수신 불가 안내 (버튼 최소 원칙의 유일한 잔소리) */}
          {user && orgCtx?.kind === "member" && !user.user_metadata?.real_email_verified_at && (
            <div className="flex items-center gap-3 p-3.5 rounded-[12px] bg-amber-500/10 border border-amber-500/25">
              <span className="text-[18px]" aria-hidden>📮</span>
              <div className="flex-1 min-w-0 text-[13px] leading-snug">
                <p className="font-semibold text-cur-ink">이메일 인증이 필요해요</p>
                <p className="text-cur-muted">인증해야 매달 1일 우리 현장 월간 보고서를 받을 수 있어요.</p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  const meta = user.user_metadata || {}
                  const email = meta.real_email || window.prompt("보고서를 받을 이메일 주소를 입력하세요")
                  if (!email) return
                  const { data } = await supabase.auth.getSession()
                  const res = await fetch("/api/auth/email", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${data?.session?.access_token}` },
                    body: JSON.stringify({ email }),
                  })
                  // 서버 안내(쿨다운·상한)를 그대로 보여준다 — 일반 실패 문구로 뭉개면 연타가 고장으로 읽힌다
                  const j = await res.json().catch(() => ({}))
                  alert(res.ok ? "인증 메일을 보냈어요. 메일함을 확인하세요." : (j.error || "인증 메일 발송에 실패했어요. 잠시 후 다시 시도해주세요."))
                }}
                className="shrink-0 h-9 px-3 rounded-lg bg-cur-ink text-white text-[12px] font-bold"
              >
                인증 메일
              </button>
            </div>
          )}

          {/* 튜토리얼 미이수 배너 — 완료·건너뛰기·X 모두 tutorial_seen_at 기록으로 사라진다 */}
          {user && !user.user_metadata?.tutorial_seen_at && (
            <div className="flex items-center gap-3 p-3.5 rounded-[12px] bg-cur-primary/5 border border-cur-primary/20">
              <PlayCircle className="w-5 h-5 shrink-0 text-cur-primary" />
              <button
                type="button"
                onClick={() => router.push('/tutorial')}
                className="flex-1 min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary rounded-[4px]"
              >
                <span className="block text-[14px] font-semibold text-cur-ink">1분 사용법 보기</span>
                <span className="block text-[12px] text-cur-body mt-0.5">말한 내용이 회의록이 되는 과정을 보여드려요</span>
              </button>
              <button
                type="button"
                aria-label="사용법 안내 닫기"
                onClick={async () => {
                  const { data } = await supabase.auth.updateUser({ data: { tutorial_seen_at: new Date().toISOString() } })
                  if (data?.user) commitUser(data.user)
                }}
                className="shrink-0 p-1.5 rounded-[8px] text-cur-muted hover:text-cur-ink hover:bg-cur-elevated transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* 솔로가 온보딩에서 '여러 현장'을 골라둔 경우만 — 첫 현장 추가 입구 (그 외 솔로에겐 소음이라 숨김) */}
          {orgCtx?.kind === "solo" && hintAddSite && (
            <button
              type="button"
              onClick={() => {
                try { window.localStorage.removeItem("antok_hint_add_site") } catch { /* 무시 */ }
                setHintAddSite(false)
                router.push("/org/members?new=1")
              }}
              className="relative w-full flex items-center gap-3 p-4 rounded-[12px] border border-cur-hairline bg-cur-card text-left hover:border-cur-primary/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
            >
              <span aria-hidden className="absolute inset-1 rounded-[10px] border-2 border-cur-primary pointer-events-none animate-pulse" />
              <span className="w-9 h-9 rounded-full border border-dashed border-cur-hairline-strong text-cur-muted flex items-center justify-center shrink-0">
                <Plus className="w-4 h-4" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[14px] font-semibold text-cur-ink">현장 계정 추가하기</span>
                <span className="block text-[12px] text-cur-muted mt-0.5">첫 현장을 만들면 이 계정이 회사 감독자가 돼요</span>
              </span>
              <ChevronRight className="w-4 h-4 text-cur-muted-soft shrink-0" />
            </button>
          )}

          {/* 빈 상태(기록 0건) — 첫 방문의 질문은 "내 기록이 몇 개지?"가 아니라 "뭘 하는 앱이지?"다.
              0·0·0·0% 대신 첫 행동을 맨 위에 놓고, 첫 기록이 생기면 아래 평소 홈으로 전환된다 */}
          {isEmptyStart && (
            <div className="space-y-5">
              <div className="pt-1">
                <h2 className="text-[20px] font-bold text-cur-ink tracking-[-0.02em] leading-snug">오늘 TBM, 편하게 녹음해보세요</h2>
                <p className="text-[13px] text-cur-muted mt-1.5 leading-relaxed">
                  녹음만 하면 회의록·교육일지 출력물을 AI가 자동으로 만들어드려요. 첫 기록이 생기면 이 자리에 활동 현황과 교육 진행도가 채워집니다.
                </p>
              </div>
              {writeCards}
              <div className="bg-cur-card rounded-[12px] border border-cur-hairline p-4">
                <ol className="flex items-start gap-2">
                  {[
                    ["말하기", "조회 내용을 녹음"],
                    ["AI 정리", "회의록·일지 자동 완성"],
                    ["서명·보관", "법정 서류로 저장"],
                  ].map(([t, d], i) => (
                    <li key={t} className="flex-1 min-w-0 text-center">
                      <span className="mx-auto w-6 h-6 rounded-full bg-cur-elevated text-cur-ink text-[12px] font-bold flex items-center justify-center font-mono">{i + 1}</span>
                      <p className="text-[13px] font-semibold text-cur-ink mt-1.5">{t}</p>
                      <p className="text-[11px] text-cur-muted mt-0.5 leading-snug">{d}</p>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}

          {!isEmptyStart && (<>
          {/* 활동 현황 — 개인 그리드. 감독자는 탭(내 활동 | 모든 현장 통계↗) 구성 */}
          <HomeActivity
            isOwner={orgCtx?.kind === "owner"}
            statsLoading={statsLoading}
            myMinutes={shownMinutes}
            myLogs={shownLogs}
            mySuggestions={shownSuggestions}
            myUnread={unreadSuggestions}
          />

          <div
            onClick={() => router.push('/education-progress')}
            className="bg-cur-card rounded-[12px] p-4 border border-cur-hairline cursor-pointer hover:border-cur-primary/40 active:bg-cur-elevated/40 transition-all group"
          >
            <div className="flex items-center justify-between gap-3 mb-5">
              <h3 className="text-[15px] font-semibold text-cur-ink flex items-center gap-2 flex-wrap tracking-[-0.11px] min-w-0">
                법정 의무 교육 진행도
                <span className="bg-cur-primary/15 px-2 py-0.5 rounded-[4px] text-[11px] text-cur-primary font-semibold shrink-0">
                  {user?.user_metadata?.worker_type || '현장 근로자 (비사무직)'}
                </span>
              </h3>
              <span className="flex items-center gap-1 whitespace-nowrap shrink-0">
                <span className="text-[14px] font-bold text-cur-primary font-mono">
                  {statsLoading ? <Loader2 className="w-4 h-4 animate-spin inline-block" /> : `${formatHoursProgress(totalEducationSeconds)} / ${requiredHours}시간`}
                </span>
                <ChevronRight className="w-4 h-4 text-cur-muted group-hover:text-cur-primary transition-colors" />
              </span>
            </div>

            <div className="relative mt-1 mb-7">
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
          </>)}
        </div>

        {/* 작성 카드 2종 — 병렬 배치 (Chris): 홈의 두 핵심 행동이라 나란히. 빈 상태에선 위에서 이미 보여줬다 */}
        {!isEmptyStart && (
          <div className="flex-1 p-6">
            {writeCards}
          </div>
        )}
      </div>

      {/* 최초 설정 모달 — 형식 선택은 온보딩에서 뺐다(Chris): 감독자/솔로는 보고서 설정 위저드로 보내고,
          여기서는 근로자 구분(없을 때만)만 수집한다. 소속 현장 계정은 형식이 회사 공통이라 근로자 구분만. */}
      {showFormatModal && (() => {
        // 역할 판정 전(orgCtx null)에는 CTA를 띄우지 않는다 — 소속 현장 계정에 감독자용 모달이 비치는 것 방지
        const needsSetupCta = !user?.user_metadata?.preferred_export_format && !!orgCtx && orgCtx.kind !== "member"
        if (!needsSetupCta && !needsWorkerType) return null
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div
              ref={formatModalRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="format-modal-title"
              tabIndex={-1}
              className="bg-cur-card rounded-[12px] p-8 w-full max-w-sm shadow-[0_16px_48px_rgba(0,0,0,0.1)] animate-in zoom-in-95 duration-200 border border-cur-hairline outline-none"
            >
              {needsSetupCta ? (
                <>
                  <h3 id="format-modal-title" className="text-[22px] font-bold text-cur-ink mb-2 tracking-tight">보고서 설정을 하러 갑시다</h3>
                  <p className="text-cur-muted text-[14px] mb-1 leading-[1.5]">
                    문서 출력 형식과 매월 1일 자동 발송되는 보고서의 받는 사람을 정해요. 1분이면 끝나요.
                  </p>
                </>
              ) : (
                <>
                  <h3 id="format-modal-title" className="text-[22px] font-bold text-cur-ink mb-2 tracking-tight">근로자 구분</h3>
                  <p className="text-cur-muted text-[14px] mb-1 leading-[1.5]">교육시간 산정 기준을 선택해주세요. 내 정보 수정에서 언제든 바꿀 수 있어요.</p>
                </>
              )}
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
                onClick={needsSetupCta ? handleGoReportSetup : handleSaveWorkerType}
                disabled={isSavingFormat}
                className="w-full h-12 mt-5 text-[15px] font-bold bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary rounded-[8px]"
              >
                {isSavingFormat ? <Loader2 className="animate-spin mr-2 w-4 h-4" /> : null}
                {needsSetupCta ? "보고서 설정 하러 가기" : "저장하고 시작하기"}
              </Button>
            </div>
          </div>
        )
      })()}
    </div>
  )
}