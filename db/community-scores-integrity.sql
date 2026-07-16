-- =====================================================================
-- ZoFHub · scores integrity add-on   (run ONCE in the Supabase SQL editor)
-- =====================================================================
-- ADDITIVE & SAFE. Adds a moderation status to the existing `scores` table so
-- the Node server can QUARANTINE suspicious high scores (outliers) instead of
-- showing them on the public leaderboard, and upgrades the cleanup functions so
-- the tables stay BOUNDED (flagged rows are purged/excluded; the community feed
-- gets a hard ceiling). Existing rows default to 'ok' and stay visible.
-- Re-runnable (IF NOT EXISTS / OR REPLACE everywhere).
--
-- Until you run this, the server still enforces the two strongest defenses
-- (single-use proof-of-play sessions + per-game score ceilings); it just can't
-- hold outliers for review. After you run it, quarantine turns on automatically
-- the next time the server probes the table.
--
--   Dashboard → SQL Editor → New query → paste → Run.
-- =====================================================================

-- 1) Moderation columns.
alter table public.scores add column if not exists status      text not null default 'ok';
alter table public.scores add column if not exists flag_reason text;

-- 2) Index the common read path: visible ('ok') rows ordered by score.
create index if not exists scores_status_score_idx on public.scores (status, score desc);

-- 3) Tighten RLS so the public anon key can only ever read VISIBLE scores.
--    The Node server reads with the service-role key (bypasses RLS) and still
--    sees flagged rows for moderation.
drop policy if exists "Public can read scores" on public.scores;
drop policy if exists "Public can read visible scores" on public.scores;
create policy "Public can read visible scores"
  on public.scores for select using (status = 'ok');

-- 4) Status-aware cleanup: purge old flagged rows + keep only the top VISIBLE
--    scores per game (flagged rows excluded from the ranking so a fake outlier
--    can't survive in place of a real score). Replaces the old prune_scores.
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
  delete from public.scores
  where status is distinct from 'ok'
    and created_at < now() - interval '7 days';
  get diagnostics n = row_count;  removed := removed + n;

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

-- 5) Hard-cap the community feed (keep newest `keep`, delete the rest).
create or replace function public.prune_recommendations(keep integer default 1000)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare removed integer;
begin
  with ranked as (
    select id, row_number() over (order by created_at desc) as rn
    from public.recommendations
  )
  delete from public.recommendations r
  using ranked k
  where r.id = k.id and k.rn > keep;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_scores(integer)          from public, anon, authenticated;
revoke all on function public.prune_recommendations(integer) from public, anon, authenticated;

-- 6) Sanity check.
select
  count(*) filter (where status = 'ok')      as visible,
  count(*) filter (where status = 'flagged') as flagged
from public.scores;
