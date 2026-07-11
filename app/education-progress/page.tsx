// app/education-progress/page.tsx
"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
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

// 한 행(start~end)의 교육 시간(시간 단위). 홈(app/page.tsx)과 동일 계산.
function hoursOf(rows: Row[]): number {
  let mins = 0
  for (const log of rows) {
    if (log.start_time && log.end_time) {
      const [sh, sm] = log.start_time.split(":").map(Number)
      const [eh, em] = log.end_time.split(":").map(Number)
      let diff = eh * 60 + em - (sh * 60 + sm)
      if (diff < 0) diff += 1440 // 자정 넘김 보정
      if (diff > 0) mins += diff
    }
  }
  return mins / 60
}

interface CatStat { label: string; color: string; hours: number; count: number }

export default function EducationProgressPage() {
  const router = useRouter()
  const { checking } = useRequireSubscription()
  const [loading, setLoading] = useState(true)
  const [workerType, setWorkerType] = useState("현장 근로자 (비사무직)")
  const [cats, setCats] = useState<CatStat[]>([])
  const [totalHours, setTotalHours] = useState(0)

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

        const [{ data: tbmLogs }, { data: minutesLogs }] = await Promise.all([
          supabase.from("tbm_logs").select("date, start_time, end_time, education_type").eq("user_id", session.user.id),
          supabase.from("tbm_minutes").select("date, start_time, end_time").eq("user_id", session.user.id),
        ])

        // 현재 반기 필터 (홈과 동일: 올해 & 상/하반기)
        const now = new Date()
        const year = now.getFullYear()
        const isFirstHalf = now.getMonth() < 6
        const inHalf = (d: string | null) => {
          if (!d) return false
          const month = parseInt(d.split("-")[1], 10)
          return d.startsWith(`${year}`) && (isFirstHalf ? month <= 6 : month > 6)
        }

        const logsHalf = ((tbmLogs as Row[]) || []).filter((l) => inHalf(l.date))
        const minsHalf = ((minutesLogs as Row[]) || []).filter((m) => inHalf(m.date))

        const logsByType = (type: string) => logsHalf.filter((l) => (l.education_type || "") === type)

        const built: CatStat[] = CATEGORIES.map((c) => {
          // TBM 유형은 회의록(tbm_minutes) + 교육일지 중 'TBM' 분류를 합산
          const rows = c.key === "TBM" ? [...minsHalf, ...logsByType("TBM")] : logsByType(c.key)
          return { label: c.label, color: c.color, hours: hoursOf(rows), count: rows.length }
        })

        // 명명되지 않은 유형(관리감독자 교육·기타·미분류)은 데이터가 있을 때만 '기타'로 합산 — 총합 정합성 유지
        const otherRows = logsHalf.filter((l) => !NAMED_LOG_TYPES.includes(l.education_type || ""))
        if (otherRows.length > 0) {
          built.push({ label: "기타 교육", color: "bg-cur-muted", hours: hoursOf(otherRows), count: otherRows.length })
        }

        if (cancelled) return
        setCats(built)
        setTotalHours(hoursOf(logsHalf) + hoursOf(minsHalf))
        setLoading(false)
      } catch (e) {
        console.error("교육 진행도 로드 실패:", e)
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [router])

  // 홈(app/page.tsx)은 시간을 1자리로 반올림한 값으로 %·이수판정을 계산한다. 같은 '12.0시간' 표기인데
  // %가 갈리지 않도록(홈 100% vs 여기 99%) 동일하게 표기용 반올림값에서 %를 도출한다.
  const displayHours = parseFloat(totalHours.toFixed(1))
  const rawPercent = requiredHours > 0 ? (displayHours / requiredHours) * 100 : 0
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
                {loading ? <Loader2 className="w-4 h-4 animate-spin inline-block" /> : `${displayHours.toFixed(1)} / ${requiredHours} (시간)`}
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
                  const h = parseFloat(c.hours.toFixed(1))
                  const pct = requiredHours > 0 ? Math.min(100, (h / requiredHours) * 100) : 0
                  const empty = c.count === 0
                  return (
                    <div key={c.label} className="p-4 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`w-2.5 h-2.5 rounded-[3px] shrink-0 ${empty ? "bg-cur-hairline" : c.color}`} />
                          <span className={`text-[13px] font-semibold truncate ${empty ? "text-cur-muted-soft" : "text-cur-ink"}`}>{c.label}</span>
                        </div>
                        <span className={`text-[13px] font-mono whitespace-nowrap shrink-0 ${empty ? "text-cur-muted-soft" : "text-cur-body font-bold"}`}>
                          {h.toFixed(1)}시간
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
