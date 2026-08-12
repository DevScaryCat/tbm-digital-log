"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { formatRangeLabelKo } from "@/lib/utils"
import { fetchSubscription, isProActive, isExpired } from "@/lib/useSubscription"
import { fetchOrgContext } from "@/lib/useOrgContext"
import { TBMHeader } from "@/components/TBMHeader"
import { AnalyzeProgress, type ProgressStep } from "@/components/AnalyzeProgress"
import { countRecipients } from "@/lib/reportRecipients"
import { resolveMyReportEmail } from "@/lib/myEmail"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DateRange } from "react-day-picker"
import { ExternalLink, Loader2 } from "lucide-react"
import { format, parseISO, isWithinInterval, startOfDay, endOfDay } from "date-fns"

interface RiskItem {
    hazard: string
    cause: string
    measures: string
    recurring?: boolean
}

const SAMPLE_ITEMS: RiskItem[] = [
    { hazard: "고소작업 중 추락", cause: "여러 날 반복된 비계·고소 작업, 안전대 미체결", measures: "안전대 100% 체결, 작업발판·안전난간 점검, 추락방지망 설치", recurring: true },
    { hazard: "중량물 취급 중 협착·끼임", cause: "자재 인양·운반 작업 반복", measures: "신호수 배치, 인양구 결속 확인, 하부 출입통제", recurring: true },
    { hazard: "전동공구 사용 중 감전", cause: "누전·피복 손상, 우천 시 작업", measures: "누전차단기 설치, 공구 절연 점검, 젖은 손 사용 금지", recurring: false },
    { hazard: "정리정돈 미흡으로 전도", cause: "자재·공구 적치, 통로 미확보", measures: "통로 확보, 적치장 분리, 작업 후 정리정돈", recurring: false },
    { hazard: "분진·소음 노출", cause: "절단·천공 작업 반복", measures: "방진마스크·귀마개 착용, 습식 작업, 작업시간 관리", recurring: false },
]

export default function RiskAssessmentPage() {
    const router = useRouter()
    const [checking, setChecking] = useState(true)
    const [pro, setPro] = useState(false)
    const [companyName, setCompanyName] = useState("")
    // 보고서 설정(문서 형식·수신자) 미완료면 진행 차단 — "설정을 마치고 와주세요" (Chris)
    const [setupNeeded, setSetupNeeded] = useState(false)
    // 등록은 했는데 아무도 승인 안 한 상태 — 안내 문구가 달라야 한다("등록하세요"가 아니라 "승인을 받으세요")
    const [setupPendingOnly, setSetupPendingOnly] = useState(false)

    // 화면 상태 5개로 단순화: 게이트(setupNeeded) / 체험 인트로(0) / 시작(1) / 분석 중(analyzing) / 결과(2)
    const [step, setStep] = useState<0 | 1 | 2>(1)
    const [analyzing, setAnalyzing] = useState(false)
    // 분석 진행 표시 — 단계 목록과 현재 단계는 analyze()가 실제 작업 경계에서만 바꾼다
    const [phaseSteps, setPhaseSteps] = useState<ProgressStep[]>([])
    const [phase, setPhase] = useState("")
    const [range, setRange] = useState<DateRange | undefined>()
    const [items, setItems] = useState<RiskItem[]>([])
    const [periodLabel, setPeriodLabel] = useState("")
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
    const [tbmDates, setTbmDates] = useState<string[]>([])

    // 안전관리자(owner) 모드: 대상 현장을 골라 서버가 그 현장 데이터로 분석 (§4-A)
    const [orgKind, setOrgKind] = useState<"owner" | "member" | "solo">("solo")
    // 현장 목록은 화면에 없다(입구가 달력뿐이라 대상은 항상 본인 현장) — 조회 결과만 흘려보낸다
    const [, setSites] = useState<{ userId: string; siteName: string }[]>([])
    const [targetSite, setTargetSite] = useState<{ userId: string; siteName: string } | null>(null)

    // 보고서 보내기 (결과 화면) — 서버가 내 이메일(인증 real_email·카카오)을 자동 포함하므로 입력은 추가 수신자만
    const [reportEmail, setReportEmail] = useState("")
    const [myEmail, setMyEmail] = useState<string | null>(null)
    const [sending, setSending] = useState(false)
    const [sendMsg, setSendMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
    // 같은 기간 안전보건교육일지 통계 (회의록 위험성평가와 함께 메일 발송)
    const [eduStats, setEduStats] = useState<{ sessions: number; days: number; headcount: number; avg: string } | null>(null)
    // 이메일 형식 미리보기(회의록 종합분석 / 안전보건교육일지 종합분석) HTML
    const [minutesHtml, setMinutesHtml] = useState("")
    const [eduHtml, setEduHtml] = useState("")
    const [loadingPreviews, setLoadingPreviews] = useState(false)
    // 버튼이 "몇 명에게 보내는지"를 그대로 말하도록 — 입력창의 쉼표 목록 + 내 이메일
    const extraEmails = reportEmail.split(",").map((e) => e.trim()).filter((e) => e && e !== myEmail).slice(0, 3)
    const recipientCount = (myEmail ? 1 : 0) + extraEmails.length


    useEffect(() => {
        ;(async () => {
            // 달력 핸드오프(ra_range)는 진입 즉시 소비한다 — 게이트·리다이렉트로 빠져나가도
            // localStorage에 묵은 범위가 남아 다음 방문(통계 ra_target 등)을 오발사시키지 않게.
            let pendingRange: { from: string; to?: string } | null = null
            try {
                const raw = localStorage.getItem("ra_range")
                if (raw) {
                    localStorage.removeItem("ra_range")
                    const parsed = JSON.parse(raw)
                    if (parsed?.from) pendingRange = parsed
                }
            } catch { /* 무시 */ }

            const { data: { user } } = await supabase.auth.getUser()
            if (!user) { router.replace("/login"); return }
            // 발송 카드에서 "내 이메일 자동 수신" 여부를 가르는 값 — 인증 real_email > 카카오 > null
            setMyEmail(resolveMyReportEmail(user))
            // 역할 분기: member는 AI 분석 없음(안전관리자 전용, §4-C) / owner는 현장 선택 모드
            const ctx = await fetchOrgContext()
            // ⚠️ orgLapse·seatLocked도 함께 본다. 회사 결제가 끊기면 서버가 kind를 'solo'로
            //    강등하므로 kind만 보는 가드를 통과했고, 그 다음 줄의 isExpired가 그 사람을
            //    /pricing으로 보냈다 — 결제 주체가 아닌 사람에게 결제 화면이었다. 홈으로
            //    되돌려 OrgLapseNotice가 사실을 말하게 한다(useSubscription과 같은 규칙).
            if (ctx?.kind === "member" || ctx?.orgLapse || ctx?.seatLocked) { router.replace("/"); return }
            const kind = ctx?.kind === "owner" ? "owner" : "solo"
            setOrgKind(kind)
            const s = await fetchSubscription()
            // 만료(행은 있는데 불허 — 체험 종료·해지 만료)는 pro=false로 legacy '예시' 화면(C)에
            // 흘러들면 안 된다 — C는 원래 Pro 미포함 플랜(grandfather·베이직) 전용이다.
            // 만료자는 B 게이트 정책대로 축출(결제 유도). isAllowed=true인 기존 플랜은 그대로 통과.
            if (isExpired(s)) { router.replace("/pricing"); return }
            const p = isProActive(s)
            setPro(p)
            if (!p && kind !== "owner") setStep(0) // 베이직: 설명 화면 먼저
            setCompanyName(user.user_metadata?.company_name || "")

            // 보고서 설정 완료 판정 — 문서 형식 + (Pro면) '승인된' 수신자 1명 이상. 판정 실패 시엔 막지 않는다.
            // 등록만 하고 승인 전인 상태를 통과시키면, 게이트만 열리고 실제 발송은 0통이 된다.
            {
                let needs = !user.user_metadata?.preferred_export_format
                let pendingOnly = false
                if (!needs && p) {
                    try {
                        const { data: sess } = await supabase.auth.getSession()
                        const rres = await fetch("/api/reports/recipients", { headers: { Authorization: `Bearer ${sess?.session?.access_token}` } })
                        if (rres.ok) {
                            const rj = await rres.json()
                            const c = countRecipients(rj.recipients)
                            needs = c.approved === 0
                            pendingOnly = c.approved === 0 && c.pending > 0
                        }
                    } catch { /* 네트워크 실패로 기능을 잠그지 않는다 */ }
                }
                setSetupPendingOnly(pendingOnly)
                if (needs) {
                    // 게이트로 나가면 현장 선택 의도(ra_target)는 소비되지 않는다 — 남겨두면
                    // 다음 방문에서 엉뚱한 현장이 자동 선택되므로 지운다
                    try { sessionStorage.removeItem("ra_target") } catch { /* 무시 */ }
                    setSetupNeeded(true)
                    setChecking(false)
                    return
                }
            }

            if (kind === "owner") {
                // 현장 목록 = 감독자 본인 현장 + 소속 현장. 본인을 빼면 회사관리의
                // '내 현장 → AI 분석' 경로가 조용히 버려지고, 하위 0곳이면 완전 막다른 길이 된다.
                const meta = user.user_metadata ?? {}
                const selfSite = {
                    userId: user.id,
                    siteName: `${String(meta.site_name ?? "").trim() || String(meta.company_name ?? "").trim() || "내 현장"} (내 현장)`,
                }
                try {
                    const { data: sess } = await supabase.auth.getSession()
                    const res = await fetch("/api/org/members", { headers: { Authorization: `Bearer ${sess?.session?.access_token}` } })
                    if (res.ok) {
                        const j = await res.json()
                        const active = [
                            selfSite,
                            ...(j.members ?? []).filter((m: any) => m.status === "active")
                                .map((m: any) => ({ userId: m.userId, siteName: m.siteName || "현장명 미설정" })),
                        ]
                        setSites(active)
                        // 달력 진입(pendingRange)이 있으면 그 의도가 최신 — ra_target은 소비만 하고 버린다
                        const saved = sessionStorage.getItem("ra_target")
                        if (saved) sessionStorage.removeItem("ra_target")
                        if (!pendingRange && saved) {
                            const t = JSON.parse(saved)
                            if (t?.userId && active.some((a: any) => a.userId === t.userId)) setTargetSite(t)
                        } else if (!pendingRange && active.length === 1) {
                            setTargetSite(active[0])
                        }
                    }
                } catch { /* 무시 */ }
                setChecking(false)

                // 안전달력에서 기간을 골라 넘어온 경우 — 달력의 분석 버튼은 '내 현장' 모드 전용이므로
                // owner도 대상=본인으로 자동 지정. 자동 실행은 Pro만 — 비Pro는 체험 프레이밍 없이
                // 샘플 결과가 실기간 라벨과 섞여 보이는 오인을 막기 위해 시작 화면에 멈춘다.
                if (pendingRange) {
                    try {
                        const rng = { from: parseISO(pendingRange.from), to: pendingRange.to ? parseISO(pendingRange.to) : parseISO(pendingRange.from) }
                        setRange(rng)
                        setTargetSite(selfSite)
                        if (p) analyze(rng, p, selfSite, "owner")
                    } catch { /* 무시 */ }
                }
                return
            }

            await loadTbmDates() // 달력 점 표시는 모두에게 (solo)
            setChecking(false)

            // 안전문서 달력에서 기간을 골라 넘어온 경우 → 재선택 없이 바로 분석 (Pro만 자동 실행 —
            // 비Pro는 체험 인트로를 유지하고 기간만 미리 채워, '체험해보기'에서 이어가게 한다)
            if (pendingRange) {
                try {
                    const rng = { from: parseISO(pendingRange.from), to: pendingRange.to ? parseISO(pendingRange.to) : parseISO(pendingRange.from) }
                    setRange(rng)
                    if (p) analyze(rng, p)
                } catch { /* 무시 */ }
            } else {
                // 기간 없이 들어왔다 = 주소 직접 입력이거나 새로고침. 여기서 기간을 다시 고르게 하면
                // 달력과 두 개의 입구가 생긴다 — 달력으로 돌려보낸다(마지막 기간은 dash_restore로 복원).
                router.replace("/dashboard")
            }
        })()
    }, [router])

    // 새로고침하면 결과가 날아가고 달력으로 되돌아간다 — 그 전에 한 번 물어본다.
    // (브라우저 기본 경고라 문구는 브라우저가 정한다. 앱 모달로는 이탈을 막을 수 없다.)
    useEffect(() => {
        if (!analyzing && step !== 2) return
        const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault() }
        window.addEventListener("beforeunload", onBeforeUnload)
        return () => window.removeEventListener("beforeunload", onBeforeUnload)
    }, [analyzing, step])

    // owner: 대상 현장이 바뀌면 그 현장의 회의록 작성일을 서버에서 로드 (건수 표시)
    useEffect(() => {
        if (orgKind !== "owner") return
        if (!targetSite) { setTbmDates([]); return }
        ;(async () => {
            try {
                const { data: sess } = await supabase.auth.getSession()
                const res = await fetch(`/api/org/site-stats?userId=${encodeURIComponent(targetSite.userId)}`, {
                    headers: { Authorization: `Bearer ${sess?.session?.access_token}` },
                })
                if (res.ok) {
                    const j = await res.json()
                    setTbmDates(Array.isArray(j.minuteDates) ? j.minuteDates : [])
                }
            } catch { /* 무시 */ }
        })()
    }, [orgKind, targetSite])

    const loadTbmDates = async () => {
        // 위험성평가는 TBM 회의록(minutes)만 분석 — 안전보건교육일지는 제외
        const { data: m } = await supabase.from("tbm_minutes").select("date").order("date", { ascending: false }).limit(300)
        const dates = new Set<string>()
        for (const r of (m as any[]) || []) if (r.date) dates.add(r.date)
        setTbmDates([...dates])
    }

    const countInRange = (): number => {
        if (!range?.from) return 0
        const from = startOfDay(range.from)
        const to = endOfDay(range.to ?? range.from)
        return tbmDates.filter((d) => isWithinInterval(parseISO(d), { start: from, end: to })).length
    }

    // 진행 표시가 "회의록 N건 모았어요"로 실제 건수를 말할 수 있게 개수도 함께 돌려준다
    const buildRangeContext = async (fromS: string, toS: string): Promise<{ text: string; count: number }> => {
        // 위험성평가는 TBM 회의록(minutes)만 분석 — 안전보건교육일지(tbm_logs) 제외
        const { data: minutes } = await supabase
            .from("tbm_minutes")
            .select("date, process_name, work_name, work_content, hazards, instructions, safety_phrase, ppe_check")
            .gte("date", fromS).lte("date", toS).order("date")
        const blocks: string[] = []
        for (const m of (minutes as any[]) || []) {
            const hz = Array.isArray(m.hazards) ? m.hazards : []
            const hzText = hz.map((h: any) => `- ${h?.factor ?? ""}${h?.level ? ` (위험도: ${h.level})` : ""}${h?.measure ? ` → 대책: ${h.measure}` : ""}`).filter((s: string) => s.trim() !== "-").join("\n")
            blocks.push(`=== TBM (${m.date}, 회의록) ===\n` + [
                m.process_name && `공정: ${m.process_name}`, m.work_name && `작업명: ${m.work_name}`,
                m.work_content && `작업내용: ${m.work_content}`, m.ppe_check && `보호구: ${m.ppe_check}`,
                hzText && `논의된 위험요인:\n${hzText}`, m.instructions && `지시사항: ${m.instructions}`,
            ].filter(Boolean).join("\n"))
        }
        let text = blocks.join("\n\n")
        if (text.length > 11000) text = text.slice(0, 11000)
        return { text, count: blocks.length }
    }

    // 같은 기간 안전보건교육일지(tbm_logs) 통계 — 미리보기 + 발송 여부 판단용 (RLS로 본인 데이터만)
    const loadEduStats = async (fromS: string, toS: string) => {
        const { data: rows } = await supabase.from("tbm_logs").select("id, date").gte("date", fromS).lte("date", toS)
        const logs = (rows as { id: string; date: string }[]) || []
        const sessions = logs.length
        const days = new Set(logs.map((l) => l.date)).size
        let headcount = 0
        if (sessions > 0) {
            const ids = logs.map((l) => l.id)
            const { count } = await supabase.from("tbm_participants").select("id", { count: "exact", head: true }).in("log_id", ids)
            headcount = count ?? 0
        }
        const avg = sessions ? (headcount / sessions).toFixed(1) : "0.0"
        setEduStats({ sessions, days, headcount, avg })
    }

    // targetArg·kindArg: 초기 마운트 직후 자동 분석은 state 반영 전이라 대상·역할을 인자로 받는다 (달력→내 현장)
    const analyze = async (rangeArg?: DateRange, proArg?: boolean, targetArg?: { userId: string; siteName: string } | null, kindArg?: "owner" | "member" | "solo") => {
        const r = rangeArg ?? range
        const isPro = proArg ?? pro
        const kind = kindArg ?? orgKind
        const target = targetArg !== undefined ? targetArg : targetSite
        const targetUserId = kind === "owner" ? target?.userId : undefined
        if (!r?.from) { setMsg({ type: "err", text: "기간을 선택해주세요." }); return }
        setMsg(null)
        const fromS = format(r.from, "yyyy-MM-dd")
        const toS = format(r.to ?? r.from, "yyyy-MM-dd")
        const label = formatRangeLabelKo(fromS, toS)

        // 진행 표시 단계 — 경로마다 실제로 일어나는 일이 달라서 목록도 다르다.
        // (owner는 회의록 수집을 서버가 AI 호출 안에서 하므로 클라가 관측할 수 있는 경계가 없다)
        // 단계는 클라이언트가 실제로 관측할 수 있는 경계에서만 나눈다(체크=진짜 끝났다는 뜻).
        // 다만 AI 호출은 한 번의 요청이라 안이 안 보인다 — 그 안에서 순서대로 일어나는 일을
        // 보조 문구로 흘려보낸다(체크는 안 붙는다. 끝났다고 말하지 않는다).
        const AI_STEP: ProgressStep = {
            key: "ai",
            label: "AI가 위험요인을 뽑는 중",
            doneLabel: "위험요인 정리 완료",
            subSteps: [
                "회의에서 오간 말을 읽는 중",
                "위험요인 후보를 추려내는 중",
                "비슷한 지적을 하나로 묶는 중",
                "위험 등급을 매기는 중",
                "감소대책을 정리하는 중",
                "거의 다 됐어요",
            ],
        }
        const EDU_STEP: ProgressStep = { key: "edu", label: "같은 기간 교육일지 집계 중", doneLabel: "교육일지 집계 완료" }
        const COMPOSE_STEP: ProgressStep = {
            key: "compose",
            label: "출력물 서식 만드는 중",
            doneLabel: "보고서 완성",
            subSteps: ["회의록 종합 서식 채우는 중", "교육일지 종합 서식 채우는 중"],
        }
        const steps: ProgressStep[] = !isPro
            ? [{ key: "collect", label: "예시 데이터를 준비하는 중", doneLabel: "예시 데이터 준비 완료" }, COMPOSE_STEP]
            : kind === "owner"
              ? [AI_STEP, EDU_STEP, COMPOSE_STEP]
              : [{ key: "collect", label: "기간 안 회의록을 모으는 중", doneLabel: "회의록 수집 완료" }, AI_STEP, EDU_STEP, COMPOSE_STEP]
        setPhaseSteps(steps)
        setPhase(steps[0].key)

        setAnalyzing(true)
        try {
            // 베이직: 체험(더미 결과). Pro: 실제 AI 분석
            if (!isPro) {
                await new Promise((r) => setTimeout(r, 1200))
                setItems(SAMPLE_ITEMS)
                setPeriodLabel(label)
                setSendMsg(null)
                setPhase("compose")
                await loadPreviews(fromS, toS, SAMPLE_ITEMS, targetUserId)
                setStep(2)
                return
            }

            const { data: sessionData } = await supabase.auth.getSession()
            const token = sessionData?.session?.access_token

            // 안전관리자: 대상 현장 지정 → 서버가 그 현장 회의록로 컨텍스트를 빌드 (클라 RLS로는 못 읽음)
            if (kind === "owner") {
                if (!target) { setMsg({ type: "err", text: "분석할 현장을 먼저 선택해주세요." }); return }
                const res = await fetch("/api/ai/risk-assessment", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ targetUserId: target.userId, from: fromS, to: toS, workName: `${label} 종합` }),
                })
                const json = await res.json()
                if (!res.ok) { setMsg({ type: "err", text: json.error || "분석 실패" }); return }
                setItems(json.items as RiskItem[])
                setPeriodLabel(label)
                setSendMsg(null)
                setPhase("edu")
                const sessions = Number(json.eduSessions) || 0
                setEduStats(sessions > 0 ? { sessions, days: 0, headcount: 0, avg: "-" } : null)
                setPhase("compose")
                await loadPreviews(fromS, toS, json.items as RiskItem[], targetUserId)
                setStep(2)
                return
            }

            const { text: content, count: collected } = await buildRangeContext(fromS, toS)
            if (!content.trim()) { setMsg({ type: "err", text: "선택한 기간에 작성된 TBM이 없습니다." }); return }
            // 수집이 실제로 끝났으므로 몇 건이었는지 그대로 적는다
            setPhaseSteps(steps.map((s) => (s.key === "collect" ? { ...s, doneLabel: `회의록 ${collected}건 모았어요` } : s)))
            setPhase("ai")
            const res = await fetch("/api/ai/risk-assessment", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ workName: `${label} 종합`, workContent: content }),
            })
            const json = await res.json()
            if (!res.ok) { setMsg({ type: "err", text: json.error || "분석 실패" }); return }
            setItems(json.items as RiskItem[])
            setPeriodLabel(label)
            setSendMsg(null)
            setPhase("edu")
            // 서로 독립인 로더 2개는 병렬로 (교육통계 ↔ 미리보기) — 직렬화하면 그만큼 느려진다.
            // 다만 표시는 교육 집계가 '실제로' 끝난 시점에 다음 단계로 넘긴다(가짜 경계 아님).
            await Promise.all([
                loadEduStats(fromS, toS).then(() => setPhase("compose")),
                loadPreviews(fromS, toS, json.items as RiskItem[], targetUserId),
            ])
            setStep(2)
        } catch {
            setMsg({ type: "err", text: "분석 중 오류가 발생했습니다." })
        } finally {
            setAnalyzing(false)
        }
    }

    // 회의록·교육 이메일 형식 미리보기 HTML 로드 (분석 후) — targetUserId는 analyze가 확정해 넘긴다
    const loadPreviews = async (fromS: string, toS: string, riskItems: RiskItem[], targetUserId?: string) => {
        setLoadingPreviews(true)
        setMinutesHtml(""); setEduHtml("")
        try {
            const { data: s } = await supabase.auth.getSession()
            const headers = { "Content-Type": "application/json", Authorization: `Bearer ${s?.session?.access_token}` }
            const [mRes, eRes] = await Promise.all([
                fetch("/api/reports/minutes/render", { method: "POST", headers, body: JSON.stringify({ from: fromS, to: toS, items: riskItems, targetUserId }) }),
                fetch("/api/reports/education/render", { method: "POST", headers, body: JSON.stringify({ from: fromS, to: toS, targetUserId }) }),
            ])
            const mj = await mRes.json().catch(() => ({}))
            const ej = await eRes.json().catch(() => ({}))
            setMinutesHtml(mRes.ok ? (mj.html || "") : "")
            setEduHtml(eRes.ok ? (ej.html || "") : "")
        } finally {
            setLoadingPreviews(false)
        }
    }

    const sendReport = async () => {
        // 서버가 내 이메일을 자동 포함하므로 body에는 추가 수신자만 담는다 (계약: emails, 최대 3)
        // 중복은 소문자 키로 걸러낸다 — 추가 칸에 내 이메일을 또 적으면 인원수가 부풀고
        // 상한 슬롯만 잡아먹는다 (서버도 같은 규칙으로 한 번 더 거른다)
        const seenEmails = new Set<string>(myEmail ? [myEmail.toLowerCase()] : [])
        const emails = reportEmail.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).filter((e) => {
            const k = e.toLowerCase()
            if (seenEmails.has(k)) return false
            seenEmails.add(k)
            return true
        })
        if (!myEmail && emails.length === 0) { setSendMsg({ type: "err", text: "받는 사람 이메일을 입력해주세요." }); return }
        if (emails.length > 3) { setSendMsg({ type: "err", text: "추가 수신자는 최대 3명까지 보낼 수 있어요." }); return }
        const total = emails.length + (myEmail ? 1 : 0)
        setSending(true); setSendMsg(null)
        try {
            // 베이직 체험: 실제 발송하지 않음
            if (!pro) {
                await new Promise((r) => setTimeout(r, 800))
                setSendMsg({ type: "ok", text: `체험 모드 — Pro에서는 ${total}명에게 실제로 발송돼요.` })
                return
            }
            const { data: sessionData } = await supabase.auth.getSession()
            const headers = { "Content-Type": "application/json", Authorization: `Bearer ${sessionData?.session?.access_token}` }
            const fromS = range?.from ? format(range.from, "yyyy-MM-dd") : undefined
            const toS = range?.from ? format(range.to ?? range.from, "yyyy-MM-dd") : undefined
            const hasEdu = !!(eduStats && eduStats.sessions > 0) && !!fromS
            const targetUserId = orgKind === "owner" ? targetSite?.userId : undefined
            const sendCompany = orgKind === "owner" ? targetSite?.siteName || companyName : companyName

            // 메일 2개 동시 발송: ① 회의록 분석·위험요인 분석  ② 안전보건교육일지 종합(교육일지가 있을 때만)
            const [r1, r2] = await Promise.all([
                fetch("/api/reports/risk-assessment/send", {
                    method: "POST", headers,
                    body: JSON.stringify({ items, period: `${periodLabel} 종합`, company: sendCompany, emails, from: fromS, to: toS, targetUserId }),
                }),
                hasEdu
                    ? fetch("/api/reports/education/send", {
                        method: "POST", headers,
                        body: JSON.stringify({ company: sendCompany, emails, from: fromS, to: toS, targetUserId }),
                    })
                    : Promise.resolve(null),
            ])

            const j1 = await r1.json().catch(() => ({}))
            const ok1 = r1.ok
            let ok2 = false, eduSent = false
            if (r2) { const j2 = await r2.json().catch(() => ({})); ok2 = r2.ok; eduSent = ok2 && (j2.sent ?? 0) > 0 }

            if (!ok1 && !eduSent) { setSendMsg({ type: "err", text: j1.error || "발송 실패" }); return }
            const parts: string[] = []
            if (ok1) parts.push("회의록 분석 보고서")
            if (eduSent) parts.push("안전보건교육일지 종합")
            setSendMsg({
                type: "ok",
                text: `${total}명에게 보냈어요 · 메일 ${parts.length}통${hasEdu && !eduSent ? " (교육일지 메일은 실패)" : ""}`,
            })
        } finally { setSending(false) }
    }

    // 이미 렌더된 이메일 HTML을 새 탭 전체 화면으로 — 팝업 차단을 피하려면 반드시 클릭 핸들러 안에서 연다.
    // Blob URL은 새 탭이 로드되기 전에 revoke하면 빈 화면이 되므로 넉넉히 늦춰 누수만 막는다.
    const openPreviewTab = (html: string) => {
        // charset을 명시하지 않으면 브라우저가 인코딩을 추측해 한글이 전부 깨진다(실측).
        // 보고서 HTML은 <meta charset>이 없는 조각이라 MIME 타입이 유일한 단서다.
        const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }))
        window.open(url, "_blank", "noopener")
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }

    // 기간을 다시 고르는 곳은 달력 하나뿐이다 — 지금 기간을 들고 그리로 돌아간다
    const backToCalendar = () => {
        try {
            if (range?.from) {
                sessionStorage.setItem("dash_restore", JSON.stringify({
                    from: format(range.from, "yyyy-MM-dd"),
                    to: format(range.to ?? range.from, "yyyy-MM-dd"),
                }))
            }
        } catch { /* 무시 */ }
        router.push("/dashboard")
    }

    if (checking) return <div className="min-h-screen flex items-center justify-center bg-cur-canvas"><Loader2 className="w-10 h-10 text-cur-primary animate-spin" /></div>

    // 게이트: 보고서 설정 미완료 — 설정을 끝내야 진행할 수 있다
    if (setupNeeded) {
        return (
            <div className="min-h-screen bg-cur-canvas font-sans">
                <div className="max-w-lg mx-auto px-4 pt-4">
                    <TBMHeader title="분석 보고서" backHref="/" />
                </div>
                <main className="max-w-lg mx-auto px-5 py-10">
                    <div className="bg-cur-card rounded-[12px] border border-cur-hairline p-5 py-8 text-center space-y-3">
                        <p className="text-[16px] font-bold text-cur-ink">
                            {setupPendingOnly ? "받는 사람의 승인을 기다리는 중이에요" : "출력/발송 설정을 마치고 와주세요"}
                        </p>
                        <p className="text-[13px] text-cur-muted leading-relaxed">
                            {setupPendingOnly ? (
                                <>받는 사람이 확인 메일의 승인 링크를 누르면 열려요.</>
                            ) : (
                                <>문서 출력 형식과 보고서 받는 사람을 먼저 설정해야<br />분석 보고서를 만들 수 있어요. 1분이면 끝나요.</>
                            )}
                        </p>
                        <Button
                            onClick={() => router.push("/org/reports")}
                            className="w-full h-12 rounded-[8px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary font-bold focus-visible:ring-2 focus-visible:ring-cur-primary"
                        >
                            {setupPendingOnly ? "승인 상태 확인·재발송" : "출력/발송 설정 하러 가기"}
                        </Button>
                    </div>
                </main>
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-cur-canvas pb-24 font-sans text-cur-ink">
            <div className="max-w-lg mx-auto min-h-screen bg-cur-card shadow-sm border-x border-cur-hairline overflow-hidden flex flex-col">
                <div className="p-4 border-b border-cur-hairline bg-cur-card sticky top-0 z-10 print:hidden">
                    <TBMHeader
                        title="분석 보고서"
                        backHref="/dashboard"
                        pageBadge={pro ? undefined : "체험"}
                    />
                </div>

                <div className="p-5 space-y-4 flex-1 bg-cur-canvas-soft">
                    {msg && <div className={`text-[13px] rounded-[8px] p-3 ${msg.type === "ok" ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-error/10 text-cur-error"}`}>{msg.text}</div>}

                    {/* 체험 인트로: 비Pro 솔로 — 카피 유지, 카드만 idiom */}
                    {!analyzing && step === 0 && (
                        <div className="space-y-5">
                            <div className="text-center space-y-3 pt-6">
                                <h2 className="text-[22px] font-bold text-cur-ink">TBM 종합 분석 보고서</h2>
                                <p className="text-cur-muted text-[14px] leading-relaxed">
                                    기간만 고르면 TBM을 분석해<br />
                                    위험요인 자료를 만들어요.
                                </p>
                            </div>

                            <div className="bg-cur-card rounded-[12px] border border-cur-hairline divide-y divide-cur-hairline">
                                {[
                                    { t: "기간만 선택", d: "이번 주·이번 달·지난 달 버튼으로 끝" },
                                    { t: "AI가 종합 분석", d: "중복 위험은 통합, 반복 위험은 따로 표시" },
                                    { t: "엑셀·PDF·메일 발송", d: "사장·안전보건 담당자에게 바로 제출" },
                                ].map((f, i) => (
                                    <div key={i} className="flex items-start gap-3 p-4">
                                        <div className="w-6 h-6 rounded-full bg-cur-primary/15 text-cur-primary text-[12px] font-bold flex items-center justify-center shrink-0">{i + 1}</div>
                                        <div>
                                            <div className="font-semibold text-[14px] text-cur-ink">{f.t}</div>
                                            <div className="text-[13px] text-cur-muted-soft">{f.d}</div>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            <div className="space-y-2">
                                <Button onClick={() => setStep(1)} className="w-full h-12 rounded-[8px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary font-bold focus-visible:ring-2 focus-visible:ring-cur-primary">
                                    체험해보기
                                </Button>
                                <p className="text-[12px] text-cur-muted-soft text-center">월 3,900원 · 첫 달 무료 · 분석 보고서 + 월간 보고서</p>
                            </div>
                        </div>
                    )}

                    {/* 분석 중 — 단계가 실제로 끝날 때마다 체크가 켜진다 */}
                    {analyzing && phaseSteps.length > 0 && (
                        <AnalyzeProgress
                            steps={phaseSteps}
                            activeKey={phase}
                            title="TBM 내용을 분석하고 있어요"
                            subtitle="보통 10~20초 걸려요. 화면을 닫지 말아주세요."
                        />
                    )}

                    {/* 시작: 직접 진입·통계 경로 — 현장(owner)·기간·시작 버튼을 카드 하나로 */}
                    {/* 기간 선택 화면은 없앴다(Chris) — 이 페이지의 입구는 출력(달력)에서 기간을 잡고
                        들어오는 것 하나뿐이다. 직접 들어오거나 새로고침하면 아래 효과가 달력으로 돌려보낸다. */}
                    {!analyzing && step === 1 && (
                        <div className="py-24 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-cur-muted" /></div>
                    )}


                    {!analyzing && step === 2 && (
                        <div className="space-y-4">
                            <div className="bg-cur-card rounded-[12px] border border-cur-hairline p-5 flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <p className="text-[14px] font-bold text-cur-ink truncate">{periodLabel}</p>
                                    <div className="flex items-center gap-1.5 mt-1 text-[12px] text-cur-muted">
                                        <span className="shrink-0">회의록 {countInRange()}건</span>
                                        {orgKind === "owner" && targetSite && (
                                            <span className="px-2 py-0.5 rounded-full bg-cur-elevated border border-cur-hairline text-[11px] font-medium truncate">{targetSite.siteName}</span>
                                        )}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={backToCalendar}
                                    className="h-10 px-3 rounded-[8px] border border-cur-hairline bg-cur-elevated text-[13px] font-semibold text-cur-ink hover:border-cur-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary shrink-0"
                                >
                                    기간 다시 선택
                                </button>
                            </div>

                            {/* 결과 미리보기 — 인라인 렌더 대신 새 탭 전체 화면 (보고서 설정 '예시 보기' 패턴과 통일) */}
                            <div className="space-y-2">
                                <p className="text-[12px] text-cur-muted-soft">실제 발송되는 이메일과 같은 모습입니다.</p>
                                {loadingPreviews ? (
                                    <div className="flex items-center justify-center py-10 border border-cur-hairline rounded-[12px] bg-cur-card">
                                        <Loader2 className="w-6 h-6 animate-spin text-cur-muted" />
                                    </div>
                                ) : minutesHtml || eduHtml ? (
                                    <div className="rounded-[12px] border border-cur-hairline bg-cur-card divide-y divide-cur-hairline overflow-hidden">
                                        {([["TBM 회의록 종합", minutesHtml], ["안전보건교육일지 종합", eduHtml]] as const)
                                            .filter(([, html]) => !!html)
                                            .map(([label, html]) => (
                                                <button
                                                    key={label}
                                                    type="button"
                                                    onClick={() => openPreviewTab(html)}
                                                    className="w-full flex items-center gap-2 px-4 py-3 hover:bg-cur-elevated/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cur-primary"
                                                >
                                                    <span className="text-[14px] text-cur-ink flex-1 min-w-0 truncate text-left">{label}</span>
                                                    <span className="text-[12px] text-cur-primary font-semibold shrink-0">새 탭에서 보기</span>
                                                    <ExternalLink className="w-3.5 h-3.5 text-cur-muted-soft shrink-0" />
                                                </button>
                                            ))}
                                    </div>
                                ) : (
                                    <div className="text-[12px] text-cur-muted-soft text-center rounded-[8px] border border-dashed border-cur-hairline-strong py-4">
                                        이 기간에 미리볼 보고서가 없습니다.
                                    </div>
                                )}
                            </div>

                            {/* 이메일로 보고서 전송 (회의록 종합 + 안전보건교육일지 종합, 메일 2개)
                                내 이메일(인증 real_email·카카오)이 있으면 서버가 자동 포함 — 입력은 추가 수신자만 */}
                            <div className="bg-cur-card rounded-[12px] border border-cur-hairline p-5 space-y-2 print:hidden">
                                <h3 className="text-[14px] font-bold text-cur-ink">이메일로 보내기</h3>
                                {/* '자동으로 보내드려요'가 이미 보낸 것처럼 읽혀서 버튼을 눌러야 하는지 헷갈렸다(Chris).
                                    받는 사람을 목록으로 보여주고, 버튼이 '누구에게 보낼지'를 그대로 말한다. */}
                                {myEmail ? (
                                    <div className="rounded-[8px] border border-cur-hairline bg-cur-elevated px-3 py-2.5 min-w-0">
                                        <p className="text-[11px] font-semibold text-cur-muted mb-0.5">받는 사람</p>
                                        {/* 첫 줄이 내 주소인 걸 명시 — 주소만 있으면 "이건 누구 메일이지?"가 된다(Chris) */}
                                        <p className="flex items-center gap-1.5 min-w-0">
                                            <span className="text-[13px] font-semibold text-cur-ink truncate">{myEmail}</span>
                                            <span className="shrink-0 text-[10px] font-semibold text-cur-primary bg-cur-primary/10 rounded-[4px] px-1.5 py-0.5">내 이메일</span>
                                        </p>
                                        {extraEmails.map((e) => (
                                            <p key={e} className="text-[13px] font-semibold text-cur-ink truncate">{e}</p>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="text-[12px] text-cur-muted-soft">
                                        이메일을 인증하면 내 주소로도 자동 수신돼요.
                                    </p>
                                )}
                                <div className="flex gap-2">
                                    <Input
                                        type="email"
                                        value={reportEmail}
                                        onChange={(e) => setReportEmail(e.target.value)}
                                        placeholder={myEmail ? "다른 받는 분 이메일 (쉼표로 최대 3명)" : "이메일 (쉼표로 최대 3명)"}
                                        className="h-11 rounded-[8px] focus-visible:ring-2 focus-visible:ring-cur-primary"
                                    />
                                    <Button onClick={sendReport} disabled={sending || recipientCount === 0} className="h-11 px-4 rounded-[8px] bg-cur-primary hover:bg-cur-primary-active text-cur-on-primary font-bold shrink-0 focus-visible:ring-2 focus-visible:ring-cur-primary disabled:opacity-40">
                                        {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : `${recipientCount}명에게 보내기`}
                                    </Button>
                                </div>
                                {sendMsg && <p className={`text-[13px] ${sendMsg.type === "ok" ? "text-cur-primary" : "text-cur-error"}`}>{sendMsg.text}</p>}
                            </div>
                        </div>
                    )}
                </div>
            </div>

        </div>
    )
}
