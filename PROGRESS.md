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

### [2025-05-17] Cursor 디자인 시스템 전면 적용 (bnc- → cur- 마이그레이션)
- **완료 내용**:
  - `globals.css` 전면 재작성 — Cursor 라이트 테마 CSS 변수 (`cur-` 접두사)
  - shadcn/ui 시맨틱 토큰(--primary, --card 등) Cursor 팔레트로 재설정
  - `layout.tsx` 업데이트 — warm cream 캔버스, Inter + JetBrains Mono 폰트 스택
  - `TBMHeader.tsx` Cursor 스타일 리디자인 (오렌지 아이콘, 라이트 드롭다운)
  - 전체 TSX 파일 sed 일괄 치환: `bnc-` → `cur-` 토큰 (100% 완료)
  - 추가 하드코딩 hex 색상 일괄 치환: `#000000`, `#dc2626`, `#fef2f2` 등 → 시맨틱 토큰
  - `slate-` Tailwind 유틸리티 전량 → `cur-` 토큰으로 치환 (privacy, terms, sign, history 등)
  - `app/tbm/page.tsx` 783번줄 Turbopack 파싱 에러 **수정 완료** (삼항 연산자 닫기 태그 구조 교정)
  - **프로덕션 빌드 성공 확인** (exit code 0)

### [2026-05-17] 메인페이지 UI 개선 및 직군 데이터 마이그레이션
- **완료 내용**:
  - 메인페이지 메뉴 텍스트 및 서브타이틀 직관적으로 변경 ("안전보건교육일지 작성" 등)
  - 법정 의무 교육 진행도 막대 개선: 100% 초과 시 퍼센트 표시 및 초록색(success) 시각적 효과 추가
  - "관리감독자" 직군 선택지 삭제 및 기본값을 "현장 근로자 (비사무직)"로 변경
  - DB 마이그레이션: 기존 `worker_type`이 "관리감독자"인 유저들을 "현장 근로자 (비사무직)"로 일괄 업데이트 완료

### [Ongoing] UX 워크플로우 병렬화 및 UI 피드백 반영
- **다음 단계**: 
  - (분석 완료된 피드백 기반) "교육 장소"/"TBM 장소" 필드 현장명 자동 입력 로직 반영
  - 회의록 녹음 UI의 일시정지 횟수 표시 등 세부 UI 개선 사항 반영
