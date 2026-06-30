-- db/stats.sql — OPTIONAL. Makes "how much each game is played" survive restarts.
-- ============================================================================
-- The site ranks games by popularity (play counts) and shuffles the order per
-- visitor. It works WITHOUT this table — play counts just live in memory and
-- reset whenever the server restarts/redeploys. Run this once and the counts
-- persist and keep accumulating, so ranking gets better over time.
--
-- HOW TO RUN:  Supabase → SQL Editor → New query → paste → Run.
--             Expect "Success. No rows returned." Safe to re-run.
--
-- Security model (matches the rest of ZoFHub):
--   * RLS ON. Public (anon key) may only SELECT.
--   * Writes happen ONLY from the Node server using the service-role key, which
--     bypasses RLS — the browser can never write play counts directly.
-- ============================================================================

create table if not exists public.game_stats (
  slug        text        primary key,
  plays       bigint      not null default 0,
  updated_at  timestamptz not null default now()
);

comment on table public.game_stats is 'Lifetime play counts per game slug. Written server-side (service role) by POST /api/play flushes; powers popularity ranking.';

-- Find the most-played games quickly (for any future "Top games" query).
create index if not exists game_stats_plays_idx on public.game_stats (plays desc);

alter table public.game_stats enable row level security;
drop policy if exists "Public can read game_stats" on public.game_stats;
create policy "Public can read game_stats"
  on public.game_stats for select using (true);
