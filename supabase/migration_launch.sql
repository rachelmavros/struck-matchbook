-- Launch hardening + note reports. Safe to run more than once.

-- ---------- photo storage limits ----------
-- Only images, at most 5 MB each (the app uploads cropped JPEGs well under 1 MB).
update storage.buckets
   set file_size_limit = 5242880,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id = 'matchbooks';

-- Uploads need a session (every visitor gets an anonymous one) and are capped per person per day.
-- One photo of a collage can produce up to ~20 cropped matchbooks, so 300 is generous.
drop policy if exists "matchbook upload" on storage.objects;
create policy "matchbook upload" on storage.objects for insert with check (
  bucket_id = 'matchbooks'
  and auth.role() = 'authenticated'
  and (
    select count(*) from storage.objects o
     where o.bucket_id = 'matchbooks'
       and o.owner = auth.uid()
       and o.created_at > now() - interval '1 day'
  ) < 300
);

-- ---------- "report this note" ----------
create table if not exists public.comment_reports (
  comment_id uuid not null references public.spot_comments(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)   -- one report per person per note
);

alter table public.comment_reports enable row level security;

drop policy if exists "reports insert" on public.comment_reports;
drop policy if exists "reports read"   on public.comment_reports;
drop policy if exists "reports delete" on public.comment_reports;

-- Any visitor (including signed-out) can report, as themselves.
create policy "reports insert" on public.comment_reports for insert with check (auth.uid() = user_id);

-- People see their own reports; admins see all of them.
create policy "reports read" on public.comment_reports for select using (
  auth.uid() = user_id
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
);

-- Admins dismiss reports.
create policy "reports delete" on public.comment_reports for delete using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
);
