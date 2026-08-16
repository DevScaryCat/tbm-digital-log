-- 회원탈퇴 부정이용 방지 표식 (2026-08-14, MCP로 선적용된 것의 소급 기록 — 스키마 드리프트 방지)
create table if not exists withdrawn_users (
  id bigint generated always as identity primary key,
  phone_hash text,
  kakao_hash text,
  email_hash text,
  trial_used boolean not null default false,
  withdrawn_at timestamptz not null default now()
);
create index if not exists withdrawn_users_phone_idx on withdrawn_users (phone_hash) where phone_hash is not null;
create index if not exists withdrawn_users_kakao_idx on withdrawn_users (kakao_hash) where kakao_hash is not null;
create index if not exists withdrawn_users_email_idx on withdrawn_users (email_hash) where email_hash is not null;
alter table withdrawn_users enable row level security;
