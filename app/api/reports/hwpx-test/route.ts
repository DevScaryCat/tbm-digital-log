import { htmlToHwpx } from "@ssabrojs/hwpxjs";

export const runtime = "nodejs";

// 임시 테스트: 결재서류 샘플 .hwpx 생성 → 한글에서 열리는지 확인용. (확인 후 삭제 예정)
export async function GET() {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
    <table border="1" align="right">
      <thead><tr><th>담당</th><th>검토</th><th>승인</th></tr></thead>
      <tbody><tr><td>　　　</td><td>　　　</td><td>　　　</td></tr></tbody>
    </table>
    <h1>위험성평가 결재 보고서</h1>
    <p>현장/업체: 비트플립　·　대상기간: 2026-06-02 ~ 2026-06-17</p>

    <h2>안전활동 요약</h2>
    <table border="1">
      <thead><tr><th>총 회의록</th><th>위험성(상)</th><th>위험성(중)</th></tr></thead>
      <tbody><tr><td>5건</td><td>2건</td><td>1건</td></tr></tbody>
    </table>

    <h2>AI 안전 총평</h2>
    <p>이번 기간 총 5건의 TBM 회의록이 작성되었으며, 크레인 인양 시 철근 낙하와 중량물 취급 위험이 반복적으로 지적되었습니다. 작업 전 안전점검 강화와 신호수 배치 정착을 권고합니다.</p>

    <h2>주요 위험요인</h2>
    <table border="1">
      <thead><tr><th>No</th><th>유해·위험요인 / 공정</th><th>등급</th><th>감소대책</th></tr></thead>
      <tbody>
        <tr><td>1</td><td>크레인 인양 중 철근 낙하 (철근공사)</td><td>상</td><td>신호수 배치, 낙하방지망 설치, 하부 출입통제</td></tr>
        <tr><td>2</td><td>크레인 작업 중 주변 근로자 충돌 (철근공사)</td><td>상</td><td>작업반경 통제구역 설정, 신호 체계 운영</td></tr>
        <tr><td>3</td><td>중량물 취급으로 인한 근골격계 질환</td><td>중</td><td>2인 1조 운반, 올바른 들기 자세 교육</td></tr>
      </tbody>
    </table>

    <h2>위험성평가표</h2>
    <table border="1">
      <thead><tr><th>No</th><th>유해·위험요인 / 원인</th><th>가능성×중대성</th><th>위험성</th><th>감소대책</th></tr></thead>
      <tbody>
        <tr><td>1</td><td>크레인 인양 중 철근 낙하 / 와이어 손상·결속 불량</td><td>4×5</td><td>20 · 매우높음</td><td>2인 1조, 신호수 배치, 작업 전 점검</td></tr>
        <tr><td>2</td><td>주변 근로자 충돌 / 회전반경 내 진입</td><td>4×4</td><td>16 · 매우높음</td><td>진입 금지, 안전거리 확보</td></tr>
      </tbody>
    </table>
  </body></html>`;

  const bytes = await htmlToHwpx(html, { title: "위험성평가 결재 보고서", creator: "안전톡톡e" });
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="report-sample.hwpx"; filename*=UTF-8''${encodeURIComponent("결재서류_샘플.hwpx")}`,
    },
  });
}
