-- 위험성평가 월 한도를 Pro 50 → 20으로 동기화 (앱 UI/요금표/위험성평가 API와 일치)
-- grandfather(무료 화이트리스트)는 monthly_pro가 아니므로 else 분기(베이직 한도 0)로 유지된다.
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
    v_limit := case when v_plan = 'monthly_pro' then 200 else 80 end;
    select count(*) into v_count from public.tbm_logs
      where user_id = NEW.user_id
        and to_char(timezone('Asia/Seoul', created_at), 'YYYY-MM') = v_month;
  elsif TG_TABLE_NAME = 'tbm_minutes' then
    v_kind := '회의록';
    v_limit := case when v_plan = 'monthly_pro' then 30 else 10 end;
    select count(*) into v_count from public.tbm_minutes
      where user_id = NEW.user_id
        and to_char(timezone('Asia/Seoul', created_at), 'YYYY-MM') = v_month;
  else
    v_kind := '위험성평가';
    v_limit := case when v_plan = 'monthly_pro' then 20 else 0 end;
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
