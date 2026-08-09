-- 계정 복구(아이디 찾기·비밀번호 재설정) — 인증된 복구 이메일 기반. 문자(솔라피) 아님.
-- 아이디 계정은 로그인 이메일이 가짜({아이디}@tbm.com)라 Supabase 기본 재설정 메일이 도달하지 못한다.
-- 그래서 user_metadata.real_email(인증 완료분)로만 보낸다.
--
-- email_verifications를 재사용하지 않는 이유: 그건 "이 주소로 메일이 닿는가"를 확인하는 물건(3일 만료·원문 토큰)이고,
-- 이건 "계정을 여는 열쇠"(30분·1회용·해시 저장)다. 만료와 파기 규칙이 다른 둘을 한 테이블에 두면
-- 한쪽 정책을 고칠 때 다른 쪽 보안이 조용히 무너진다.
create table if not exists public.password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- 원문 토큰은 메일 안에만 존재한다. DB가 통째로 유출돼도 계정을 열 수 없도록 sha256 해시만 저장.
  -- 아이디 찾기(purpose='find_id')는 링크가 없어 토큰도 없다 — 그 행은 발송 이력(폭주 제한의 근거)으로만 쓴다.
  token_hash text unique,
  purpose text not null default 'reset' check (purpose in ('reset', 'find_id')),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  used_at timestamptz,
  requested_ip text,
  created_at timestamptz not null default now()
);

-- 폭주 제한이 매 요청마다 읽는 경로 (user_id의 최근 발송)
create index if not exists password_reset_tokens_user_created_idx
  on public.password_reset_tokens (user_id, created_at desc);

-- 서버(service role) 전용. 정책을 하나도 만들지 않아 anon/authenticated는 한 행도 못 읽는다
-- (email_verifications·consents와 동일한 취급). 토큰 해시가 클라이언트로 새는 경로를 원천 차단.
alter table public.password_reset_tokens enable row level security;

-- 아이디 찾기: 이 이메일로 복구가 가능한 계정 목록.
-- auth.users는 PostgREST로 직접 조회 불가 → security definer RPC (find_user_id_by_login_email과 같은 전례).
--  · recovery_verified = true  → 아이디 계정. 인증된 복구 이메일이 이 주소다.
--  · recovery_verified = false → 로그인 이메일 자체가 이 주소(카카오 계정). 아이디가 없으니 메일에서 카카오 로그인을 안내한다.
create or replace function public.find_accounts_by_recovery_email(p_email text)
returns table (user_id uuid, login_email text, recovery_verified boolean)
language sql
security definer
set search_path to 'public', 'auth'
as $function$
  select
    u.id,
    u.email::text,
    (
      lower(coalesce(u.raw_user_meta_data ->> 'real_email', '')) = lower(p_email)
      and coalesce(u.raw_user_meta_data ->> 'real_email_verified_at', '') <> ''
    )
  from auth.users u
  where u.deleted_at is null
    and (
      (
        lower(coalesce(u.raw_user_meta_data ->> 'real_email', '')) = lower(p_email)
        and coalesce(u.raw_user_meta_data ->> 'real_email_verified_at', '') <> ''
      )
      or lower(u.email) = lower(p_email)
    );
$function$;

revoke execute on function public.find_accounts_by_recovery_email(text) from anon, authenticated, public;

-- 재설정 성공 시 기존 세션 전부 파기 (비밀번호가 이미 털렸다는 전제 — 안 끊으면 공격자 세션이 그대로 살아 있다).
-- auth.sessions 삭제로 refresh_tokens는 FK 캐스케이드되지만, session_id 없이 남은 옛 토큰까지 확실히 지운다.
create or replace function public.revoke_user_sessions(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
begin
  delete from auth.sessions where user_id = p_user_id;
  delete from auth.refresh_tokens where user_id = p_user_id::text;
end;
$function$;

revoke execute on function public.revoke_user_sessions(uuid) from anon, authenticated, public;
