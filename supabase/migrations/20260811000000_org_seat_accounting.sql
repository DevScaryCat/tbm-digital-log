-- 좌석 회계의 단일 진실 (2026-08-11) — 순수 추가 DDL. 기존 행을 UPDATE·DELETE 하지 않는다.
--
-- 고치는 사고: 감독자 구독이 끊긴 사이 현장 계정이 **스스로 스토어 구독**을 해 이어 쓴 뒤
-- 감독자가 재결제하면, 미러 복원이 그 사람의 구독 행을 org_seat/0원으로 덮는다. 서버는 스토어
-- 구독을 해지할 권한이 없으므로 스토어는 계속 본인에게 4,900원을 청구하고, 감독자 카드에서도
-- 그 좌석 몫 3,900원이 나간다 — 한 자리에 무기한 이중청구.
--
-- 앞선 시도는 "자가 결제면 미러 복원을 건너뛴다" 가드 하나였고 반려됐다. 이유가 핵심이다:
--   · 감독자 청구액은 미러가 아니라 org_members active **개수**에서 나온다 → 미러만 건너뛰면
--     이중청구가 한 푼도 안 줄고 그 사람은 좌석도 못 받는다.
--   · 미러 복원 경로가 전부 `.eq(plan,'org_seat')`로 접힌 행만 골라, 한 번 건너뛴 사람은
--     영구히 후보에서 빠진다(되돌아올 길 없음).
--   · 판정을 코드에 두면 청구(TS)·정원(SQL claim_org_seat)·미러(TS)가 서로 다르게 틀린다.
--
-- 그래서 규칙을 **DB 함수 하나**에 둔다. 뷰와 RPC가 같은 함수를 부르고, TS는 규칙을
-- 재구현하지 않고 뷰를 읽기만 한다. 세 숫자(청구·정원·미러)가 같은 자리에서 나온다.

-- ① 규칙의 유일한 정의. "앞으로도 스토어가 이 사람에게 청구할 구독인가?"
create or replace function public.is_store_self_paid(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = p_user
      -- 웹 카드(portone)는 대상이 아니다: 미러 upsert가 billing_key·card_info를 null로 지워
      -- 좌석 청구 크론(billing_key NOT NULL 필터)이 그 카드를 더는 안 긁는다 — 이미 안전하다.
      and s.source in ('google_play','app_store')
      -- 잔재 컬럼만 남은 행은 구독이 아니다(웹으로 돌아온 계정의 store_* 찌꺼기)
      and s.store_purchase_token is not null
      -- canceled(해지 후 잔여기간 포함)는 앞으로 돈이 안 나간다 → 즉시 좌석으로 돌려보낸다
      and s.status in ('active','trialing','past_due')
      and s.canceled_at is null
      -- ⚠️ status만 보고 판정하지 않는다 — 기간을 함께 본다(이 저장소의 반복 사고).
      -- 기간을 모르면 갱신 시각으로 대신 본다: 14일 넘게 방치된 스토어 행은 '살아 있는 구독'이
      -- 아니라 '갱신이 고장난 행'이다(lib/portone.ts subscriptionAllows의 STALE_PERIOD_GRACE_MS와
      -- 같은 규율·같은 폭).
      and coalesce(s.current_period_end, s.updated_at) > now() - interval '14 days'
  );
$$;
revoke execute on function public.is_store_self_paid(uuid) from anon, authenticated, public;
grant execute on function public.is_store_self_paid(uuid) to service_role;

-- ② 청구·정원·미러·경보가 공유하는 단일 회계표.
--    seat_state 는 세 값뿐이다:
--      seat        — 감독자가 좌석을 제공하고 요금을 받는다(미러 발급 대상)
--      self_store  — 본인 스토어 구독으로 산다. 청구·정원·미러 **전부에서 제외**한다.
--                    (조직 연결은 유지 — 감독자의 관제·보고서 대상에는 그대로 남는다)
--      grandfather — 영구 무료. 미러도 주지 않고 요금도 받지 않는다.
--                    (종전에는 미러를 안 주면서 요금만 받고 있었다 — 이번에 고치는 것과 같은 결함)
create or replace view public.org_seat_states
with (security_invoker = on) as
select
  m.org_id,
  m.member_user_id,
  m.joined_at,
  case
    when public.is_store_self_paid(m.member_user_id) then 'self_store'
    when s.plan = 'grandfather'                      then 'grandfather'
    else 'seat'
  end as seat_state,
  -- 미러가 실제로 살아 있는가. '자격 상한'(정원)과 '무과금 누수 경보'는 서로 다른 질문이라
  -- 이 한 컬럼으로만 갈린다 — 규칙을 두 번 적지 않는다.
  coalesce(s.plan = 'org_seat' and s.status = 'active', false) as mirror_alive
from public.org_members m
left join public.subscriptions s on s.user_id = m.member_user_id
where m.status = 'active';

revoke all on public.org_seat_states from anon, authenticated;
grant select on public.org_seat_states to service_role;

-- ③ 정원 점유도 같은 정의로 센다. 시그니처가 같아 create or replace로 교체 가능하고,
--    구 코드가 배포된 상태에서도 호출 형태가 그대로라 안전하다(정원 카운트만 새 정의로 바뀐다).
create or replace function public.claim_org_seat(p_org uuid, p_member uuid, p_capacity int default null)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_exists boolean;
  v_current_org uuid;
  v_active int;
  v_self int;
begin
  -- 같은 조직에 대한 편입을 직렬화 (트랜잭션 종료 시 자동 해제)
  perform pg_advisory_xact_lock(hashtext('org_seat_' || p_org::text));

  select exists(select 1 from public.organizations where id = p_org) into v_exists;
  if not v_exists then return 'no_org'; end if;

  -- 한 계정이 두 회사에 동시에 속하는 것은 여전히 금지
  select org_id into v_current_org from public.org_members
    where member_user_id = p_member and status = 'active';
  if v_current_org is not null and v_current_org <> p_org then return 'other_org'; end if;

  if p_capacity is not null then
    -- 본인 스토어 구독으로 사는 멤버는 감독자가 산 정원을 먹지 않는다(청구·미러와 같은 판정).
    -- 이미 이 조직 활성 멤버면 재점유라 증가하지 않는다(<> p_member).
    select count(*) into v_active from public.org_seat_states
      where org_id = p_org and seat_state = 'seat' and member_user_id <> p_member;
    -- 이번에 들어오는 사람도 자가 결제면 정원을 먹지 않는다 — 같은 함수를 부른다.
    v_self := case when public.is_store_self_paid(p_member) then 0 else 1 end;
    if (1 + v_active + v_self) > p_capacity then return 'over_capacity'; end if;
  end if;

  insert into public.org_members (org_id, member_user_id, status, joined_at, detached_at)
  values (p_org, p_member, 'active', now(), null)
  on conflict (member_user_id) do update
    set org_id = excluded.org_id, status = 'active', joined_at = now(), detached_at = null;
  return 'ok';
end;
$function$;

revoke execute on function public.claim_org_seat(uuid, uuid, int) from anon, authenticated, public;
grant execute on function public.claim_org_seat(uuid, uuid, int) to service_role;
