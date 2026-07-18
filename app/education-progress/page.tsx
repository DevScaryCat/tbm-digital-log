// app/education-progress/page.tsx
"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { fetchAllRows } from "@/lib/fetchAllRows"
import { totalSeconds, secondsToHours, formatDuration } from "@/lib/educationHours"
import { useRequireSubscription } from "@/lib/useSubscription"
import { TBMHeader } from "@/components/TBMHeader"
import { Loader2, CheckCircle2, ClipboardList } from "lucide-react"

interface Row { date: string | null; start_time: string | null; end_time: string | null; education_type?: string | null }

// 유형별 표기(순서·색). 홈 진행도와 동일하게 반기 누적 시간을 유형별로 쪼갠다.
const CATEGORIES: { key: string; label: string; color: string }[] = [
  { key: "TBM", label: "TBM (작업 전 안전점검)", color: "bg-cur-primary" },
  { key: "정기 안전교육", label: "정기 안전교육", color: "bg-[#ff9a5c]" },
  { key: "특별안전보건교육", label: "특별안전보건교육", color: "bg-amber-400" },
  { key: "신규 채용시 교육", label: "신규 채용시 교육", color: "bg-emerald-400" },
  { key: "작업내용 변경시 교육", label: "작업내용 변경시 교육", color: "bg-sky-400" },
]
const NAMED_LOG_TYPES = ["TBM", "정기 안전교육", "특별안전보건교육", "신규 채용시 교육", "작업내용 변경시 교육"]

// 소요시간 계산·표기는 lib/educationHours(totalSeconds/formatDuration)로 일원화 — 홈(app/page.tsx)과 동일 규칙.
interface CatStat { label: string; color: string; seconds: number; count: number }

export default function EducationProgressPage() {
  const router = useRouter()
  const { checking } = useRequireSubscription()
  const [loading, setLoading] = useState(true)
  const [workerType, setWorkerType] = useState("현장 근로자 (비사무직)")
  const [cats, setCats] = useState<CatStat[]>([])
  const [totalSec, setTotalSec] = useState(0)

  const requiredHours = workerType === "사무직 / 판매직" ? 6 : 12
  const halfLabel = (() => { const d = new Date(); return `${d.getFullYear()} ${d.getMonth() < 6 ? "상반기" : "하반기"}` })()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        // 비로그인은 useRequireSubscription이 리다이렉트하지 않고 페이지에 위임 → 여기서 로그인으로 보냄
        if (!session) { router.replace("/login"); return }
        const wt = session.user.user_metadata?.worker_type || "현장 근로자 (비사무직)"
        if (cancelled) return
        setWorkerType(wt)

        // 현재 반기(홈과 동일: 올해 & 상/하반기)만 서버에서 필터 —
        // 전체 이력 조회는 PostgREST 1000행 캡에 걸려 법정 이수시간이 조용히 과소집계될 수 있다.
        const now = new Date()
        const year = now.getFullYear()
        const isFirstHalf = now.getMonth() < 6
        const halfStart = `${year}-${isFirstHalf ? "01" : "07"}-01`
        const halfEnd = `${year}-${isFirstHalf ? "06-30" : "12-31"}`

        // fetchAllRows = 반기 내에서도 Pro(월 200건)면 1000행을 넘을 수 있어 페이지 순회
        const [logsHalf, minsHalf] = await Promise.all([
          fetchAllRows<Row>((f, t) => supabase.from("tbm_logs").select("date, start_time, end_time, education_type").eq("user_id", session.user.id).gte("date", halfStart).lte("date", halfEnd).order("id").range(f, t)),
          fetchAllRows<Row>((f, t) => supabase.from("tbm_minutes").select("date, start_time, end_time").eq("user_id", session.user.id).gte("date", halfStart).lte("date", halfEnd).order("id").range(f, t)),
        ])

        const logsByType = (type: string) => logsHalf.filter((l) => (l.education_type || "") === type)

        const built: CatStat[] = CATEGORIES.map((c) => {
          // TBM 유형은 회의록(tbm_minutes) + 교육일지 중 'TBM' 분류를 합산
          const rows = c.key === "TBM" ? [...minsHalf, ...logsByType("TBM")] : logsByType(c.key)
          return { label: c.label, color: c.color, seconds: totalSeconds(rows), count: rows.length }
        })

        // 명명되지 않은 유형(관리감독자 교육·기타·미분류)은 데이터가 있을 때만 '기타'로 합산 — 총합 정합성 유지
        const otherRows = logsHalf.filter((l) => !NAMED_LOG_TYPES.includes(l.education_type || ""))
        if (otherRows.length > 0) {
          built.push({ label: "기타 교육", color: "bg-cur-muted", seconds: totalSeconds(otherRows), count: otherRows.length })
        }

        if (cancelled) return
        setCats(built)
        setTotalSec(totalSeconds(logsHalf) + totalSeconds(minsHalf))
        setLoading(false)
      } catch (e) {
        console.error("교육 진행도 로드 실패:", e)
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [router])

  // %·이수판정은 홈(app/page.tsx)과 같은 lib/educationHours를 써서 동일 데이터면 동일 % — 두 화면이 갈리지 않음.
  const rawPercent = requiredHours > 0 ? (secondsToHours(totalSec) / requiredHours) * 100 : 0
  const isDone = rawPercent >= 100
  const totalFill = Math.min(100, rawPercent)

  if (checking) return <div className="min-h-screen flex items-center justify-center bg-cur-canvas"><Loader2 className="w-10 h-10 text-cur-primary animate-spin" /></div>

  return (
    <div className="bg-cur-canvas min-h-screen sm:py-8 flex sm:block items-center justify-center font-sans text-cur-body pb-20">
      <div className="max-w-lg w-full mx-auto bg-cur-card sm:rounded-[12px] relative flex flex-col min-h-[100dvh] sm:min-h-[85vh] border-x sm:border border-cur-hairline mb-[env(safe-area-inset-bottom)] overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.04)]">

        <div className="p-4 bg-cur-card/90 backdrop-blur-sm border-b border-cur-hairline sticky top-0 z-50">
          <TBMHeader title="법정 의무 교육 진행도" backHref="/" />
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">

          {/* 총 진행도 */}
          <div className="bg-cur-card rounded-[12px] p-5 border border-cur-hairline">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <h2 className="text-[15px] font-semibold text-cur-ink tracking-[-0.11px]">이번 반기 진행도</h2>
                <span className="bg-cur-primary/15 px-2 py-0.5 rounded-[4px] text-[11px] text-cur-primary font-semibold shrink-0">{workerType}</span>
              </div>
              <span className="text-[14px] font-bold text-cur-primary font-mono whitespace-nowrap shrink-0">
                {loading ? <Loader2 className="w-4 h-4 animate-spin inline-block" /> : `${formatDuration(totalSec)} / ${requiredHours}시간`}
              </span>
            </div>

            <div className="w-full h-2.5 bg-cur-elevated rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-1000 ease-out ${isDone ? "bg-cur-success" : "bg-gradient-to-r from-cur-primary-active to-cur-primary"}`}
                style={{ width: `${loading ? 0 : totalFill}%` }}
              />
            </div>

            <div className="flex items-center justify-between mt-3">
              <p className="text-[12px] text-cur-muted leading-relaxed">
                <span className="font-semibold text-cur-body">{halfLabel}</span> 기준 · 반기별 {requiredHours}시간 이상
              </p>
              {!loading && (
                isDone ? (
                  <span className="flex items-center gap-1 text-[12px] font-bold text-cur-success shrink-0">
                    <CheckCircle2 className="w-4 h-4" /> 이수 완료
                  </span>
                ) : (
                  <span className="text-[12px] font-bold text-cur-primary font-mono shrink-0">{Math.floor(rawPercent)}%</span>
                )
              )}
            </div>
          </div>

          {/* 유형별 진행 현황 */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 px-1">
              <ClipboardList className="w-4 h-4 text-cur-primary" />
              <h3 className="text-[14px] font-bold text-cur-ink">유형별 진행 현황</h3>
            </div>

            {loading ? (
              <div className="bg-cur-card p-8 rounded-[12px] border border-cur-hairline flex justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-cur-muted" />
              </div>
            ) : (
              <div className="bg-cur-card rounded-[12px] border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                {cats.map((c) => {
                  const pct = requiredHours > 0 ? Math.min(100, (secondsToHours(c.seconds) / requiredHours) * 100) : 0
                  const empty = c.count === 0
                  return (
                    <div key={c.label} className="p-4 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`w-2.5 h-2.5 rounded-[3px] shrink-0 ${empty ? "bg-cur-hairline" : c.color}`} />
                          <span className={`text-[13px] font-semibold truncate ${empty ? "text-cur-muted-soft" : "text-cur-ink"}`}>{c.label}</span>
                        </div>
                        <span className={`text-[13px] font-mono whitespace-nowrap shrink-0 ${empty ? "text-cur-muted-soft" : "text-cur-body font-bold"}`}>
                          {formatDuration(c.seconds)}
                          <span className="text-[11px] text-cur-muted ml-1 font-sans font-medium">· {c.count}건</span>
                        </span>
                      </div>
                      <div className="w-full h-2 bg-cur-elevated rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all duration-700 ease-out ${c.color}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            <p className="text-[12px] text-cur-muted leading-relaxed px-1">
              정기 안전교육은 <span className="font-semibold text-cur-body">TBM(작업 전 안전점검)으로 대체 가능</span>합니다. 막대는 각 유형이 반기 의무시간({requiredHours}시간)에서 차지하는 비중이에요.
            </p>
          </div>

        </div>
      </div>
    </div>
  )
}
