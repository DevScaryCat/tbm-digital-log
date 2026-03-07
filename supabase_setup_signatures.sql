-- Please run this SQL in your Supabase SQL Editor to create the pending signatures table:

create table if not exists public.tbm_pending_signatures (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  name text not null,
  gender text not null check (gender in ('M', 'F')),
  signature text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Turn on row level security
alter table public.tbm_pending_signatures enable row level security;

-- Allow anonymous users to insert signatures (since workers scanning the QR code might not be logged in)
drop policy if exists "Anyone can insert a pending signature" on public.tbm_pending_signatures;
create policy "Anyone can insert a pending signature"
  on public.tbm_pending_signatures
  for insert
  with check (true);

-- Allow everyone to read pending signatures
drop policy if exists "Anyone can view pending signatures" on public.tbm_pending_signatures;
create policy "Anyone can view pending signatures"
  on public.tbm_pending_signatures
  for select
  using (true);

-- Allow everyone to delete pending signatures (for cleanup)
drop policy if exists "Anyone can delete pending signatures" on public.tbm_pending_signatures;
create policy "Anyone can delete pending signatures"
  on public.tbm_pending_signatures
  for delete
  using (true);
