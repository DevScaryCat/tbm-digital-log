-- 스토어 좌석 정원제 (Google Play base plan seats-02~seats-30) — 가산적 마이그레이션
--
-- ⚠️ 이 파일은 seats-01까지 seed하던 판본으로 원격에 이미 적용됐다(2026-08-10).
--    설계 변경으로 seats-01은 폐기됐고(무료체험 오퍼가 legacy 'monthly' base plan 소속이라
--    seats-01을 진입 요금제로 쓰면 신규 가입자의 첫 달 무료가 조용히 사라진다),
--    원격의 잔재는 20260810120000_seats_drop_seats01.sql이 걷어낸다.
--    아래 seed는 새 환경에서 애초에 만들지 않도록 2부터 시작한다.
--
-- 배경: 앱(안드로이드) 감독자가 스테퍼(+/-)로 현장 계정 수를 조절하면, 스토어 구독 하나의
-- 요금제(base plan)가 바뀌면서 "산 정원"이 늘고 그 안의 현장 계정은 0원이 된다.
--
-- 이 마이그레이션은 데이터를 지우거나 바꾸지 않는다:
--   - 기존 google_play 구독자는 store_seat_capacity=NULL로 남아 **현재 동작 100% 보존**
--     (본인 몫 스토어 + 좌석 몫 PortOne 카드). 백필하지 않는 이유는 아래 ③ 주석.
--   - 웹(source='portone') 구독자는 이 컬럼이 영원히 NULL이라 어떤 새 분기도 타지 않는다.

-- ① 스토어 요금제 ↔ 좌석 정원 매핑 (서버 전용 조회 테이블)
create table if not exists public.store_products (
  platform      text    not null check (platform in ('google_play','app_store')),
  product_id    text    not null,
  base_plan_id  text    not null,
  -- 감독자 본인을 포함한 총 계정 수. organizations.seat_count / lib/billing.ts
  -- resolveBillableAmount의 accountCount(=1+활성좌석)와 **같은 단위**다.
  -- NULL = 좌석 정원제가 아닌 요금제(legacy 'monthly') → 기존 카드 좌석 청구 경로 유지.
  seat_capacity int     null check (seat_capacity is null or seat_capacity >= 1),
  price_krw     int     not null check (price_krw >= 0),
  active        boolean not null default true,
  sort_order    int     not null default 0,
  created_at    timestamptz not null default now(),
  primary key (platform, product_id, base_plan_id)
);

comment on column public.store_products.seat_capacity is
  '이 요금제가 파는 총 계정 수(감독자 본인 포함). organizations.seat_count 및 resolveBillableAmount의 accountCount와 같은 단위. NULL이면 정원제가 아니다(legacy).';

-- 클라이언트가 직접 읽을 이유가 없다(앱은 /api/org/context로 받는다). RLS 켜고 정책 없음 = service_role 전용.
alter table public.store_products enable row level security;

-- 진입 요금제(현 구독자 전원이 여기 있다). 의미상 정원 1이지만 seat_capacity는 **NULL로 둔다** —
-- 1로 채우면 다음 verify/RTDN에서 기존 스토어 구독자의 카드 좌석 경로가 통째로 끊긴다
-- (사유는 20260810120000_seats_drop_seats01.sql 주석에 전부 적었다).
insert into public.store_products (platform, product_id, base_plan_id, seat_capacity, price_krw, sort_order)
values ('google_play','antok_monthly','monthly', null, 4900, 0)
on conflict (platform, product_id, base_plan_id) do nothing;

-- 좌석 요금제 29개(seats-02~30)를 미리 seed. Play Console에 아직 없어도 무해하다 —
-- 앱은 '스토어가 실제로 내려준 오퍼'와 이 표를 교집합해 렌더하므로, 콘솔에서 만드는 즉시
-- 코드 변경 없이 스테퍼가 나타난다. 창업자는 **정확히 이 ID**로 만들어야 한다.
-- seats-01은 만들지 않는다(무료체험 오퍼가 monthly 소속 — 위 ⚠️).
insert into public.store_products (platform, product_id, base_plan_id, seat_capacity, price_krw, sort_order)
select 'google_play','antok_monthly','seats-'||lpad(n::text,2,'0'), n, n*4900, n
from generate_series(2,30) n
on conflict (platform, product_id, base_plan_id) do nothing;

-- ② 구독 행에 확정 정원 기록
alter table public.subscriptions
  add column if not exists store_base_plan_id  text,
  add column if not exists store_seat_capacity int,
  -- 표시 전용. 게이트·청구에 절대 쓰지 않는다(클라이언트 주장값).
  add column if not exists store_pending_seat_capacity int;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'subscriptions_store_seat_capacity_check'
  ) then
    alter table public.subscriptions
      add constraint subscriptions_store_seat_capacity_check
      check (store_seat_capacity is null or store_seat_capacity >= 1);
  end if;
end $$;

comment on column public.subscriptions.store_seat_capacity is
  '스토어 요금제가 보장하는 총 계정 수(감독자 본인 포함). NOT NULL이면 이 구독의 좌석 청구는 스토어 단독 — PortOne 카드 좌석 청구(cron chargeGoogleOwnerSeats · chargeProratedAccount)에서 제외된다. NULL = 기존 카드 경로 그대로.';

comment on column public.subscriptions.store_pending_seat_capacity is
  '다음 결제일에 적용 예정인 정원(지연 다운그레이드). **표시 전용** — 발급 게이트·청구에 절대 쓰지 않는다. RTDN이 실제 정원을 반영할 때 비운다.';

create index if not exists subscriptions_store_capacity_idx
  on public.subscriptions (source) where store_seat_capacity is not null;

-- ③ **백필하지 않는다.** 기존 google_play 구독자는 store_seat_capacity=NULL로 남아
--    현재 동작(본인 몫 스토어 + 좌석 몫 카드)이 100% 보존되고, seats-NN을 실제로
--    구매한 순간에만 정원제로 전환된다. 백필하면 카드로 좌석을 쓰던 감독자가
--    (a) 즉시 발급 차단되고 (b) 기존 좌석이 무과금이 된다.

-- ④ 좌석 점유 지점에서 정원 강제 — 여기가 유일한 경합-안전 지점이다.
--    (bulk·members·attach·signup(초대 링크)이 전부 이 함수를 통과한다. 이미 advisory lock 안이다.)
--
-- 인자를 추가하려면 기존 2-인자 함수를 먼저 내려야 한다. create or replace는 인자 수를 바꾸지 못해
-- 오버로드가 생기고, 기본값이 있는 3-인자와 2-인자가 공존하면 호출이 모호해질 수 있다.
-- 구 코드가 배포된 상태에서도 안전하다: 이름 있는 인자 2개 호출은 기본값(NULL)로 해석돼
-- 정원 검사만 건너뛰고 종전과 똑같이 동작한다.
drop function if exists public.claim_org_seat(uuid, uuid);

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
begin
  -- 같은 조직에 대한 편입을 직렬화 (트랜잭션 종료 시 자동 해제)
  perform pg_advisory_xact_lock(hashtext('org_seat_' || p_org::text));

  select exists(select 1 from public.organizations where id = p_org) into v_exists;
  if not v_exists then return 'no_org'; end if;

  -- 한 계정이 두 회사에 동시에 속하는 것은 여전히 금지
  select org_id into v_current_org from public.org_members
    where member_user_id = p_member and status = 'active';
  if v_current_org is not null and v_current_org <> p_org then return 'other_org'; end if;

  -- 정원 검사(스토어 정원제 구독만 p_capacity를 넘긴다). 본인(1) + 이 사람을 뺀 활성 좌석 + 이번 1건.
  -- 이미 이 조직 활성 멤버면 재점유라 증가하지 않는다(<> p_member).
  -- p_capacity가 NULL이면 종전대로 상한 없음(웹 카드 경로 — 과금이 실제 계정 수 × 단가).
  if p_capacity is not null then
    select count(*) into v_active from public.org_members
      where org_id = p_org and status = 'active' and member_user_id <> p_member;
    if (1 + v_active + 1) > p_capacity then return 'over_capacity'; end if;
  end if;

  insert into public.org_members (org_id, member_user_id, status, joined_at, detached_at)
  values (p_org, p_member, 'active', now(), null)
  on conflict (member_user_id) do update
    set org_id = excluded.org_id, status = 'active', joined_at = now(), detached_at = null;
  return 'ok';
end;
$function$;

revoke execute on function public.claim_org_seat(uuid, uuid, int) from anon, authenticated, public;
