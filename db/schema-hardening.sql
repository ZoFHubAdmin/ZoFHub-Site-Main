-- db/schema-hardening.sql — corrections found by a full audit of the SQL layer.
--
-- Runs LAST, after db/feedback.sql. Like that file, it exists as a NEW migration
-- rather than an edit to the ones before it: those have already been applied to
-- production, and the Supabase integration will not re-run a file it has already
-- recorded. Editing an applied migration changes only the repository's account of
-- the database, never the database — which is the worst of both, because the two
-- then disagree while appearing to agree.
--
-- Four independent corrections. Each is idempotent and each is a no-op on a
-- database that never had the defect.


-- ── 1. The leaderboard teardown missed the function it was aiming at ────────
--
-- db/feedback.sql retires the leaderboard and says, in its own header, that it
-- "removes two SECURITY DEFINER functions — code that runs with elevated rights
-- and should not exist without a caller." It drops:
--
--     submit_score(text, text, integer, text)
--     submit_score(text, text, integer)
--     prune_scores(integer)
--
-- but the function db/community-scores-unique.sql actually created is
--
--     submit_score(text, text, BIGINT)                     -- p_score bigint
--
-- and Postgres identifies a function by name AND argument types. So the two
-- drops named above matched nothing, and the real function survived the
-- teardown: a SECURITY DEFINER routine, still present, whose body inserts into
-- public.scores — a table that no longer exists. Every call raises
-- `relation "public.scores" does not exist`.
--
-- It is revoked from anon and authenticated, so this was never reachable from a
-- browser. It is dead elevated-privilege code that the repository believed was
-- already gone, which is its own problem: the next person to audit the database
-- finds a SECURITY DEFINER function that no file admits to keeping.
--
-- Only the bigint spelling is dropped here. Repeating the other two would be
-- theatre: db/feedback.sql already issues them, it always runs first, and a
-- `drop … if exists` for a signature that was never created is a no-op whose
-- only effect is to make the next reader wonder what it was for.
drop function if exists public.submit_score(text, text, bigint);


-- ── 2. Two prune functions where one is called ──────────────────────────────
--
-- db/admin.sql created prune_admin_state(integer, integer, integer). db/feedback.sql
-- later created prune_admin_logs(integer, integer, integer), which does the same
-- work plus the expired-session sweep, and that is the one lib/cron-jobs.mjs
-- calls. Nothing anywhere calls prune_admin_state — not the server, not a tool,
-- not a runbook.
--
-- It is not merely unused. prune_admin_logs deliberately floors its arguments
-- (`greatest(attempts_days, 7)`, and a hard one-year floor on the audit trail)
-- so that a caller passing 0 cannot erase the record. prune_admin_state has no
-- floors at all: prune_admin_state(0, 0, 0) deletes every login attempt and every
-- security event on the spot. Keeping the unfloored predecessor next to the
-- floored replacement means the safety is one argument away from being bypassed.
drop function if exists public.prune_admin_state(integer, integer, integer);


-- ── 3. Two functions do not pin search_path ─────────────────────────────────
--
-- db/schema.sql sets the house standard and explains it: `security invoker` plus
-- `set search_path = ''` clears Supabase's "Function Search Path Mutable"
-- advisor, and now() still resolves because pg_catalog is implicitly present
-- even with an empty search_path. games_set_updated_at() follows it.
--
-- These two were written later and did not. They are re-declared here with the
-- same bodies and the hardening added, so the whole schema passes the advisor
-- rather than most of it. CREATE OR REPLACE keeps the existing triggers bound —
-- replacing a function does not detach the triggers that use it, so nothing has
-- to be recreated and there is no window where the audit table is writable.
create or replace function public.admin_audit_is_append_only()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'admin_audit_logs is append-only (attempted %)', tg_op;
end $$;

create or replace function public.touch_game_fingerprints()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end $$;


-- ── 4. The orphan-counter sweep deletes counters for games that ARE served ──
--
-- prune_orphan_game_stats() deletes every game_stats row whose slug is not in
-- public.games. That rests on an assumption which is false in this application:
-- that public.games is the whole catalog.
--
-- It is not. server.js builds the served catalog in setCatalog(), which starts
-- from the Supabase rows and then calls mergeFinalGames() — appending every
-- entry of finalgames.json whose slug is NOT already present — and then
-- applyCatalogOverrides(), whose `add` rules inject four more. Those games are
-- appended precisely BECAUSE they are absent from public.games. Roughly 76 of
-- the ~12,300 served games therefore exist only in the repository's JSON.
--
-- Play them and POST /api/play increments the counter; flushPlayStats() upserts
-- it into game_stats a minute later; the weekly sweep sees a slug that is not in
-- public.games and deletes it. Those games are pinned at zero plays forever, so
-- popularity ranking can never learn anything about them no matter how much they
-- are played — the one signal the ranking blend weights most heavily.
--
-- The intent of the sweep is right; its evidence was wrong. "Absent from
-- public.games" does not mean delisted. What does mean delisted is that nobody
-- has played it since: flushPlayStats() writes updated_at on every flush, so a
-- counter that is still moving is proof the game is still reachable, whatever
-- public.games says. A genuinely delisted game stops being played, its
-- updated_at freezes, and it ages out on the next sweep after the grace period.
--
-- The signature stays zero-argument on purpose. Adding `stale_days integer
-- default 90` would create a SECOND function of this name, and PostgREST would
-- then refuse rpc('prune_orphan_game_stats', {}) as ambiguous — the same
-- overload trap that let submit_score survive in section 1 above.
create or replace function public.prune_orphan_game_stats()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  n bigint;
  -- Long enough that a real player's counter is never collected, short enough
  -- that a delisted game's row does not outlive its usefulness by much.
  grace interval := interval '90 days';
begin
  delete from public.game_stats gs
   where not exists (select 1 from public.games g where g.slug = gs.slug)
     and gs.updated_at < now() - grace;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.prune_orphan_game_stats() from public, anon, authenticated;

comment on function public.prune_orphan_game_stats is
  'Deletes game_stats rows whose slug is neither in games NOR touched in 90 days. The staleness clause is load-bearing: ~76 served games live only in finalgames.json / catalog-overrides and are absent from games by design.';
