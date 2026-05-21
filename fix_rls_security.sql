-- fix_rls_security.sql

-- 1. Create profiles table linked to auth.users
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  company_name text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS on profiles
alter table public.profiles enable row level security;

-- Create policies for profiles
drop policy if exists "Users can view their own profile" on public.profiles;
create policy "Users can view their own profile"
  on public.profiles for select
  using (auth.uid() = id);

-- 2. Trigger function to automatically create profile on sign up
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, company_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'company_name', '기본회사')
  );
  return new;
end;
$$ language plpgsql security definer;

-- Recreate trigger
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 3. Migrate existing user metadata to profiles
insert into public.profiles (id, company_name)
select id, coalesce(raw_user_meta_data->>'company_name', '기본회사')
from auth.users
on conflict (id) do update
set company_name = excluded.company_name;

-- 4. Drop vulnerable policy on tbm_logs and create secure one
drop policy if exists company_can_see_logs on public.tbm_logs;
create policy company_can_see_logs on public.tbm_logs
for select
using (
  company_name = (
    select company_name from public.profiles where id = auth.uid()
  )
);
