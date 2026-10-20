-- Notes & updates on a spot ("closed now", "out of matchbooks", ...).
-- The app has read/written public.spot_comments for a while, but nothing ever created it,
-- so posting a note failed. Safe to run more than once.

create table if not exists public.spot_comments (
  id         uuid primary key default gen_random_uuid(),
  spot_id    uuid not null references public.spots(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  body       text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists spot_comments_spot_idx on public.spot_comments (spot_id, created_at desc);

alter table public.spot_comments enable row level security;

drop policy if exists "comments read"         on public.spot_comments;
drop policy if exists "comments insert"       on public.spot_comments;
drop policy if exists "comments delete"       on public.spot_comments;

-- Anyone can read notes.
create policy "comments read" on public.spot_comments for select using (true);

-- Only real (non-anonymous) signed-in accounts can post, and only as themselves.
create policy "comments insert" on public.spot_comments for insert with check (
  auth.uid() = user_id
  and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
);

-- Authors can delete their own notes; admins can delete any.
create policy "comments delete" on public.spot_comments for delete using (
  auth.uid() = user_id
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
);
