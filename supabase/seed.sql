-- =============================================================================
-- ZoFHub · preview-branch seed
-- -----------------------------------------------------------------------------
-- Runs on PREVIEW BRANCHES ONLY (never production), after every migration in
-- supabase/migrations/ has been applied.
--
-- INTENTIONALLY TINY.
--
-- The real catalog is ~16,800 rows and lives in db/load-*.sql, about 14 MB of
-- INSERTs. Replaying that on every preview branch would make each branch slow to
-- provision while proving nothing a handful of rows can't: a preview branch
-- exists to show a SCHEMA change is sound. Restoring the full catalog is a
-- separate, deliberate act — run the db/load-*.sql files by hand against the
-- branch if you genuinely need production-scale data.
--
-- These few rows are enough for the app to boot against a branch and render
-- something: the homepage needs games, and /leaderboard needs the scores table
-- to exist and be queryable.
-- =============================================================================

-- A couple of real, license-clean games so the grid isn't empty.
insert into public.games (slug, title, game_url, thumbnail_url, category, is_working)
values
  ('smash-karts', 'Smash Karts',
   'https://smashkarts.io/', '/thumbs/smash-karts.jpg', 'io-games', true),
  ('bloxd-io', 'Bloxd io',
   'https://bloxd.io/', '/thumbs/bloxd-io.jpg', 'sandbox', true)
on conflict (slug) do nothing;

-- No seed scores. The leaderboard's whole point is that a row got there through
-- a signed proof-of-play session; hand-inserting rows here would model something
-- the app cannot actually produce, and would sit in the branch looking real.
