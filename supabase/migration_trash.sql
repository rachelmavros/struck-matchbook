-- Soft-delete trash bin for spots and photos.
-- Instead of hard-deleting, admins mark rows with deleted_at. RLS hides them from
-- everyone except admins, who see a separate Trash view where items can be restored
-- or permanently purged.
--
-- Safe to run once on top of the moderation migration. Existing spots stay live
-- (deleted_at defaults to null).

alter table public.spots  add column if not exists deleted_at timestamptz;
alter table public.photos add column if not exists deleted_at timestamptz;

create index if not exists spots_deleted_at_idx  on public.spots  (deleted_at);
create index if not exists photos_deleted_at_idx on public.photos (deleted_at);

-- Rebuild the spots read policy so soft-deleted rows only surface for admins.
-- Preserves moderation behavior: non-admins still see approved rows + their own.
drop policy if exists "spots read" on public.spots;
create policy "spots read" on public.spots for select using (
  (deleted_at is null and (approved or submitted_by = auth.uid()))
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
);

-- Photos: hide soft-deleted from non-admins.
drop policy if exists "photos read" on public.photos;
create policy "photos read" on public.photos for select using (
  deleted_at is null
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
);

-- Admin update on photos, so soft-delete and restore actually go through.
-- (photos never had an update policy — the delete policy from the previous
-- migration stays around for the eventual "purge permanently" path.)
drop policy if exists "photos update admin" on public.photos;
create policy "photos update admin" on public.photos for update using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
);
