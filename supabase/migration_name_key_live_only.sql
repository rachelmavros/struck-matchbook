-- The plain unique(name_key) constraint applies to every row, including soft-deleted
-- ones sitting in the trash bin. That means a name can never be reused once its old
-- spot was trashed — renaming/creating a spot with that name fails with
-- "duplicate key value violates unique constraint spots_name_key_key" even though
-- nothing visibly duplicate exists anywhere in the app.
--
-- Replace it with a unique index that only applies to live rows (deleted_at is
-- null). Trashed rows keep their name_key on record but no longer reserve it.

alter table public.spots drop constraint if exists spots_name_key_key;

create unique index if not exists spots_name_key_live_idx
  on public.spots (name_key)
  where deleted_at is null;
