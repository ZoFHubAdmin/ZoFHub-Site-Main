-- ==========================================================================
-- ZoFHub migration: scores_unique
-- Source of truth: db/community-scores-unique.sql
--
-- Real UNIQUE index for one-row-per-player-per-game (was app-code only, so concurrent submits could duplicate).
--
-- Applied by the Supabase GitHub integration to every preview branch and,
-- on merge, to production. This file is a VERBATIM copy of db/community-scores-unique.sql —
-- edit that file and re-run `npm run sync-migrations`, so the two cannot
-- drift.
--
-- Idempotent (IF NOT EXISTS / OR REPLACE / guarded DROPs), so applying it to
-- a database that already has this schema is a no-op rather than an error.
-- ==========================================================================

-- =====================================================================
-- ZoFHub · one-row-per-player-per-game UNIQUENESS  (run ONCE in Supabase)
-- =====================================================================
-- ADDITIVE & SAFE. Re-runnable (IF NOT EXISTS / OR REPLACE everywhere).
-- Run AFTER db/community.sql and db/community-scores-integrity.sql.
--
-- WHY THIS EXISTS
-- "One row per player per game (their best score)" was enforced ONLY in
-- application code: SELECT existing -> if higher UPDATE else INSERT. Between the
-- SELECT and the INSERT nothing stopped two concurrent submissions (the same
-- player in two tabs, a double-tap, a retry) from both seeing "no existing row"
-- and both inserting — producing duplicate rows for the same (slug, player_name).
-- scores_slug_player_idx was a PLAIN index, not UNIQUE, so the database happily
-- allowed it. /leaderboard hid the damage with a client-side dedupe; /community
-- did not, so the same data could render differently on the two pages.
--
-- WHAT THIS DOES
--   1. De-duplicates existing VISIBLE rows, keeping each player's highest score
--      per game (ties -> the earliest, matching prune_scores' ordering).
--      'flagged' / 'rejected' rows are NOT touched (see community-scores-review.sql).
--   2. Adds a PARTIAL UNIQUE index on (slug, player_name) WHERE status = 'ok'.
--      Partial on purpose: a player may legitimately have one visible row AND a
--      later attempt sitting in the flagged queue — a full unique index would
--      make that collide and reject the quarantine insert.
--   3. Installs submit_score(), an ATOMIC keep-the-best upsert the server calls
--      instead of select-then-branch. INSERT ... ON CONFLICT is what actually
--      makes the rule race-proof. (A partial unique index needs the matching
--      WHERE predicate in ON CONFLICT, which PostgREST's upsert cannot express —
--      that is why this is a function rather than a plain .upsert() call.)
--
--   Dashboard -> SQL Editor -> New query -> paste -> Run.
-- =====================================================================

-- 1) Report + remove duplicate VISIBLE rows, keeping each player's best.
do $$
declare dupes integer;
begin
  select count(*) into dupes
  from (
    select id, row_number() over (
             partition by slug, player_name
             order by score desc, created_at asc
           ) as rn
    from public.scores
    where status is not distinct from 'ok'
  ) t
  where t.rn > 1;
  raise notice 'Duplicate visible rows to remove: %', dupes;
end $$;

with ranked as (
  select id, row_number() over (
           partition by slug, player_name
           order by score desc, created_at asc
         ) as rn
  from public.scores
  where status is not distinct from 'ok'
)
delete from public.scores s
using ranked r
where s.id = r.id and r.rn > 1;

-- 2) The real constraint. Partial: only VISIBLE rows must be unique.
create unique index if not exists scores_slug_player_ok_uidx
  on public.scores (slug, player_name)
  where status = 'ok';

-- 3) Atomic "keep the best score" upsert.
--    Returns the resulting best plus whether this call created / raised it, so
--    the API can keep its existing { created, updated, best } response shape.
create or replace function public.submit_score(
  p_slug   text,
  p_player text,
  p_score  bigint
)
returns table (best bigint, updated boolean, created boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev bigint;
begin
  select s.score into v_prev
    from public.scores s
   where s.slug = p_slug and s.player_name = p_player and s.status = 'ok'
   limit 1;

  -- The atomic part: concurrent callers serialize here, so a duplicate row can
  -- never be created no matter how the requests interleave.
  insert into public.scores (slug, player_name, score, status, flag_reason)
  values (p_slug, p_player, p_score, 'ok', null)
  on conflict (slug, player_name) where status = 'ok'
  do update
     set score      = greatest(public.scores.score, excluded.score),
         created_at = case when excluded.score > public.scores.score
                           then now() else public.scores.created_at end,
         flag_reason = null;

  if v_prev is null then
    return query select p_score, false, true;
  elsif p_score > v_prev then
    return query select p_score, true, false;
  else
    return query select v_prev, false, false;
  end if;
end;
$$;

revoke all on function public.submit_score(text, text, bigint) from public, anon, authenticated;

-- 4) Sanity check: this must return 0 rows once the constraint is in place.
select slug, player_name, count(*) as copies
from public.scores
where status is not distinct from 'ok'
group by slug, player_name
having count(*) > 1;
