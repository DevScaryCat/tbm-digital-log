-- 자가 결제 판정 정정·확장 (2026-08-13) — 순수 추가 DDL. 기존 행을 UPDATE·DELETE 하지 않는다.
--
-- 두 가지를 고친다.
--
-- ① is_store_self_paid가 '해지 예약(잔여 기간 있음)'을 즉시 자가결제 아님으로 봤다.
--    구글·애플은 **자동갱신만 끈 상태**를 status='canceled' + canceled_at=now + 미래 만료일로
--    기록한다(lib/googlePlay.ts·lib/appStore.ts toLocalStatus). 종전 조건
--    (`status in ('active','trialing','past_due') and canceled_at is null`)은 멤버가 Play/App Store에서
--    '해지'를 누른 그 순간 self_store → seat 로 넘겨버렸고, 다음 크론의 미러 복원이
--    **살아 있는 스토어 구독 행을 0원 미러로 덮어썼다**(잔여 기간 이중지불 + purchase token 소실).
--    → 상태 판정을 손으로 다시 적지 않고 public.subscription_allows 하나에 맡긴다.
--      "돈이 아직 우리 밖에서 살아 있는가"의 답이 거기 이미 있다(잔여 기간 포함).
--
-- ② 자가결제를 **스토어로만** 인정한 탓에, 유예가 끝나 웹 카드(PortOne)로 직접 결제한 멤버가
--    감독자 재결제 순간 미러 upsert에 billing_key·card_info·기간을 통째로 날렸다
--    (lib/org.ts가 SELF_PAID_PORTONE_SEAT_OVERWRITE 경보만 남기고 그대로 진행하던 자리).
--    미러만 건너뛰는 가드로는 못 고친다 — 청구·정원이 여전히 그 사람을 세면 이중지불이 된다.
--    → 판정을 한 자리에서 넓힌다. 청구(resolveBillableAmount)·정원(claim_org_seat)·
--      미러(restoreOrgSeatMirrors)가 **같은 뷰**를 보므로 세 곳이 함께 움직인다.
--      Chris 2026-08-11 원칙 그대로: "자가 결제자는 회사 청구·정원에서만 빠진다."
--
-- 두 함수를 남기는 이유(사본이 아니라 포함 관계다):
--   is_store_self_paid — "서버가 해지할 수 없는 결제가 살아 있는가". 편입(attach)이 개인 구독을
--     정산할지 판단할 때 쓴다. 스토어 구독은 우리가 해지할 권한이 없어 정산 자체가 불가능하다.
--   is_self_paid       — "본인 돈으로 사고 있는가"(= 위 + 본인 카드). 회계(청구·정원·미러)는 이쪽.
--   is_self_paid는 is_store_self_paid를 **호출**한다. 규칙 사본은 존재하지 않는다.

-- ① 스토어 자가결제 — 상태 판정은 subscription_allows에 위임한다(잔여 기간 포함)
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
      and s.source in ('google_play','app_store')
      -- 잔재 컬럼만 남은 행은 구독이 아니다(웹으로 돌아온 계정의 store_* 찌꺼기)
      and s.store_purchase_token is not null
  )
  -- ⚠️ status만 보고 판정하지 않는다 — 기간을 함께 본다(이 저장소의 반복 사고).
  --    해지 예약(canceled + 미래 만료일)은 아직 스토어가 청구를 끝내지 않은 상태이므로
  --    자가결제로 **인정한다**. 잔여 기간이 끝나는 순간 자동으로 seat로 넘어간다.
  --    14일 STALE 백스톱도 그 함수 안에 있다.
  and public.subscription_allows(p_user);
$$;
revoke execute on function public.is_store_self_paid(uuid) from anon, authenticated, public;
grant execute on function public.is_store_self_paid(uuid) to service_role;

-- ② 자가결제 일반 — 스토어 + 본인 카드(PortOne)
create or replace function public.is_self_paid(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.is_store_self_paid(p_user)
      or (
        exists (
          select 1 from public.subscriptions s
          where s.user_id = p_user
            and s.source = 'portone'
            -- 본인이 등록한 결제수단이 붙어 있는 행만. 좌석 미러는 billing_key가 null이라
            -- 여기 걸리지 않지만, 판정을 상태 하나에 기대지 않도록 plan도 함께 배제한다.
            and s.billing_key is not null
            and s.plan not in ('org_seat', 'grandfather')
        )
        and public.subscription_allows(p_user)
      );
$$;
revoke execute on function public.is_self_paid(uuid) from anon, authenticated, public;
grant execute on function public.is_self_paid(uuid) to service_role;

-- ③ 회계표는 넓힌 판정을 본다. seat_state 값 이름('self_store')은 **바꾸지 않는다** —
--    앱(tbm-app)이 서버가 내려준 이 문자열을 그대로 쓰고 있어, 값을 바꾸면 배포 순서에 따라
--    자가 결제자 화면이 통째로 사라진다. 뜻은 "본인이 직접 결제 중"이다.
create or replace view public.org_seat_states
with (security_invoker = on) as
select
  m.org_id,
  m.member_user_id,
  m.joined_at,
  case
    when public.is_self_paid(m.member_user_id) then 'self_store'
    when s.plan = 'grandfather'                then 'grandfather'
    else 'seat'
  end as seat_state,
  coalesce(s.plan = 'org_seat' and s.status = 'active', false) as mirror_alive
from public.org_members m
left join public.subscriptions s on s.user_id = m.member_user_id
where m.status = 'active';

revoke all on public.org_seat_states from anon, authenticated;
grant select on public.org_seat_states to service_role;

-- ④ 정원 점유도 같은 정의로 센다(시그니처 동일 → create or replace로 교체 가능)
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
  perform pg_advisory_xact_lock(hashtext('org_seat_' || p_org::text));

  select exists(select 1 from public.organizations where id = p_org) into v_exists;
  if not v_exists then return 'no_org'; end if;

  select org_id into v_current_org from public.org_members
    where member_user_id = p_member and status = 'active';
  if v_current_org is not null and v_current_org <> p_org then return 'other_org'; end if;

  if p_capacity is not null then
    -- 이미 들어와 있는 멤버는 **지금의 상태**로 센다(뷰 = is_self_paid).
    select count(*) into v_active from public.org_seat_states
      where org_id = p_org and seat_state = 'seat' and member_user_id <> p_member;
    -- ⚠️ 이번에 들어오는 사람은 **편입 후의 상태**로 센다. 편입(app/api/org/attach)은 본인
    --    카드(PortOne) 구독을 정산·해지하고 좌석 미러를 씌우므로 카드 결제자는 편입 직후
    --    정원을 먹는다 — is_self_paid로 세면 0이 되어 정원을 한 자리 넘긴다.
    --    스토어 구독만 편입 후에도 살아남는다(서버가 해지할 권한이 없다) → is_store_self_paid.
    --    attach의 사전검사 checkSeatCapacity(count: selfStorePaid ? 0 : 1)와 같은 수다.
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
