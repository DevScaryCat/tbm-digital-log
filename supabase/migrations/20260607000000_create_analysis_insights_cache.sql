-- AI 분석 총평 캐시. signature가 동일하면 재호출 없이 재사용, 데이터 변경 시에만 갱신.
create table if not exists public.analysis_insights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null,
  period_year int not null,
  period_month int not null,
  signature text not null default '',
  content text not null default '',
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, scope, period_year, period_month)
);

alter table public.analysis_insights enable row level security;

comment on table public.analysis_insights is 'AI 분석 총평 캐시. signature가 동일하면 재호출 없이 재사용, 데이터 변경 시에만 갱신.';
