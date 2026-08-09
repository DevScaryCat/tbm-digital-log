-- 2026-08-10 Chris 결정: grandfather(영구 무료)는 "결제만 없는 유료 계정"이다.
-- 기능·한도를 유료 단일 티어와 **완전히 동일**하게 맞춘다 (교육일지 200 / 회의록 30 / AI 분석 20).
-- 종전에는 grandfather가 else 분기로 떨어져 AI 분석이 0회였고, 실고객(이현로지스 등 8계정)이
-- AI 위험성평가를 아예 쓸 수 없었다.
-- ⚠️ monthly_basic(구 베이직 1,900원)은 그대로 80/10/0 — 이 마이그레이션에서 건드리지 않는다.
-- 이 집합은 lib/portone.ts isProPlan(), lib/useSubscription.ts LIMITS,
-- 앱 src/lib/subscription.ts LIMITS 세 곳과 반드시 같아야 한다(어긋나면 화면은 여유인데 저장이 거부된다).
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
