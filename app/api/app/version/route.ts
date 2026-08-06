// app/api/app/version/route.ts — 앱이 실행 시 물어보는 "지금 최신이 뭔가"
//
// 스토어 자동 업데이트는 사용자 설정·Wi-Fi 상태에 따라 며칠씩 늦는다. 결제·법정서식처럼
// 서버와 계약이 맞아야 하는 기능이 바뀌면 구버전이 조용히 깨지므로, 앱이 직접 물어보고
// 필요하면 업데이트를 안내한다.
//
// 값은 환경변수로만 바꾼다 — 배포 없이 즉시 반영되고, 잘못 올렸을 때 되돌리기도 쉽다.
//   APP_MIN_VERSION    : 이 버전 미만이면 사용을 막고 업데이트를 요구(강제)
//   APP_LATEST_VERSION : 이 버전 미만이면 닫을 수 있는 안내만(권장)

import { NextResponse } from "next/server"

export const runtime = "nodejs"
// 앱이 켜질 때마다 호출되므로 CDN에 잠깐 태워 원본 호출을 줄인다
export const revalidate = 300

export async function GET() {
    return NextResponse.json(
        {
            // 기본값은 "아무도 막지 않음" — 환경변수를 올려야 비로소 동작한다
            minVersion: process.env.APP_MIN_VERSION ?? "0.0.0",
            latestVersion: process.env.APP_LATEST_VERSION ?? "0.0.0",
            storeUrl: "https://play.google.com/store/apps/details?id=kr.bitflip.tbm",
        },
        { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } }
    )
}
