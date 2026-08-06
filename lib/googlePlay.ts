// lib/googlePlay.ts — Google Play 구독 영수증 검증 (Android 인앱결제)
//
// 앱에서 결제가 끝나면 클라이언트는 purchaseToken만 들고 온다. 그 토큰이 진짜인지,
// 지금 활성인지, 언제까지인지는 **반드시 서버가 구글에 물어봐야** 한다 — 클라이언트가 보낸
// 상태를 믿으면 위조 영수증으로 무한 무료 이용이 열린다.
//
// 인증: Play Console에 등록된 서비스 계정(EAS 제출에 쓰는 것과 동일 계정 재사용 가능)의
// JWT를 구글 토큰 엔드포인트에서 액세스 토큰으로 교환한다. 공식 SDK(googleapis)는 수 MB라
// 결제 경로 하나 때문에 들이지 않고, RS256 서명만 node:crypto로 직접 만든다.

import crypto from "node:crypto"

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications"
const SCOPE = "https://www.googleapis.com/auth/androidpublisher"

/** 앱 패키지명 — 영수증은 이 패키지 것만 유효하다 */
export const ANDROID_PACKAGE = process.env.GOOGLE_PLAY_PACKAGE ?? "kr.bitflip.tbm"

interface ServiceAccount { client_email: string; private_key: string }

function loadServiceAccount(): ServiceAccount {
    const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT
    if (!raw) throw new Error("GOOGLE_PLAY_SERVICE_ACCOUNT 미설정")
    // Vercel 환경변수에 붙여넣을 때 개행이 \n 문자열로 들어오는 경우가 흔하다
    const json = JSON.parse(raw) as ServiceAccount
    return { client_email: json.client_email, private_key: json.private_key.replace(/\\n/g, "\n") }
}

const b64url = (b: Buffer | string) =>
    Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

// 액세스 토큰은 1시간짜리 — 요청마다 새로 받으면 지연·쿼터 낭비라 만료 1분 전까지 재사용
let cachedToken: { token: string; expiresAt: number } | null = null

async function getAccessToken(): Promise<string> {
    if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.token

    const sa = loadServiceAccount()
    const now = Math.floor(Date.now() / 1000)
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    const claims = b64url(
        JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })
    )
    const signature = b64url(
        crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.private_key)
    )
    const assertion = `${header}.${claims}.${signature}`

    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
        }),
    })
    if (!res.ok) throw new Error(`구글 토큰 발급 실패: ${res.status} ${await res.text()}`)
    const j = (await res.json()) as { access_token: string; expires_in: number }
    cachedToken = { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 }
    return j.access_token
}

/** 구글이 돌려주는 구독 상태 — 우리가 쓰는 필드만 추림 */
export interface GooglePurchase {
    subscriptionState: string
    productId: string | null
    expiryTime: string | null
    autoRenewing: boolean
    acknowledged: boolean
    isTrial: boolean
    /** 구독을 산 구글 계정의 안정적 식별자(있으면) — 체험 중복 판정 보조 */
    externalAccountId: string | null
    /** 우리가 결제 시작 때 심은 값(= 우리 user_id) — 계정 도용 방지 대조용 */
    obfuscatedExternalAccountId: string | null
    testPurchase: boolean
}

/** purchaseToken으로 구독 실제 상태 조회 (subscriptionsv2) */
export async function getSubscription(purchaseToken: string): Promise<GooglePurchase> {
    const token = await getAccessToken()
    const url = `${API_BASE}/${ANDROID_PACKAGE}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`구글 구독 조회 실패: ${res.status} ${await res.text()}`)

    const j = (await res.json()) as Record<string, unknown>
    const lineItems = (Array.isArray(j.lineItems) ? j.lineItems : []) as Record<string, unknown>[]
    // 구독 1건에 라인아이템은 보통 1개. 여러 개면 가장 늦게 끝나는 것이 현재 유효 기간.
    const item = lineItems.reduce<Record<string, unknown> | null>((best, cur) => {
        if (!best) return cur
        return String(cur.expiryTime ?? "") > String(best.expiryTime ?? "") ? cur : best
    }, null)

    const offer = (item?.offerDetails ?? {}) as Record<string, unknown>
    const autoPlan = (item?.autoRenewingPlan ?? null) as Record<string, unknown> | null
    const acct = (j.externalAccountIdentifiers ?? {}) as Record<string, unknown>

    return {
        subscriptionState: String(j.subscriptionState ?? ""),
        productId: item?.productId ? String(item.productId) : null,
        expiryTime: item?.expiryTime ? String(item.expiryTime) : null,
        autoRenewing: autoPlan?.autoRenewEnabled === true,
        acknowledged: String(j.acknowledgementState ?? "") === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
        // 무료체험은 offerId가 붙은 프로모션으로 판매된다(기본 요금제엔 offerId가 없다)
        isTrial: !!offer.offerId,
        externalAccountId: acct.externalAccountId ? String(acct.externalAccountId) : null,
        obfuscatedExternalAccountId: acct.obfuscatedExternalAccountId
            ? String(acct.obfuscatedExternalAccountId)
            : null,
        testPurchase: j.testPurchase !== undefined,
    }
}

/**
 * 구매 확인(acknowledge). 구글은 결제 후 3일 안에 확인하지 않으면 **자동 환불**한다.
 * 검증에 성공해 이용 권한을 부여한 직후에 호출해야 한다.
 */
export async function acknowledge(productId: string, purchaseToken: string): Promise<void> {
    const token = await getAccessToken()
    const url = `${API_BASE}/${ANDROID_PACKAGE}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`
    const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
    })
    // 이미 확인된 구매를 다시 확인하면 400 — 재시도·중복 호출에서 정상 경로라 삼킨다
    if (!res.ok && res.status !== 400) {
        throw new Error(`구매 확인 실패: ${res.status} ${await res.text()}`)
    }
}

/**
 * 이용 권한을 즉시 회수해야 하는 상태인가.
 * 만료·보류(결제 실패 최종)·일시정지·미완료 결제가 여기 해당한다.
 */
export function isRevokedState(subscriptionState: string): boolean {
    return ![
        "SUBSCRIPTION_STATE_ACTIVE",
        "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
        "SUBSCRIPTION_STATE_CANCELED",
    ].includes(subscriptionState)
}

/**
 * 구글 구독 상태 → 우리 subscriptions.status.
 *
 * ⚠️ DB의 status 체크 제약은 trialing/active/past_due/canceled 넷만 허용한다.
 * 'expired' 같은 값을 쓰면 UPDATE가 조용히 실패해 **해지·환불이 반영되지 않는다**
 * (권한이 영원히 안 끊김). 그래서 회수 상태는 전부 'canceled'로 매핑하고,
 * 이용 종료는 호출부가 current_period_end를 과거로 박아 판정하게 한다
 * — subscriptionAllows/isAllowed가 "canceled + 기간 만료 = 불허"로 이미 판정한다.
 */
export function toLocalStatus(p: GooglePurchase): string {
    switch (p.subscriptionState) {
        case "SUBSCRIPTION_STATE_ACTIVE":
            return p.isTrial ? "trialing" : "active"
        case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
            // 결제 실패 재시도 중 — 아직 이용은 허용(PortOne past_due와 동일 취급)
            return "past_due"
        default:
            // 해지 예약(CANCELED)은 남은 기간까지 이용 가능, 그 외 회수 상태도 같은 status를 쓰되
            // 기간을 과거로 두어 즉시 차단된다.
            return "canceled"
    }
}
