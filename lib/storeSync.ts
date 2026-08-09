// lib/storeSync.ts — 스토어 재조회 결과를 subscriptions 행 패치로 옮기는 순수 함수.
//
// 크론(reconcile-store-subs)에서 떼어낸 이유는 하나다: **멱등성을 눈으로 검증**하기 위해서다.
// (같은 날 두 번 돌아도 두 번째 실행은 아무것도 쓰지 않아야 한다)
// DB·네트워크에 의존하지 않으므로 그대로 단위 검증이 된다.

/** 재조회 대상 행에서 비교에 쓰는 필드만 */
export interface StoreSyncRow {
    status: string | null
    current_period_end: string | null
    store_product_id: string | null
    canceled_at: string | null
}

/** 스토어(애플·구글)가 확정해 준 사실 */
export interface StoreSyncFacts {
    /** toLocalStatus 결과 (trialing/active/past_due/canceled — DB 체크제약이 허용하는 값만) */
    status: string
    /** 이용 권한을 즉시 회수해야 하는 상태(환불·만료·미결제) */
    revoked: boolean
    /** 스토어가 알려준 이용 만료 시각(ISO) */
    storeEnd: string | null
    productId: string | null
}

export interface StoreSyncPatch {
    status: string
    current_period_end: string | null
    store_product_id: string | null
    canceled_at: string | null
    updated_at: string
}

/** 두 타임스탬프가 같은 시각인가 (DB 반환 형식과 ISO 문자열을 문자열 비교하면 항상 다르게 나온다) */
function sameInstant(a: string | null, b: string | null): boolean {
    if (!a || !b) return a === b
    return new Date(a).getTime() === new Date(b).getTime()
}

export function storeSyncPatch(
    row: StoreSyncRow,
    facts: StoreSyncFacts,
    now: Date
): { changed: boolean; patch: StoreSyncPatch } {
    const nowIso = now.toISOString()

    // 회수 상태면 남은 기간을 인정하지 않고 지금으로 끊는다. 단 이미 과거로 박혀 있으면 그 값을
    // 유지한다 — 매 실행 now()로 다시 박으면 같은 행이 영원히 '변경됨'으로 잡혀 멱등이 깨진다.
    const currentEnd = row.current_period_end
    const periodEnd = facts.revoked
        ? currentEnd && new Date(currentEnd) <= now
            ? currentEnd
            : nowIso
        : (facts.storeEnd ?? currentEnd)

    const productId = facts.productId ?? null
    const changed =
        facts.status !== row.status ||
        !sameInstant(periodEnd, currentEnd) ||
        productId !== (row.store_product_id ?? null)

    return {
        changed,
        patch: {
            status: facts.status,
            current_period_end: periodEnd,
            store_product_id: productId,
            // 해지 시각은 처음 접힌 때를 보존한다(재실행마다 갱신하면 이력이 사라진다)
            canceled_at: facts.status === "canceled" ? (row.canceled_at ?? nowIso) : null,
            updated_at: nowIso,
        },
    }
}
