"use client"

/* Hallmark · component: notice / gate · genre: modern-minimal · theme: 안톡 cur-* (기존 토큰만)
 * states: default · hover · focus-visible · active · disabled · loading · error · success
 * 새 토큰·새 폰트·새 색을 만들지 않는다 — 기존 카드 문법(rounded-[12px] · border-cur-hairline ·
 * bg-cur-card · text-[15px]/[13px] 사다리)을 그대로 따른다. 이 화면만 다르게 생기면 그게 사고다.
 *
 * ── 무엇을 말하는 컴포넌트인가 ────────────────────────────────────────────
 * 소속 현장 계정이 "쓸 수 없게 된" 세 상황의 **유일한** 안내면이다. 셋은 원인이 다르고,
 * 원인을 틀리게 말하면 사용자는 자기가 할 수 없는 일을 하러 간다:
 *   ① 유예 중(phase='grace')  회사 결제가 끊겼다. 감독자가 되살릴 시간이 남아 있다.
 *   ② 유예 후(phase='ended')  되살아나지 않았다. 상태는 ①과 같고 문구만 다르다.
 *   ③ 좌석만 잠김(seatLocked) 회사 구독은 **유효한데** 내 좌석만 안 열렸다.
 *
 * ⚠️ **개인 결제 버튼은 어느 분기에도 없다**(Chris 2026-08-11 2차 정정 — 종전 설계 번복).
 *    감독자가 결제를 그만두면 그 계정은 그냥 못 쓴다. 유예가 끝나도 개인 구독으로 갈아탈 문을
 *    열지 않는다 — 세 분기 모두 주 행동은 '감독자에게 알리기' 하나이고, 기록 열람·출력은
 *    항상 열려 있다. 이 컴포넌트에 /pricing으로 가는 길을 다시 만들지 말 것.
 * ⚠️ 남은 일수(카운트다운)를 그리지 않는다 — 유예 종료일에 일어나는 일이 없기 때문이다(아래 주석).
 * ⚠️ "구독이 만료됐어요"라고 쓰지 않는다 — 이 사람은 구독한 적이 없다. 거짓말이 된다.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { Button } from "@/components/ui/button"
import { Antoki } from "@/components/Antoki"
import { clearOrgContextCache, type ClientOrgLapse } from "@/lib/useOrgContext"
import { Loader2, Check, FileText, RefreshCw, Building2 } from "lucide-react"

type PingState = "idle" | "sending" | "done" | "error"

function timeLabel(iso: string | null): string {
    if (!iso) return ""
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ""
    return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
}

// dateLabel(graceEndsAt)은 "…부터 직접 구독" 예고에만 쓰였다 — 그 문구와 함께 제거(2026-08-11).

export function OrgLapseNotice({
    lapse,
    seatLocked = false,
    variant = "gate",
    className = "",
}: {
    /** 서버 판정 그대로. seatLocked 전용 화면에서는 없을 수 있다 */
    lapse?: ClientOrgLapse | null
    /** 회사 구독은 유효한데 내 좌석만 죽어 있다 */
    seatLocked?: boolean
    /** gate = 화면 전체를 대신하는 안내 · banner = 홈 상단 축약형 */
    variant?: "gate" | "banner"
    className?: string
}) {
    const router = useRouter()
    const [ping, setPing] = useState<PingState>(lapse && !lapse.canPingNow && lapse.lastPingAt ? "done" : "idle")
    const [pingAt, setPingAt] = useState<string | null>(lapse?.lastPingAt ?? null)
    const [error, setError] = useState<string | null>(null)
    const [refreshing, setRefreshing] = useState(false)

    const orgName = lapse?.orgName || "회사"
    const ended = !seatLocked && lapse?.phase === "ended"

    const sendPing = async () => {
        setPing("sending")
        setError(null)
        try {
            const { data } = await supabase.auth.getSession()
            const res = await fetch("/api/org/ping-owner", {
                method: "POST",
                headers: { Authorization: `Bearer ${data?.session?.access_token}` },
            })
            const j = await res.json().catch(() => ({}))
            if (!res.ok) {
                // 유예 중에 감독자가 연결을 해제하면 404가 온다. 오류 토스트로 띄우지 않는다 —
                // 사실을 말하고 화면을 새로 고쳐 올바른 상태(개인 만료)로 넘긴다.
                if (j?.code === "not_in_org") {
                    clearOrgContextCache()
                    setError("회사 연결이 해제됐어요. 화면을 새로 불러올게요.")
                    setTimeout(() => window.location.reload(), 1200)
                    setPing("error")
                    return
                }
                setError(j?.error || "전달하지 못했어요. 잠시 후 다시 시도해 주세요.")
                setPing("error")
                return
            }
            setPingAt(j?.sentAt ?? new Date().toISOString())
            setPing("done")
        } catch {
            setError("전달하지 못했어요. 잠시 후 다시 시도해 주세요.")
            setPing("error")
        }
    }

    // 감독자가 방금 재결제해도 앱·웹은 역할을 캐시한다 — 사용자가 스스로 확인할 손잡이를 둔다.
    // 이게 없으면 결제가 끝났는데도 화면이 세션 끝까지 잠긴 채 남는다.
    const recheck = async () => {
        setRefreshing(true)
        clearOrgContextCache()
        window.location.reload()
    }

    const pingButton = (
        <Button
            onClick={sendPing}
            disabled={ping === "sending" || ping === "done"}
            /* 유예 후에도 primary다 — 개인 결제 버튼이 사라진 지금, 이것이 유일한 출구다.
               (종전에는 '내 구독 시작하기'가 primary 자리를 가져가 여기가 secondary였다) */
            className={`w-full h-12 rounded-[8px] font-bold text-[15px] disabled:opacity-100 ${
                ping === "done"
                    ? "bg-cur-elevated text-cur-muted hover:bg-cur-elevated"
                    : "bg-cur-primary text-cur-on-primary hover:bg-cur-primary-active"
            }`}
        >
            {ping === "sending" ? (
                <Loader2 className="w-4 h-4 animate-spin" />
            ) : ping === "done" ? (
                <span className="inline-flex items-center gap-1.5">
                    <Check className="w-4 h-4" /> 감독자에게 전달했어요{pingAt ? ` (${timeLabel(pingAt)})` : ""}
                </span>
            ) : ended ? (
                "감독자에게 다시 알리기"
            ) : (
                "감독자에게 알리기"
            )}
        </Button>
    )

    const body = (
        <>
            <div className="flex items-start gap-3">
                {variant === "gate" ? (
                    <Antoki pose="guide" size="md" motion="sway" />
                ) : (
                    <span className="w-9 h-9 rounded-[8px] bg-cur-primary/12 text-cur-primary flex items-center justify-center shrink-0">
                        <Building2 className="w-[18px] h-[18px]" />
                    </span>
                )}
                <div className="min-w-0 flex-1 space-y-1">
                    <h2 className="text-[16px] font-bold text-cur-ink leading-snug">
                        {seatLocked
                            ? "이용 준비가 아직 안 끝났어요"
                            : ended
                              ? "회사 구독이 종료됐어요"
                              : "회사 구독이 확인되지 않아요"}
                    </h2>
                    <p className="text-[13.5px] text-cur-body leading-relaxed">
                        {seatLocked ? (
                            <>
                                {/* ⚠️ "보통 하루 안에 자동으로 풀려요"는 거짓이었다. seatLocked는 자가복구를
                                    이미 시도해 **실패**했을 때만 세워지고, 그 원인은 둘뿐이다 — 좌석 카드 3회
                                    소진(크론이 의도적으로 복원 중단)과 요금제 정원 부족(복원 보류). 둘 다
                                    감독자가 손대기 전에는 하루가 아니라 영원히 안 풀린다. 기다리면 된다고
                                    읽은 사용자는 아무것도 하지 않는다(2026-08-13 검수).
                                    문구는 감독자 화면(/org/members)·seat_locked 메일과 같은 말이어야 한다. */}
                                <b className="font-semibold text-cur-ink">{orgName}</b> 구독은 확인됐는데 이 계정의 이용
                                권한이 연결되지 않았어요. 감독자가 결제수단 또는 요금제를 확인해야 열려요.
                            </>
                        ) : ended ? (
                            <>
                                <b className="font-semibold text-cur-ink">{orgName}</b>의 결제가 되살아나지 않았어요.
                                감독자가 다시 결제하면 바로 이어서 쓸 수 있어요.
                            </>
                        ) : (
                            <>
                                <b className="font-semibold text-cur-ink">{orgName}</b>의 결제가 확인되지 않아 새 기록
                                작성과 AI 분석이 잠겼어요.
                            </>
                        )}
                    </p>
                </div>
            </div>

            {/* 법정 서류라 접근을 끊지 않는다 — 이 한 줄이 유예 설계의 핵심이라 항상 보인다 */}
            <div className="rounded-[8px] bg-cur-elevated border border-cur-hairline px-3.5 py-3">
                <p className="text-[13px] text-cur-body leading-relaxed">
                    지금까지 만든 기록은 그대로 <b className="font-semibold text-cur-ink">보고 출력</b>할 수 있어요.
                </p>
            </div>

            {/* 이 분기의 주 행동은 '감독자에게 알리기' 하나다 — 위 문구가 그것을 필요 없어
                보이게 만들던 자리라, 무엇을 하면 되는지 한 줄로 못박는다.
                유예 후에도 같은 자리가 필요하다: 개인 결제 문이 닫힌 뒤로 여기가 유일한 출구다. */}
            {(seatLocked || ended) && (
                <p className="text-[13px] text-cur-body">
                    <span aria-hidden="true">🔔 </span>
                    {seatLocked ? "감독자에게 알리면 바로 확인할 수 있어요." : "감독자에게 알리면 결제 후 바로 다시 열려요."}
                </p>
            )}

            {/* ⚠️ "…기간이 N일 남았어요" 카운트다운이 있던 자리 — 2026-08-11 제거.
                개인 결제 전환이 폐지된 뒤로 **그 날짜에 일어나는 일이 없다.** 지나도 감독자가
                결제하면 그대로 열리고, 안 하면 그대로 잠겨 있다. 남은 일수를 보여주면 현장
                계정은 무언가를 기다리게 되는데 기다릴 것이 없다. 대신 참인 문장 하나를 둔다.
                (daysLeft·graceEndsAt은 서버에 그대로 있다 — 감독자 재촉 메일 D0/D3/D6의 타이밍
                 근거로 계속 쓰인다. 클라이언트가 그리지 않을 뿐이다.) */}
            {!seatLocked && !ended && (
                <p className="text-[13px] text-cur-body">
                    <span aria-hidden="true">🔔 </span>
                    감독자가 결제하면 바로 다시 열려요.
                </p>
            )}

            {error && (
                <div className="text-[13px] rounded-[8px] p-3 bg-cur-error/10 text-cur-error leading-relaxed">
                    {error}
                </div>
            )}

            <div className="space-y-2">
                {/* '내 구독 시작하기'(→/pricing)가 있던 자리 — 2026-08-11 제거.
                    회사가 그만두면 그 계정은 그냥 못 쓴다(Chris). 다시 만들지 말 것. */}
                {pingButton}
                <div className="flex gap-2">
                    <Button
                        variant="outline"
                        onClick={() => router.push("/dashboard")}
                        className="flex-1 h-11 rounded-[8px] border-cur-hairline bg-cur-card text-cur-body font-semibold text-[14px] hover:bg-cur-elevated"
                    >
                        <FileText className="w-4 h-4 mr-1.5" /> 기록 보기
                    </Button>
                    <Button
                        variant="outline"
                        onClick={recheck}
                        disabled={refreshing}
                        aria-label="결제 상태 다시 확인"
                        className="h-11 px-3 rounded-[8px] border-cur-hairline bg-cur-card text-cur-muted hover:bg-cur-elevated hover:text-cur-ink"
                    >
                        {refreshing ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <RefreshCw className="w-4 h-4" />
                        )}
                        <span className="ml-1.5 text-[14px] font-semibold">다시 확인</span>
                    </Button>
                </div>
            </div>

            {ping === "done" && (
                <p className="text-[12px] text-cur-muted-soft">내일 다시 알릴 수 있어요.</p>
            )}

            {/* "회사가 결제하지 않으면 {날짜}부터 직접 구독해서 이어 쓸 수 있어요"가 있던 자리 —
                2026-08-11 제거. 그 날은 오지 않는다(개인 결제 전환 폐지). 예고를 남겨두면
                기다렸다가 배신당하는 안내가 된다. */}
        </>
    )

    if (variant === "banner") {
        return (
            <div
                className={`rounded-[12px] border border-cur-hairline bg-cur-card p-4 space-y-3 ${className}`}
                role="status"
            >
                {body}
            </div>
        )
    }

    return (
        <div
            className={`rounded-[12px] border border-cur-hairline bg-cur-card p-5 space-y-4 ${className}`}
            role="status"
        >
            {body}
        </div>
    )
}
