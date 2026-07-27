import { notFound } from "next/navigation"
import { SAMPLE_MINUTES_HTML, SAMPLE_EDU_HTML } from "@/components/reportSampleHtml"

// 예시 보고서 전체 화면 — 보고서 화면 '미리보기'에서 새 탭으로 연다.
// 실제 발송본 뷰어(/report/monthly/[token])와 같은 배경·여백. 예시 HTML은 max-width:640 유동이라 축소 없이 폰 폭에 맞는다.
const SAMPLES = {
    minutes: SAMPLE_MINUTES_HTML,
    edu: SAMPLE_EDU_HTML,
} as const

export default async function SampleReportPage({
    params,
}: {
    params: Promise<{ kind: string }>
}) {
    const { kind } = await params
    if (kind !== "minutes" && kind !== "edu") notFound()
    const html = SAMPLES[kind]

    return (
        <div style={{ minHeight: "100vh", background: "#f7f7f4", padding: "24px 12px" }}>
            <div style={{ maxWidth: 640, margin: "0 auto 12px", fontFamily: "'Apple SD Gothic Neo', Arial, sans-serif", fontSize: 13, color: "#807d72", textAlign: "center" }}>
                예시 보고서입니다 — 실제 발송본은 지난달 데이터로 채워집니다.
            </div>
            <div dangerouslySetInnerHTML={{ __html: html }} />
        </div>
    )
}
