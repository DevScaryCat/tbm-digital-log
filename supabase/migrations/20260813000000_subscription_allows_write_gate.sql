-- 작성 차단을 서버(DB)에 못박는다 (2026-08-13) — 순수 추가 DDL. 기존 행을 UPDATE·DELETE 하지 않는다.
--
-- 고치는 사고: 작성 차단이 사실상 **클라이언트 게이트뿐**이었다.
--   · tbm_minutes·tbm_logs·tbm_risk_assessments의 RLS INSERT 정책은 with_check가
--     auth.uid() = user_id 하나뿐이다.
--   · 유일한 서버측 관문인 트리거 enforce_tbm_monthly_limit는 subscriptions에서 **plan만** 읽고
--     status·current_period_end를 보지 않는다.
-- 그래서 회사 유예로 미러가 접힌 멤버의 행(plan='org_seat', status='canceled')에도 트리거가
-- 유료 한도(일지 200·회의록 30·AI 20)를 그대로 내줬다. anon key + 본인 JWT로
-- supabase.from('tbm_minutes').insert()를 직접 부르면 월 30건까지 무과금 작성이 됐고,
-- 이 구멍은 유예 멤버뿐 아니라 **개인 만료자 전원**에게 열려 있었다.
--
-- ⚠️ 판정을 새로 적지 않는다. lib/portone.ts subscriptionAllows의 식을 SQL 함수 하나로 옮기고
--    트리거가 그것을 부른다(is_store_self_paid가 14일 STALE 규율을 SQL로 옮긴 것과 같은 자리·
--    같은 규율). 이 함수를 고칠 때는 lib/portone.ts subscriptionAllows도 같이 고칠 것.

-- ① 구독 유효성의 SQL 정의. lib/portone.ts subscriptionAllows와 **분기 순서까지** 같다.
--    행이 없으면 false — "행 없음"과 "행은 있는데 무효"를 구분하는 것은 호출부의 몫이다.
create or replace function public.subscription_allows(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce((
    select
      case
        -- ① 카드 없는 무료체험(휴대폰인증 가입): 체험 기간이 끝나면 결제 등록 전까지 불허.
        --    billing_key가 있는 trialing(카드등록 체험)은 크론이 과금하므로 그대로 허용한다.
        when s.status = 'trialing'
             and s.billing_key is null
             and s.current_period_end is not null
             and s.current_period_end <= now() then false
        -- ② STALE 백스톱: 만료가 14일 넘게 지났는데 상태만 살아 있는 행은 "권한이 있는 상태"가
        --    아니라 "갱신이 고장난 상태"다. lib/orgGrace.ts STALE_PERIOD_GRACE_MS와 같은 폭.
        --    current_period_end가 null인 행(org_seat 미러·grandfather 영구무료)은 애초에 만료
        --    개념이 없어 여기 걸리지 않는다.
        when s.current_period_end is not null
             and s.current_period_end < now() - interval '14 days' then false
        when s.status in ('active', 'trialing', 'past_due') then true
        -- ③ 해지 예약(잔여 기간 있음)은 그 기간까지 허용 — 이미 낸 돈이다.
        when s.status = 'canceled'
             and s.current_period_end is not null
             and s.current_period_end > now() then true
        else false
      end
    from public.subscriptions s
    where s.user_id = p_user
  ), false);
$$;
revoke execute on function public.subscription_allows(uuid) from anon, authenticated, public;
grant execute on function public.subscription_allows(uuid) to service_role;

-- ② 월 한도 트리거 맨 앞에 구독 유효성 관문을 붙인다.
--
-- ⚠️ 오차단이 더 나쁘다 — 그래서 **"구독 행이 있는데 무효일 때"만** 거절한다.
--    구독 행이 아예 없는 계정(카카오 OAuth·구 무인증 가입 등)은 종전대로 legacy 한도(80/10/0)로
--    통과시킨다. 이 조건은 웹 lib/useSubscription.ts isExpired(`!!sub && !isAllowed(sub)`)와
--    글자 그대로 같은 판정이다 — 화면이 이미 잠그는 것을 DB가 뒤늦게 확인해 줄 뿐,
--    화면이 열어주는 것을 DB가 새로 잠그지는 않는다.
--
-- 통과가 보장되는 경우(전수 확인 2026-08-13, 실 DB 14행):
--   · grandfather(영구 무료)  plan='grandfather' status='active' cpe=null → ②는 cpe null이라
--     건너뛰고 status active로 true. 8행 전부 통과.
--   · org_seat 미러(살아 있음) status='active' cpe=null → true.
--   · 카드 붙은 체험(committed trial) billing_key not null → ①을 건너뛰고 true.
--   · 카드 없는 체험 진행 중  cpe > now → ①의 `cpe <= now`가 거짓 → true.
--   · past_due(결제 재시도 중) → true. 해지 예약(잔여기간) → ③으로 true.
--   · 스토어(구글·애플) 구독 status='active' cpe=미래 → true.
-- 거절되는 경우: 체험 종료(카드 없음)·해지 만료·3회 실패 해지·유예로 접힌 미러
--   (plan='org_seat' status='canceled') — 전부 화면이 이미 "작성이 잠겼어요"를 띄우는 상태다.
create or replace function public.enforce_tbm_monthly_limit()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_plan text;
  v_has_sub boolean;
  v_limit int;
  v_count int;
  v_kind text;
  v_month text := to_char(timezone('Asia/Seoul', now()), 'YYYY-MM');
begin
  select plan into v_plan from public.subscriptions where user_id = NEW.user_id;
  v_has_sub := FOUND;
  v_plan := coalesce(v_plan, 'monthly_basic');

  -- 구독 행이 있는데 무효 = 작성 잠김. 한도를 세기 전에 여기서 끝낸다.
  -- errcode를 한도 초과(P0001)와 **다르게** 준다: 서버 라우트가 둘을 구분하지 못하면
  -- "이번 달 한도를 모두 사용했습니다"라는 거짓 이유를 사용자에게 말하게 된다
  -- (app/api/ai/risk-assessment/route.ts가 P0001을 한도 초과로 매핑한다).
  -- 클라이언트 직접 insert 경로는 이 메시지를 그대로 화면에 띄운다.
  if v_has_sub and not public.subscription_allows(NEW.user_id) then
    raise exception '구독이 확인되지 않아 새 기록을 만들 수 없습니다. 이미 만든 기록은 그대로 보고 출력할 수 있어요.'
      using errcode = 'P0002';
  end if;

  if TG_TABLE_NAME = 'tbm_logs' then
    v_kind := '일지';
    v_limit := case
      when v_plan in ('monthly_pro', 'org_seat', 'org', 'grandfather') then 200
      else 80 end;
    select count(*) into v_count from public.tbm_logs
      where user_id = NEW.user_id
        and to_char(timezone('Asia/Seoul', created_at), 'YYYY-MM') = v_month;
  elsif TG_TABLE_NAME = 'tbm_minutes' then
    v_kind := '회의록';
    v_limit := case
      when v_plan in ('monthly_pro', 'org_seat', 'org', 'grandfather') then 30
      else 10 end;
    select count(*) into v_count from public.tbm_minutes
      where user_id = NEW.user_id
        and to_char(timezone('Asia/Seoul', created_at), 'YYYY-MM') = v_month;
  else
    v_kind := 'AI 분석';
    v_limit := case
      when v_plan in ('monthly_pro', 'org_seat', 'org', 'grandfather') then 20
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
