# TBM Digital Log

## 최종 목표
TBM(Tool Box Meeting) 디지털 일지 웹앱 — 현장 안전보건교육 기록을 디지털화하고 AI 요약 기능을 제공하는 모바일 웹 애플리케이션

## 기억해야 할 사항
- **프레임워크**: Next.js + TypeScript + Tailwind CSS
- **백엔드**: Supabase (Auth, Database, Storage)
- **주요 기능**: TBM 일지 작성, TBM 회의록 작성, 녹음 → AI 요약, QR 서명, PDF 출력, 캘린더 대시보드
- **인증**: Kakao 로그인 + 일반 계정 로그인
- **UI 컴포넌트**: shadcn/ui 기반
- **디자인 시스템**: Cursor 디자인 시스템 적용 완료 (`cur-` 토큰 체계)
  - 캔버스: `#f7f7f4` (cur-canvas, warm cream)
  - 카드: `#ffffff` (cur-card)
  - 강조: `#efeee8` (cur-elevated)
  - 프라이머리: `#f54e00` (cur-primary, Cursor Orange)
  - 잉크: `#26251e` (cur-ink, warm dark)
  - 헤어라인: `#e6e5e0` (cur-hairline)
  - 성공: `#1f8a65` / 에러: `#cf2d56`
  - 참고 문서: `cursor/DESIGN.md`

---

## 진행 로그

### [2026-05-21] Supabase Storage 마이그레이션 및 RLS 최적화
- **완료 내용**:
  - 기존 DB 테이블 내 base64 이미지 데이터를 Supabase Storage 버킷(`signatures`, `photos`)으로 순차적으로 완전 이관 완료 (총 563건 서명, 179건 사진, 26건 대기 서명, 12건 회의록 서명).
  - 서명 제출 페이지, TBM 일지 작성, 회의록 작성 시 base64 데이터를 Storage에 자동 업로드하고 DB에는 퍼블릭 URL을 저장하도록 코드 수정 완료.
  - Next.js 프로덕션 빌드 성공 확인 (`exit code 0`).
  - user_metadata 참조 RLS 취약점을 해결하기 위한 SQL 패치 코드 (`fix_rls_security.sql`) 작성 완료.

### [Ongoing] DB 쿼리 보안 RLS 조치 및 테스트 피드백
- **다음 단계**:
  - 사용자가 Supabase SQL Editor에서 `fix_rls_security.sql`을 실행하여 RLS 보안 권장사항 완벽 조치.
  - (분석 완료된 피드백 기반) "교육 장소"/"TBM 장소" 필드 현장명 자동 입력 로직 반영.
  - 회의록 녹음 UI의 일시정지 횟수 표시 등 세부 UI 개선 사항 반영.
