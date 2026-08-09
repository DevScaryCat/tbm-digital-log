-- 저장 후 도착 의견 봉합 2탄 — 20260809020000의 '저장 후 서버 합류'는 실제로 도달 불가였다.
--
-- 결함: submit_worker_suggestion의 게이트가 tbm_pending_signatures의 OPEN_SESSION 마커
-- 하나뿐인데, 감독자가 저장하면 pending 행을 전부 지운다. 따라서 "저장 후 도착한 의견"은
-- SESSION_CLOSED로 거절돼 접수조차 되지 않았고, /api/suggestions의 서버 합류 경로는
-- 저장 UPDATE와 pending DELETE 사이 수 밀리초에만 열리는 죽은 코드였다.
-- (근로자는 서명 직후 의견 화면에 머물다 감독자 저장 뒤 제출하는 동선이 실사용 최빈.)
--
--  1) tbm_minutes.session_id — 세션→저장 문서의 내구 추적. 저장 시 위저드가 기록한다.
--     기존엔 worker_suggestions의 doc 링크가 유일한 추적이라, 저장 전 의견이 0건이면
--     추적 자체가 없어 '저장 후 첫 의견'은 문서를 영영 못 찾았다.
--  2) submit_worker_suggestion — OPEN 마커가 없어도 이 세션의 저장본(저장 후 30분 이내)이
--     있으면 그 소유자로 접수하는 유예창. 소유 후보가 갈리면 접수 거부(fail-closed) —
--     타인 세션 id를 미리 알아내 자기 문서에 박아 의견을 가로채는 선점 공격 차단.
--  3) merge_worker_suggestion_hazards — 문서 탐색을 session_id 우선으로.
--     의견 doc 링크 추적은 구버전 앱(session_id 미기록) 저장분 폴백으로 유지.

alter table public.tbm_minutes add column if not exists session_id uuid;
create index if not exists tbm_minutes_session_idx
  on public.tbm_minutes (session_id) where session_id is not null;
-- 세션 기준 조회(접수 상한 count·스윕·합류)가 상시 경로가 됐다 — 전표 스캔 방지
create index if not exists worker_suggestions_session_idx
  on public.worker_suggestions (session_id);

create or replace function public.submit_worker_suggestion(
  p_session uuid,
  p_content text,
  p_author_name text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_owner uuid;
  v_count int;
  v_content text := trim(coalesce(p_content, ''));
  v_name text := nullif(trim(coalesce(p_author_name, '')), '');
begin
  if char_length(v_content) < 5 then
    raise exception 'CONTENT_TOO_SHORT';
  end if;
  if char_length(v_content) > 500 then
    raise exception 'CONTENT_TOO_LONG';
  end if;
  if v_name is not null and char_length(v_name) > 30 then
    raise exception 'NAME_TOO_LONG';
  end if;

  select user_id into v_owner
  from tbm_pending_signatures
  where session_id = p_session
    and name = 'OPEN_SESSION'
    and created_at > now() - interval '30 minutes'
  limit 1;

  if v_owner is null then
    -- 저장 후 유예창: 세션이 이미 회의록으로 저장됐으면(마커는 저장 시 삭제됨)
    -- 저장 30분 이내에 한해 그 문서 소유자로 접수한다.
    -- 소유자 결정은 세션 개장 중 접수된 앞선 의견의 소유자를 최우선 근거로 삼는다 —
    -- 그 소유자의 저장본이 있어야만 인정하고, 앞선 의견이 없으면(저장 후 첫 의견)
    -- 이 세션 id를 가진 문서의 소유 후보가 유일할 때만 인정한다(선점 공격 fail-closed).
    select user_id into v_owner
      from worker_suggestions
     where session_id = p_session
     order by created_at asc
     limit 1;
    if v_owner is not null then
      if not exists (
        select 1 from tbm_minutes
         where session_id = p_session
           and user_id = v_owner
           and created_at > now() - interval '30 minutes'
      ) then
        v_owner := null;
      end if;
    elsif (
      select count(distinct user_id) from tbm_minutes
       where session_id = p_session
         and created_at > now() - interval '30 minutes'
    ) = 1 then
      select user_id into v_owner
        from tbm_minutes
       where session_id = p_session
         and created_at > now() - interval '30 minutes'
       limit 1;
    end if;
  end if;

  if v_owner is null then
    raise exception 'SESSION_CLOSED';
  end if;

  -- 세션당 30건 상한(스팸 방어)
  select count(*) into v_count from worker_suggestions where session_id = p_session;
  if v_count >= 30 then
    raise exception 'TOO_MANY_SUGGESTIONS';
  end if;

  insert into worker_suggestions (user_id, session_id, content, author_name)
  values (v_owner, p_session, v_content, v_name);
end;
$$;

create or replace function public.merge_worker_suggestion_hazards(
  p_suggestion uuid,
  p_hazards jsonb
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_session uuid;
  v_user uuid;
  v_doc uuid;
begin
  if p_hazards is null or jsonb_typeof(p_hazards) <> 'array' then
    raise exception 'INVALID_HAZARDS';
  end if;

  select session_id, user_id into v_session, v_user
    from worker_suggestions
   where id = p_suggestion;
  if v_session is null then
    return 'NOT_FOUND';
  end if;

  -- 문서 탐색 1순위: 저장 시 위저드가 기록한 tbm_minutes.session_id.
  -- 의견 소유자와 문서 소유자가 일치하는 문서만 본다(계정 간 오염 차단).
  select id into v_doc
    from tbm_minutes
   where session_id = v_session
     and user_id = v_user
   order by created_at desc
   limit 1;
  -- 2순위(구버전 앱 저장분 — session_id 미기록): 같은 세션의 다른 의견이 남긴 doc 링크
  if v_doc is null then
    select ws.doc_id into v_doc
      from worker_suggestions ws
     where ws.session_id = v_session
       and ws.doc_type = 'minute'
       and ws.doc_id is not null
     limit 1;
  end if;
  if v_doc is null then
    return 'NO_DOC';
  end if;

  -- 멱등 클레임: 아직 어떤 문서에도 연결되지 않은 의견만 잡는다
  update worker_suggestions
     set doc_type = 'minute', doc_id = v_doc
   where id = p_suggestion
     and doc_id is null;
  if not found then
    return 'ALREADY_MERGED';
  end if;

  if jsonb_array_length(p_hazards) > 0 then
    -- 소유자 일치 강제: 의견 소유자와 문서 소유자가 다르면 append하지 않고 전체 롤백
    update tbm_minutes
       set hazards = coalesce(hazards, '[]'::jsonb) || p_hazards
     where id = v_doc
       and user_id = v_user;
    if not found then
      raise exception 'DOC_NOT_FOUND'; -- 클레임까지 롤백된다
    end if;
  end if;

  return 'MERGED';
end;
$$;

-- ACL 재확인 (OR REPLACE는 기존 ACL을 유지하지만 신규 환경 대비 명시)
revoke all on function public.merge_worker_suggestion_hazards(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.merge_worker_suggestion_hazards(uuid, jsonb) to service_role;
