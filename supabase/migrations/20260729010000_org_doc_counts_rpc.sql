-- 통계 화면용 누적 카운트 RPC — 현장 수 × 3개의 head-count 쿼리를 1회 호출로 통합
-- (overview API가 현장마다 tbm_minutes/tbm_logs/worker_suggestions를 각각 세던 것이 로드 지연의 주범)
create or replace function public.org_doc_counts(p_ids uuid[])
returns table(user_id uuid, minutes bigint, logs bigint, suggestions bigint)
language sql
stable
security definer
set search_path = public
as $$
  select u.id,
    (select count(*) from tbm_minutes m where m.user_id = u.id),
    (select count(*) from tbm_logs l where l.user_id = u.id),
    (select count(*) from worker_suggestions s where s.user_id = u.id)
  from unnest(p_ids) as u(id)
$$;

-- 서버(service_role) 전용 — 클라이언트가 임의 uuid로 남의 카운트를 세지 못하게
revoke execute on function public.org_doc_counts(uuid[]) from public, anon, authenticated;
