-- Moderation queue: user submissions stay hidden until an admin approves them.
-- Safe to run once on an existing database — everything already live is approved
-- up front so the public map doesn't go blank.

-- ---------- columns ----------
alter table public.spots add column if not exists approved     boolean not null default false;
alter table public.spots add column if not exists submitted_by uuid references auth.users(id);

-- Everything that already exists predates moderation — grandfather it in.
update public.spots set approved = true where approved = false;

create index if not exists spots_approved_idx     on public.spots (approved);
create index if not exists spots_submitted_by_idx on public.spots (submitted_by);

-- ---------- upsert RPC ----------
-- A second person uploading a matchbook for an existing spot must never flip that
-- spot's approved flag back to false or steal its original submitter. Doing this in
-- SQL (rather than a client-side upsert) keeps that guarantee server-side.
-- security definer so the insert path can set submitted_by/approved despite RLS.
create or replace function public.upsert_spot(
  p_name text, p_name_key text, p_address text, p_neighborhood text,
  p_type text, p_status text, p_lat double precision, p_lng double precision,
  p_approx boolean
) returns public.spots
language plpgsql security definer set search_path = public as $$
declare
  v_spot public.spots;
  v_is_admin boolean;
begin
  select coalesce(p.is_admin, false) into v_is_admin
    from public.profiles p where p.id = auth.uid();

  select * into v_spot from public.spots s where s.name_key = p_name_key;

  if found then
    -- Existing spot: only fill in blanks. Never touch submitted_by or approved.
    update public.spots set
      address      = coalesce(nullif(p_address, ''),      address),
      neighborhood = coalesce(nullif(p_neighborhood, ''), neighborhood),
      lat          = coalesce(p_lat, lat),
      lng          = coalesce(p_lng, lng)
    where id = v_spot.id
    returning * into v_spot;
    return v_spot;
  end if;

  insert into public.spots (
    name, name_key, address, neighborhood, type, status, lat, lng, approx,
    submitted_by, approved
  ) values (
    p_name, p_name_key, nullif(p_address, ''), nullif(p_neighborhood, ''),
    coalesce(p_type, 'bar'), coalesce(p_status, 'unknown'), p_lat, p_lng,
    coalesce(p_approx, false),
    auth.uid(), coalesce(v_is_admin, false)  -- admin submissions self-approve
  )
  returning * into v_spot;
  return v_spot;
end $$;

grant execute on function public.upsert_spot to anon, authenticated;

-- ---------- row level security ----------
-- Public reads are limited to approved spots; you can always see your own
-- submissions, and admins see everything.
drop policy if exists "spots read"   on public.spots;
drop policy if exists "spots update" on public.spots;

create policy "spots read" on public.spots for select using (
  approved
  or submitted_by = auth.uid()
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
);

-- Admins can edit anything. Submitters can edit their own spot; a WITH CHECK on the
-- non-admin path forces approved=false, so a user editing an already-approved spot
-- sends it back to the review queue instead of pushing changes straight to the map.
create policy "spots update admin" on public.spots for update
  using  (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "spots update own" on public.spots for update
  using  (submitted_by = auth.uid())
  with check (submitted_by = auth.uid() and not approved);
