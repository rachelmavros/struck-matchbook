-- Daily cap on matchbook-photo reads per visitor, enforced by /api/read.
-- Each read costs a Claude Vision call, so this keeps one person (or a bot) from running up the bill.
-- The server stores only a keyed hash of the visitor's IP + date, never the IP itself; rows older
-- than two days are cleared out as new ones come in. Safe to run more than once.

create table if not exists public.read_quota (
  key   text not null,
  day   date not null default current_date,
  count int  not null default 0,
  primary key (key, day)
);

-- No policies: the table is only reachable through the function below.
alter table public.read_quota enable row level security;

create or replace function public.take_read_quota(p_key text, p_limit int)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  delete from public.read_quota where day < current_date - 1;
  insert into public.read_quota (key, day, count) values (p_key, current_date, 1)
  on conflict (key, day) do update set count = read_quota.count + 1
  returning count into v_count;
  return v_count <= p_limit;
end $$;

grant execute on function public.take_read_quota(text, int) to anon, authenticated;
