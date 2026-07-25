# 안톡 2계층 구조 설계 — 안전관리자 / 관리감독자

> 2026-07-25 확정. 결정권자: Chris. 코드 스캔 + 적대적 검증(게이팅·결제·플로우 3렌즈) 반영 완료판.
> 원칙: **user_id 축(계정=현장=데이터 소유)은 건드리지 않고**, 그 위에 조직 레이어만 얹는 최소 침습 설계.

## ⚡ 구현 상태 (2026-07-25)

**Phase 0~4 구현 완료.** 타입체크·프로덕션 빌드 통과, 마이그레이션 3건 라이브 DB 적용
(`20260725000000` 기반 스키마 / `20260725010000` 아이디 조회 RPC / `20260725020000` 좌석 감축 캡).
구현 후 4-렌즈 적대 코드리뷰(결제·권한·cron·UI)에서 확정 버그 ~15건 발견 → 전부 수정:
checkout 이중청구·영구무료 가드, 첫 결제 실패 롤백, attach 순서(좌석→정산), owner 편입 금지,
좌석 감축 레이스 캡(RPC), owner AI 무제한 구멍, cron 멱등 kind 분리(org_*/member_monthly_{id}),
grandfather 복원, 셀프 강등 우회 차단, manager 무료체험 우회 차단, 만료 owner 재결제 경로,
org 캐시 레이스, 리디렉션 ctx 유실 방어 등. 상세는 git diff.

**남은 것(코드 밖):** 커밋·배포(Chris), PortOne 실결제 QA(org checkout·좌석 증설 일할),
cron 실발송 prod `?force=1` 테스트, 이현로지스 편입 파일럿(§8 Phase 5),
APP_DEPLOY_PLAN.md의 risk-assessment 범위 조정 반영.

---

## 0. 확정 결정 요약

| # | 결정 |
|---|---|
| 1 | 하위 계정 = **현장** (사람 아님). 담당자 이름은 `/profile`에서 상시 수정 |
| 2 | 안전관리자 = **순수 관리 전용** (TBM·교육일지 작성 불가). 화면 = 관제 대시보드 + 현장 분석 + 보고서 + 보고서 설정 + 좌석/결제 |
| 3 | **상중하법·빈도강도법(등급 산정) 전면 제거** — TBM 기반 정식 위평 포지셔닝 회피, "정보성 기록"으로 전환. 전 유저 공통 |
| 4 | org 소속 관리감독자의 보고서 = **앱 내 화면 없음**. 매달 1일 자기 현장 월간 보고서를 **본인 인증 이메일로 발송**. 열람은 이메일에서 |
| 5 | 가격 = **관리감독자 좌석당 4,900원 × N**, 안전관리자 총합 결제. 상위 기본료 없음. 단독(시나리오 2)은 현행 1,900/4,900 유지 |
| 6 | AI 분석 월 한도 = **대상 현장당 20회** (org 총량 아님). 생성 주체는 상위 — 하위는 AI 분석 실행 불가 |
| 7 | 좌석 **증설 = 즉시 일할 청구·즉시 활성 / 감축 = 다음 결제일부터** |
| 8 | 상위 결제 실패(3회) → 하위 **시나리오 2 상태로 강등, 유예 없음**. 이후 미구독 유저와 동일 취급 |
| 9 | 초대 = **직접 아이디/비번 발급이 메인**, 초대 링크는 보조. 초대 경로에서 휴대폰 무료체험 **미발급** |
| 10 | 단독→조직 합류의 정산 상세 = 보류. 단 편입 메커니즘은 11번으로 커버 |
| 11 | 기존 유저 강제 이전 없음(전원 시나리오 2 유지). **기존 계정 편입 기능은 정식 포함** (아이디 초대 → 수락 → 하위 귀속) |
| 12 | 수신자 승인제 = 시나리오 2 현행 유지. org에선 상위 계정의 수신처 기능으로 재사용 |

시나리오 2(단독)가 존재하므로 보고서·설정·AI 분석은 **제거가 아니라 "org 소속 여부"로 조건부 노출**. 그리고 검증 결과의 핵심 교훈: **"메뉴 숨김 + DB 트리거"만으론 부족하다 — 페이지 redirect와 API 403을 역할 매트릭스(§4-C)로 전 라우트에 명시적으로 건다.**

---

## 1. 데이터 모델

### 신규 테이블

```sql
create table organizations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users(id),  -- 안전관리자
  name text not null,                     -- 회사명
  seat_count int not null default 1,      -- 결제된 좌석 수
  pending_seat_count int,                 -- 감축 예약 (다음 청구일 적용, §6)
  created_at timestamptz default now()
);

create table org_members (
  org_id uuid not null references organizations(id),
  member_user_id uuid not null unique references auth.users(id), -- 한 계정은 한 조직에만
  status text not null default 'active' check (status in ('active','detached')),
  joined_at timestamptz default now(),
  detached_at timestamptz,
  primary key (org_id, member_user_id)
);

create table org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  token text not null unique default encode(gen_random_bytes(18),'hex'),
  kind text not null check (kind in ('link','attach')),  -- link=신규 가입, attach=기존계정 편입
  target_user_id uuid references auth.users(id),          -- attach일 때 대상 계정
  expires_at timestamptz not null default now() + interval '14 days',
  used_at timestamptz,
  created_at timestamptz default now()
);
```

RLS: 세 테이블 모두 소유자·본인 SELECT만, 쓰기는 서버(service role). 하위 데이터 RLS는 현행 그대로 — 상위 열람은 서버 경유(§4).

### subscriptions 확장 (plan 값 2개 추가)

| plan | 누구 | amount | billing_key | 의미 |
|---|---|---|---|---|
| `org` | 안전관리자 | 청구 시점 `seat_count × 4,900` 재계산 | 있음 | 관리 기능 허용, 작성 불허 |
| `org_seat` | 하위 | 0 | null | Pro 상당 — 단 §4-C 매트릭스가 우선 (보고서·AI 계열은 차단) |

- 하위는 발급/편입 시점에 본인 `subscriptions` 행을 `plan='org_seat'`로 upsert(UNIQUE(user_id) 활용). cron 청구 대상에서는 `billing_key null`로 자동 제외됨(검증 확인).
- **미러 status 규칙**: 상위 `active`·`past_due` → 하위 `active` (past_due를 그대로 미러하면 클라이언트 `isAllowed`가 past_due를 불허해서 재시도 기간에 하위가 조기 강등됨 — `lib/useSubscription.ts:51` vs `lib/portone.ts:89` 불일치). 상위 `canceled` → 하위 `canceled + current_period_end=now` (즉시 차단 확인됨).
- **게이트는 3겹이 아니라 4겹** — 전부 수정 필요:
  1. 서버 `subscriptionAllows`/`isPro` (`lib/portone.ts`) — PLANS에 org/org_seat 추가, isPro에 org_seat 포함
  2. 클라 `isAllowed`/`isProActive`/`planBadge` (`lib/useSubscription.ts:20,31,51`) — **monthly_pro 하드코딩** 확장 필수 (안 하면 하위가 베이직 UI·베이직 배지)
  3. `components/TBMHeader.tsx:24-31` LIMITS 맵 — org_seat=Pro 한도, org 전용 표시
  4. DB 트리거 `enforce_tbm_monthly_limit` — **함수 재정의 마이그레이션 필수.** 현행은 `when 'monthly_pro' then X else Y` 구조라 미지정 plan은 "차단"이 아니라 **베이직 한도(80/10, 위평 0)로 조용히 열화**된다. `org_seat`=Pro 한도(200/30/20), `org`=**세 분기 모두 명시적 0** (else가 80/10을 주므로 명시 없이는 상위 작성이 안 막힘).
- **selectable 화이트리스트**: `change-plan`·`billing-key` 라우트가 body의 plan을 그대로 `getPlan()`에 넘기므로, PLANS에 org_seat(0원)를 추가하는 순간 아무나 `pending_plan='org_seat'`로 0원 Pro를 예약할 수 있다. PLANS에 `selectable: false` 플래그를 두고 두 라우트에서 거부. `plan='org'` 구독의 pending_plan 설정도 차단(§6과 충돌).

### 실이메일 (결정 4의 전제)

현행 계정 이메일은 가상(`{아이디}@tbm.com`) — 실수신 가능 이메일이 없다.

- `user_metadata.real_email` + `real_email_verified_at`. 인증 = **만료 있는** 토큰 메일 (기존 consent 토큰이 무만료였던 전례 반복 금지).
- 링크 가입: 위저드에서 휴대폰(솔라피 게이트 현행 유지) + 이메일 인증. **직접 발급: 생성 시점엔 반장이 없으므로 인증 불가 → 첫 로그인 시 이메일 인증 배너만 요구, 휴대폰 인증은 생략** (상위가 신원 보증하는 경로. 기본값이며 조정 가능).
- 미인증이면 월간 발송 skip + 하위 홈에 인증 배너 1개.

---

## 2. 역할 판정 (분기 키)

진실의 원천은 DB 한 곳:

```
owner  = organizations.owner_user_id 에 존재
member = org_members(status=active) 에 존재
solo   = 둘 다 아님 → 현행 화면·요금 그대로
```

- `user_metadata.role`은 표시용(카카오 가입자는 메타데이터 결격).
- 서버 유틸 `getOrgContext(userId)` → `{ kind: 'owner'|'member'|'solo', org?, memberIds?, pendingAttach? }`. 클라이언트 컴포넌트(홈 `app/page.tsx` 등)는 서버 유틸을 직접 못 부르므로 **`/api/org/context` 엔드포인트 신설** — 홈 스왑·헤더 분기·attach 수락 모달이 전부 이걸 소비.
- **강등 동기화는 2중**: ① 해지·강등이 일어나는 그 자리에서 즉시 (수동 해지 cancel 라우트, 3회 실패 처리 직후) ② cron 말미에 멱등 reconciliation 스윕(`plan='org'`·canceled인 구독의 미동기 org_seat 미러 일괄 canceled) — canceled 전이 경로가 cron 밖에도 있어(수동 해지, 재구독 실패) 스윕 없이는 누수.
- **활성 member의 개인 결제 차단**: member가 `/account`·`/pricing`(헤더에 노출됨)에서 개인 카드를 등록하면 본인 행이 덮여 **자기도 모르게 detach**되고 상위는 좌석비를 계속 낸다. 결제 라우트에서 member는 403 + 두 페이지에 "조직 소속 계정입니다" 안내로 대체.

---

## 3. 온보딩·가입·초대·편입

### /start 역할 선택

```
[안전관리자로 시작]  → 안전관리자 가입 위저드
[관리감독자로 시작]  → 초대 코드 있음 → org 가입 위저드
                      없음 → 현행 가입 위저드 (시나리오 2, 변경 없음)
```

- 카카오 OAuth = 시나리오 2 전용 현행 유지. **카카오 세션이 있는 브라우저에서 초대 링크를 열면 로그아웃 후 진행 안내** (start는 로그인 세션을 홈으로 강제 리다이렉트하는 현행 패턴이 있어 명시 필요).
- **카카오 단독 유저는 attach 편입 대상에서 v1 제외** — 편입이 아이디(`{id}@tbm.com`) 기반인데 카카오 계정은 아이디가 없다. (필요해지면 별도 설계)
- 이미 계정 있는 반장이 신규 가입 링크를 열면 "기존 계정은 편입으로" 안내 문구.

### 안전관리자 가입·결제

1. 아이디/비번 (현행 1단계 재사용)
2. 회사명 + 좌석 수 선택
3. 결제 — **기존 billing-key 라우트 재사용 금지.** 그 라우트는 `trial_used=false`면 무조건 첫 달 무료 체험을 부여하고(`billing-key/route.ts:146-184`), 재구독 경로는 정적 plan 금액을 upsert한다. **org 전용 결제 라우트 신설**: 빌링키 발급 → 체험 없이 `seat_count × 4,900` 즉시 청구 → `plan='org'` upsert.
4. 완료 → 좌석 관리 페이지

`/api/signup`의 org 분기에서 **3가지를 모두 skip**: ① 본인 명의 구독 upsert ② `trial_redemptions` insert ③ 중복 번호 409 롤백. ③이 특히 중요 — 과거 체험을 쓴 번호의 반장(기존 단독 유저 출신이 흔함)이 초대 가입에서 409로 원천 차단되는 걸 방지. 대신 org_seat 미러 upsert 수행 (실패 시 구독 행 없음 → 모든 게이트 fail-closed 확인됨).

### 하위 계정 만들기 (3경로)

| 경로 | 흐름 | 비고 |
|---|---|---|
| **직접 발급 (메인)** | 상위가 현장명+아이디/비번 입력 → 서버가 계정 생성+org 귀속+미러 구독 → 반장에게 전달 | `/api/admin/create` 패턴 재활용. 첫 로그인 시 이메일 인증 배너(§1) |
| 초대 링크 (보조) | 14일 만료 링크 → org 가입 위저드(아이디/비번+현장명+휴대폰·이메일 인증) | 좌석 여유 검증. **동시 가입 레이스는 서버 트랜잭션(advisory lock)으로 좌석 검증** |
| **기존 계정 편입 (attach)** | 상위가 기존 아이디 입력 → attach 초대 → 대상 계정 다음 로그인 때 **홈에서 수락 모달**(`/api/org/context`의 pendingAttach) → 수락 시 org 귀속+미러 전환 | 이현로지스 전환 경로 |

**attach 수락 시 처리 순서**: ① 기존 개인 유료 구독 일할 환불+해지 — 현행 cancel 라우트 로직을 **lib 함수로 추출**해서 호출(라우트 인라인이라 현재는 재사용 불가). **grandfather는 환불·해지 스킵**(cancel 라우트가 grandfather를 400 거절하므로 분기 필수, §9.3) ② org_seat 미러 upsert ③ 수락 화면에 **"기존 수신자에게 가던 보고서가 중단됩니다" 고지** — 편입 즉시 그 계정의 승인 수신자 발송이 멈춘다(§7). 수신을 유지하려면 상위가 자기 수신처에 재등록. detach로 단독 복귀 시 묵은 승인이 자동 재개되는 것도 명시된 동작으로 수용.

**기존 단독 유저의 "상위 승격"은 미지원** — 결정 1·2상 상위는 현장 데이터가 없는 관리 전용 계정이어야 하므로, 데이터 있는 기존 계정을 owner로 전환하지 않는다. 회사 전환 시 상위는 **신규 계정**으로 만들고 기존 현장 계정들은 attach로 편입 (이현로지스: 본사 담당자가 새 안전관리자 계정 생성 → 기존 2현장 attach).

---

## 4. 화면·권한

### A. 상위 화면 (신규, 관리 전용)

| 화면 | 내용 | 데이터 경로 |
|---|---|---|
| 관제 대시보드 (홈) | 현장 목록 + 오늘 TBM 여부·서명 수·최근 활동 | 서버 라우트(service role + `getOrgContext` 멤버 검증). RLS 개방 없음 |
| 현장 분석 | 현장 선택 → 통계 서버 렌더 | `buildMinutesContent(admin, userId…)` 등 기존 서버 부품 재사용 |
| 보고서 | 월별 병합 열람(종합+현장별 소계) | `buildMergedMinutesContent` — 이미 가동 중인 코드 재사용 |
| 보고서 설정 | 수신처(승인제 재사용, 외부·원청용) + 미리보기 | 위평 방법 설정은 삭제(§5)라 이것만 남음 |
| 좌석·계정 관리 | 하위 목록, 발급/초대/편입, 비번 리셋, 좌석 증감, detach | §3, §6 |
| 결제 관리 | 현행 `/account` 재사용 + 좌석·총액 표시 | |

상위의 AI 분석 실행: 대상 현장 선택 → 서버가 해당 하위 user_id로 컨텍스트 빌드(현행 클라이언트 직조회는 상위 화면에서 불가 → 서버 라우트로 이관). **한도는 `tbm_risk_assessments.user_id = 대상 하위`로 insert**해서 현장당 20회가 트리거 그대로 작동.

### B. 상위의 작성 기능 차단 = 3중

트리거 0 한도(§1)는 **INSERT 시점**에만 걸린다 — 상위가 `/safety-log`·`/tbm-minutes`에 URL로 들어가 녹음→STT→AI 정리까지 다 돌리고(AI 비용 발생) 저장에서야 막히는 구멍이 있으므로:

1. 페이지: `/safety-log`, `/tbm-minutes`, `/education-progress`, `/suggestions` → owner는 관제 대시보드로 redirect
2. API: `/api/ai/stt`·`minutes`·`summary`(현재 `allowed`만 확인) → **owner 403**
3. 트리거 0 한도 (최후 방어)

부수: 홈의 출력형식/worker_type 온보딩 모달은 owner 제외(owner는 문서 출력 안 함).

### C. 라우트 × 역할 매트릭스 (검증에서 잡힌 핵심 — 메뉴 숨김만으론 뚫림)

org_seat가 isPro에 포함되는 순간 isPro만 보는 라우트가 전부 member에게 열리므로, 아래를 명시적으로 건다:

| 대상 | owner | member | solo(Pro) |
|---|---|---|---|
| `/report-settings` 페이지, `/api/reports/recipients` POST | ✅ (org 수신처) | ❌ redirect/403 | ✅ |
| `/risk-assessment` 페이지, `/api/ai/risk-assessment` | ✅ (대상 현장 지정) | ❌ | ✅ |
| `/api/reports/risk-assessment/send`·`education/send`·`/api/reports/send` | ✅ | ❌ (아니면 하위가 임의 이메일로 발송 가능 — 결정 4 위반) | ✅ |
| 문서 출력 render/download 계열 (`/report/[id]`, `/report/batch`, minutes·education render) | — | ✅ 유지 (현장 실무) | ✅ |
| TBM·교육일지 작성 (페이지+AI stt/minutes/summary) | ❌ (§4-B) | ✅ | ✅ |
| `/api/payments/*` (빌링키·플랜변경) | ✅ (org 결제) | ❌ (§2 셀프 detach 방지) | ✅ |

member 화면 변화 = 헤더 드롭다운 보고서 설정 제거 + 대시보드 "이 기간으로 AI 분석" 버튼 제거 + 위 매트릭스의 서버 게이트. solo = 현행 그대로.

---

## 5. 위평 등급 제거 (결정 3 — 전 유저 공통, 독립 작업이라 최우선 착수)

- **제거**: 상중하/빈도강도 선택 UI, 매트릭스 설정, `risk_assessment_method`·`risk_matrix` 소비 로직, AI 출력의 `frequency/severity/level`, xlsx·PDF 등급 컬럼, `lib/riskMatrix.ts`(삭제 후보)
- **유지**: hazard·cause·measures·recurring
- **문구**: 노출명은 이미 "AI 분석 보고서". 출력물·메일의 "위험성평가(표)" 단정 표현을 "위험요인 분석" 계열로 교체, 법정 서식 대체 인상 문구 전수 점검
- 영향: `app/api/ai/risk-assessment`·`minutes`·`suggestion-hazards`, `lib/approvalPdf.tsx`, `lib/reportXlsx.ts`, `components/ReportSettingsPanel.tsx`, **`lib/useSubscription.ts`·`TBMHeader.tsx`**(플랜 표시 연동), `lib/portone.ts:113-115`의 riskMethod 강제 로직 소멸 — 이게 Phase 0로 먼저 끝나면 §1의 isPro 확장 부작용도 함께 소멸

---

## 6. 결제 (좌석제) — 검증 반영 상세

- **정기 청구 (`lib/billing.ts` 수정)**: `plan='org'`이면 chargeSubscription **내부에서** organizations를 조회해 `seat_count × 4,900` 재계산. 수정 지점 3곳 = amount 결정(L104-105) / orderName(L130) / paid 시 planChange(L181-183). **org 분기는 pending_plan 삼항보다 앞에** (pending_plan이 최우선이라 안 그러면 재계산을 가로챔 — org에는 pending_plan 자체를 금지). `opts.amount`는 최우선 유지(즉시결제 경로 공존). ~~opts.amount 주입 방식~~은 재구독 경로가 스냅샷을 청구하게 되므로 채택 안 함.
- **증설**: 좌석 +N → 즉시 `(잔여일/주기일) × 4,900 × N` 일할 청구. **chargeSubscription 재사용 금지** — 정기결제 후 `current_period_end`가 다음 결제일로 가 있어 `periodPaymentId`가 **다음 기간의 id를 선점**하고, 그러면 다음 달 cron이 "이미 결제됨" skip을 영원히 반복(정기청구 영구 누락). `chargeWithBillingKey` 직접 호출 + **전용 paymentId 체계 `seat_{subId}_{yyyymmdd}_{n}`** + payments 직접 insert.
- **감축**: `organizations.pending_seat_count`에 예약 → 다음 청구 성공 시 적용. 청구 paid 브랜치의 낙관적 잠금 update가 현재 affected rows를 확인하지 않으므로(L198), 좌석 반영을 얹을 땐 `.select()`로 매치 확인 후 org 갱신. 감축 후 active 멤버 수 > 새 좌석이면 상위가 좌석 관리에서 detach 대상을 선택해야 확정.
- **detach (모든 경로 공통)**: org_members `detached` + **미러 행 `canceled, current_period_end=now` 원자 갱신.** 이거 없으면 detach된 계정의 `org_seat/active/0원` 행이 남아 **영구 무료 Pro**가 된다 (게이트 4겹 전부 subscriptions 행만 읽음 — 검증 확인).
- **실패**: 현행 3회 재시도(past_due) → canceled → §2 강등 동기화. past_due 동안 하위는 active 미러 유지(§1 정규화 규칙).
- **해지(상위 자진)**: 일할 환불 재사용하되 **환불 기준 수정 필요** — 현행 cancel 라우트는 "마지막 paid 1건" 기준이라 증설 proration 건이 끼면 환불액·주기 시작일을 proration 건으로 오인. 정기 건(`payment_id LIKE 'sub_%'`) 기준 + proration 별도 합산. 해지 후 하위 전원 강등(§2 즉시 동기화 경로).
- 시나리오 2 요금제·grandfather 변경 없음.

---

## 7. 보고서 파이프라인 (cron 개편)

매월 1일 KST:

1. **org 병합**: 하위 현장 병합 → `monthly_reports`에 **user_id=owner**로 upsert(기존 unique 키 user_id+연월 그대로 활용, 상위 웹 열람) + 상위 승인 수신처(외부·원청)로 발송
2. **하위 개별**: 각 하위의 자기 현장분을 본인 인증 이메일로 발송. 멱등 가드 `consolidated_report_sends`에 **새 kind 값 `member_monthly`** 사용 — 하위 실이메일이 시나리오 2 쪽 수신자 이메일과 같은 경우(같은 원청 담당자, 현실적으로 흔함) 기존 kind와 충돌해 한쪽이 조용히 skip되는 것 방지
3. **시나리오 2 (기존 승인제 경로)**: 현행 유지 + **`org_members(active)` 제외 조인을 validPro 구성부(65-77행)에 추가.** ⚠️ 이 라우트의 `plan !== 'monthly_pro'` 필터(73행)에 org_seat를 **추가하지 말 것** — 추가하면 편입 계정(기존 승인 수신자 행이 남아 있음)이 승인제 경로로 되살아나 이중 발송된다. 현행 필터가 org_seat를 자연 배제하므로 이 필터는 시나리오 2 전용으로 그대로 두고, org_seat의 Pro 매핑은 portone/useSubscription 게이트와 위 1·2 신규 경로에만 적용

---

## 8. 착수 순서 (Phase)

| Phase | 내용 | 의존성 |
|---|---|---|
| **0. 등급 제거** | §5 전체. 법적 리스크 제거 급함 + 독립 | 없음 |
| **1. 스키마·판정** | 신규 3테이블, plan 2종+selectable, **트리거 함수 재정의 마이그레이션**(org=명시적 0), 4겹 게이트 확장(클라 포함), `getOrgContext`+`/api/org/context`, 실이메일 | 없음 |
| **2. 가입·결제** | /start 역할 선택, 상위 가입+**org 전용 결제 라우트**, 발급/링크/attach 3경로, signup 3-skip 분기, billing.ts org 재계산·증설 전용 paymentId·감축·detach 동기화, cancel 로직 lib 추출·환불 기준 수정 | 1 |
| **3. 상위 화면** | 관제 대시보드, 현장 분석, 병합 열람, 좌석 관리 + **§4-B/C 게이트 일괄 적용** | 1 |
| **4. 파이프라인** | cron 개편(§7), 하위 이메일 발송, member 화면 마이너스, 강등 reconciliation 스윕 | 1–3 |
| **5. 파일럿** | 이현로지스 attach 실전 검증 → 회사단위 결제 첫 매출 | 전부 |

**앱(APP_DEPLOY_PLAN.md) 파급**: 앱 = member/solo용 현장 도구. Phase 3 목록의 risk-assessment는 "solo 전용 + 등급 제거 반영"으로 조정, 관리 기능은 웹 전용. 4.2 최소기능 방어 논리는 "일지 작성·문서 출력·(solo) AI 분석"으로 재구성.

## 9. 열린 항목 (기본값으로 진행, 이견 시 조정)

1. 상위 무료체험 없음(즉시 결제) — 나중에 체험을 넣게 되면 미러 status는 trialing이 아니라 active로 쓸 것(카드 없는 trialing 만료 차단 로직에 하위가 걸리는 지뢰)
2. 편입 시 기존 개인 유료 구독 = 일할 환불+해지 (결정 10 보류의 최소 규칙)
3. grandfather 편입 = 환불·해지 스킵, 좌석 차지(4,900 과금 대상), detach 시 grandfather 지위 복원
4. 죽은 코드 정리: `generateAndSendRangeReport`(호출처 0 확인, 삭제 가능). **`subscriptions.report_recipients` 컬럼은 `/api/reports/send` 라우트(배포됨, UI 미사용)가 아직 읽으므로 라우트 제거/개편과 함께** drop
5. PortOne이 실패한 paymentId 재사용 시 금액 변경(재시도 중 좌석 변경 케이스)을 허용하는지 확인 — 안 되면 기간키에 시도 차수 포함
6. consent 토큰 무만료(사실 확인됨) — 이번 개편에서 신규 발급분부터 expires_at 부여 권장
7. 직접 발급 경로의 휴대폰 인증 생략(§1) — Chris 컨펌 필요 시 조정
