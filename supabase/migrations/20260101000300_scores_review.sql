-- ==========================================================================
-- ZoFHub migration: scores_review
-- Source of truth: db/community-scores-review.sql
--
-- Review lifecycle: unreviewed rows are never auto-deleted; only rejected ones are purged.
--
-- Applied by the Supabase GitHub integration to every preview branch and,
-- on merge, to production. This file is a VERBATIM copy of db/community-scores-review.sql —
-- edit that file and re-run `npm run sync-migrations`, so the two cannot
-- drift.
--
-- Idempotent (IF NOT EXISTS / OR REPLACE / guarded DROPs), so applying it to
-- a database that already has this schema is a no-op rather than an error.
-- ==========================================================================

-- =====================================================================
-- ZoFHub · flagged-score REVIEW add-on   (run ONCE in the Supabase SQL editor)
-- =====================================================================
-- ADDITIVE & SAFE. Re-runnable (OR REPLACE everywhere). Run this AFTER
-- db/community-scores-integrity.sql.
--
-- WHY THIS EXISTS
-- Before this, a quarantined score's real lifecycle was:
--     flagged -> invisible to everyone -> DELETED by prune_scores after 7 days
-- with no code path anywhere that could ever un-flag it. The player was still
-- told "pending review", so a genuinely great score could trip the outlier
-- heuristic, be hidden, and then vanish a week later — a promise the app could
-- not keep.
--
-- There is now a real review path (the private /admin console + the
-- /api/admin/scores/:id/approve|reject endpoints). This migration makes the
-- database agree with it:
--   * UNREVIEWED ('flagged') rows are NEVER auto-deleted — they wait for you.
--   * Only rows you actively REJECTED are purged, 7 days after rejection.
--   * The per-game "keep top N visible" cap is unchanged.
--
--   Dashboard -> SQL Editor -> New query -> paste -> Run.
-- =====================================================================

-- Status-aware cleanup, review-safe.
--   status 'ok'       -> public, capped at keep_per_game per slug
--   status 'flagged'  -> awaiting YOUR review; kept indefinitely
--   status 'rejected' -> you said no; purged after 7 days
create or replace function public.prune_scores(keep_per_game integer default 200)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer := 0;
  n integer;
begin
  -- 1) Purge only REJECTED rows. 'flagged' (unreviewed) rows are deliberately
  --    NOT touched — deleting them is what made "pending review" a false promise.
  delete from public.scores
  where status = 'rejected'
    and created_at < now() - interval '7 days';
  get diagnostics n = row_count;  removed := removed + n;

  -- 2) Long tail of VISIBLE scores, per game (unchanged).
  with ranked as (
    select id,
           row_number() over (partition by slug order by score desc, created_at asc) as rn
    from public.scores
    where status is not distinct from 'ok'
  )
  delete from public.scores s
  using ranked r
  where s.id = r.id and r.rn > keep_per_game;
  get diagnostics n = row_count;  removed := removed + n;

  return removed;
end;
$$;

revoke all on function public.prune_scores(integer) from public, anon, authenticated;

-- Sanity check: what is waiting for review right now?
select
  count(*) filter (where status = 'ok')       as visible,
  count(*) filter (where status = 'flagged')  as awaiting_review,
  count(*) filter (where status = 'rejected') as rejected
from public.scores;
