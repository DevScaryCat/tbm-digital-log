import { renderApprovalPdf } from "@/lib/approvalPdf";
import type { ReportContent } from "@/lib/monthlyReport";

export const runtime = "nodejs";
export const maxDuration = 30;

// 임시: 결재서류 PDF 샘플 미리보기 (확인 후 제거 예정)
export async function GET() {
  const content: ReportContent = {
    companyName: "비트플립(bitflip)",
    periodLabel: "2026-06-02 ~ 2026-06-17",
    stats: { total: 5, high: 2, mid: 1 },
    keywords: [
      { word: "크레인 인양 시 철근 낙하 위험", count: 1 },
      { word: "크레인 작업 중 주변 근로자 충돌", count: 1 },
      { word: "중량물 취급으로 인한 근골격계 질환", count: 1 },
    ],
    hazards: [
      { factor: "크레인 인양 중 철근 낙하", level: "상", measure: "신호수 배치, 낙하방지망 설치, 하부 출입통제", process: "철근공사", date: "2026-06-02" },
      { factor: "크레인 작업 중 주변 근로자 충돌", level: "상", measure: "작업반경 통제구역 설정, 신호 체계 운영", process: "철근공사", date: "2026-06-02" },
      { factor: "중량물 취급으로 인한 근골격계 질환", level: "중", measure: "2인 1조 운반, 올바른 들기 자세 교육", process: "철근공사", date: "2026-06-02" },
    ],
    aiSummary:
      "이번 기간 총 5건의 TBM 회의록이 작성되었으며, 크레인 인양 시 철근 낙하와 중량물 취급 위험이 반복적으로 지적되었습니다. 특히 크레인 인양 작업 시 낙하 위험이 상위험으로 평가되어 즉각적 개선이 필요합니다. 다음 작업 전 안전점검 강화와 신호수 배치 정착을 권고합니다.",
    riskItems: [
      { hazard: "크레인 인양 중 철근 낙하", cause: "와이어 손상, 슬링 결속 불량, 인양 하중 초과", frequency: 4, severity: 5, risk: 20, level: "매우높음", measures: "2인 1조 체계 운영, 신호수 배치, 작업 전 점검", recurring: true },
      { hazard: "크레인 작업 중 주변 근로자 충돌", cause: "회전반경 내 근로자 진입", frequency: 4, severity: 4, risk: 16, level: "매우높음", measures: "진입 금지, 안전거리 확보", recurring: true },
      { hazard: "중량물 취급 근골격계", cause: "1인 운반, 반복적 중량물 취급", frequency: 3, severity: 2, risk: 6, level: "보통", measures: "2인 1조 운반, 올바른 자세", recurring: false },
    ],
  };

  const pdf = await renderApprovalPdf(content, "TBM 회의록 종합분석 결재 보고서");
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="approval-sample.pdf"`,
    },
  });
}
