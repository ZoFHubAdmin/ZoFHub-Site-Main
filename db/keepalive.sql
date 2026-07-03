-- ZoFHub · keep-alive status table  (OPTIONAL but recommended)
-- ============================================================================
-- One row. The daily cron job and the /healthz endpoint upsert `last_pinged`
-- here so (a) your free-tier Supabase project sees a write and never hits its
-- 7-day inactivity pause, and (b) you can SEE the last heartbeat time.
--
-- The app also works WITHOUT this table — supabaseKeepAlive() falls back to a
-- tiny read — so running this is optional. With it, you get a visible marker.
--
-- HOW TO RUN: Supabase -> SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- Security: RLS on. Public may read the status; only the server (service-role
-- key, which bypasses RLS) writes it.
-- ============================================================================
create table if not exists public.keepalive (
  id          smallint    primary key default 1,
  last_pinged timestamptz not null default now(),
  constraint keepalive_single_row check (id = 1)
);

-- Seed the single row so the first upsert has a row to update.
insert into public.keepalive (id) values (1) on conflict (id) do nothing;

alter table public.keepalive enable row level security;
drop policy if exists "Public can read keepalive" on public.keepalive;
create policy "Public can read keepalive"
  on public.keepalive for select using (true);

-- Sanity check
select id, last_pinged from public.keepalive;
