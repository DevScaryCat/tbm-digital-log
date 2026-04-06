-- Create table for TBM Minutes
create table if not exists public.tbm_minutes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  date date not null,
  start_time time without time zone,
  end_time time without time zone,
  location text,
  process_name text,
  work_name text,
  work_content text,
  leader_title text,
  leader_name text,
  leader_signature text,
  health_check text default '해당없음',
  ppe_check text default '안전모, 안전화',
  safety_phrase text,
  instructions text,
  hazards jsonb default '[]'::jsonb
);

-- Enable RLS
alter table public.tbm_minutes enable row level security;

-- Policies for tbm_minutes
drop policy if exists "Users can view their own tbm_minutes" on public.tbm_minutes;
create policy "Users can view their own tbm_minutes"
  on public.tbm_minutes for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own tbm_minutes" on public.tbm_minutes;
create policy "Users can insert their own tbm_minutes"
  on public.tbm_minutes for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own tbm_minutes" on public.tbm_minutes;
create policy "Users can update their own tbm_minutes"
  on public.tbm_minutes for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete their own tbm_minutes" on public.tbm_minutes;
create policy "Users can delete their own tbm_minutes"
  on public.tbm_minutes for delete
  using (auth.uid() = user_id);

-- Create table for TBM Minutes Participants
create table if not exists public.tbm_minutes_participants (
  id uuid primary key default gen_random_uuid(),
  minutes_id uuid not null references public.tbm_minutes(id) on delete cascade,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  name text not null,
  signature text not null
);

-- Enable RLS
alter table public.tbm_minutes_participants enable row level security;

-- Policies for tbm_minutes_participants
drop policy if exists "Users can view participants of their own minutes" on public.tbm_minutes_participants;
create policy "Users can view participants of their own minutes"
  on public.tbm_minutes_participants for select
  using (
    exists (
      select 1 from public.tbm_minutes
      where tbm_minutes.id = tbm_minutes_participants.minutes_id
      and tbm_minutes.user_id = auth.uid()
    )
  );

drop policy if exists "Users can insert participants to their own minutes" on public.tbm_minutes_participants;
create policy "Users can insert participants to their own minutes"
  on public.tbm_minutes_participants for insert
  with check (
    exists (
      select 1 from public.tbm_minutes
      where tbm_minutes.id = tbm_minutes_participants.minutes_id
      and tbm_minutes.user_id = auth.uid()
    )
  );

drop policy if exists "Users can update participants of their own minutes" on public.tbm_minutes_participants;
create policy "Users can update participants of their own minutes"
  on public.tbm_minutes_participants for update
  using (
    exists (
      select 1 from public.tbm_minutes
      where tbm_minutes.id = tbm_minutes_participants.minutes_id
      and tbm_minutes.user_id = auth.uid()
    )
  );

drop policy if exists "Users can delete participants of their own minutes" on public.tbm_minutes_participants;
create policy "Users can delete participants of their own minutes"
  on public.tbm_minutes_participants for delete
  using (
    exists (
      select 1 from public.tbm_minutes
      where tbm_minutes.id = tbm_minutes_participants.minutes_id
      and tbm_minutes.user_id = auth.uid()
    )
  );
