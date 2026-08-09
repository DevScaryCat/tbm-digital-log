// lib/appStore.ts — App Store Server API v1 클라이언트 (iOS 인앱결제 검증)
//
// 앱은 결제가 끝나면 transactionId만 들고 온다. 그 거래가 진짜인지, 지금 활성인지,
// 언제까지인지는 **반드시 서버가 애플에 물어봐야** 한다 — 클라이언트가 보낸 상태를 믿으면
// 위조 영수증으로 무한 무료 이용이 열린다(googlePlay.ts와 같은 원칙).
//
// 인증: App Store Connect에서 발급한 In-App Purchase 키(.p8, ES256)로 JWT를 직접 만들어
// Authorization 헤더에 넣는다. 공식 SDK(@apple/app-store-server-library)는 이 경로 하나
// 때문에 들이지 않고, node:crypto만으로 서명·검증을 처리한다.
//
// 애플 응답의 signedTransactionInfo·signedRenewalInfo는 **JWS**다. 헤더 x5c 인증서 체인을
// 애플 루트 CA(G3)까지 검증한 뒤 서명을 확인한다 — 검증을 건너뛰고 페이로드만 디코드하면
// 누구나 만든 JWS를 애플 응답인 척 들이밀 수 있다(알림 엔드포인트가 공개돼 있으므로 실질 위험).

import crypto from "node:crypto"

const PROD_BASE = "https://api.storekit.itunes.apple.com"
const SANDBOX_BASE = "https://api.storekit-sandbox.itunes.apple.com"
const AUDIENCE = "appstoreconnect-v1"

/** 앱 번들 ID — 영수증은 이 앱 것만 유효하다 */
export const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID ?? "kr.bitflip.tbm"

/**
 * Apple Root CA - G3. 애플이 JWS 서명에 쓰는 체인의 최상위(공개 인증서).
 * 여기에 **고정(pin)** 하지 않고 체인만 자체 검증하면, 공격자가 자기 루트로 만든
 * 체인을 붙여 어떤 페이로드든 "검증 통과"시킬 수 있다.
 */
const APPLE_ROOT_CA_G3 = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`

let rootCert: crypto.X509Certificate | null = null
function appleRoot(): crypto.X509Certificate {
    if (!rootCert) rootCert = new crypto.X509Certificate(APPLE_ROOT_CA_G3)
    return rootCert
}

interface AppleKey {
    keyId: string
    issuerId: string
    privateKey: string
}

function loadKey(): AppleKey {
    const keyId = process.env.APPLE_IAP_KEY_ID
    const issuerId = process.env.APPLE_IAP_ISSUER_ID
    const raw = process.env.APPLE_IAP_PRIVATE_KEY
    if (!keyId) throw new Error("APPLE_IAP_KEY_ID 미설정")
    if (!issuerId) throw new Error("APPLE_IAP_ISSUER_ID 미설정")
    if (!raw) throw new Error("APPLE_IAP_PRIVATE_KEY 미설정")
    // Vercel 환경변수에 .p8을 붙여넣으면 개행이 \n 문자열로 들어오는 경우가 흔하다
    return { keyId, issuerId, privateKey: raw.replace(/\\n/g, "\n") }
}

// 애플 인증 토큰의 상한은 60분 — 요청마다 새로 만들지 않고 만료 1분 전까지 재사용
let cachedToken: { token: string; expiresAt: number } | null = null

function getAuthToken(): string {
    if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.token

    const { keyId, issuerId, privateKey } = loadKey()
    const now = Math.floor(Date.now() / 1000)
    const exp = now + 3000 // 50분 (애플 상한 60분 안쪽)
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" })).toString(
        "base64url"
    )
    const payload = Buffer.from(
        JSON.stringify({ iss: issuerId, iat: now, exp, aud: AUDIENCE, bid: APPLE_BUNDLE_ID })
    ).toString("base64url")
    // JWS(ES256)의 서명은 DER이 아니라 r||s 고정폭 — dsaEncoding을 안 주면 애플이 거절한다
    const signature = crypto
        .sign("sha256", Buffer.from(`${header}.${payload}`), {
            key: crypto.createPrivateKey(privateKey),
            dsaEncoding: "ieee-p1363",
        })
        .toString("base64url")

    const token = `${header}.${payload}.${signature}`
    cachedToken = { token, expiresAt: exp * 1000 }
    return token
}

/**
 * 애플이 서명한 JWS를 **검증하고** 페이로드를 돌려준다.
 * 체인: 리프 → 중간 → Apple Root CA G3(고정값과 일치해야 함). 유효기간·발급자·서명 전부 확인.
 * (인증서 폐기(OCSP)까지는 확인하지 않는다 — 애플 리프 인증서는 수명이 짧고, 폐기 조회 실패가
 *  결제 검증 전체를 막는 편이 더 큰 사고다.)
 */
export function verifyAppleJWS<T>(jws: string): T {
    const parts = jws.split(".")
    if (parts.length !== 3) throw new Error("애플 JWS 형식 오류")
    const [h, p, s] = parts

    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as {
        alg?: string
        x5c?: unknown
    }
    if (header.alg !== "ES256") throw new Error(`애플 JWS 알고리즘 불허: ${String(header.alg)}`)
    const x5c = header.x5c
    if (!Array.isArray(x5c) || x5c.length < 2) throw new Error("애플 JWS 인증서 체인 없음")

    const chain = (x5c as string[]).map(
        (der) => new crypto.X509Certificate(Buffer.from(der, "base64"))
    )

    // ① 체인의 최상위는 우리가 아는 애플 루트여야 한다.
    //    애플은 x5c에 루트까지 실어 보내지만, 안 실려 오는 경우에도 우리 고정값을 붙여
    //    "애플 루트가 발급한 체인인가"를 검사한다 — 남의 루트를 붙인 체인은 ③에서 걸린다.
    const root = appleRoot()
    if (!chain[chain.length - 1].raw.equals(root.raw)) chain.push(root)

    // ② 유효기간
    const now = Date.now()
    for (const cert of chain) {
        if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) < now) {
            throw new Error("애플 인증서 유효기간 벗어남")
        }
    }

    // ③ 각 단계가 상위에서 발급·서명됐는지
    for (let i = 0; i < chain.length - 1; i++) {
        if (!chain[i].checkIssued(chain[i + 1]) || !chain[i].verify(chain[i + 1].publicKey)) {
            throw new Error("애플 인증서 체인 검증 실패")
        }
    }

    // ④ 리프 공개키로 본문 서명 확인
    const ok = crypto.verify(
        "sha256",
        Buffer.from(`${h}.${p}`),
        { key: chain[0].publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(s, "base64url")
    )
    if (!ok) throw new Error("애플 JWS 서명 검증 실패")

    return JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as T
}

/** 애플 거래 정보(JWSTransactionDecodedPayload) — 우리가 쓰는 필드만 */
export interface AppleTransactionInfo {
    transactionId?: string
    originalTransactionId?: string
    bundleId?: string
    productId?: string
    purchaseDate?: number
    expiresDate?: number
    type?: string
    inAppOwnershipType?: string
    /** 결제 시작 때 앱이 심은 값(= 우리 user_id UUID) */
    appAccountToken?: string
    revocationDate?: number
    revocationReason?: number
    /** 1 = 소개(introductory) 오퍼 — 우리 무료체험이 여기 해당 */
    offerType?: number
    offerDiscountType?: string
    environment?: string
}

/** 애플 갱신 정보(JWSRenewalInfoDecodedPayload) — 우리가 쓰는 필드만 */
export interface AppleRenewalInfo {
    autoRenewStatus?: number
    autoRenewProductId?: string
    expirationIntent?: number
    gracePeriodExpiresDate?: number
    isInBillingRetryPeriod?: boolean
    originalTransactionId?: string
    renewalDate?: number
    environment?: string
}

/** 애플이 돌려주는 구독 상태 — 구글의 GooglePurchase에 대응 */
export interface ApplePurchase {
    /** 1 활성 · 2 만료 · 3 청구 재시도 · 4 청구 유예기간 · 5 취소(환불·회수) */
    status: number
    /** 구독 identity — subscriptions.store_purchase_token에 저장 */
    originalTransactionId: string
    transactionId: string | null
    productId: string | null
    /** 이용 만료 시각(ISO). 유예기간 중이면 유예 종료일 */
    expiresAt: string | null
    autoRenewing: boolean
    isTrial: boolean
    appAccountToken: string | null
    /** 환불·회수됨(revocationDate 존재) */
    refunded: boolean
    environment: string
    bundleId: string | null
}

interface StatusResponse {
    bundleId?: string
    environment?: string
    data?: Array<{
        subscriptionGroupIdentifier?: string
        lastTransactions?: Array<{
            status?: number
            originalTransactionId?: string
            signedTransactionInfo?: string
            signedRenewalInfo?: string
        }>
    }>
}

/**
 * 거래 조회. 프로덕션에 먼저 묻고, 없으면(404) 샌드박스로 폴백한다 —
 * 심사·내부 테스트 영수증은 샌드박스에만 있고, 반대로 프로덕션 영수증은 샌드박스에 없다.
 */
async function fetchStatuses(transactionId: string): Promise<StatusResponse> {
    const token = getAuthToken()
    const path = `/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`
    let notFound = ""
    for (const base of [PROD_BASE, SANDBOX_BASE]) {
        const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) return (await res.json()) as StatusResponse
        const text = await res.text()
        // 4040010(Transaction id not found): 환경이 다르다는 뜻 → 다음 환경으로
        if (res.status === 404) {
            notFound = text
            continue
        }
        throw new Error(`애플 구독 조회 실패: ${res.status} ${text}`)
    }
    throw new Error(`애플 구독 조회 실패: 404 ${notFound}`)
}

/** transactionId(또는 originalTransactionId)로 구독 실제 상태 조회 */
export async function getSubscription(transactionId: string): Promise<ApplePurchase> {
    const json = await fetchStatuses(transactionId)

    const entries = (json.data ?? []).flatMap((g) => g.lastTransactions ?? [])
    const decoded = entries
        .filter((t) => typeof t.signedTransactionInfo === "string")
        .map((t) => ({
            status: Number(t.status ?? 0),
            tx: verifyAppleJWS<AppleTransactionInfo>(t.signedTransactionInfo as string),
            renewal: t.signedRenewalInfo
                ? verifyAppleJWS<AppleRenewalInfo>(t.signedRenewalInfo)
                : null,
        }))
    if (decoded.length === 0) throw new Error("애플 구독 정보 없음")

    // 요청한 거래와 같은 구독을 고른다. 못 찾으면(그룹 안 다른 상품으로 업/다운그레이드 등)
    // 만료가 가장 늦은 것이 현재 유효한 주기다.
    const picked =
        decoded.find(
            (c) => c.tx.transactionId === transactionId || c.tx.originalTransactionId === transactionId
        ) ??
        decoded.reduce((best, cur) =>
            (cur.tx.expiresDate ?? 0) > (best.tx.expiresDate ?? 0) ? cur : best
        )

    const tx = picked.tx
    if (tx.bundleId && tx.bundleId !== APPLE_BUNDLE_ID) {
        throw new Error(`다른 앱의 영수증: ${tx.bundleId}`)
    }
    const originalTransactionId = tx.originalTransactionId ?? tx.transactionId
    if (!originalTransactionId) throw new Error("애플 거래 식별자 없음")

    // 유예기간(status 4) 중에는 실제 이용 가능 시각이 grace 종료일까지 연장된다
    const graceEnd = picked.status === 4 ? picked.renewal?.gracePeriodExpiresDate : undefined
    const endMs = Math.max(graceEnd ?? 0, tx.expiresDate ?? 0)

    return {
        status: picked.status,
        originalTransactionId,
        transactionId: tx.transactionId ?? null,
        productId: tx.productId ?? null,
        expiresAt: endMs > 0 ? new Date(endMs).toISOString() : null,
        autoRenewing: picked.renewal?.autoRenewStatus === 1,
        // 무료체험은 소개 오퍼로 판매된다(기본 요금제엔 오퍼가 붙지 않는다)
        isTrial: tx.offerDiscountType === "FREE_TRIAL" || tx.offerType === 1,
        appAccountToken: tx.appAccountToken ?? null,
        refunded: typeof tx.revocationDate === "number",
        environment: String(tx.environment ?? json.environment ?? ""),
        bundleId: tx.bundleId ?? null,
    }
}

/**
 * 이용 권한을 즉시 회수해야 하는 상태인가.
 * 만료(2)·청구 재시도(3, 유예기간이 이미 끝난 상태)·취소/환불(5)이 여기 해당한다.
 * 유예기간(4)은 아직 이용을 허용한다(구글 grace, 포트원 past_due와 동일 취급).
 */
export function isRevoked(p: ApplePurchase): boolean {
    return p.refunded || ![1, 4].includes(p.status)
}

/**
 * 애플 구독 상태 → 우리 subscriptions.status.
 *
 * ⚠️ DB의 status 체크 제약은 trialing/active/past_due/canceled 넷만 허용한다.
 * 'expired'를 쓰면 UPDATE가 조용히 실패해 **환불·해지가 반영되지 않는다**(권한이 안 끊김).
 * 그래서 회수 상태는 전부 'canceled'로 매핑하고, 이용 종료는 호출부가
 * current_period_end를 과거로 박아 판정하게 한다(subscriptionAllows가 "canceled + 기간 만료 = 불허").
 */
export function toLocalStatus(p: ApplePurchase): string {
    if (p.refunded) return "canceled"
    switch (p.status) {
        case 1:
            // 자동갱신을 꺼둔 상태 = 해지 예약. 남은 기간까지는 이용 가능(구글 CANCELED와 동일).
            if (!p.autoRenewing) return "canceled"
            return p.isTrial ? "trialing" : "active"
        case 4:
            // 결제 실패 유예기간 — 아직 이용은 허용(PortOne past_due와 동일 취급)
            return "past_due"
        default:
            return "canceled"
    }
}

/** App Store Server Notifications V2 본문(디코드 결과) */
export interface AppleNotification {
    notificationType?: string
    subtype?: string
    notificationUUID?: string
    version?: string
    signedDate?: number
    data?: {
        appAppleId?: number
        bundleId?: string
        bundleVersion?: string
        environment?: string
        status?: number
        signedTransactionInfo?: string
        signedRenewalInfo?: string
    }
    summary?: { environment?: string; appAppleId?: number; bundleId?: string }
}
