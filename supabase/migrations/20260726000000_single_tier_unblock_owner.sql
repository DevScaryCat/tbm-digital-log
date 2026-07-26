-- 단일 요금제(3,900원/계정) + 감독자 작성 차단 해제 — 1단계(DB만, 가산적)
--
-- 배경: 기존 2계층에서 상위(plan='org')는 "관리 전용"이라 작성 한도가 0이었다.
-- 통합 모델에서는 감독자도 본인 현장 하나를 가지고 TBM을 쓴다 → 0 한도를 걷어낸다.
--
-- 이 마이그레이션은 코드보다 먼저 단독으로 올라가도 안전하다:
--   - 한도를 '올리는' 방향뿐이라 기존 사용자에게 보이는 변화가 없다.
--   - 앱 쪽 403 가드(isOrgOwner/useBlockOwner)가 아직 살아 있어 실제 작성은 여전히 막힌다.
-- 반대 순서(코드 먼저)로 하면 STT·AI 요약을 다 태운 뒤 마지막 INSERT가 P0001로 죽어
-- 작성 세션 전체가 날아간다. 그래서 트리거가 반드시 선행이다.

-- 1) 작성 한도 — 'org'를 유료 티어와 동일하게. legacy(monthly_basic/grandfather)는 그대로 둔다.
create or replace function public.enforce_tbm_monthly_limit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_plan text;
  v_limit int;
  v_count int;
  v_kind text;
  v_month text := to_char(timezone('Asia/Seoul', now()), 'YYYY-MM');
begin
  select plan into v_plan from public.subscriptions where user_id = NEW.user_id;
  v_plan := coalesce(v_plan, 'monthly_basic');

  -- 유료 단일 티어 = monthly_pro. org(구 상위)·org_seat(하위 미러)도 동일 한도.
  -- monthly_basic·grandfather는 legacy 무료/구가입 한도(80/10/0)를 유지한다.
  if TG_TABLE_NAME = 'tbm_logs' then
    v_kind := '일지';
    v_limit := case
      when v_plan in ('monthly_pro', 'org_seat', 'org') then 200
      else 80 end;
    select count(*) into v_count from public.tbm_logs
      where user_id = NEW.user_id
        and to_char(timezone('Asia/Seoul', created_at), 'YYYY-MM') = v_month;
  elsif TG_TABLE_NAME = 'tbm_minutes' then
    v_kind := '회의록';
    v_limit := case
      when v_plan in ('monthly_pro', 'org_seat', 'org') then 30
      else 10 end;
    select count(*) into v_count from public.tbm_minutes
      where user_id = NEW.user_id
        and to_char(timezone('Asia/Seoul', created_at), 'YYYY-MM') = v_month;
  else
    v_kind := 'AI 분석';
    v_limit := case
      when v_plan in ('monthly_pro', 'org_seat', 'org') then 20
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

-- 2) 좌석 선구매 상한 제거.
-- 통합 모델의 과금은 "실제 계정 수 × 3,900"이라 미리 사둔 좌석 수라는 개념이 없다.
-- seat_count 상한을 그대로 두면 organizations.seat_count 기본값 1 때문에
-- 두 번째 현장 초대가 'no_seat'으로 실패하고, 호출부가 방금 만든 auth 유저를 지워버린다.
-- 경쟁 조건 방지용 advisory lock은 유지한다(동시 초대 수락 시 중복 편입 방지).
-- 파라미터명(p_org/p_member)은 기존 시그니처와 동일해야 한다 — 바꾸면 42P13으로 교체가 거부된다.
create or replace function public.claim_org_seat(p_org uuid, p_member uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_exists boolean;
  v_current_org uuid;
begin
  -- 같은 조직에 대한 편입을 직렬화 (트랜잭션 종료 시 자동 해제)
  perform pg_advisory_xact_lock(hashtext('org_seat_' || p_org::text));

  select exists(select 1 from public.organizations where id = p_org) into v_exists;
  if not v_exists then return 'no_org'; end if;

  -- 한 계정이 두 회사에 동시에 속하는 것은 여전히 금지 (org_members.member_user_id UNIQUE와 별개로
  -- 다른 회사 소속을 조용히 빼앗아오지 않도록 명시적으로 거절한다)
  select org_id into v_current_org from public.org_members
    where member_user_id = p_member and status = 'active';
  if v_current_org is not null and v_current_org <> p_org then return 'other_org'; end if;

  -- 좌석 상한 검사 없음: 과금이 "실제 계정 수 × 단가"로 바뀌어 선구매 좌석 개념이 사라졌다.
  insert into public.org_members (org_id, member_user_id, status, joined_at, detached_at)
  values (p_org, p_member, 'active', now(), null)
  on conflict (member_user_id) do update
    set org_id = excluded.org_id, status = 'active', joined_at = now(), detached_at = null;
  return 'ok';
end;
$function$;

revoke execute on function public.claim_org_seat(uuid, uuid) from anon, authenticated, public;
