-- 기존 계정 편입(attach): 안전관리자가 입력한 아이디({id}@tbm.com)로 대상 user id를 찾는다.
-- auth.users는 PostgREST로 직접 조회 불가 → security definer RPC. 서버(service role) 전용.
create or replace function public.find_user_id_by_login_email(p_email text)
returns uuid
language sql
security definer
set search_path to 'public', 'auth'
as $function$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$function$;

revoke execute on function public.find_user_id_by_login_email(text) from anon, authenticated, public;
