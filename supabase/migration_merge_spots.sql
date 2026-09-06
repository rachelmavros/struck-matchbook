-- Merge two duplicate spot rows into one (e.g. "Cafe Ba-Ba-Reeba" submitted twice
-- under slightly different names, producing two different name_key values).
--
-- Moves photos, wishlist/been-there rows, and comments (if that table exists) from
-- the duplicate onto the spot being kept, then deletes the duplicate. Admin-only.

create or replace function public.merge_spots(p_keep_id uuid, p_remove_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) then
    raise exception 'admin only';
  end if;
  if p_keep_id = p_remove_id then
    raise exception 'cannot merge a spot into itself';
  end if;

  -- Photos: bring over any link the kept spot doesn't already have, then drop
  -- the duplicate's links (avoids a (spot_id, photo_id) primary key collision).
  insert into public.spot_photos (spot_id, photo_id)
  select p_keep_id, sp.photo_id from public.spot_photos sp
  where sp.spot_id = p_remove_id
  on conflict (spot_id, photo_id) do nothing;

  delete from public.spot_photos where spot_id = p_remove_id;

  -- Wishlist / been-there: OR the flags together per user, then drop the duplicate
  -- rows (avoids a (user_id, spot_id) primary key collision).
  insert into public.user_lists (user_id, spot_id, wishlist, visited)
  select ul.user_id, p_keep_id, ul.wishlist, ul.visited
  from public.user_lists ul
  where ul.spot_id = p_remove_id
  on conflict (user_id, spot_id) do update set
    wishlist = public.user_lists.wishlist or excluded.wishlist,
    visited  = public.user_lists.visited  or excluded.visited;

  delete from public.user_lists where spot_id = p_remove_id;

  -- Comments have their own id, so no conflict possible — just repoint them.
  if to_regclass('public.spot_comments') is not null then
    update public.spot_comments set spot_id = p_keep_id where spot_id = p_remove_id;
  end if;

  delete from public.spots where id = p_remove_id;
end $$;

grant execute on function public.merge_spots to authenticated;
