-- Allow admins to delete a single photo (e.g. a bad/wrong shot in a spot's gallery).
-- Assumes public.profiles(id, is_admin) already exists, same as the admin-only
-- spots update/delete policies already applied to this project.
--
-- Deleting a photos row cascades to remove its spot_photos link automatically
-- (spot_photos.photo_id references photos(id) on delete cascade) — the spot
-- itself and its other photos are untouched.

create policy "photos delete" on public.photos for delete
  using (exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.is_admin
  ));

create policy "matchbook delete" on storage.objects for delete
  using (bucket_id = 'matchbooks' and exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.is_admin
  ));
