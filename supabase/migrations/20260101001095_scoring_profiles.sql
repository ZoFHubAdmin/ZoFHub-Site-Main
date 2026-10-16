-- ==========================================================================
-- ZoFHub migration: scoring_profiles
-- Source of truth: db/17_scoring_profiles.sql
--
-- Per-game scoring profiles: which metric a game is scored on, in what unit, with what precision and bounds, and which direction wins (so a time trial ranks lowest-first instead of being ranked backwards by a hardcoded "higher is better"). Adds public.game_scoring_profiles plus two ADDITIVE columns on public.scores (metric_id, value_numeric) — `score` is untouched and still written, so every existing row and index keeps working. The source column (default | suggested | confirmed) is the honesty mechanism: a metric derived from genre/tags is a suggestion for an administrator and is never rendered into a player's form. RLS deny-by-default with no policies, like game_telemetry: a profile decides what counts as a valid score, so only the service key may write one. Runs BEFORE schema_hardening and grants, for the same reason as 14, 15, 16 and control_plane.
--
-- Applied by the Supabase GitHub integration to every preview branch and,
-- on merge, to production. This file is a VERBATIM copy of db/17_scoring_profiles.sql —
-- edit that file and re-run `npm run sync-migrations`, so the two cannot
-- drift.
--
-- Idempotent (IF NOT EXISTS / OR REPLACE / guarded DROPs), so applying it to
-- a database that already has this schema is a no-op rather than an error.
-- ==========================================================================

-- =====================================================================
-- 17_scoring_profiles.sql — what a submitted score MEANS, per game.
-- ---------------------------------------------------------------------
-- THE PROBLEM THIS FIXES. public.scores has one numeric column, `score
-- bigint`, and the submission form had one field labelled "Score". Every game
-- shared them. So a golf game measured in metres, a time trial where the
-- SMALLEST number wins, and a basketball game measured in rounds won all pushed
-- a bare integer into the same ranking, and the player had to guess what number
-- was wanted. "Higher is better" was hardcoded in the ranking, which is exactly
-- backwards for a time trial.
--
-- WHAT THIS ADDS
--   1. public.game_scoring_profiles — one row per game slug, saying which
--      metric it measures, in what unit, with what precision and bounds, and
--      which direction is better.
--   2. Two NON-DESTRUCTIVE columns on public.scores:
--        · metric_id     — which metric this row was submitted under
--        · value_numeric — the true value, including decimals
--      `score` is untouched and still written (rounded), so every existing row
--      and every existing index keeps working. Reads prefer value_numeric and
--      fall back to score, which is why the backfill below is a convenience
--      rather than a requirement.
--
-- WHY SLUG AND NOT A FOREIGN KEY. Same reason public.scores has none: the
-- SERVED catalog is not public.games alone. setCatalog() merges finalgames.json
-- and the catalog-overrides `add` rules on top, and those games have no row in
-- the table by design. A foreign key would refuse a profile for a game that is
-- demonstrably playable. See the long note in db/schema-hardening.sql.
--
-- THE `source` COLUMN IS THE HONESTY MECHANISM. The catalog stores title,
-- category and tags; it does NOT store how any given game counts a score. So
-- for most games the true metric is not knowable from the data, and a system
-- that guessed would print a confident "Distance achieved (meters)" on a game
-- that actually counts points — a specific false claim, which is worse than the
-- vague true one it replaced. Hence three states:
--     'default'   the neutral points metric, labelled "Score". Claims no unit,
--                 so it can never be wrong about one.
--     'suggested' derived from genre/tags/title, with the evidence in `basis`.
--                 Shown to an ADMINISTRATOR for confirmation and deliberately
--                 NOT used to render a player's form (lib/scoring-profiles.mjs
--                 formFieldFor() enforces that).
--     'confirmed' a human checked the game. Only now does the player see the
--                 specific metric and unit.
--
-- RLS: DENY-BY-DEFAULT WITH NO POLICIES, like game_telemetry. A scoring profile
-- decides what counts as a valid score, so an anon key that could write one
-- could make any number legal. Only the service key (the Node server) touches
-- these tables.
-- =====================================================================

create table if not exists public.game_scoring_profiles (
  slug                  text        primary key,
  metric_id             text        not null default 'points',
  display_label         text        not null default 'Score',
  unit                  text,                    -- null = unitless (points, wins, laps)
  value_type            text        not null default 'integer',
  higher_is_better      boolean     not null default true,
  decimal_precision     smallint    not null default 0,
  minimum_value         numeric     not null default 0,
  maximum_value         numeric     not null default 1000000000,
  mode                  text,                    -- an optional named game mode
  source                text        not null default 'default',
  basis                 text,                    -- the evidence behind a suggestion
  enabled               boolean     not null default true,
  configuration_version integer     not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Closed vocabularies, pinned in the database as well as in the application.
  -- lib/scoring-profiles.mjs METRICS is the matching list; adding a metric means
  -- editing both, deliberately.
  constraint game_scoring_profiles_metric_chk check (metric_id in (
    'points', 'distance', 'time_fastest', 'survival_time', 'wins',
    'goals', 'levels', 'objectives', 'laps', 'accuracy'
  )),
  constraint game_scoring_profiles_source_chk check (source in ('default', 'suggested', 'confirmed')),
  constraint game_scoring_profiles_type_chk check (value_type in ('integer', 'decimal')),
  -- An integer metric with decimal places is incoherent; so is a reversed range.
  constraint game_scoring_profiles_precision_chk check (
    decimal_precision between 0 and 3
    and (value_type <> 'integer' or decimal_precision = 0)
  ),
  constraint game_scoring_profiles_range_chk check (maximum_value > minimum_value),
  constraint game_scoring_profiles_slug_chk check (slug = lower(slug) and length(slug) between 1 and 120)
);

comment on table public.game_scoring_profiles is
  'Per-game scoring configuration: which metric, what unit, which direction wins. '
  'source=confirmed is the only state a player''s submission form renders from; '
  'suggested is an administrator''s to-do, not an assertion. Written only by the '
  'Node server (lib/scoring-profiles.mjs).';
comment on column public.game_scoring_profiles.source is
  'default | suggested | confirmed. A suggested metric is NEVER shown to a player — '
  'it is a derived guess awaiting human confirmation.';
comment on column public.game_scoring_profiles.basis is
  'Why a metric was suggested, in words ("a golf tag"), so the review is reviewable.';

create index if not exists game_scoring_profiles_source_idx
  on public.game_scoring_profiles (source);

-- ── public.scores: two additive columns ───────────────────────────────
-- Both nullable / defaulted, so every existing row stays valid and every
-- existing index keeps serving. Nothing is dropped and nothing is rewritten.
alter table public.scores add column if not exists metric_id     text not null default 'points';
alter table public.scores add column if not exists value_numeric numeric;

comment on column public.scores.metric_id is
  'The metric this row was submitted under. Rows that predate scoring profiles '
  'default to points, which is what they always meant.';
comment on column public.scores.value_numeric is
  'The true submitted value, including decimals. `score` is kept in step (rounded) '
  'for the pre-existing indexes and for backward compatibility; readers prefer '
  'value_numeric and fall back to score, so a null here is not a broken row.';

-- A board is read per game AND per metric: two metrics must never be ranked
-- together, so the metric is part of the lookup rather than filtered afterwards.
create index if not exists scores_slug_metric_idx on public.scores (slug, metric_id);

-- Convenience backfill. Readers already coalesce, so this only saves them the
-- fallback; it is cheap, idempotent and touches no row that already has a value.
update public.scores set value_numeric = score where value_numeric is null;

-- ── RLS: closed, with no policies at all ──────────────────────────────
alter table public.game_scoring_profiles enable row level security;
alter table public.game_scoring_profiles force row level security;

-- Stated explicitly because this file may run AFTER db/grants.sql on a live
-- database (same reason as 14/15/16): a later grants sweep must not be what
-- decides whether anon can write a scoring rule.
revoke all on public.game_scoring_profiles from anon, authenticated;
grant all on public.game_scoring_profiles to service_role;

-- ── updated_at ────────────────────────────────────────────────────────
create or replace function public.touch_scoring_profile()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists game_scoring_profiles_touch on public.game_scoring_profiles;
create trigger game_scoring_profiles_touch
  before update on public.game_scoring_profiles
  for each row execute function public.touch_scoring_profile();
