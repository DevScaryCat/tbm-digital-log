"use client"

// 현장 계정 관리 (감독자 전용) — 계정 발급/초대/편입/해제.
// 좌석 선구매는 없앴다 — 계정을 만들면 그 자리에서 일할 청구되고, 다음 주기부터 계정 수만큼 청구된다.
// prompt/confirm 대신 전용 모달을 쓴다 — 인앱 브라우저에서 prompt가 막히는 케이스가 있었고, 안내 문구를 담을 자리도 필요하다.
import { useEffect, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { supabase } from "@/lib/supabaseClient"
import { TBMHeader } from "@/components/TBMHeader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Loader2, Copy, KeyRound, UserMinus, Plus, Minus, Link2, UserPlus2, CheckCircle2, ChevronRight, Pencil } from "lucide-react"
import { useOrgContext } from "@/lib/useOrgContext"
import { suggestIdStems, suggestInitialPassword, sanitizeStem, STEM_RE } from "@/lib/romanize"
import { fetchSubscription, isWhitelist, type SubscriptionRow } from "@/lib/useSubscription"
import type { SeatBlockReason } from "@/lib/billing"

const inputCls =
    "h-12 rounded-[8px] bg-cur-elevated border-cur-hairline text-[15px] font-medium text-cur-ink placeholder:text-cur-muted-soft focus-visible:ring-1 focus-visible:ring-cur-primary"

// 모달 공통 스타일 — 페이지 Dialog 관례 (bg-cur-card·hairline·12px 라운드)
// 앱 공통 Dialog 관례(회의록·교육일지 페이지와 동일): 20px 라운드 + 부양 그림자
const dialogCls = "bg-cur-card border-cur-hairline rounded-[20px] shadow-[0_8px_32px_rgba(0,0,0,0.1)] p-5 gap-4 w-[calc(100%-2rem)] sm:max-w-md"
const dialogTitleCls = "text-[16px] font-bold text-cur-ink"
const iconBtnCls =
    "h-9 w-9 rounded-lg flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"

interface MemberRow {
    userId: string
    siteName: string
    managerName: string
    /** 실제 로그인 아이디 (발급 계정은 @tbm.com 앞부분) */
    loginId?: string
    status: "active" | "detached"
    joinedAt: string
}

export default function OrgMembersPage() {
    const router = useRouter()
    const { ctx, loading: ctxLoading } = useOrgContext()
    const [members, setMembers] = useState<MemberRow[]>([])
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState<string | null>(null)
    const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)

    // 일괄 발급 폼 — 시드 + 개수 + 공용 초기 비밀번호. 현장명·새 비밀번호는
    // 현장담당자가 첫 로그인 온보딩에서 직접 정한다.
    // 추가 마법사: count(몇 개) → method(방식 선택) → direct(직접 발급) | link(초대 링크)
    const [addStep, setAddStep] = useState<null | "count" | "names" | "method" | "direct" | "link">(null)
    // 현장명은 감독자가 발급 단계에서 정한다(Chris) — 개수만큼 입력받아 직접 발급·링크 양쪽에 싣는다
    const [siteNames, setSiteNames] = useState<string[]>([""])
    const [stem, setStem] = useState("")
    const [count, setCount] = useState(1)
    const [initPw, setInitPw] = useState("")
    const [formErr, setFormErr] = useState<string | null>(null)
    // 402(결제 자격·결제수단) 실패인가 — 이때만 오류 문구 아래에 /account 링크를 붙인다.
    // 문구만 주고 갈 곳을 안 주면 감독자가 "그래서 어디서 등록하나요"에서 멈춘다.
    const [formErrPay, setFormErrPay] = useState(false)
    const [createdIds, setCreatedIds] = useState<string[] | null>(null)
    // 위저드 모달 내부 알림 — 페이지 배너는 모달 뒤에 가려져 보이지 않는다
    const [addMsg, setAddMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
    // 청구 미리보기용 구독 정보 (체험 여부·다음 결제일)
    const [sub, setSub] = useState<SubscriptionRow | null>(null)
    // 청구 주체 — 'google_play'·'app_store'(스토어 소유주)는 본인 몫을 스토어가 받고
    // 등록 카드로는 좌석 몫만 청구된다(lib/billing.ts resolveBillableAmount). 미리보기 분기용.
    const [subSource, setSubSource] = useState<string | null>(null)
    // 지금 즉시 승인될 금액 — 화면이 자체 계산하지 않고 서버(/api/org/seat-preview)에 묻는다.
    // 실제 청구(lib/billing.ts resolveSeatCharge)와 같은 함수로 계산된 값이라 예고와 승인이 어긋나지 않는다.
    const [immediate, setImmediate] = useState<{ amount: number; periodBase: number } | null>(null)
    const [immediateLoading, setImmediateLoading] = useState(false)
    // 발급 자격 — 화면이 서버 규칙을 베껴 계산하지 않고 /api/org/seat-preview에 묻는다.
    // (종전엔 card_info 유무 + 체험/스토어 조합을 화면에서 다시 적었는데, 서버는 billing_key로
    //  판정하고 주기 만료 거절도 따로 있어 언제든 조용히 갈라질 수 있는 세 번째 사본이었다.)
    // null = 아직 모른다(조회 중·실패) → 막지 않는다.
    // reason은 서버가 준 사유 코드다 — 화면은 한국어 문장을 되짚지 않고 이 코드로만 분기한다
    // (lib/billing.ts SeatBlockReason 주석: 문장 되짚기가 legacy 요금제를 결제 화면으로 보냈다).
    const [seatGate, setSeatGate] = useState<{
        chargeable: boolean
        error?: string
        plan?: string | null
        reason?: SeatBlockReason
    } | null>(null)
    // 편입 폼
    const [attachId, setAttachId] = useState("")
    // 초대 링크
    const [inviteUrl, setInviteUrl] = useState<string | null>(null)

    // 행 액션 모달 3종 — 정보 수정 / 비밀번호 재설정 / 연결 해제
    const [editTarget, setEditTarget] = useState<MemberRow | null>(null)
    const [editSite, setEditSite] = useState("")
    const [editManager, setEditManager] = useState("")
    const [pwTarget, setPwTarget] = useState<MemberRow | null>(null)
    const [pwValue, setPwValue] = useState("")
    const [pwConfirm, setPwConfirm] = useState("")
    const [pwDone, setPwDone] = useState(false)
    const [detachTarget, setDetachTarget] = useState<MemberRow | null>(null)
    const [modalErr, setModalErr] = useState<string | null>(null)

    const authHeaders = async () => {
        const { data } = await supabase.auth.getSession()
        return { "Content-Type": "application/json", Authorization: `Bearer ${data?.session?.access_token}` }
    }

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch("/api/org/members", { headers: await authHeaders() })
            if (res.ok) {
                const j = await res.json()
                setMembers(j.members ?? [])
            }
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        if (ctxLoading) return
        // 아직 회사가 없는 단독 계정도 들어와야 한다 — 첫 현장을 만드는 화면이 여기다.
        if (!ctx || ctx.kind === "member") { router.replace("/"); return }
        load()
    }, [ctx, ctxLoading, router, load])

    // 첫 진입 온보딩("현장 계정 만들기")에서 넘어온 경우(?new=1) 발급 모달을 바로 연다.
    // useSearchParams는 정적 렌더에서 Suspense를 요구해 window로 직접 읽는다.
    // count·method를 실어주던 /org/setup은 삭제됐지만(2026-08-09) 북마크·안내문서의 구 링크가
    // 올 수 있어 파라미터는 계속 받는다. 단 어떤 조합이어도 현장명(names) 단계는 건너뛰지
    // 않는다 — method=direct로 direct 단계에 직행하면 siteNames가 빈 채 발급돼 이름 없는
    // 현장이 만들어지던 구멍의 봉합. 21개 이상은 조용히 1로 리셋하지 않고 20으로 절사+안내.
    useEffect(() => {
        if (typeof window === "undefined") return
        const sp = new URLSearchParams(window.location.search)
        if (sp.get("new") !== "1") return
        const raw = Math.floor(Number(sp.get("count")))
        if (Number.isFinite(raw) && raw >= 1) {
            const c = Math.min(raw, 20)
            setCount(c)
            if (raw > 20) setAddMsg({ type: "ok", text: `현장 계정은 한 번에 20개까지 만들 수 있어요. ${raw}개 대신 20개로 맞춰뒀어요.` })
            if (sp.get("method")) {
                // 방식까지 정해 들어온 구 딥링크 — 개수 단계만 건너뛰고 현장명부터 받는다
                setSiteNames(Array.from({ length: c }, () => ""))
                setAddStep("names")
                return
            }
        }
        setAddStep("count")
    }, [])

    // 아이디 시드 추천 — 회사명 로마자 (예: '하이' → hai01, hai02…)
    useEffect(() => {
        ;(async () => {
            const { data } = await supabase.auth.getUser()
            const name = String(data?.user?.user_metadata?.company_name ?? "")
            // 추천 칩은 없앴다(혼란) — 회사명 로마자를 입력칸 기본값으로만 깔아준다
            const sugg = suggestIdStems(name)
            setStem((cur) => cur || sugg[0] || "")
            setInitPw((cur) => cur || suggestInitialPassword())
            setSub(await fetchSubscription())
            // source는 공용 SubscriptionRow에 없는 컬럼이라 여기서만 따로 읽는다 (본인 행 RLS)
            const { data: srcRow } = await supabase.from("subscriptions").select("source").maybeSingle()
            setSubSource(((srcRow as { source?: string | null } | null)?.source as string | null) ?? null)
            // 발급 자격은 서버가 판정한다 — count=1로 물어도 거절 사유(체험·결제수단·주기)는 같다.
            // 실패하면 seatGate를 null로 두어 막지 않는다(조회 실패로 유료 감독자의 발급이 잠기는
            // 쪽이 더 나쁘다 — 그 경우엔 종전대로 서버 402가 마지막 방어선이다).
            try {
                const res = await fetch("/api/org/seat-preview?count=1", { headers: await authHeaders() })
                const j = await res.json()
                if (res.ok) setSeatGate({ chargeable: !!j.chargeable, error: j.error, plan: j.plan ?? null, reason: j.reason })
            } catch { /* 무시 — 막지 않는다 */ }
        })()
    }, [])

    // 확인 단계(direct)에 들어올 때마다 '지금 결제될 금액'을 서버에 묻는다.
    // 개수(count)는 이 단계 전에 확정되므로 한 번만 부르면 되고, 뒤로 갔다 오면 다시 부른다.
    useEffect(() => {
        if (addStep !== "direct") { setImmediate(null); return }
        let alive = true
        ;(async () => {
            setImmediateLoading(true)
            try {
                const res = await fetch(`/api/org/seat-preview?count=${count}`, { headers: await authHeaders() })
                const j = await res.json()
                if (!alive) return
                // 조회 실패·청구 불가면 null로 두고 종전의 서술형 문구로 되돌아간다(거짓 숫자보다 낫다)
                setImmediate(res.ok && j.chargeable ? { amount: Number(j.amount) || 0, periodBase: Number(j.periodBase) || 0 } : null)
            } catch {
                if (alive) setImmediate(null)
            } finally {
                if (alive) setImmediateLoading(false)
            }
        })()
        return () => { alive = false }
    }, [addStep, count])

    const activeCount = members.filter((m) => m.status === "active").length

    // ── 청구 미리보기 재료 (/org/setup 삭제로 이식) — 서버 청구 규칙과 같은 식이어야 한다.
    // lib/billing.ts: resolveBillableAmount = (본인 1 + 활성 현장) × 3,900. 스토어(구글·애플)
    // 소유주는 본인 몫을 스토어가 받으므로 카드 청구는 활성 현장 × 3,900만. 체험(trialing) 중에는
    // chargeProratedAccount가 일할 청구를 하지 않고, 체험이 끝나는 날 cron이 늘어난 계정 수로 청구한다.
    const SEAT_PRICE = 3900
    const isTrialing = sub?.status === "trialing"
    const storeOwner = subSource === "google_play" || subSource === "app_store"
    const nextChargeDate = sub?.current_period_end ? new Date(sub.current_period_end).toLocaleDateString("ko-KR") : null
    const monthlyAfter = ((storeOwner ? 0 : 1) + activeCount + count) * SEAT_PRICE

    // 청구 자격 선검사 — 위저드에 들어가기 **전에**. 종전에는 현장명·아이디·비밀번호를 다 입력하고
    // 'N개 만들기'를 누른 뒤에야 서버가 402 한 문장으로 전부 롤백했다(갈 곳 링크도 없었다).
    // 판정과 문구는 서버(resolveSeatCharge)의 것을 그대로 쓴다 — 결제수단 없음뿐 아니라
    // 주기 만료(past_due) 거절도 같이 걸린다.
    // seatGate가 null(로딩 중·조회 실패)이면 막지 않는다 — 조회 실패로 유료 감독자의 발급이
    // 잠기는 쪽이 더 나쁘다(바로 아래 grandfather 분기와 같은 규율).
    const seatBlocked = !!seatGate && !seatGate.chargeable
    // 영구 무료(grandfather)는 결제 자격이 아니라 정책으로 막힌다 — 결제 유도를 붙이면
    // 결제 UI를 걷어낸 계정에게 갈 곳 없는 안내가 된다(커밋 1b01f52와 같은 규율).
    // 구독 조회(sub)가 실패해도 서버가 돌려준 plan으로 다시 확인한다 — 둘 중 하나만 알아도
    // 결제 유도가 새어 나가면 안 되는 쪽이다.
    const whitelisted = isWhitelist(sub) || seatGate?.plan === "grandfather"
    const seatReason = seatGate?.reason

    // 차단 범위를 사유로 나눈다 — 위저드는 세 가지 행동(직접 발급 / 초대 링크 / 편입)을 담는데
    // 즉시 청구를 하는 건 직접 발급 하나뿐이다. 초대·편입이 만드는 좌석은 가입·수락 시점에
    // 생기고 chargeProratedAccount를 부르지 않는다(app/api/signup, app/api/org/attach).
    //   plan·subscription = **자격** 문제 → 서버 초대 라우트도 같은 판정(subscriptionAllows +
    //     isBillablePlan)으로 막으므로 위저드를 통째로 닫는다. 열어두면 초대 버튼이 402로 죽는다.
    //   method·period     = **즉시 청구 실행** 조건 → 초대·편입은 지금 돈을 받지 않으므로 열어둔다.
    //     (직접 발급만 아래 method 단계에서 막는다)
    // ⚠️ 한 가지 어긋남을 남긴 채로 둔다: app/api/org/invites/route.ts 46-55행의 게이트는 이 화면과
    //    **다른 규칙**이다 — 거기선 store source + billing_key 없음만 402를 내고 current_period_end는
    //    보지 않는다. 즉 웹 카드 감독자의 '결제수단 없음'은 초대에서 통과한다(청구가 없으니 유령
    //    좌석도 안 생긴다). 근본 해결은 invites도 resolveSeatCharge dry run으로 통일하되 "즉시 청구
    //    없음"을 인자로 구분하는 것이고, 그건 별건이다(이번 라운드 범위 밖 — notFixed에 기록).
    const blockAll = whitelisted || (seatBlocked && (seatReason === "plan" || seatReason === "subscription"))
    // 사유 코드를 모르는 채 chargeable=false만 온 경우(구 응답·예상 못한 값)는 안전하게 전부 막는다
    const blockUnknown = seatBlocked && !seatReason
    // 스토어 소유주의 method(카드 없음)는 예외로 위저드까지 닫는다 — invites 라우트(46-55행)가
    // 막는 유일한 케이스가 정확히 'store source + billing_key 없음'이라, 열어두면 초대·편입 버튼이
    // 100% 402로 죽는다. 위 ⚠️의 "웹 카드 감독자는 통과"와 방향이 반대인 쪽이다(검수 2026-08-10).
    const blockWizard = blockAll || blockUnknown || (storeOwner && seatReason === "method")
    // 직접 발급만 막히는 경우 — 위저드는 열리고 method 단계에서 이 분기만 잠긴다
    const blockDirect = seatBlocked || whitelisted

    // 결제 화면으로 보내도 되는 사유인가. plan(요금제 부적격)은 /account에 바꿀 수단이 없어
    // 링크를 붙이는 순간 '안내받은 막다른 길'이 된다 — grandfather도 같다(결제 UI 자체가 없다).
    const payLinkOk = !whitelisted && seatReason !== "plan"

    // 발급을 막을 때 보여줄 패널 — 목록 마지막 행과 위저드 모달 본문이 **같은 것**을 쓴다.
    // 버튼만 막으면 ?new=1 딥링크(홈 온보딩 카드가 미는 바로 그 URL)가 게이트를 통째로 지나쳐
    // 위저드가 열리고, 다 입력한 끝에 402 벽을 다시 만난다(검수 2026-08-10).
    const blockedPanel = whitelisted ? (
        <p className="text-[13px] text-cur-muted leading-relaxed">
            영구 무료 계정은 현장 계정을 추가할 수 없어요. 정책 변경 전까지 무료로 사용 가능합니다.
        </p>
    ) : (
        <>
            {/* 사유 문구는 서버가 준 것 그대로 — 화면이 따로 지어내면 실제 거절 이유와 갈라진다 */}
            <p className="text-[13px] text-cur-body leading-relaxed">{seatGate?.error || "지금은 현장 계정을 만들 수 없어요."}</p>
            {/* 이 한 줄은 스토어(구글·애플) 구독자 전용 설명이다 — 본인 몫은 스토어가 받고 좌석만
                카드로 청구되는 구조를 설명한다. 웹 카드 감독자·카드 없는 체험자·요금제 부적격자에게
                띄우면 서버가 준 진짜 사유 바로 밑에 틀린 두 번째 문장이 붙는다(검수 2026-08-10 지적 4). */}
            {storeOwner && seatReason === "method" && (
                <p className="text-[12px] text-cur-muted leading-relaxed">현장 계정 몫(계정당 월 3,900원)은 등록한 카드로 청구돼요.</p>
            )}
            {payLinkOk ? (
                <Link
                    href="/account"
                    className="inline-flex items-center gap-1 text-[13px] font-bold text-cur-primary rounded-[6px] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                >
                    구독 및 결제로 가기
                    <ChevronRight className="w-3.5 h-3.5" />
                </Link>
            ) : (
                /* 갈 곳을 약속하지 않는다 — 요금제 전환은 화면에 수단이 없으므로 사실과 연락처만 준다 */
                <p className="text-[12px] text-cur-muted leading-relaxed">
                    요금제 전환이 필요해요. 고객센터 <b className="text-cur-body font-semibold">032-229-1556</b> 또는{" "}
                    <a href="mailto:support@bitflip.team" className="text-cur-primary font-semibold hover:underline">support@bitflip.team</a>
                    로 문의해주세요.
                </p>
            )}
        </>
    )

    // 한글·띄어쓰기를 입력해도 아이디 규칙으로 자동 변환 ("하이 물류" → hai_mulryu)
    const effStem = sanitizeStem(stem)

    // 추가 위저드는 단계 상태에서 열림을 유도한다 — ?new=1 딥링크도 같은 경로로 모달이 열린다
    const addOpen = addStep !== null || createdIds !== null
    const closeAdd = () => { setAddStep(null); setCreatedIds(null); setFormErr(null); setFormErrPay(false); setAddMsg(null) }

    const createBulk = async () => {
        setFormErr(null)
        setFormErrPay(false)
        setAddMsg(null)
        if (!STEM_RE.test(effStem)) { setFormErr("아이디로 만들 수 있는 글자가 부족해요. 영문·숫자·한글 2자 이상 입력해주세요."); return }
        if (initPw.length < 8) { setFormErr("초기 비밀번호는 8자 이상이어야 해요."); return }
        setBusy("create")
        try {
            const res = await fetch("/api/org/members/bulk", {
                method: "POST",
                headers: await authHeaders(),
                body: JSON.stringify({ stem: effStem, count, password: initPw, siteNames: siteNames.map((n) => n.trim()) }),
            })
            const j = await res.json()
            // 402는 '결제 자격·결제수단' 실패다 — 문구만 주면 갈 곳이 없으니 /account 링크를 함께 띄운다
            if (!res.ok) { setFormErr(j.error || "발급 실패"); setFormErrPay(res.status === 402); return }
            setCreatedIds(j.created ?? [])
            await load()
        } finally {
            setBusy(null)
        }
    }

    const copyCreated = async () => {
        if (!createdIds) return
        const text = [
            "[안톡] 현장 계정 안내",
            ...createdIds.map((id, i) => `아이디: ${id}${siteNames[i]?.trim() ? ` (${siteNames[i].trim()})` : ""}`),
            `초기 비밀번호: ${initPw}`,
            "",
            // 랜딩의 [시작하기]는 카카오로 빠진다 — 아이디 폼이 먼저 뜨는 딥링크를 그대로 준다
            "접속 주소: https://www.safetalk.kr/login?m=id",
            "카카오 버튼이 아니라, 아래 아이디 칸에 위 아이디와 비밀번호를 입력하세요.",
            "로그인하면 첫 화면에서 새 비밀번호만 정하면 바로 시작됩니다.",
        ].join("\n")
        try { await navigator.clipboard.writeText(text); setAddMsg({ type: "ok", text: "계정 목록을 복사했어요. 현장담당자들에게 전달하세요." }) } catch { /* 무시 */ }
    }

    const createInviteLink = async () => {
        setAddMsg(null)
        setFormErrPay(false)
        setBusy("link")
        try {
            const res = await fetch("/api/org/invites", {
                method: "POST",
                headers: await authHeaders(),
                body: JSON.stringify({ kind: "link", siteNames: siteNames.map((n) => n.trim()).filter(Boolean) }),
            })
            const j = await res.json()
            // 초대 링크 경로도 402(결제 자격·결제수단)를 낸다 — 게이트가 앞에서 걸러도
            // 자격이 그 사이에 바뀌면(주기 만료·카드 삭제) 여기로 떨어지므로 갈 곳을 같이 준다
            if (!res.ok) { setFormErrPay(res.status === 402); setAddMsg({ type: "err", text: j.error || "링크 생성 실패" }); return }
            setAddStep("link")
            setInviteUrl(`${window.location.origin}/join/${j.token}`)
        } finally {
            setBusy(null)
        }
    }

    const requestAttach = async () => {
        setAddMsg(null)
        setFormErrPay(false)
        setBusy("attach")
        try {
            const res = await fetch("/api/org/invites", {
                method: "POST",
                headers: await authHeaders(),
                body: JSON.stringify({ kind: "attach", loginId: attachId }),
            })
            const j = await res.json()
            if (!res.ok) { setFormErrPay(res.status === 402); setAddMsg({ type: "err", text: j.error || "편입 초대 실패" }); return }
            setAddMsg({ type: "ok", text: `편입 초대를 보냈어요. [${attachId}] 계정이 다음 로그인 때 수락하면 연결됩니다.` })
            setAttachId("")
        } finally {
            setBusy(null)
        }
    }

    // ── 정보 수정 모달 — 계정을 발급한 감독자가 표시 정보도 고칠 수 있어야 한다 (Chris)
    const openEdit = (m: MemberRow) => {
        setModalErr(null)
        setEditSite(m.siteName)
        setEditManager(m.managerName)
        setEditTarget(m)
    }
    const submitEdit = async () => {
        if (!editTarget) return
        if (!editSite.trim()) { setModalErr("현장명을 입력해주세요."); return }
        setBusy("edit")
        setModalErr(null)
        try {
            const res = await fetch("/api/org/members", {
                method: "PATCH",
                headers: await authHeaders(),
                body: JSON.stringify({ userId: editTarget.userId, siteName: editSite.trim(), managerName: editManager }),
            })
            const j = await res.json()
            if (!res.ok) { setModalErr(j.error || "수정 실패"); return }
            setEditTarget(null)
            await load()
        } finally {
            setBusy(null)
        }
    }

    // ── 비밀번호 재설정 모달 — 현장담당자 교체 시 감독자가 새 비밀번호를 만들어 전달한다
    const openPw = (m: MemberRow) => {
        setModalErr(null)
        setPwValue("")
        setPwConfirm("")
        setPwDone(false)
        setPwTarget(m)
    }
    const submitPw = async () => {
        if (!pwTarget) return
        if (pwValue.length < 8) { setModalErr("비밀번호는 8자 이상 입력해주세요."); return }
        if (pwValue !== pwConfirm) { setModalErr("확인 비밀번호가 일치하지 않아요."); return }
        setBusy("pw")
        setModalErr(null)
        try {
            const res = await fetch("/api/org/members", {
                method: "PATCH",
                headers: await authHeaders(),
                body: JSON.stringify({ userId: pwTarget.userId, newPassword: pwValue }),
            })
            const j = await res.json()
            if (!res.ok) { setModalErr(j.error || "변경 실패"); return }
            setPwDone(true)
        } finally {
            setBusy(null)
        }
    }

    // ── 연결 해제 모달 — confirm 대신 경고 모달. 계정·데이터 보존을 명확히 안내한다
    const openDetach = (m: MemberRow) => {
        setModalErr(null)
        setDetachTarget(m)
    }
    const submitDetach = async () => {
        if (!detachTarget) return
        setBusy("detach")
        setModalErr(null)
        try {
            const res = await fetch(`/api/org/members?userId=${encodeURIComponent(detachTarget.userId)}`, {
                method: "DELETE",
                headers: await authHeaders(),
            })
            const j = await res.json()
            if (!res.ok) { setModalErr(j.error || "해제 실패"); return }
            setMsg({ type: "ok", text: `[${detachTarget.siteName || "현장명 미설정"}] 연결을 해제했어요. 계정과 기록은 보존됩니다.` })
            setDetachTarget(null)
            await load()
        } finally {
            setBusy(null)
        }
    }


    return (
        <div className="min-h-screen bg-cur-canvas font-sans">
            <div className="max-w-lg mx-auto px-4 pt-4">
                <TBMHeader title="현장 계정 관리" backHref="/" />
            </div>
            <main className="max-w-lg mx-auto px-5 py-6 space-y-5 pb-16">
                {msg && (
                    <div className={`text-[13px] rounded-lg p-3 ${msg.type === "ok" ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-error/10 text-cur-error"}`}>{msg.text}</div>
                )}

                {/* 현장 목록 — 수정(정보·비번)·삭제(해제)·추가가 전부 이 카드 하나에서 */}
                <section className="space-y-2">
                    <h2 className="text-[14px] font-bold text-cur-ink px-1">
                        연결된 현장{activeCount > 0 && <span className="text-cur-muted-soft font-medium ml-1.5">{activeCount}곳</span>}
                    </h2>
                    {loading ? (
                        <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-cur-muted" /></div>
                    ) : (
                        <div className="bg-cur-card rounded-2xl border border-cur-hairline divide-y divide-cur-hairline overflow-hidden">
                            {members.length === 0 && (
                                <p className="text-[13px] text-cur-muted-soft text-center py-6">아직 연결된 현장이 없어요.</p>
                            )}
                            {members.map((m) => (
                                <div key={m.userId} className="flex items-center gap-3 p-4">
                                    {/* "기록 보기" 진입은 뺐다 (Chris) — 이 화면은 계정 관리만 한다 */}
                                    <div className="flex-1 min-w-0">
                                        <p className="flex items-baseline gap-1.5 min-w-0">
                                            <span className={`text-[14px] font-semibold truncate ${m.status === "active" ? "text-cur-ink" : "text-cur-muted-soft line-through"}`}>{m.siteName || "현장명 미설정"}</span>
                                            {m.loginId && <span className="text-[11px] font-mono text-cur-muted shrink-0">{m.loginId}</span>}
                                        </p>
                                        <p className="text-[12px] text-cur-muted mt-0.5 truncate">
                                            {m.managerName && `${m.managerName} · `}
                                            {m.status === "active" ? `연결 ${m.joinedAt?.slice(0, 10)}` : "해제됨"}
                                        </p>
                                    </div>
                                    {m.status === "active" && (
                                        <>
                                            <button onClick={() => openEdit(m)} aria-label="현장명·현장담당자 수정" className={`${iconBtnCls} text-cur-muted hover:text-cur-ink hover:bg-cur-elevated`}>
                                                <Pencil className="w-4 h-4" />
                                            </button>
                                            <button onClick={() => openPw(m)} aria-label="비밀번호 재설정" className={`${iconBtnCls} text-cur-muted hover:text-cur-ink hover:bg-cur-elevated`}>
                                                <KeyRound className="w-4 h-4" />
                                            </button>
                                            <button onClick={() => openDetach(m)} aria-label="현장 연결 해제" className={`${iconBtnCls} text-cur-muted hover:text-cur-error hover:bg-cur-error/5`}>
                                                <UserMinus className="w-4 h-4" />
                                            </button>
                                        </>
                                    )}
                                </div>
                            ))}
                            {/* 추가는 목록의 마지막 행 — 별도 카드 대신 (Chris 스케치) */}
                            {/* 영구 무료(grandfather)에게는 추가 진입 자체를 열지 않는다(2026-08-10).
                                서버(app/api/org/members·bulk·invites)가 isBillablePlan으로 402를 주는데,
                                그 문구가 "구독을 먼저 확인해주세요"다 — 결제 UI를 걷어낸 계정에게는
                                갈 곳 없는 유도가 된다. 앱 org-members.tsx의 canIssueSeats와 같은 규율.
                                (sub 로딩 중에는 null이라 기존처럼 버튼을 보여준다 — 조회 실패로
                                 유료 감독자의 발급이 잠기는 쪽이 더 나쁘다) */}
                            {blockWizard ? (
                                /* 자격(plan·subscription)이 없으면 위저드를 열지 않는다 — 세 경로가 전부
                                   서버에서 막히므로 다 입력한 뒤 402로 되돌려보내는 대신 여기서 이유와
                                   갈 곳을 함께 준다. 결제수단·주기 문제(method·period)는 초대·편입이
                                   살아 있으므로 여기서 막지 않는다 (blockAll 주석 참조) */
                                <div className="p-4 space-y-2">{blockedPanel}</div>
                            ) : (
                            <button
                                type="button"
                                onClick={() => { setCreatedIds(null); setAddMsg(null); setAddStep("count") }}
                                className="w-full flex items-center gap-3 p-4 text-left hover:bg-cur-elevated/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary focus-visible:ring-inset"
                            >
                                <span className="w-9 h-9 rounded-full border border-dashed border-cur-hairline-strong text-cur-muted flex items-center justify-center shrink-0">
                                    <UserPlus2 className="w-4 h-4" />
                                </span>
                                <span className="flex-1 min-w-0 text-[14px] font-semibold text-cur-body">현장 계정 추가하기</span>
                                <ChevronRight className="w-4 h-4 text-cur-muted-soft shrink-0" />
                            </button>
                            )}
                        </div>
                    )}
                </section>

            </main>

            {/* ── 현장 계정 추가 모달 — 인라인 위저드를 그대로 옮겼다 (단계·솔로 승급 안내·청구 한 줄 동일) */}
            <Dialog open={addOpen} onOpenChange={(o) => { if (!o) { if (busy) return; closeAdd() } }}>
                <DialogContent aria-describedby={undefined} className={dialogCls}>
                    <DialogHeader className="text-left">
                        <DialogTitle className={dialogTitleCls}>현장 계정 추가</DialogTitle>
                    </DialogHeader>
                    {addMsg && (
                        <div className={`text-[13px] rounded-[8px] px-3 py-2 space-y-1.5 ${addMsg.type === "ok" ? "bg-cur-primary/10 text-cur-primary" : "bg-cur-error/5 border border-cur-error/20 text-cur-error"}`}>
                            <p>{addMsg.text}</p>
                            {/* 402는 결제 자격·결제수단 문제 — 문구만 주면 "그래서 어디서 등록하나요"에서 멈춘다.
                                단 요금제 부적격(payLinkOk=false)에는 붙이지 않는다 — /account에 바꿀 수단이 없다 */}
                            {addMsg.type === "err" && formErrPay && payLinkOk && (
                                <Link
                                    href="/account"
                                    className="inline-flex items-center gap-1 font-bold text-cur-primary rounded-[6px] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                                >
                                    구독 및 결제로 가기
                                    <ChevronRight className="w-3.5 h-3.5" />
                                </Link>
                            )}
                        </div>
                    )}
                    {ctx?.kind === "solo" && addStep !== null && !createdIds && !blockWizard && (
                        <div className="rounded-xl bg-cur-primary/[0.06] border border-cur-primary/25 px-4 py-3 space-y-1">
                            <p className="text-[13px] font-bold text-cur-primary">첫 현장 계정을 만들면 이 계정이 회사 감독자가 돼요</p>
                            <p className="text-[12px] text-cur-muted leading-relaxed">
                                회사 공통 설정을 정하고, 현장별 기록·보고서를 모아 봐요.
                            </p>
                        </div>
                    )}

                    {/* ① 일괄 발급 (메인) — 시드+개수+초기 비밀번호. 현장명·새 비밀번호는 현장담당자 첫 로그인 때 */}
                    {createdIds ? (
                        <div className="rounded-xl border border-cur-success/30 bg-cur-success/5 p-4 space-y-3">
                            <p className="flex items-center gap-1.5 text-[14px] font-bold text-cur-success">
                                <CheckCircle2 className="w-4 h-4" /> 계정 {createdIds.length}개를 만들었어요
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                                {createdIds.map((id) => (
                                    <span key={id} className="text-[13px] font-mono font-semibold text-cur-ink bg-cur-card border border-cur-hairline rounded-[6px] px-2 py-1">{id}</span>
                                ))}
                            </div>
                            <p className="text-[12px] text-cur-muted leading-relaxed">
                                초기 비밀번호는 전부 <b className="text-cur-ink font-mono break-all">{initPw}</b> 예요.
                                현장담당자가 처음 로그인하면 새 비밀번호와 현장명을 직접 설정합니다.
                            </p>
                            <div className="flex gap-2">
                                <Button onClick={copyCreated} className="flex-1 h-12 rounded-lg bg-cur-ink text-white text-[13px] font-bold">
                                    <Copy className="w-4 h-4 mr-1.5" /> 계정 목록 복사
                                </Button>
                                <Button onClick={closeAdd} variant="outline" className="h-12 px-4 rounded-lg border-cur-hairline text-cur-muted font-semibold">닫기</Button>
                            </div>
                        </div>
                    ) : blockWizard ? (
                        /* 자격이 없으면 위저드 대신 이유와 갈 곳만 — 버튼만 막으면 ?new=1 딥링크가
                           그 게이트를 지나쳐 여기까지 들어온다(홈 온보딩 카드가 미는 URL이 그것이다).
                           모달을 조용히 닫지 않는 이유: 눌렀는데 아무 일도 안 일어나면 그게 또 다른
                           막다른 길이다. 열되, 왜 못 만드는지를 이 자리에서 말한다. */
                        <div className="space-y-2">
                            {blockedPanel}
                            <Button onClick={closeAdd} variant="outline" className="w-full h-12 mt-2 rounded-lg border-cur-hairline text-cur-muted font-semibold">닫기</Button>
                        </div>
                    ) : addStep === "count" ? (
                        /* 1단계 — 몇 개? */
                        <div className="space-y-4">
                            <p className="text-[14px] font-semibold text-cur-ink">몇 개 현장을 추가할까요?</p>
                            <div className="flex items-center justify-center gap-5">
                                <button onClick={() => setCount((c) => Math.max(1, c - 1))} disabled={count <= 1} aria-label="줄이기"
                                    className="w-11 h-12 rounded-[8px] border border-cur-hairline bg-cur-elevated text-cur-ink flex items-center justify-center disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"><Minus className="w-4 h-4" /></button>
                                <span className="w-12 text-center text-[28px] font-bold tabular-nums">{count}</span>
                                <button onClick={() => setCount((c) => Math.min(20, c + 1))} aria-label="늘리기"
                                    className="w-11 h-12 rounded-[8px] border border-cur-hairline bg-cur-elevated text-cur-ink flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"><Plus className="w-4 h-4" /></button>
                            </div>
                            {/* 요금 계산기 카드가 사라진 자리 — 청구 규칙 한 줄만 남긴다 */}
                            <p className="text-[12px] text-cur-muted-soft text-center leading-relaxed">
                                계정 1개당 월 3,900원 · {sub?.status === "trialing" ? "무료체험 중엔 결제되지 않아요" : "추가는 남은 기간만큼 즉시 결제"}
                            </p>
                            <div className="flex gap-2">
                                <Button onClick={closeAdd} variant="outline" className="flex-1 h-12 rounded-lg border-cur-hairline text-cur-muted font-semibold">취소</Button>
                                <Button onClick={() => { setSiteNames((prev) => Array.from({ length: count }, (_, i) => prev[i] ?? "")); setAddStep("names") }} className="flex-[2] h-12 rounded-lg bg-cur-primary text-white font-bold">다음</Button>
                            </div>
                        </div>
                    ) : addStep === "names" ? (
                        /* 1.5단계 — 현장명을 감독자가 미리 정한다. 담당자마다 제각각 적어
                           현장 목록이 지저분해지는 것을 발급 시점에 차단 */
                        <div className="space-y-4">
                            <div>
                                <p className="text-[14px] font-semibold text-cur-ink">현장 이름을 정해주세요</p>
                                <p className="text-[12px] text-cur-muted mt-1">이 이름이 그대로 현장명이 돼요.</p>
                            </div>
                            <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-0.5">
                                {siteNames.map((n, i) => (
                                    <Input
                                        key={i}
                                        value={n}
                                        onChange={(e) => setSiteNames((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                                        placeholder={`현장 ${i + 1} — 예: OO물류센터`}
                                        className={inputCls}
                                    />
                                ))}
                            </div>
                            {formErr && (
                                <p className="text-[13px] font-medium text-cur-error bg-cur-error/5 border border-cur-error/20 rounded-[8px] px-3 py-2">{formErr}</p>
                            )}
                            <div className="flex gap-2">
                                <Button onClick={() => { setAddStep("count"); setFormErr(null) }} variant="outline" className="flex-1 h-12 rounded-lg border-cur-hairline text-cur-muted font-semibold">이전</Button>
                                <Button
                                    onClick={() => {
                                        if (siteNames.some((n) => !n.trim())) { setFormErr("현장 이름을 모두 입력해주세요."); return }
                                        setFormErr(null); setAddStep("method")
                                    }}
                                    className="flex-[2] h-12 rounded-lg bg-cur-primary text-white font-bold"
                                >
                                    다음
                                </Button>
                            </div>
                        </div>
                    ) : addStep === "method" ? (
                        /* 2단계 — 계정을 누가 만들까? */
                        <div className="space-y-3">
                            <p className="text-[14px] font-semibold text-cur-ink">계정 {count}개, 어떻게 만들까요?</p>
                            {blockDirect ? (
                                /* 직접 발급만 잠근다 — 이 분기만 그 자리에서 즉시 청구된다(bulk → chargeProratedAccount).
                                   아래 초대 링크·편입은 좌석이 가입/수락 때 생기고 지금 돈을 받지 않으므로 열어둔다. */
                                <div className="rounded-[12px] border border-cur-hairline bg-cur-elevated p-4 space-y-2">
                                    <p className="text-[14px] font-bold text-cur-muted">내가 만들어서 현장담당자에게 줄래요</p>
                                    {blockedPanel}
                                </div>
                            ) : (
                            <button
                                onClick={() => setAddStep("direct")}
                                className="w-full flex items-center gap-3.5 p-4 rounded-[12px] border border-cur-hairline bg-cur-elevated hover:border-cur-primary/40 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                            >
                                <span className="w-10 h-10 shrink-0 rounded-[8px] bg-cur-primary/10 text-cur-primary flex items-center justify-center"><KeyRound className="w-5 h-5" /></span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-[14px] font-bold text-cur-ink">내가 만들어서 현장담당자에게 줄래요</span>
                                    <span className="block text-[12px] text-cur-body mt-0.5 leading-snug">아이디·초기 비밀번호를 한 번에 만들어 드려요</span>
                                </span>
                                <ChevronRight className="w-4 h-4 shrink-0 text-cur-muted-soft" />
                            </button>
                            )}
                            <button
                                onClick={createInviteLink}
                                disabled={busy === "link"}
                                className="w-full flex items-center gap-3.5 p-4 rounded-[12px] border border-cur-hairline bg-cur-elevated hover:border-cur-primary/40 text-left transition-all disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                            >
                                <span className="w-10 h-10 shrink-0 rounded-[8px] bg-cur-ink/8 text-cur-ink flex items-center justify-center">
                                    {busy === "link" ? <Loader2 className="w-5 h-5 animate-spin" /> : <Link2 className="w-5 h-5" />}
                                </span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-[14px] font-bold text-cur-ink">현장담당자가 직접 만들게 할래요</span>
                                    <span className="block text-[12px] text-cur-body mt-0.5 leading-snug">초대 링크를 보내면 현장담당자가 스스로 가입해요</span>
                                </span>
                                <ChevronRight className="w-4 h-4 shrink-0 text-cur-muted-soft" />
                            </button>
                            <button onClick={() => setAddStep("count")} className="w-full h-9 text-[13px] font-medium text-cur-muted hover:text-cur-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary rounded-[8px]">이전</button>
                        </div>
                    ) : addStep === "link" ? (
                        /* 초대 링크 결과 */
                        <div className="space-y-3">
                            <p className="text-[14px] font-semibold text-cur-ink">초대 링크가 준비됐어요</p>
                            {inviteUrl && (
                                <div className="flex items-center gap-2 rounded-lg bg-cur-elevated p-2.5">
                                    <span className="text-[12px] text-cur-body truncate flex-1 min-w-0">{inviteUrl}</span>
                                    <button
                                        onClick={() => { navigator.clipboard?.writeText(inviteUrl); setAddMsg({ type: "ok", text: "초대 링크를 복사했어요. 현장담당자에게 보내세요." }) }}
                                        className="shrink-0 h-8 px-2.5 rounded-md bg-cur-card border border-cur-hairline text-[12px] font-semibold text-cur-ink flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                                    >
                                        <Copy className="w-3.5 h-3.5" /> 복사
                                    </button>
                                </div>
                            )}
                            <p className="text-[12px] text-cur-muted leading-relaxed">
                                링크 하나로 여러 현장담당자가 가입할 수 있어요 (14일 유효). 가입하면 현장 목록에 자동으로 떠요.
                            </p>
                            {/* 편입은 드문 일이라(기존 안톡 계정 데려오기) 상시 노출하지 않고 여기서만 */}
                            <details className="group">
                                <summary className="text-[13px] font-medium text-cur-muted cursor-pointer list-none hover:text-cur-ink">
                                    이미 안톡을 쓰던 계정을 데려오려면 →
                                </summary>
                                <div className="flex gap-2 mt-2">
                                    <Input value={attachId} onChange={(e) => setAttachId(e.target.value)} placeholder="기존 계정 아이디" className={inputCls + " flex-1"} />
                                    <Button onClick={requestAttach} disabled={busy === "attach" || !attachId.trim()} className="h-12 px-4 rounded-lg bg-cur-ink text-white text-[13px] font-bold shrink-0">
                                        {busy === "attach" ? <Loader2 className="w-4 h-4 animate-spin" /> : "편입 초대"}
                                    </Button>
                                </div>
                                <p className="text-[11px] text-cur-muted-soft mt-1.5">그 계정이 다음 로그인 때 수락하면 편입돼요. 기존 기록은 그대로 유지됩니다.</p>
                            </details>
                            <Button onClick={closeAdd} variant="outline" className="w-full h-12 rounded-lg border-cur-hairline text-cur-muted font-semibold">완료</Button>
                        </div>
                    ) : addStep === "direct" && blockDirect ? (
                        /* 자격 조회가 늦게 도착해 이미 직접 발급 단계에 들어와 있는 경우 —
                           입력을 다 받아놓고 끝에서 402로 되돌려보내지 않는다 */
                        <div className="space-y-2">
                            {blockedPanel}
                            <Button onClick={() => setAddStep("method")} variant="outline" className="w-full h-12 mt-2 rounded-lg border-cur-hairline text-cur-muted font-semibold">이전</Button>
                        </div>
                    ) : addStep === "direct" ? (
                        /* 직접 발급 — 아이디 규칙 설명을 눈앞에서 예시로 */
                        <div className="space-y-4">
                            <div className="space-y-1.5">
                                <Label className="text-[12px]">아이디 앞부분</Label>
                                <p className="text-[12px] text-cur-muted leading-relaxed">
                                    한글로 적으면 영문으로 바꿔드려요.
                                </p>
                                <Input value={stem} onChange={(e) => setStem(e.target.value)} placeholder="예: 무신사 또는 musinsa" className={inputCls} />
                                {stem && effStem && sanitizeStem(stem) !== stem.toLowerCase() && (
                                    <p className="text-[12px] text-cur-muted">아이디로는 <b className="font-mono text-cur-ink">{effStem}</b> 를 사용해요</p>
                                )}
                            </div>
                            {STEM_RE.test(effStem) && (
                                <p className="text-[12px] text-cur-muted bg-cur-elevated rounded-[8px] px-3 py-2 font-mono">
                                    {Array.from({ length: Math.min(count, 3) }, (_, i) => `${effStem}${String(i + 1).padStart(2, "0")}`).join(", ")}{count > 3 ? ` … ${effStem}${String(count).padStart(2, "0")}` : ""} 로 만들어져요
                                </p>
                            )}
                            <div className="space-y-1">
                                <Label className="text-[12px]">공용 초기 비밀번호</Label>
                                <Input value={initPw} onChange={(e) => setInitPw(e.target.value)} className={inputCls + " font-mono"} />
                                <p className="text-[11px] text-cur-muted-soft">현장담당자가 처음 로그인하면 반드시 새 비밀번호로 바꾸게 돼요.</p>
                            </div>
                            {/* 청구 미리보기 — 언제, 얼마가 나가는지 발급 확인 자리에서 숫자로 */}
                            <div className="rounded-[12px] bg-cur-elevated p-4 space-y-1.5">
                                {/* 스토어 구독자는 두 레일(스토어 4,900 + 카드 좌석)로 나가므로, 카드 몫만 보여주면
                                    "내 돈이 얼마 나가는지"를 알 수 없다(Chris 2026-08-10) — 합계를 먼저, 분해를 아래에. */}
                                <div className="flex items-baseline justify-between gap-3">
                                    <span className="text-[13px] text-cur-body">
                                        {storeOwner
                                            ? `내 구독 4,900원(앱 스토어) + 현장 계정 ${activeCount + count}개 × 3,900원(카드)`
                                            : `내 계정 1 + 현장 ${activeCount + count} = 계정 ${1 + activeCount + count}개 × 3,900원`}
                                    </span>
                                    <span className="text-[17px] font-bold text-cur-ink shrink-0">
                                        월 {(storeOwner ? 4900 + monthlyAfter : monthlyAfter).toLocaleString()}원
                                    </span>
                                </div>
                                {/* 지금 승인될 금액 — 서버 청구식 그대로. 종전엔 "이번 달 남은 기간 요금이 먼저
                                    결제되고"라고만 적어, 좌석을 가진 스토어 감독자에게 붙는 기존 좌석 이번 주기
                                    소급분(periodBase)이 통째로 빠졌다. 예고보다 큰 금액이 승인되는 건 분쟁거리다. */}
                                {!isTrialing && (immediateLoading || immediate) && (
                                    <div className="flex items-baseline justify-between gap-3 pt-2 border-t border-cur-hairline">
                                        <span className="text-[13px] text-cur-body">
                                            지금 결제{immediate && immediate.periodBase > 0 ? " · 남은 기간분 + 기존 현장 이번 주기분" : " · 남은 기간분"}
                                        </span>
                                        <span className="text-[15px] font-bold text-cur-ink shrink-0">
                                            {immediate ? `${immediate.amount.toLocaleString()}원` : "계산 중…"}
                                        </span>
                                    </div>
                                )}
                                <p className="text-[12px] text-cur-muted leading-relaxed">
                                    {isTrialing
                                        ? `무료체험 중엔 청구되지 않아요. 체험이 끝나는 ${nextChargeDate ?? "종료일"}부터 ${storeOwner ? "카드에서" : ""} 월 ${monthlyAfter.toLocaleString()}원이 결제됩니다.`
                                        : immediate || immediateLoading
                                          // 즉시 결제액을 바로 위 행에서 숫자로 보여줬으니 여기선 다음 주기만 말한다
                                          ? `${nextChargeDate ? `${nextChargeDate}부터` : "다음 결제일부터"} ${storeOwner ? "카드에서" : ""} 월 ${monthlyAfter.toLocaleString()}원이 결제됩니다.`
                                          : `현장을 추가하면 이번 달 남은 기간 요금이 먼저 결제되고, ${nextChargeDate ? `${nextChargeDate}부터` : "다음 결제일부터"} ${storeOwner ? "카드에서" : ""} 월 ${monthlyAfter.toLocaleString()}원이 결제됩니다.`}
                                    {storeOwner && " 내 구독 4,900원은 앱 스토어가 따로 청구해요."}
                                </p>
                            </div>
                            {formErr && (
                                <div className="text-[13px] font-medium text-cur-error bg-cur-error/5 border border-cur-error/20 rounded-[8px] px-3 py-2 space-y-1.5">
                                    <p>{formErr}</p>
                                    {/* 402는 결제 자격·결제수단 문제 — 갈 곳을 같이 준다.
                                        요금제 부적격(payLinkOk=false)만 예외 — 결제 화면엔 바꿀 수단이 없다 */}
                                    {formErrPay && payLinkOk && (
                                        <Link
                                            href="/account"
                                            className="inline-flex items-center gap-1 font-bold text-cur-primary rounded-[6px] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                                        >
                                            구독 및 결제로 가기
                                            <ChevronRight className="w-3.5 h-3.5" />
                                        </Link>
                                    )}
                                </div>
                            )}
                            <div className="flex gap-2">
                                <Button onClick={() => { setAddStep("method"); setFormErr(null) }} variant="outline" className="flex-1 h-12 rounded-lg border-cur-hairline text-cur-muted font-semibold">이전</Button>
                                <Button onClick={createBulk} disabled={busy === "create" || !STEM_RE.test(effStem) || !initPw} className="flex-[2] h-12 rounded-lg bg-cur-primary text-white font-bold">
                                    {busy === "create" ? <Loader2 className="w-4 h-4 animate-spin" /> : `${count}개 만들기`}
                                </Button>
                            </div>
                        </div>
                    ) : null}
                </DialogContent>
            </Dialog>

            {/* ── 정보 수정 모달 — 현장명·현장담당자 */}
            <Dialog open={!!editTarget} onOpenChange={(o) => { if (!o) { if (busy) return; setEditTarget(null); setModalErr(null) } }}>
                <DialogContent aria-describedby={undefined} className={dialogCls}>
                    <DialogHeader className="text-left">
                        <DialogTitle className={dialogTitleCls}>현장 정보 수정</DialogTitle>
                    </DialogHeader>
                    {editTarget?.loginId && (
                        <p className="text-[12px] text-cur-muted -mt-2">아이디 <span className="font-mono text-cur-ink">{editTarget.loginId}</span></p>
                    )}
                    <div className="space-y-1.5">
                        <Label className="text-[12px]">현장명</Label>
                        <Input value={editSite} onChange={(e) => setEditSite(e.target.value)} placeholder="예: 신도림 물류센터" className={inputCls} />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-[12px]">현장담당자 이름</Label>
                        <Input value={editManager} onChange={(e) => setEditManager(e.target.value)} placeholder="현장담당자 이름" className={inputCls} />
                        <p className="text-[11px] text-cur-muted-soft">비우면 현장명으로 표시돼요.</p>
                    </div>
                    {modalErr && (
                        <p className="text-[13px] font-medium text-cur-error bg-cur-error/5 border border-cur-error/20 rounded-[8px] px-3 py-2">{modalErr}</p>
                    )}
                    <div className="flex gap-2">
                        <Button onClick={() => setEditTarget(null)} variant="outline" className="flex-1 h-12 rounded-lg border-cur-hairline text-cur-muted font-semibold">취소</Button>
                        <Button onClick={submitEdit} disabled={busy === "edit" || !editSite.trim()} className="flex-[2] h-12 rounded-lg bg-cur-primary text-white font-bold">
                            {busy === "edit" ? <Loader2 className="w-4 h-4 animate-spin" /> : "저장"}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>

            {/* ── 비밀번호 재설정 모달 — 새 비밀번호 + 확인 입력, 성공 시 전달 안내 */}
            <Dialog open={!!pwTarget} onOpenChange={(o) => { if (!o) { if (busy) return; setPwTarget(null); setModalErr(null) } }}>
                <DialogContent className={dialogCls}>
                    <DialogHeader className="text-left">
                        <DialogTitle className={dialogTitleCls}>비밀번호 재설정</DialogTitle>
                        <DialogDescription className="text-[12px] text-cur-muted">
                            [{pwTarget?.siteName || "현장명 미설정"}]{pwTarget?.loginId ? <> · 아이디 <span className="font-mono text-cur-ink">{pwTarget.loginId}</span></> : null} — 현장담당자가 바뀌었을 때 사용하세요.
                        </DialogDescription>
                    </DialogHeader>
                    {pwDone ? (
                        <>
                            <div className="rounded-xl border border-cur-success/30 bg-cur-success/5 p-4 space-y-2">
                                <p className="flex items-center gap-1.5 text-[14px] font-bold text-cur-success">
                                    <CheckCircle2 className="w-4 h-4" /> 비밀번호를 변경했어요
                                </p>
                                <p className="text-[13px] text-cur-ink">새 비밀번호 <b className="font-mono break-all">{pwValue}</b></p>
                                <p className="text-[12px] text-cur-muted leading-relaxed">현장담당자에게 전달하세요. 다음 로그인부터 적용돼요.</p>
                            </div>
                            <Button onClick={() => setPwTarget(null)} variant="outline" className="w-full h-12 rounded-lg border-cur-hairline text-cur-muted font-semibold">닫기</Button>
                        </>
                    ) : (
                        <>
                            {/* 감독자가 만들어 전달하는 비밀번호라 가리지 않는다 — 읽고 옮겨 적을 수 있어야 한다 */}
                            <div className="space-y-1.5">
                                <Label className="text-[12px]">새 비밀번호 (8자 이상)</Label>
                                <Input value={pwValue} onChange={(e) => setPwValue(e.target.value)} autoComplete="off" placeholder="8자 이상" className={inputCls + " font-mono"} />
                            </div>
                            <div className="space-y-1.5">
                                <Label className="text-[12px]">새 비밀번호 확인</Label>
                                <Input value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} autoComplete="off" placeholder="한 번 더 입력" className={inputCls + " font-mono"} />
                            </div>
                            {modalErr && (
                                <p className="text-[13px] font-medium text-cur-error bg-cur-error/5 border border-cur-error/20 rounded-[8px] px-3 py-2">{modalErr}</p>
                            )}
                            <div className="flex gap-2">
                                <Button onClick={() => setPwTarget(null)} variant="outline" className="flex-1 h-12 rounded-lg border-cur-hairline text-cur-muted font-semibold">취소</Button>
                                <Button onClick={submitPw} disabled={busy === "pw" || pwValue.length < 8 || !pwConfirm} className="flex-[2] h-12 rounded-lg bg-cur-primary text-white font-bold">
                                    {busy === "pw" ? <Loader2 className="w-4 h-4 animate-spin" /> : "변경하기"}
                                </Button>
                            </div>
                        </>
                    )}
                </DialogContent>
            </Dialog>

            {/* ── 연결 해제 모달 — confirm 대신 경고 모달. 보존되는 것을 명시한다 */}
            <Dialog open={!!detachTarget} onOpenChange={(o) => { if (!o) { if (busy) return; setDetachTarget(null); setModalErr(null) } }}>
                <DialogContent className={dialogCls}>
                    <DialogHeader className="text-left">
                        <DialogTitle className={dialogTitleCls}>현장 연결 해제</DialogTitle>
                        <DialogDescription className="text-[13px] text-cur-muted leading-relaxed">
                            <b className="text-cur-ink">[{detachTarget?.siteName || "현장명 미설정"}]</b> 현장과의 연결을 해제할까요?
                        </DialogDescription>
                    </DialogHeader>
                    <div className="rounded-[8px] bg-cur-elevated border border-cur-hairline px-3.5 py-3 text-[12px] text-cur-muted leading-relaxed">
                        계정·데이터는 보존되고 연결만 해제됩니다. 해제 즉시 그 계정은 회사 이용권을 잃고, 다음 결제부터 요금에서 빠져요.
                    </div>
                    {modalErr && (
                        <p className="text-[13px] font-medium text-cur-error bg-cur-error/5 border border-cur-error/20 rounded-[8px] px-3 py-2">{modalErr}</p>
                    )}
                    <div className="flex gap-2">
                        <Button onClick={() => setDetachTarget(null)} variant="outline" className="flex-1 h-12 rounded-lg border-cur-hairline text-cur-muted font-semibold">취소</Button>
                        <Button onClick={submitDetach} disabled={busy === "detach"} className="flex-[2] h-12 rounded-lg bg-cur-error text-white font-bold hover:bg-cur-error/90">
                            {busy === "detach" ? <Loader2 className="w-4 h-4 animate-spin" /> : "해제하기"}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}
