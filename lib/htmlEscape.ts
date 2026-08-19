// lib/htmlEscape.ts — HTML 이스케이프 단독 모듈.
//
// 왜 분리했나(2026-08-19 성능 감사): 종전에 escapeHtml이 lib/monthlyReport에 있어서,
// 이 5줄을 쓰려고 consent·orgNotices가 monthlyReport를 import했고, 그 정적 의존
// (@anthropic-ai/sdk·nodemailer 등 수 MB)이 /api/org/context 같은 앱 핫패스 함수
// 번들까지 오염시켰다. monthlyReport는 하위 호환용으로 재수출한다.
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
