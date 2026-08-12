-- 감독자 알림 원장 (2026-08-12) — 순수 추가 DDL. 기존 행을 UPDATE·DELETE 하지 않는다.
--
-- 왜 테이블이 필요한가: 감독자의 "결제가 끊겼다"는 상태에서 파생 가능하므로(본인 구독 + 멤버 존재)
-- 배너는 파생값으로 그린다. **파생 불가능한 이벤트**가 딱 둘이다 —
--   ① 현장 계정이 '알리기'를 눌렀다  ② 현장 계정이 스스로 나갔다
-- 그리고 "이미 보냈는가"(이메일 중복 방지)도 상태에서 알 수 없다. 이 세 가지만 여기에 남긴다.
--
-- 중복 방지의 원리: 카운터가 아니라 **unique(dedupe_key) + insert 충돌**이다.
-- "보냈는지 조회 → 안 보냈으면 발송 → 기록"은 크론이 겹치거나 재시도되면 반드시 두 번 보낸다.
-- 그래서 **먼저 insert하고, 23505면 이미 보낸 것**으로 판정한다(원자적).
-- lapsed_at이 키에 들어가므로 감독자가 재결제 후 다시 끊겨도 새 회차로 깔끔히 갈린다.

create table if not exists public.org_notices (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  -- 수신자(감독자). auth.users FK를 걸지 않는다 — 계정 삭제가 알림 때문에 막히면 안 된다.
  owner_user_id uuid not null,
  kind          text not null check (kind in (
                  'charge_failed','lapse_d0','lapse_d3','lapse_d6',
                  'seat_locked','member_ping','member_left')),
  -- member_ping·member_left를 일으킨 현장 계정
  actor_user_id uuid,
  -- 유예 '회차' 식별용 파생값 스냅샷(새 컬럼을 subscriptions에 만들지 않기 위한 자리)
  lapsed_at     timestamptz,
  dedupe_key    text not null,
  email_status  text check (email_status in ('sent','failed','skipped')),
  email_error   text,
  email_retries int not null default 0,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);

create unique index if not exists org_notices_dedupe_uidx on public.org_notices(dedupe_key);
create index if not exists org_notices_owner_idx on public.org_notices(owner_user_id, created_at desc);
-- 이메일 재시도 스윕(email_status='failed' && retries<3)과 24h 스팸 하한 조회용
create index if not exists org_notices_org_kind_idx on public.org_notices(org_id, kind, created_at desc);

alter table public.org_notices enable row level security;
revoke all on public.org_notices from anon, authenticated;
grant all on public.org_notices to service_role;
-- 정책을 만들지 않는다 = 클라이언트 직접 접근 전면 차단.
-- 접근은 service_role 라우트(/api/org/notices·ping-owner·leave·크론)뿐이다.
