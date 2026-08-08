// app/page.tsx
"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { fetchAllRows } from "@/lib/fetchAllRows"
import { useRequireSubscription } from "@/lib/useSubscription"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { HardHat, Loader2, Users, ChevronRight, PlayCircle, X, Plus, MailPlus, Mic, Mail } from "lucide-react"
import { fetchRecipients } from "@/lib/reportRecipients"
import { resolveMyReportEmail } from "@/lib/myEmail"
import { TBMHeader } from "@/components/TBMHeader"
import { Logo } from "@/components/Logo"
import { totalSeconds, secondsToHours, formatHoursProgress, isRegularEducationType } from "@/lib/educationHours"
import { fetchOrgContext, type ClientOrgContext } from "@/lib/useOrgContext"
import { KSIC_MAJORS, findKsicMajor } from "@/lib/ksic"
import { AttachInviteModal } from "@/components/AttachInviteModal"
import { HomeActivity } from "@/components/HomeActivity"
import { OnboardingModal } from "@/components/OnboardingModal"
import { Antoki } from "@/components/Antoki"
import { showAlert } from "@/lib/uiDialog"

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

// 수신처 안내 배너를 닫은 시각(ms). 영구 숨김이 아니라 7일 뒤 다시 뜬다 —
// 한 번 닫고 잊으면 보고서가 계속 아무 데도 안 가는데 아무도 모르게 된다.
const RECIPIENT_HINT_HIDDEN_KEY = "antok_recipient_hint_hidden_at"

// created_at(타임스탬프)을 로컬 기준 YYYY-MM-DD로 변환 — tbm_logs/minutes의 date 컬럼과 같은 기준으로 월 집계
const toLocalDateStr = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

// ── 랜딩 전용: 스크롤 리빌 + 결과물 서식 목업 ─────────────────────────────
// 리빌은 IntersectionObserver 1회 관찰 후 해제. 모션 감소 설정에선 이동 없이 짧은 페이드만.
function Reveal({ children, className = "", delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setShown(true); io.disconnect() } },
      { threshold: 0.15 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <div
      ref={ref}
      style={{ transitionDelay: shown ? `${delay}ms` : "0ms" }}
      className={`transition-all duration-700 ease-out motion-reduce:duration-150 motion-reduce:translate-y-0 ${shown ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"} ${className}`}
    >
      {children}
    </div>
  )
}

// 손서명 흉내 — 서명란이 비어 있으면 '아직 안 쓴 서류'로 보인다
const SignStroke = ({ className = "" }: { className?: string }) => (
  <svg viewBox="0 0 60 20" className={`h-4 w-auto ${className}`} aria-hidden>
    <path d="M4 14 C 12 4, 18 18, 26 9 S 42 4, 48 12 S 55 10, 57 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)

// 문서 목업 공통 껍데기 — 종이 카드 + '예시 서식' 라벨 (내용 수치는 전부 예시)
function PaperDoc({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className="relative bg-white border border-cur-hairline rounded-[10px] shadow-[0_16px_48px_rgba(38,37,30,0.10)] px-5 py-5 sm:px-7 sm:py-6 text-cur-ink">
      <span className="absolute top-3 right-3 text-[10px] font-semibold text-cur-muted bg-cur-canvas border border-cur-hairline rounded-[6px] px-1.5 py-0.5">예시 서식</span>
      <p className="text-center text-[15px] sm:text-[16px] font-bold tracking-[0.12em]">{title}</p>
      {badge && <p className="text-center text-[10px] text-cur-muted mt-0.5">{badge}</p>}
      <div className="mt-4">{children}</div>
    </div>
  )
}

const DocMetaRow = ({ k, v }: { k: string; v: string }) => (
  <div className="flex border-b border-cur-hairline last:border-b-0">
    <span className="w-[72px] shrink-0 bg-cur-canvas px-2 py-1.5 text-[10px] font-semibold text-cur-body">{k}</span>
    <span className="flex-1 px-2 py-1.5 text-[11px]">{v}</span>
  </div>
)

const RiskBadge = ({ level }: { level: "상" | "중" | "하" }) => (
  <span className={`inline-block rounded-[4px] px-1.5 py-px text-[9px] font-bold ${
    level === "상" ? "bg-cur-error/10 text-cur-error" : level === "중" ? "bg-amber-500/15 text-amber-600" : "bg-cur-elevated text-cur-body"
  }`}>{level}</span>
)

// 녹음 화면 목업 — 앱의 녹음 단계 느낌만 재현 (장식용, 인터랙션 없음)
function RecordingCard() {
  const bars = [5, 9, 14, 8, 16, 11, 18, 7, 13, 17, 9, 15, 6, 12, 18, 10, 14, 7, 16, 11, 8, 15, 12, 6, 13, 9]
  const lines = [
    "오늘 B동 앞 상차 작업 집중합니다",
    "지게차 지나갈 때는 일단 멈추고, 기사님과 눈 마주치고 가세요",
    "오후에 많이 덥습니다. 물 자주 드시고 이상하면 바로 얘기하세요",
  ]
  return (
    <div className="relative bg-white border border-cur-hairline rounded-[14px] shadow-[0_16px_48px_rgba(38,37,30,0.10)] p-5 sm:p-6 text-cur-ink">
      <span className="absolute top-3 right-3 text-[10px] font-semibold text-cur-muted bg-cur-canvas border border-cur-hairline rounded-[6px] px-1.5 py-0.5">예시 화면</span>
      <div className="flex items-center gap-2">
        <span className="relative flex w-2.5 h-2.5" aria-hidden>
          <span className="absolute inline-flex w-full h-full rounded-full bg-cur-error opacity-60 animate-ping motion-reduce:animate-none" />
          <span className="relative inline-flex w-2.5 h-2.5 rounded-full bg-cur-error" />
        </span>
        <span className="text-[14px] font-bold">녹음 중</span>
        <span className="text-[13px] font-mono text-cur-body">07:42</span>
        <span className="ml-auto mr-10 text-[11px] font-semibold text-cur-body bg-cur-elevated border border-cur-hairline rounded-[6px] px-1.5 py-0.5">1회차</span>
      </div>
      <div className="mt-4 flex items-end gap-[3px] h-8" aria-hidden>
        {bars.map((h, i) => (
          <span key={i} className="w-[5px] rounded-full bg-cur-primary/60" style={{ height: `${h * 2}px` }} />
        ))}
      </div>
      <div className="mt-4 bg-cur-canvas border border-cur-hairline rounded-[10px] px-3.5 py-3 space-y-2">
        {lines.map((l, i) => (
          <p key={l} className={`text-[12.5px] leading-relaxed break-keep ${i === lines.length - 1 ? "text-cur-ink font-medium" : "text-cur-muted"}`}>{l}</p>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2" aria-hidden>
        <span className="h-10 rounded-[8px] border border-cur-hairline flex items-center justify-center text-[13px] font-semibold text-cur-body">일시정지</span>
        <span className="h-10 rounded-[8px] bg-cur-primary text-cur-on-primary flex items-center justify-center gap-1.5 text-[13px] font-bold">
          <Mic className="w-3.5 h-3.5" /> AI 요약
        </span>
      </div>
    </div>
  )
}

function DocMinutes() {
  const rows: { hazard: string; level: "상" | "중" | "하"; action: string }[] = [
    { hazard: "지게차·보행자 동선 교차", level: "상", action: "유도자 배치, 후진 경보 확인" },
    { hazard: "중량물 상차 중 낙하", level: "중", action: "결속 상태 2인 교차 확인" },
    { hazard: "여름철 온열질환", level: "중", action: "시간당 10분 그늘 휴식·수분" },
  ]
  return (
    <PaperDoc title="T B M 회 의 록">
      <div className="border border-cur-hairline rounded-[6px] overflow-hidden">
        <DocMetaRow k="현장명" v="OO물류센터 A동 증축공사" />
        <DocMetaRow k="일시" v="2026. 08. 04. (화) 07:30 ~ 07:45" />
        <DocMetaRow k="참석" v="12명 (관리자 1, 근로자 11)" />
      </div>
      <p className="mt-3 text-[10px] font-bold text-cur-body">유해위험요인 및 감소대책</p>
      <div className="mt-1 border border-cur-hairline rounded-[6px] overflow-hidden">
        {rows.map((r) => (
          <div key={r.hazard} className="flex items-center gap-2 px-2 py-1.5 border-b border-cur-hairline last:border-b-0">
            <span className="flex-1 text-[10.5px] leading-snug">{r.hazard}</span>
            <RiskBadge level={r.level} />
            <span className="flex-1 text-[10px] text-cur-body leading-snug">{r.action}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[10px] font-bold text-cur-body">참석자 서명</p>
      <div className="mt-1 grid grid-cols-4 gap-1.5">
        {["김OO", "이OO", "박OO", "정OO"].map((n) => (
          <div key={n} className="border border-cur-hairline rounded-[6px] px-1.5 py-1 flex flex-col items-center gap-0.5">
            <span className="text-[9px] text-cur-muted">{n}</span>
            <SignStroke className="text-cur-ink/70" />
          </div>
        ))}
      </div>
      <p className="mt-1 text-right text-[9px] text-cur-muted">외 8명 — QR로 각자 휴대폰에서 서명</p>
    </PaperDoc>
  )
}

function DocEduLog() {
  return (
    <PaperDoc title="안 전 보 건 교 육 일 지">
      <div className="border border-cur-hairline rounded-[6px] overflow-hidden">
        <DocMetaRow k="교육구분" v="정기교육 (TBM)" />
        <DocMetaRow k="교육시간" v="07:30 ~ 07:45 (15분)" />
        <DocMetaRow k="교육대상" v="12명" />
      </div>
      <p className="mt-3 text-[10px] font-bold text-cur-body">교육 내용</p>
      <ul className="mt-1 border border-cur-hairline rounded-[6px] px-3 py-2 space-y-1 text-[10.5px] leading-relaxed list-disc list-inside">
        <li>상차 작업 시 지게차 접근 반경 내 보행 금지</li>
        <li>안전모·안전화 착용 상태 상호 점검</li>
        <li>온열질환 증상 발생 시 즉시 작업 중지 및 보고</li>
      </ul>
      <div className="mt-3 flex items-center justify-between border border-cur-hairline rounded-[6px] px-3 py-2">
        <span className="text-[10px] text-cur-body">교육 실시자</span>
        <span className="flex items-center gap-2 text-[10.5px] font-semibold">현장담당자 <SignStroke className="text-cur-ink/70" /></span>
      </div>
      <p className="mt-2 text-[9px] text-cur-muted text-right">반기 법정 교육시간에 자동 합산됩니다</p>
    </PaperDoc>
  )
}

function DocMonthly() {
  const tiles = [
    { k: "총 회의록", v: "42건" },
    { k: "언급된 위험", v: "31건" },
    { k: "고위험", v: "6건" },
    { k: "반복 언급", v: "4건" },
  ]
  const top = [
    { k: "부딪힘", n: 9 }, { k: "떨어짐", n: 7 }, { k: "끼임", n: 5 }, { k: "물체에 맞음", n: 4 },
  ]
  return (
    <PaperDoc title="월간 안전 보고서" badge="2026년 7월 · OO물류센터">
      <div className="rounded-[6px] bg-cur-primary/8 border border-cur-primary/20 px-2.5 py-1.5 text-[9.5px] leading-snug text-cur-body">
        본 보고서는 TBM 기록을 AI가 분석한 <b>참고자료</b>이며, 법정 위험성평가가 아닙니다.
      </div>
      <div className="mt-2.5 grid grid-cols-4 gap-1.5">
        {tiles.map((t) => (
          <div key={t.k} className="border border-cur-hairline rounded-[6px] px-1 py-2 text-center">
            <p className="text-[9px] text-cur-muted">{t.k}</p>
            <p className="text-[13px] font-bold font-mono mt-0.5">{t.v}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[10px] font-bold text-cur-body">재해유형 TOP</p>
      <div className="mt-1 space-y-1">
        {top.map((t) => (
          <div key={t.k} className="flex items-center gap-2">
            <span className="w-[64px] shrink-0 text-[10px] text-cur-body">{t.k}</span>
            <span className="h-2 rounded-full bg-cur-primary/70" style={{ width: `${t.n * 9}%` }} />
            <span className="text-[10px] font-mono text-cur-muted">{t.n}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-[9.5px] text-cur-muted">
        <Mail className="w-3 h-3" /> 매월 1일, 등록한 수신처로 자동 발송
      </div>
    </PaperDoc>
  )
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

  // 카카오 동의 취소·인앱브라우저 실패는 code/error 파라미터만 남긴 채 세션 없이 홈에 떨어진다.
  // 그 자리에서 마케팅 랜딩이 뜨면 "로그인하려다 광고를 봤다"로 읽혀서 로그인 화면으로 되돌린다.
  // 판정은 마운트 시점에 잡아둔다 — 성공 시 supabase가 URL에서 파라미터를 지우기 때문.
  const [oauthLanding, setOauthLanding] = useState(false)

  // 역할 판정 — pendingAttach면 편입 수락 모달, owner면 활동 현황 옆 '통계 보기' 버튼 노출
  const [orgCtx, setOrgCtx] = useState<ClientOrgContext | null>(cached?.orgCtx ?? null)
  // 온보딩에서 '여러 현장'을 고르고 셋업을 건너뛴 솔로 — 홈에서 현장 추가 입구를 이어준다
  const [hintAddSite, setHintAddSite] = useState(false)
  // 보고서를 받을 사람이 아직 없음(=주간·월간 보고서가 아무 데도 안 나감).
  // 설정 입구가 헤더 드롭다운과 분석 보고서 게이트뿐이라 대부분 기능 존재 자체를 모른다.
  const [recipientGap, setRecipientGap] = useState<{ pending: number; noEmail: boolean } | null>(null)
  useEffect(() => {
    try { setHintAddSite(window.localStorage.getItem("antok_hint_add_site") === "1") } catch { /* 무시 */ }
    const q = new URLSearchParams(window.location.search)
    setOauthLanding(q.has("code") || q.has("error"))
  }, [])
  // 코드 교환이 끝나고도 세션이 없으면(=콜백 실패) 랜딩 대신 로그인으로
  useEffect(() => {
    if (oauthLanding && !isLoading && !checking && !user) router.replace("/login")
  }, [oauthLanding, isLoading, checking, user, router])
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
          // 감독자가 발급 때 현장명을 정했으면(company_name ≠ 아이디 임시 표시명) 여기서 다시 묻지 않는다
          const presetSite = String(currentUser.user_metadata?.company_name ?? "").trim()
          const loginLocal = String(currentUser.email ?? "").split("@")[0]
          if (presetSite && presetSite !== loginLocal) setSetupSite(presetSite)
          setMustSetup(true)
          setIsLoading(false)
          return
        }

        // 감독자도 TBM을 쓴다 — 역할과 무관하게 통계를 동일하게 로드한다.
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
        // 업종·공종·근로자 구분·출력 형식은 가입 마무리 화면(/start-trial)이 받는다 — 홈은 묻지 않는다.
        // 값이 없는 구 계정을 위해 아래 계산·표시는 모두 폴백(비사무직 12시간)을 유지한다.
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

  // 수신처 공백 점검 — 승인된 수신자가 0명이면 보고서는 만들어지고도 아무 데도 안 간다.
  // 현장 계정(member)은 수신처 개념이 없고(API가 403), 비Pro는 등록 자체가 막혀 있어 대상이 아니다.
  useEffect(() => {
    if (!user || !orgCtx || orgCtx.kind === "member") return
    let cancelled = false
      ; (async () => {
        // 닫아둔 지 7일이 안 됐으면 조회조차 하지 않는다 — 매번 조르지 않기 위해
        try {
          const hidAt = Number(window.localStorage.getItem(RECIPIENT_HINT_HIDDEN_KEY) || 0)
          if (hidAt && Date.now() - hidAt < 7 * 24 * 60 * 60 * 1000) return
        } catch { /* 무시 */ }
        const { data } = await supabase.auth.getSession()
        const r = await fetchRecipients(data?.session?.access_token)
        if (cancelled || !r || !r.isPro) return
        // 온보딩에서 이메일 입력을 건너뛴 계정은 받을 주소 자체가 없다 — 수신처 0명보다 앞선 문제다
        const noEmail = !resolveMyReportEmail(data?.session?.user as never)
        setRecipientGap(noEmail || r.counts.approved === 0 ? { pending: r.counts.pending, noEmail } : null)
      })()
    return () => { cancelled = true }
  }, [user, orgCtx])

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
    // 홈에서만 이동이 없어 "로그아웃했더니 광고가 떴다"로 읽혔다 — 다른 화면과 같이 로그인으로
    router.push("/login")
  }

  // 감독자가 발급 때 현장명을 정해뒀는지 — 정했으면 첫 로그인 화면에서 다시 묻지 않는다
  const setupSitePreset = (() => {
    const preset = String(user?.user_metadata?.company_name ?? "").trim()
    const loginLocal = String(user?.email ?? "").split("@")[0]
    return !!preset && preset !== loginLocal
  })()

  // 온보딩 2단계: 사용 형태 선택 — 계정은 이미 같고, 여는 탭과 다음 안내만 달라진다
  // 일괄 발급 시 회사 공통 업종·공종을 이미 상속받았다면 첫 로그인 화면에서 다시 묻지 않는다 —
  // 여기서 강제로 다시 고르게 하면 상속값을 사용자 선택이 덮어써 회사 값과 어긋난다
  const setupInheritedProfile = !!user?.user_metadata?.industry
  // 첫 로그인 설정 저장 — 비밀번호 교체 + 현장명·현장담당자 확정
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

  // 저장 값은 길다 — 화면 배지는 사무직/비사무직 두 단어면 충분하다(Chris)
  const workerTypeLabel = (v?: string | null) => (v === "사무직 / 판매직" ? "사무직" : "비사무직")
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

  // 첫 로그인 온보딩 — 가입 위저드에서 뺀 설정(사용 형태·이메일·출력 형식)을 여기서 받는다.
  // 트리거 = 출력 형식 부재: 카카오는 /start-trial이, 기존 계정은 과거 수집이 채웠으므로
  // 사실상 아이디 신규 가입에게만 뜬다. member는 회사 공통 설정이라 묻지 않는다.
  const needsOnboarding = !!user
    && !mustSetup
    && !checking
    && orgCtx !== null
    && orgCtx.kind !== "member"
    && !user.user_metadata?.preferred_export_format

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
          <h3 className="text-[15px] font-semibold text-cur-ink leading-snug">내 TBM 작성</h3>
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
          <h3 className="text-[15px] font-semibold text-cur-ink leading-snug">내 교육일지 작성</h3>
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
              {setupSitePreset ? (
                /* 감독자가 발급 때 정한 이름 — 여기서 바꾸면 회사 현장 목록과 어긋나므로 표시만 */
                <div className="w-full h-11 px-3 rounded-[8px] bg-cur-elevated border border-cur-hairline text-[15px] text-cur-ink flex items-center justify-between">
                  <span className="truncate">{setupSite}</span>
                  <span className="text-[11px] text-cur-muted bg-cur-card border border-cur-hairline rounded-[6px] px-1.5 py-0.5 shrink-0 ml-2">안전관리자 지정</span>
                </div>
              ) : (
                <input value={setupSite} onChange={(e) => setSetupSite(e.target.value)} placeholder="예: OO물류센터 신축현장"
                  className="w-full h-11 px-3 rounded-[8px] bg-cur-elevated border border-cur-hairline text-[15px] text-cur-ink placeholder:text-cur-muted-soft focus:outline-none focus:ring-1 focus:ring-cur-primary" />
              )}
            </div>
            {/* 업종·공종은 발급 시 회사 공통 값을 상속받았으면 묻지 않는다 (레거시 계정만 수집) */}
            {!setupInheritedProfile && (
              <div className="space-y-1">
                <label className="text-[13px] font-medium text-cur-body">업종 (대분류)</label>
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
                <label className="text-[13px] font-medium text-cur-body">공종 (중분류)</label>
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
              <label className="text-[13px] font-medium text-cur-body">현장담당자 이름 (선택)</label>
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
          {/* 받은 계정이 내 것이 아닐 수 있다 — 설정을 끝내기 전에도 나갈 길을 준다 */}
          <button
            type="button"
            onClick={handleLogout}
            className="w-full h-9 text-[13px] font-medium text-cur-muted hover:text-cur-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary rounded-[6px]"
          >
            로그아웃하고 다른 계정으로 들어갈래요
          </button>
        </div>
      </div>
    )
  }

  if (!user) {
    // 콜백 파라미터를 달고 세션 없이 착지 — 위 effect가 /login으로 보낸다. 그 사이 광고가 비치지 않게.
    if (oauthLanding) return <div className="min-h-screen flex items-center justify-center bg-cur-canvas"><Loader2 className="w-10 h-10 text-cur-primary animate-spin" /></div>

    // 결과물 쇼케이스 — 문서 목업(예시 서식)과 짝지어 스크롤로 하나씩
    const showcases: { chip: string; title: string; desc: string; formats: string[]; doc: React.ReactNode }[] = [
      {
        chip: "TBM 회의록",
        title: "아침에 말한 그대로,\n회의록이 됩니다",
        desc: "누가 참석했고 어떤 위험을 짚었는지, 감소대책까지 표로 정리됩니다. 참석자 서명은 각자 휴대폰에서 QR로 — 종이를 돌릴 필요가 없습니다.",
        formats: ["hwpx", "docx", "pdf"],
        doc: <DocMinutes />,
      },
      {
        chip: "안전보건교육일지",
        title: "교육일지는 쓰는 게 아니라\n쌓이는 겁니다",
        desc: "TBM이 곧 법정 교육 기록입니다. 교육 내용과 시간이 자동 기록되고, 반기 법정 교육시간(사무직 6시간·비사무직 12시간)에 그대로 합산됩니다.",
        formats: ["hwpx", "docx", "xlsx", "pdf"],
        doc: <DocEduLog />,
      },
      {
        chip: "월간 AI 분석 보고서",
        title: "한 달 치 안전활동이\n보고서 한 장으로",
        desc: "그달의 회의록을 AI가 분석해 자주 언급된 위험, 고위험 항목, 재해유형별 경향을 정리합니다. 매월 1일, 사장님·안전관리자 메일로 자동 발송됩니다.",
        formats: ["이메일 자동 발송", "웹 링크"],
        doc: <DocMonthly />,
      },
    ]
    return (
      <div className="min-h-screen bg-cur-canvas font-sans text-cur-body">
        {/* 상단 네비 */}
        <header className="sticky top-0 z-20 bg-cur-canvas/80 backdrop-blur-sm border-b border-cur-hairline">
          <div className="max-w-6xl mx-auto px-5 sm:px-8 h-16 flex items-center justify-between">
            <Logo size="sm" />
            {/* 진입구는 /login 하나 — 신규는 로그인 화면이 동의 게이트(/start)로 넘겨준다.
                라벨만 다르고 목적지가 같은 버튼이 나란히 있으면 어느 쪽이 내 자리인지 고르게 만든다 */}
            <Button
              onClick={() => router.push("/login")}
              className="h-10 px-5 bg-cur-ink hover:opacity-90 text-white text-[14px] font-semibold rounded-[8px]"
            >
              로그인
            </Button>
          </div>
        </header>

        {/* 히어로 */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-[70%] bg-gradient-to-b from-cur-primary/10 via-cur-primary/5 to-transparent -z-10" />
          <div className="max-w-5xl mx-auto px-5 sm:px-8 py-20 sm:py-28 lg:py-36 text-center flex flex-col items-center gap-6 sm:gap-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <span className="text-[12px] sm:text-[13px] font-semibold text-cur-primary bg-cur-primary/10 px-3 py-1.5 rounded-full">
              현장 안전관리 AI · 안톡
            </span>
            <h1 className="text-[38px] sm:text-[56px] lg:text-[68px] font-bold text-cur-ink leading-[1.08] tracking-tight">
              말하면,<br className="sm:hidden" /> 서류가 됩니다
            </h1>
            <p className="text-cur-muted text-[16px] sm:text-[19px] leading-relaxed max-w-2xl break-keep">
              아침 TBM에서 말한 그대로 — TBM 회의록, 안전보건교육일지,
              월간 AI 분석 보고서가 법정 서식으로 완성됩니다.
            </p>
            <div className="flex flex-col items-center gap-3 w-full sm:w-auto pt-2">
              {/* 옆에 있던 [로그인]은 헤더와 같은 목적지라 뺐다 — 히어로의 강조는 하나여야 눈이 안 갈린다 */}
              <Button
                onClick={() => router.push("/login")}
                className="h-12 px-8 w-full sm:w-auto bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary text-[16px] font-bold rounded-[8px]"
              >
                첫 달 무료로 시작하기
              </Button>
              <p className="text-[13px] text-cur-muted-soft">첫 달 무료 체험 · 이후 계정 1개당 월 3,900원</p>
            </div>
          </div>
        </section>

        {/* 녹음 — 히어로 바로 아래 본문 시작: 입력이 얼마나 단순한지부터 보여준다 */}
        <section id="process" className="max-w-6xl mx-auto px-5 sm:px-8 pb-20 sm:pb-28">
          <div className="grid md:grid-cols-2 gap-8 md:gap-14 items-center">
            <Reveal>
              <span className="inline-block text-[12px] font-semibold text-cur-primary bg-cur-primary/10 px-2.5 py-1 rounded-full">
                녹음
              </span>
              <h3 className="text-[24px] sm:text-[32px] font-bold text-cur-ink tracking-tight leading-[1.25] mt-4 whitespace-pre-line break-keep">
                {"하던 TBM 그대로,\n녹음 버튼만 누르세요"}
              </h3>
              <p className="text-[15px] sm:text-[16px] text-cur-muted leading-relaxed mt-4 max-w-md break-keep">
                따로 배울 것이 없습니다. 아침 조회에서 말하는 동안 안톡이 받아 적고,
                끝나면 AI 요약 버튼 하나로 문서 작성이 시작됩니다.
              </p>
              <div className="flex flex-wrap gap-1.5 mt-5">
                {["실시간 음성 인식", "회차·시간 자동 기록"].map((f) => (
                  <span key={f} className="text-[11px] font-mono font-semibold text-cur-body bg-cur-card border border-cur-hairline rounded-[6px] px-2 py-1">
                    {f}
                  </span>
                ))}
              </div>
              {/* 안톡이 — 이 랜딩에서 마스코트는 여기 한 곳뿐이다.
                  '듣고 있다'가 이 섹션의 주장이라 listen 포즈만 의미가 맞는다.
                  옆 목업의 빨간 점(animate-ping)이 이미 '지금 진행 중'을 맡고 있어서
                  마스코트는 조용한 쪽(breathe)으로 둔다. 장식이라 aria-hidden. */}
              <Antoki pose="listen" size="xl" motion="breathe" className="mt-7" />
            </Reveal>
            <Reveal delay={140} className="max-w-md w-full mx-auto md:mx-0 md:justify-self-end">
              <RecordingCard />
            </Reveal>
          </div>
        </section>

        {/* 결과물 쇼케이스 — 스크롤 내리며 서류가 하나씩 나타난다 */}
        <section id="results" className="max-w-6xl mx-auto px-5 sm:px-8 pb-8 sm:pb-12">
          <Reveal className="text-center mb-12 sm:mb-16">
            <h2 className="text-[26px] sm:text-[38px] font-bold text-cur-ink tracking-tight leading-tight break-keep">
              가입 첫날부터, 이 서류들이 나옵니다
            </h2>
            <p className="text-cur-muted text-[15px] sm:text-[17px] mt-3 max-w-xl mx-auto leading-relaxed break-keep">
              아래 서식은 실제 출력물과 같은 구성의 예시입니다.
            </p>
          </Reveal>

          <div className="space-y-20 sm:space-y-28">
            {showcases.map((s, i) => (
              <div key={s.chip} className="grid md:grid-cols-2 gap-8 md:gap-14 items-center">
                <Reveal className={i % 2 === 1 ? "md:order-2" : ""}>
                  <span className="inline-block text-[12px] font-semibold text-cur-primary bg-cur-primary/10 px-2.5 py-1 rounded-full">
                    {s.chip}
                  </span>
                  <h3 className="text-[24px] sm:text-[32px] font-bold text-cur-ink tracking-tight leading-[1.25] mt-4 whitespace-pre-line break-keep">
                    {s.title}
                  </h3>
                  <p className="text-[15px] sm:text-[16px] text-cur-muted leading-relaxed mt-4 max-w-md break-keep">
                    {s.desc}
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-5">
                    {s.formats.map((f) => (
                      <span key={f} className="text-[11px] font-mono font-semibold text-cur-body bg-cur-card border border-cur-hairline rounded-[6px] px-2 py-1">
                        {f}
                      </span>
                    ))}
                  </div>
                </Reveal>
                <Reveal delay={140} className={`${i % 2 === 1 ? "md:order-1" : ""} max-w-md w-full mx-auto md:mx-0 ${i % 2 === 1 ? "md:justify-self-start" : "md:justify-self-end"}`}>
                  {s.doc}
                </Reveal>
              </div>
            ))}
          </div>
        </section>

        <section className="max-w-6xl mx-auto px-5 sm:px-8 pb-24 sm:pb-32 pt-20 sm:pt-28">
          {/* 하단 CTA */}
          <div className="bg-cur-ink rounded-[20px] px-6 sm:px-12 py-12 sm:py-16 text-center flex flex-col items-center gap-5">
            <h2 className="text-[24px] sm:text-[34px] font-bold text-white leading-tight tracking-tight">
              첫 달 무료로 시작하세요
            </h2>
            <p className="text-white/70 text-[15px] sm:text-[16px] max-w-xl">
              복잡한 설치 없이 카카오/일반 계정으로 바로 시작. 첫 달은 무료 체험이고, 이후 계정 1개당 월 3,900원이에요. 현장이 여러 곳이면 계정을 추가한 만큼만 더 내면 됩니다. 언제든 해지할 수 있습니다.
            </p>
            <Button
              onClick={() => router.push("/login")}
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
                  showAlert(res.ok ? "인증 메일을 보냈어요. 메일함을 확인하세요." : (j.error || "인증 메일 발송에 실패했어요. 잠시 후 다시 시도해주세요."))
                }}
                className="shrink-0 h-9 px-3 rounded-lg bg-cur-ink text-white text-[12px] font-bold"
              >
                인증 메일
              </button>
            </div>
          )}

          {/* 첫 로그인 온보딩 — 저장이 끝나면 서버 기준 user로 교체돼 조건이 풀린다 */}
          {needsOnboarding && <OnboardingModal onDone={(u) => { if (u) commitUser(u); setHintAddSite((() => { try { return window.localStorage.getItem("antok_hint_add_site") === "1" } catch { return false } })()) }} />}

          {/* 튜토리얼 미이수 배너 — 완료·건너뛰기·X 모두 tutorial_seen_at 기록으로 사라진다 */}
          {user && !user.user_metadata?.tutorial_seen_at && (
            <div className="flex items-center gap-3 p-3.5 rounded-[12px] bg-cur-primary/5 border border-cur-primary/20">
              <PlayCircle className="w-5 h-5 shrink-0 text-cur-primary" />
              <button
                type="button"
                onClick={() => router.push('/tutorial')}
                className="flex-1 min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary rounded-[4px]"
              >
                <span className="block text-[14px] font-semibold text-cur-ink">가이드 안내 — 1분이면 충분해요</span>
                <span className="block text-[12px] text-cur-body mt-0.5">어떤 버튼을 누르는지 화면 그대로 따라가며 보여드려요</span>
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

          {/* 보고서 수신처 공백 — 승인된 사람이 0명이면 주간·월간 보고서가 아무 데도 안 간다.
              등록만 하고 승인 전인 경우와 아예 없는 경우는 할 일이 달라서 문구를 나눈다. */}
          {recipientGap && (
            /* 눈에 띄어야 하지만 번쩍이지는 않게(Chris) — 카드는 조용한 경고색, 점 하나만 천천히 숨쉰다 */
            <div className="flex items-center gap-3 p-3.5 rounded-[12px] bg-cur-error/[0.04] border border-cur-error/30">
              <span className="relative shrink-0">
                <MailPlus className="w-5 h-5 text-cur-error" />
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-cur-error animate-pulse motion-reduce:animate-none" />
              </span>
              <button
                type="button"
                onClick={() => router.push(recipientGap.noEmail ? '/profile' : '/org/reports')}
                className="flex-1 min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary rounded-[4px]"
              >
                <span className="block text-[14px] font-semibold text-cur-ink">
                  {recipientGap.noEmail
                    ? "보고서 받을 이메일이 없어요"
                    : recipientGap.pending > 0
                      ? `보고서 수신 승인 대기 ${recipientGap.pending}명`
                      : "보고서 받을 사람이 아직 없어요"}
                </span>
                <span className="block text-[12px] text-cur-body mt-0.5">
                  {recipientGap.noEmail
                    ? "내 정보 수정에서 이메일을 등록해주세요"
                    : recipientGap.pending > 0
                      ? "승인 링크를 눌러야 주간·월간 보고서가 발송돼요"
                      : "등록하면 주간·월간 보고서가 이메일로 자동 발송돼요"}
                </span>
              </button>
              <button
                type="button"
                aria-label="보고서 수신처 안내 닫기"
                onClick={() => {
                  try { window.localStorage.setItem(RECIPIENT_HINT_HIDDEN_KEY, String(Date.now())) } catch { /* 무시 */ }
                  setRecipientGap(null)
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
                내 법정의무 교육 진행도
                <span className="bg-cur-primary/15 px-2 py-0.5 rounded-[4px] text-[11px] text-cur-primary font-semibold shrink-0">
                  {workerTypeLabel(user?.user_metadata?.worker_type)}
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
                    : fillWidth < 6
                      ? { left: '0%' } // 0% 부근에서 가운데 정렬하면 라벨 절반이 카드 밖으로 나간다
                      : { left: `${fillWidth}%`, transform: 'translateX(-50%)' }
                }
              >
                {Math.floor(rawPercent)}%
              </div>
            </div>
            <p className="text-[12px] text-cur-muted mt-3 leading-relaxed">
              <span className="font-semibold text-cur-body">{halfLabel}</span> · TBM으로 채울 수 있어요
            </p>
          </div>
        </div>

        {/* 작성 카드 2종 — 병렬 배치 (Chris): 홈의 두 핵심 행동 */}
        <div className="flex-1 p-6">
          {writeCards}
        </div>
      </div>
    </div>
  )
}