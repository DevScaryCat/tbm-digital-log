"use client"

/* Hallmark · component: notice strip · genre: modern-minimal · theme: 안톡 cur-* (기존 토큰만)
 * states: default · hover · focus-visible · active · loading · empty(렌더 안 함) · error(조용히 숨김)
 *
 * 감독자가 **파생값으로는 알 수 없는 세 가지**만 말한다:
 *   ① 현장에서 결제를 요청했다 (org_notices의 member_ping — 상태에서 유도할 수 없는 이벤트)
 *   ② 현장 계정이 열리지 않고 있다 (seat_locked — 좌석 카드 3회 소진·요금제 정원 부족)
 *   ③ 결제 알림을 받을 이메일이 아예 없다 (이 경우 알림이 인앱에만 남아 7일이 통째로 흐른다)
 *
 * ②가 여기 있어야 하는 이유: 그 상황에서는 감독자 **본인 구독이 유효**하므로 홈의 만료 카드도
 * /account도 아무 말을 하지 않는다. 종전에는 이메일이 유일한 채널이었고, 카카오·아이디 가입
 * 감독자(emailMissing)는 그마저 없어 사건이 조용히 증발했다 — 현장 계정은 잠긴 채 남고
 * 감독자는 /org/members에 우연히 들어가야만 알았다(2026-08-13 검수).
 *
 * "내 결제가 끊겼다"는 여기서 말하지 않는다 — 그건 구독 상태에서 파생되고, 이미 홈의 만료
 * 카드와 /account가 말한다. 같은 사실을 두 곳에서 말하면 두 가지 일이 벌어진 줄 안다.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabaseClient"
import { BellRing, MailWarning, Users } from "lucide-react"

interface NoticeSummary {
    pingCount7d: number
    emailMissing: boolean
    unread: { id: string; kind: string; actorUserId?: string | null }[]
}

export function OwnerNoticeStrip() {
    const router = useRouter()
    const [data, setData] = useState<NoticeSummary | null>(null)
    const [dismissed, setDismissed] = useState(false)
    const [seatDismissed, setSeatDismissed] = useState(false)

    useEffect(() => {
        let active = true
        ;(async () => {
            try {
                const { data: sess } = await supabase.auth.getSession()
                const token = sess?.session?.access_token
                if (!token) return
                const res = await fetch("/api/org/notices", { headers: { Authorization: `Bearer ${token}` } })
                if (!res.ok) return
                const j = (await res.json()) as NoticeSummary
                if (active) setData(j)
            } catch {
                // 조용히 숨긴다 — 알림 조회 실패로 홈에 오류 배너가 뜨는 쪽이 더 나쁘다
            }
        })()
        return () => {
            active = false
        }
    }, [])

    if (!data) return null

    const unread = data.unread ?? []
    const pings = unread.filter((n) => n.kind === "member_ping")
    // ⚠️ '현장 N곳'은 행 수가 아니라 **현장 수**다. dedupe 키가 org+member+날짜라 같은 현장
    // 하나가 3일 연속 누르면 3행이 쌓이고, 감독자는 현장 3곳이 요청한 것으로 읽었다.
    // 읽음 처리는 지금처럼 행 전체를 대상으로 둔다.
    const pingSites = new Set(pings.map((p) => p.actorUserId ?? p.id)).size
    // 좌석 잠김·좌석 청구 실패는 같은 행동(현장 계정 관리에서 확인)으로 끝나므로 한 줄로 묶는다
    const seatIssues = unread.filter((n) => n.kind === "seat_locked" || n.kind === "charge_failed")
    const showPing = pings.length > 0 && !dismissed
    const showSeat = seatIssues.length > 0 && !seatDismissed
    if (!showPing && !showSeat && !data.emailMissing) return null

    const markRead = async (ids: string[]) => {
        try {
            const { data: sess } = await supabase.auth.getSession()
            await fetch("/api/org/notices", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${sess?.session?.access_token}`,
                },
                body: JSON.stringify({ ids }),
            })
        } catch {
            /* 읽음 처리 실패는 다음 방문에 다시 보이는 것으로 족하다 */
        }
    }

    return (
        <div className="space-y-2">
            {showPing && (
                <div className="rounded-[12px] border border-cur-primary/30 bg-cur-primary/[0.06] px-4 py-3 flex items-center gap-3">
                    <BellRing className="w-[18px] h-[18px] text-cur-primary shrink-0" />
                    <p className="flex-1 min-w-0 text-[13px] text-cur-body leading-snug">
                        현장 <b className="font-bold text-cur-ink">{pingSites}곳</b>에서 결제를 요청했어요.
                    </p>
                    <button
                        onClick={async () => {
                            setDismissed(true)
                            await markRead(pings.map((p) => p.id))
                            router.push("/account")
                        }}
                        className="shrink-0 h-8 px-3 rounded-[8px] bg-cur-primary text-cur-on-primary text-[12.5px] font-bold hover:bg-cur-primary-active transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                    >
                        결제 확인
                    </button>
                </div>
            )}
            {showSeat && (
                <div className="rounded-[12px] border border-amber-500/25 bg-amber-500/10 px-4 py-3 flex items-center gap-3">
                    <Users className="w-[18px] h-[18px] text-amber-600 shrink-0" />
                    <p className="flex-1 min-w-0 text-[13px] text-cur-body leading-snug">
                        현장 계정이 열리지 않고 있어요. 결제수단 또는 요금제를 확인해 주세요.
                    </p>
                    <button
                        onClick={async () => {
                            setSeatDismissed(true)
                            await markRead(seatIssues.map((n) => n.id))
                            router.push("/org/members")
                        }}
                        className="shrink-0 h-8 px-3 rounded-[8px] border border-cur-hairline bg-cur-card text-cur-body text-[12.5px] font-semibold hover:bg-cur-elevated transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                    >
                        현장 계정 관리
                    </button>
                </div>
            )}
            {data.emailMissing && (
                <div className="rounded-[12px] border border-cur-hairline bg-cur-elevated px-4 py-3 flex items-center gap-3">
                    <MailWarning className="w-[18px] h-[18px] text-cur-muted shrink-0" />
                    <p className="flex-1 min-w-0 text-[13px] text-cur-body leading-snug">
                        결제 알림을 받을 이메일이 없어요. 등록해두면 결제가 실패해도 바로 알 수 있어요.
                    </p>
                    <button
                        onClick={() => router.push("/profile#recovery-email")}
                        className="shrink-0 h-8 px-3 rounded-[8px] border border-cur-hairline bg-cur-card text-cur-body text-[12.5px] font-semibold hover:bg-cur-elevated transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cur-primary"
                    >
                        등록하기
                    </button>
                </div>
            )}
        </div>
    )
}
