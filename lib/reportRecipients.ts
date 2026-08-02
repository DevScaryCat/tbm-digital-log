// 보고서 수신처 상태 — 화면 3곳(보고서 설정 위저드·분석 보고서 게이트·홈 배너)이 같은 기준을 쓴다.
//
// 핵심: '등록됨'이 아니라 '승인됨'만 발송 대상이다.
// 크론(app/api/cron/{monthly,weekly}-report)은 status='approved'만 조회하므로,
// pending 행을 세어 "설정 완료"로 판정하면 화면은 완료라고 하고 실발송은 0통이 된다.

export type ConsentStatus = "pending" | "approved" | "declined"
export type Recipient = { email: string; status: ConsentStatus }
export type RecipientCounts = { approved: number; pending: number; total: number }

export const EMPTY_COUNTS: RecipientCounts = { approved: 0, pending: 0, total: 0 }

export function countRecipients(list: unknown): RecipientCounts {
    const rows = (Array.isArray(list) ? list : []) as Recipient[]
    return {
        approved: rows.filter((r) => r?.status === "approved").length,
        pending: rows.filter((r) => r?.status === "pending").length,
        total: rows.length,
    }
}

/**
 * GET /api/reports/recipients — 승인 상태별 집계 + Pro 여부를 한 번에.
 * 실패·403(member)은 null로 돌려준다. 판정 실패로 기능을 잠그지 않기 위해
 * 호출부는 null을 "모름"으로 다루고 게이트를 열어둔다.
 */
export async function fetchRecipients(
    token?: string,
): Promise<{ counts: RecipientCounts; recipients: Recipient[]; isPro: boolean } | null> {
    try {
        const res = await fetch("/api/reports/recipients", {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (!res.ok) return null
        const j = await res.json()
        const recipients = (Array.isArray(j.recipients) ? j.recipients : []) as Recipient[]
        return { counts: countRecipients(recipients), recipients, isPro: !!j.isPro }
    } catch {
        return null
    }
}
