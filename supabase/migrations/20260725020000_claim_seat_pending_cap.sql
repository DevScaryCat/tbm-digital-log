-- 좌석 감축 예약(pending_seat_count) 중에도 구 좌석 수까지 가입이 허용되던 구멍 수정 (리뷰 D):
-- 예약 후 결제일 전에 현장을 추가하면 "1석 결제로 N현장" 과소 청구가 가능했다.
-- 상한 = least(seat_count, pending_seat_count) 로 교정.
create or replace function public.claim_org_seat(p_org uuid, p_member uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cap int;
  v_active int;
  v_current_org uuid;
begin
  perform pg_advisory_xact_lock(hashtext('org_seat_' || p_org::text));
  select least(seat_count, coalesce(pending_seat_count, seat_count)) into v_cap
    from public.organizations where id = p_org;
  if v_cap is null then return 'no_org'; end if;

  select org_id into v_current_org from public.org_members
    where member_user_id = p_member and status = 'active';
  if v_current_org is not null and v_current_org <> p_org then return 'other_org'; end if;

  select count(*) into v_active from public.org_members
    where org_id = p_org and status = 'active' and member_user_id <> p_member;
  if v_active >= v_cap then return 'no_seat'; end if;

  insert into public.org_members (org_id, member_user_id, status, joined_at, detached_at)
  values (p_org, p_member, 'active', now(), null)
  on conflict (member_user_id) do update
    set org_id = excluded.org_id, status = 'active', joined_at = now(), detached_at = null;
  return 'ok';
end;
$function$;

revoke execute on function public.claim_org_seat(uuid, uuid) from anon, authenticated, public;
