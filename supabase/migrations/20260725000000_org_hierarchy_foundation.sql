-- 2계층(안전관리자/관리감독자) 기반 스키마 — ORG_HIERARCHY_PLAN.md Phase 1
-- 1) organizations / org_members / org_invites / email_verifications
-- 2) enforce_tbm_monthly_limit 재정의: org_seat=Pro 한도, org=명시적 0 (else 분기가 베이직 80/10을 주므로 명시 필수)
-- 3) claim_org_seat(): 좌석 검증 + 멤버 upsert를 advisory lock으로 원자화 (동시 가입 레이스 방지)

-- ── 조직 (안전관리자 1명 = 조직 1개) ──────────────────────────────
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users(id) on delete cascade,
  name text not null,
  seat_count int not null default 1 check (seat_count >= 1),
  pending_seat_count int check (pending_seat_count >= 1),
  created_at timestamptz not null default now()
);

-- ── 조직 멤버 (하위 관리감독자 = 현장, 한 계정은 한 조직에만) ─────
create table if not exists public.org_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  member_user_id uuid not null unique references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active','detached')),
  joined_at timestamptz not null default now(),
  detached_at timestamptz,
  primary key (org_id, member_user_id)
);
create index if not exists idx_org_members_org on public.org_members (org_id) where status = 'active';

-- ── 초대 (link=신규 가입용, attach=기존 계정 편입용) ───────────────
create table if not exists public.org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  token text not null unique default encode(gen_random_bytes(18),'hex'),
  kind text not null check (kind in ('link','attach')),
  target_user_id uuid references auth.users(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '14 days',
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_org_invites_target on public.org_invites (target_user_id) where used_at is null;

-- ── 실이메일 인증 토큰 (org 소속 월간 보고서 발송 전제) ────────────
create table if not exists public.email_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  token text not null unique default encode(gen_random_bytes(24),'hex'),
  expires_at timestamptz not null default now() + interval '3 days',
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_email_verifications_user on public.email_verifications (user_id);

-- ── RLS: 읽기는 소유자/본인만, 쓰기는 전부 서버(service role) ──────
alter table public.organizations enable row level security;
alter table public.org_members enable row level security;
alter table public.org_invites enable row level security;
alter table public.email_verifications enable row level security;

drop policy if exists organizations_owner_select on public.organizations;
create policy organizations_owner_select on public.organizations
  for select using (owner_user_id = (select auth.uid()));

drop policy if exists organizations_member_select on public.organizations;
create policy organizations_member_select on public.organizations
  for select using (exists (
    select 1 from public.org_members m
    where m.org_id = organizations.id and m.member_user_id = (select auth.uid())
  ));

drop policy if exists org_members_self_or_owner_select on public.org_members;
create policy org_members_self_or_owner_select on public.org_members
  for select using (
    member_user_id = (select auth.uid())
    or exists (
      select 1 from public.organizations o
      where o.id = org_members.org_id and o.owner_user_id = (select auth.uid())
    )
  );

drop policy if exists org_invites_owner_select on public.org_invites;
create policy org_invites_owner_select on public.org_invites
  for select using (exists (
    select 1 from public.organizations o
    where o.id = org_invites.org_id and o.owner_user_id = (select auth.uid())
  ));
-- email_verifications: 정책 없음(전부 차단) — 서버 service role만 접근

-- ── 월 한도 트리거 재정의 ──────────────────────────────────────────
-- org_seat(하위 현장) = Pro와 동일 한도. org(안전관리자) = 작성 전부 0 (관리 전용 계정).
-- 미지정 plan은 기존대로 베이직 한도(else)로 열화되므로 org를 else에 맡기면 안 된다.
CREATE OR REPLACE FUNCTION public.enforce_tbm_monthly_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_plan text;
  v_limit int;
  v_count int;
  v_kind text;
  v_month text := to_char(timezone('Asia/Seoul', now()), 'YYYY-MM');
begin
  select plan into v_plan from public.subscriptions where user_id = NEW.user_id;
  v_plan := coalesce(v_plan, 'monthly_basic');

  if TG_TABLE_NAME = 'tbm_logs' then
    v_kind := '일지';
    v_limit := case
      when v_plan in ('monthly_pro', 'org_seat') then 200
      when v_plan = 'org' then 0
      else 80 end;
    select count(*) into v_count from public.tbm_logs
      where user_id = NEW.user_id
        and to_char(timezone('Asia/Seoul', created_at), 'YYYY-MM') = v_month;
  elsif TG_TABLE_NAME = 'tbm_minutes' then
    v_kind := '회의록';
    v_limit := case
      when v_plan in ('monthly_pro', 'org_seat') then 30
      when v_plan = 'org' then 0
      else 10 end;
    select count(*) into v_count from public.tbm_minutes
      where user_id = NEW.user_id
        and to_char(timezone('Asia/Seoul', created_at), 'YYYY-MM') = v_month;
  else
    v_kind := 'AI 분석';
    v_limit := case
      when v_plan in ('monthly_pro', 'org_seat') then 20
      else 0 end;
    select count(*) into v_count from public.tbm_risk_assessments
      where user_id = NEW.user_id
        and to_char(timezone('Asia/Seoul', created_at), 'YYYY-MM') = v_month;
  end if;

  if v_count >= v_limit then
    raise exception '이번 달 % 작성 한도(%회)를 모두 사용했습니다.', v_kind, v_limit
      using errcode = 'P0001';
  end if;

  return NEW;
end;
$function$;

-- ── 좌석 청구/검증 원자화: 좌석 여유 검증 + 멤버 upsert ────────────
-- 서버(service role) 전용. 링크 2명 동시 가입 레이스를 org 단위 advisory lock으로 직렬화.
create or replace function public.claim_org_seat(p_org uuid, p_member uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_seats int;
  v_active int;
  v_current_org uuid;
begin
  perform pg_advisory_xact_lock(hashtext('org_seat_' || p_org::text));
  select seat_count into v_seats from public.organizations where id = p_org;
  if v_seats is null then return 'no_org'; end if;

  -- 다른 조직에 active로 소속돼 있으면 이동 금지 (명시적 detach 후에만)
  select org_id into v_current_org from public.org_members
    where member_user_id = p_member and status = 'active';
  if v_current_org is not null and v_current_org <> p_org then return 'other_org'; end if;

  select count(*) into v_active from public.org_members
    where org_id = p_org and status = 'active' and member_user_id <> p_member;
  if v_active >= v_seats then return 'no_seat'; end if;

  insert into public.org_members (org_id, member_user_id, status, joined_at, detached_at)
  values (p_org, p_member, 'active', now(), null)
  on conflict (member_user_id) do update
    set org_id = excluded.org_id, status = 'active', joined_at = now(), detached_at = null;
  return 'ok';
end;
$function$;

revoke execute on function public.claim_org_seat(uuid, uuid) from anon, authenticated, public;
