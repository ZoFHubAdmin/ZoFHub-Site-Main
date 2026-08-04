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
-- something: the homepage needs games in the grid.
-- =============================================================================

-- A couple of games so the grid isn't empty.
--
-- These MUST be distributor embed URLs, not a publisher's own site root. The
-- previous pair were 'https://smashkarts.io/' and 'https://bloxd.io/' — framing
-- someone's whole commercial website, which is the exact licensing shape
-- data/catalog-overrides.json now blocks by host. Seeding them re-created a
-- blocked row on every preview branch and labelled it "license-clean".
--
-- GameDistribution licenses its html5.gamedistribution.com URLs for embedding on
-- any site; that is what makes these two safe to ship in the repo.
insert into public.games (slug, title, game_url, thumbnail_url, category, is_working)
values
  ('slope-rolling', 'Slope',
   'https://html5.gamedistribution.com/0022998ce3c54962be6ffe178229b168/',
   '/thumbs/slope.png', 'arcade', true),
  ('cut-the-grass-3d', 'Cut the Grass 3D',
   'https://html5.gamedistribution.com/85e71c964bcf440aa715e4f0e69c6c76/',
   'https://img.gamedistribution.com/85e71c964bcf440aa715e4f0e69c6c76-512x512.jpg',
   'arcade', true)
on conflict (slug) do nothing;

-- No seed feedback. public.feedback is insert-only to anon/authenticated by
-- design; hand-inserting rows here would put messages in the admin queue that
-- no one actually sent.
