-- Struck — Chicago Matchbook Map schema
-- Run this in the Supabase SQL editor (Project → SQL → New query).

-- ---------- tables ----------
create table if not exists public.spots (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  name_key     text not null unique,        -- normalized name, used for dedupe
  address      text,
  neighborhood text,
  type         text not null default 'bar', -- 'bar' | 'restaurant' | 'other'
  status       text not null default 'unknown',
  lat          double precision,
  lng          double precision,
  approx       boolean not null default false,
  created_at   timestamptz not null default now()
);

create table if not exists public.photos (
  id           uuid primary key default gen_random_uuid(),
  storage_path text not null,
  public_url   text not null,
  uploaded_by  uuid references auth.users(id),
  created_at   timestamptz not null default now()
);

-- a photo (e.g. a collage) can belong to many spots, and vice versa
create table if not exists public.spot_photos (
  spot_id  uuid references public.spots(id) on delete cascade,
  photo_id uuid references public.photos(id) on delete cascade,
  primary key (spot_id, photo_id)
);

-- per-user wishlist / been-there
create table if not exists public.user_lists (
  user_id  uuid references auth.users(id),
  spot_id  uuid references public.spots(id) on delete cascade,
  wishlist boolean not null default false,
  visited  boolean not null default false,
  primary key (user_id, spot_id)
);

-- ---------- row level security ----------
alter table public.spots       enable row level security;
alter table public.photos      enable row level security;
alter table public.spot_photos enable row level security;
alter table public.user_lists  enable row level security;

-- spots, photos and the join table are a shared community map: anyone can read,
-- any signed-in user (including anonymous sessions) can add.
create policy "spots read"   on public.spots       for select using (true);
create policy "spots write"  on public.spots       for insert with check (auth.role() = 'authenticated');
create policy "spots update" on public.spots       for update using (auth.role() = 'authenticated');

create policy "photos read"  on public.photos      for select using (true);
create policy "photos write" on public.photos      for insert with check (auth.role() = 'authenticated');

create policy "sp read"      on public.spot_photos for select using (true);
create policy "sp write"     on public.spot_photos for insert with check (auth.role() = 'authenticated');

-- lists are private to each user
create policy "lists own read"   on public.user_lists for select using (auth.uid() = user_id);
create policy "lists own write"  on public.user_lists for insert with check (auth.uid() = user_id);
create policy "lists own update" on public.user_lists for update using (auth.uid() = user_id);

-- ---------- storage bucket ----------
insert into storage.buckets (id, name, public)
values ('matchbooks', 'matchbooks', true)
on conflict (id) do nothing;

create policy "matchbook read"   on storage.objects for select
  using (bucket_id = 'matchbooks');
create policy "matchbook upload" on storage.objects for insert
  with check (bucket_id = 'matchbooks' and auth.role() = 'authenticated');
