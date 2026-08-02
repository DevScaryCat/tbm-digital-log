-- worker_suggestions ↔ 문서 연결
--
-- 제안은 QR 서명 세션에서 들어오는데, 세션 행(tbm_pending_signatures)은 문서 저장 시 삭제되고
-- tbm_minutes/tbm_logs에는 세션 컬럼이 없다. 그래서 "이 제안이 어느 회의록에서 나왔나"를
-- 되짚을 방법이 아예 없었다 — 제안함에서 출력물로 갈 링크를 만들 수가 없었던 이유.
--
-- 저장 시점에 문서 id를 제안에 박아둔다. RLS는 기존 정책(소유자만 UPDATE) 그대로면 충분하다.

alter table public.worker_suggestions
  add column if not exists doc_type text,
  add column if not exists doc_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'worker_suggestions_doc_type_chk'
  ) then
    alter table public.worker_suggestions
      add constraint worker_suggestions_doc_type_chk
      check (doc_type is null or doc_type in ('minute', 'log'));
  end if;
end $$;

create index if not exists worker_suggestions_doc_idx
  on public.worker_suggestions (doc_type, doc_id);

-- 과거분 보정 — 세션 정보가 이미 사라진 기존 행은 시간 근접으로 잇는다.
-- 제안은 서명(=문서 저장) 직전에 들어오므로 '제안 시각 이후에 저장된 같은 소유자의 문서'가
-- 사실상 유일한 후보다. 앞뒤로 여유를 두되 가장 가까운 것 하나만 연결한다.
with cand as (
  select
    s.id as sug_id,
    d.doc_type,
    d.doc_id,
    row_number() over (
      partition by s.id
      order by abs(extract(epoch from (d.created_at - s.created_at)))
    ) as rn
  from public.worker_suggestions s
  join (
    select id as doc_id, user_id, created_at, 'minute'::text as doc_type from public.tbm_minutes
    union all
    select id as doc_id, user_id, created_at, 'log'::text as doc_type from public.tbm_logs
  ) d
    on d.user_id = s.user_id
   and d.created_at between s.created_at - interval '2 hours'
                        and s.created_at + interval '12 hours'
  where s.doc_id is null
)
update public.worker_suggestions ws
   set doc_type = c.doc_type,
       doc_id   = c.doc_id
  from cand c
 where c.sug_id = ws.id
   and c.rn = 1;
