// app/api/app/version/route.ts — 앱이 실행 시 물어보는 "지금 최신이 뭔가"
//
// 스토어 자동 업데이트는 사용자 설정·Wi-Fi 상태에 따라 며칠씩 늦는다. 결제·법정서식처럼
// 서버와 계약이 맞아야 하는 기능이 바뀌면 구버전이 조용히 깨지므로, 앱이 직접 물어보고
// 필요하면 업데이트를 안내한다.
//
// 환경변수로 덮어쓸 수 있다(급할 때 코드 배포 없이 조정).
//   APP_MIN_VERSION    : 이 버전 미만이면 사용을 막고 업데이트를 요구(강제)
//   APP_LATEST_VERSION : 이 버전 미만이면 닫을 수 있는 안내만(권장)
//
// ⚠️ 다만 **기본값을 0.0.0으로 두면 안 된다**. 2026-08-09 실측: 두 환경변수가 한 번도 설정된 적이 없어
//    이 API가 계속 0.0.0을 반환했고, 그래서 UpdateGate의 "새 버전이 나왔어요" 배너가 **한 번도 뜬 적이 없다**.
//    1.3.6을 Play에 100% 배포하고도 1.3.5 사용자에게 아무 안내가 안 갔다.
//    → 기본값을 코드에 박아 릴리스 커밋에서 같이 올린다. 환경변수를 잊어도 배너는 동작한다.

import { NextResponse } from "next/server"

/** 스토어에 올라간 최신 앱 버전. **앱 릴리스마다 여기를 같이 올린다**(app.config.js의 version과 일치). */
const LATEST_APP_VERSION = "1.3.6"
/** 이 버전 미만은 서버와 계약이 안 맞아 저장·결제가 깨지는 경우에만 올린다. 함부로 올리면 사용자를 잠근다. */
const MIN_APP_VERSION = "0.0.0"

export const runtime = "nodejs"
// 앱이 켜질 때마다 호출되므로 CDN에 잠깐 태워 원본 호출을 줄인다
export const revalidate = 300

/** iOS 최신 버전 — iOS 릴리스마다 올린다. 아직 미출시라 0.0.0(배너 영구 침묵). */
const LATEST_APP_VERSION_IOS = "0.0.0"
/** App Store 앱 페이지 — 출시 후 실제 앱 ID URL로 교체(비어 있으면 앱이 배너를 숨긴다) */
const IOS_STORE_URL = ""

export async function GET(request: Request) {
    // 플랫폼 무구분이면 iOS 사용자가 '새 버전' 배너에서 Google Play로 보내진다(2026-08-16 QA).
    // 파라미터 누락(구버전 앱)은 안드로이드로 폴백 — 현행 사용자 전원이 안드로이드다.
    const platform = new URL(request.url).searchParams.get("platform") === "ios" ? "ios" : "android"
    const body = platform === "ios"
        ? {
            minVersion: process.env.APP_MIN_VERSION_IOS ?? MIN_APP_VERSION,
            latestVersion: process.env.APP_LATEST_VERSION_IOS ?? LATEST_APP_VERSION_IOS,
            storeUrl: process.env.APP_STORE_URL_IOS ?? IOS_STORE_URL,
        }
        : {
            minVersion: process.env.APP_MIN_VERSION ?? MIN_APP_VERSION,
            latestVersion: process.env.APP_LATEST_VERSION ?? LATEST_APP_VERSION,
            storeUrl: "https://play.google.com/store/apps/details?id=kr.bitflip.tbm",
        }
    return NextResponse.json(body, {
        headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    })
}
