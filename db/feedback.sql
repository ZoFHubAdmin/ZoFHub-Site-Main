-- db/feedback.sql — user feedback.
--
-- Earlier files are left untouched on purpose: they are the applied history of
-- this database, and rewriting history so it never mentions scores would make a
-- replay from scratch diverge from what production actually did.
--
-- ── Part 1: the leaderboard retirement, undone ─────────────────────────────

-- RETIREMENT REVERSED. The leaderboard is back in the application (lib/scores.mjs,
-- GET/POST /api/scores, /leaderboard), so this file no longer drops the table it
-- reads. The drops are kept below, commented, because they DID run against
-- production once and a reader of this file needs to know that -- deleting the
-- lines outright would make the applied history unexplainable.
--
--   drop function if exists public.submit_score(text, text, integer, text);
--   drop function if exists public.submit_score(text, text, integer);
--   drop function if exists public.prune_scores(integer);
--   drop view     if exists public.scores_public;
--   drop table    if exists public.scores;
--
-- Because Supabase tracks migrations by FILENAME, editing this file does not
-- un-drop anything on a database where it already ran. That is what
-- db/scores-restore.sql is for: a forward migration that re-creates the table.
-- A replay from scratch now keeps the table all the way through.

-- ── Part 2: feedback ───────────────────────────────────────────────────────
-- Private by construction. Feedback is not a public wall: people report bugs,
-- mention what they were doing, and sometimes leave contact details. Read
-- access is admin-only via the secret key, which bypasses RLS. The publishable
-- key that ships in the browser can INSERT and nothing else.

create table if not exists public.feedback (
  id          bigint generated always as identity primary key,
  created_at  timestamptz  not null default now(),
  -- What the person said. Bounded in the database as well as the API, so a
  -- direct PostgREST insert cannot store a megabyte of text.
  message     text         not null check (length(btrim(message)) between 4 and 2000),
  -- Optional. Empty string is normalised to NULL by the API so "no email" has
  -- one representation rather than two.
  email       text         check (email is null or length(email) <= 200),
  -- Where they were when they sent it — the single most useful field for
  -- reproducing a bug, and the one people always forget to include.
  page        text         check (page is null or length(page) <= 300),
  -- 'bug' | 'idea' | 'other'. Kept as text with a check rather than an enum so
  -- adding a kind later is a one-line migration, not a type alteration.
  kind        text         not null default 'other'
                           check (kind in ('bug', 'idea', 'other')),
  -- Moderation lifecycle. Archived rows stay for the record; deletion is a
  -- separate, deliberate act in the admin UI.
  status      text         not null default 'new'
                           check (status in ('new', 'read', 'archived')),
  -- Salted hash, never a raw address. Enough to spot one person filing forty
  -- submissions; useless for identifying them.
  ip_hash     text         check (ip_hash is null or length(ip_hash) <= 64),
  user_agent  text         check (user_agent is null or length(user_agent) <= 300)
);

-- The review queue reads "newest first, optionally filtered by status", which is
-- exactly this index. Without it every dashboard load is a sequential scan.
create index if not exists feedback_status_created_idx
  on public.feedback (status, created_at desc);

-- Spam triage: "how many did this source send recently?" One partial index
-- rather than one on the whole table, since only recent rows are ever asked about.
create index if not exists feedback_ip_recent_idx
  on public.feedback (ip_hash, created_at desc)
  where ip_hash is not null;

alter table public.feedback enable row level security;

-- Deny-by-default plus ONE permissive policy: anonymous insert. There is
-- deliberately no select policy, so the publishable key cannot read back a
-- single row — not even the one it just wrote.
drop policy if exists "Anyone may send feedback" on public.feedback;
create policy "Anyone may send feedback"
  on public.feedback for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Feedback is never publicly readable" on public.feedback;

revoke all on public.feedback from anon, authenticated;
grant insert on public.feedback to anon, authenticated;

comment on table public.feedback is
  'User-submitted feedback. Insert-only for anon; readable only via the secret key. Never expose through a public view.';

-- ── Part 3: retention ──────────────────────────────────────────────────────
-- The admin security tables grow forever and are only ever read for the last
-- ~50 rows. Left alone they become the largest tables in the database, made
-- entirely of records nobody will look at again.
--
-- The audit trail is deliberately kept LONGER than the rest and is never
-- touched by anything the dashboard can call: it is the record of what
-- administrators did, and a log that operators can shorten is not evidence.

create or replace function public.prune_admin_logs(
  attempts_days integer default 30,
  events_days   integer default 90,
  audit_days    integer default 365
)
returns table (attempts_deleted bigint, events_deleted bigint, audit_deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare a bigint; e bigint; d bigint;
begin
  delete from public.admin_login_attempts
    where at < now() - make_interval(days => greatest(attempts_days, 7));
  get diagnostics a = row_count;

  delete from public.admin_security_events
    where at < now() - make_interval(days => greatest(events_days, 30));
  get diagnostics e = row_count;

  -- Floor of one year. A caller passing 0 must not be able to erase the trail.
  delete from public.admin_audit_logs
    where at < now() - make_interval(days => greatest(audit_days, 365));
  get diagnostics d = row_count;

  -- Expired and revoked sessions are pure garbage once they can no longer
  -- authenticate anything.
  delete from public.admin_sessions
    where expires_at < now() - interval '7 days'
       or (revoked_at is not null and revoked_at < now() - interval '7 days');

  return query select a, e, d;
end;
$$;

revoke all on function public.prune_admin_logs(integer, integer, integer) from public, anon, authenticated;

comment on function public.prune_admin_logs is
  'Retention sweep for the admin tables. SECURITY DEFINER and revoked from anon/authenticated: only the service key may call it.';

-- Orphaned play counters: rows for games that no longer exist in the catalog.
-- game_stats is written by slug with no foreign key (the catalog is refreshed
-- wholesale, and a hard FK would make a refresh fail rather than a counter go
-- stale), so orphans accumulate silently every time a game is delisted.
create or replace function public.prune_orphan_game_stats()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare n bigint;
begin
  delete from public.game_stats gs
   where not exists (select 1 from public.games g where g.slug = gs.slug);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.prune_orphan_game_stats() from public, anon, authenticated;

comment on function public.prune_orphan_game_stats is
  'Deletes game_stats rows whose slug is no longer in games. No FK exists by design — a wholesale catalog refresh must not fail on one counter.';
