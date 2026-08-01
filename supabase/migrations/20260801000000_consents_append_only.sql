-- 약관·개인정보처리방침 동의 증빙 (append-only).
-- 지금까지 동의는 브라우저 localStorage에만 남아 회사가 보유한 증빙이 0건이었다.
-- user_metadata는 본인이 세션만 있으면 덮어쓸 수 있어 증빙 저장소로 부적격 —
-- 판정용 캐시는 metadata에 두되, 증빙은 이 테이블에 정정·삭제 없이 쌓는다.
create table if not exists public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  doc text not null check (doc in ('terms', 'privacy')),
  version text not null,
  agreed_at timestamptz not null default now(),
  source text not null,
  ip text,
  user_agent text
);

create index if not exists consents_user_doc_idx
  on public.consents (user_id, doc, agreed_at desc);

-- 정책 없음 = service role 외 접근 불가. 갱신이 아니라 새 행 추가로만 기록한다.
alter table public.consents enable row level security;
revoke update, delete on public.consents from authenticated, anon;
