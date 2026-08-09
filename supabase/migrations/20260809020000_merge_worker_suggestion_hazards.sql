-- 저장 후 도착한 근로자 의견을 이미 저장된 회의록(tbm_minutes.hazards)에 원자적으로 합류
--
-- 배경: 의견→위험요인 합류는 감독자가 검토 화면(step 4)을 열어둔 동안의 12초 폴링이 전부였다.
-- 감독자가 저장하고 나가면(실사용에서 제일 흔한 동선) 의견이 worker_suggestions에는 쌓이지만
-- 저장된 문서에는 영영 합류하지 않았다. /api/suggestions(service role 전용 호출)가 접수 직후
-- 이 함수를 불러 "이미 저장된 회의록" 케이스를 서버에서 줍는다.
--
-- 설계:
--  · 문서 탐색: 저장 시 worker_suggestions UPDATE(doc_type='minute', doc_id)가 남긴
--    같은 세션의 연결 흔적을 그대로 따른다(클라이언트 입력으로 문서를 지정받지 않는다).
--  · 멱등: doc_id IS NULL 조건부 클레임 — 같은 의견 id는 두 번 합류하지 않는다(재시도·이중 탭).
--  · 동시성: hazards 갱신은 jsonb || 단일 UPDATE(행 잠금 하 원자) — read-modify-write 경합 없음.
--    클레임과 append가 한 함수(=한 트랜잭션)라 "클레임만 되고 append 유실" 반쪽 상태도 없다.
--  · p_hazards가 빈 배열이면 문서 연결만 하고 append는 생략(모델이 위험요인 해석 불가로 거른 의견).

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

  -- 같은 세션의 다른 의견이 이미 회의록에 연결돼 있으면 그 문서가 이 세션의 저장본이다
  select ws.doc_id into v_doc
    from worker_suggestions ws
   where ws.session_id = v_session
     and ws.doc_type = 'minute'
     and ws.doc_id is not null
   limit 1;
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

-- 서버(service role) 전용 — 무인증 클라이언트가 직접 부를 수 없어야 한다
revoke all on function public.merge_worker_suggestion_hazards(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.merge_worker_suggestion_hazards(uuid, jsonb) to service_role;
