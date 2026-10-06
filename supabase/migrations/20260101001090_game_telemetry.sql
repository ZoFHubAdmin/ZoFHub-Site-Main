-- ==========================================================================
-- ZoFHub migration: game_telemetry
-- Source of truth: db/16_game_telemetry.sql
--
-- Aggregate quality telemetry: game_failures (which games fail to render, per browser family and platform) and web_vitals (bucketed page-speed). Pure counters — there is no id, ip, session or user-agent column, and the primary keys ARE the full dimension set, so a write is an atomic increment via bump_game_failure() / bump_web_vital() and two visitors hitting one bug are indistinguishable. Check constraints pin both closed vocabularies, which caps web_vitals at 180 rows for the whole site. RLS deny-by-default with no policies at all: the anon key can neither read nor bump a counter. Runs BEFORE schema_hardening and grants, for the same reason as 14, 15 and control_plane.
--
-- Applied by the Supabase GitHub integration to every preview branch and,
-- on merge, to production. This file is a VERBATIM copy of db/16_game_telemetry.sql —
-- edit that file and re-run `npm run sync-migrations`, so the two cannot
-- drift.
--
-- Idempotent (IF NOT EXISTS / OR REPLACE / guarded DROPs), so applying it to
-- a database that already has this schema is a no-op rather than an error.
-- ==========================================================================

-- =====================================================================
-- ZoFHub · game_failures + web_vitals   (run ONCE in the Supabase SQL editor)
-- =====================================================================
-- Aggregate quality telemetry. These two tables answer the questions the
-- server genuinely cannot answer on its own:
--
--   1. "Which games are broken, and broken for WHOM?" A game that paints a
--      black screen only on iOS Safari passes the server-side link-check (the
--      URL returns 200) and passes render-verification (it framed fine in
--      headless Chromium). Only a real browser failing to render it knows.
--   2. "Which pages are slow for real visitors on real networks?"
--
-- WHAT THESE TABLES ARE NOT, BY SHAPE AND NOT BY PROMISE
--
-- There is NO VISITOR here. These are counters. The unit of storage is "this
-- combination happened N times", never "this person did this". Look at the
-- columns: there is no id, no ip, no ip_hash, no session, no user agent, no
-- timestamp per event, and no foreign key to anything that identifies anyone.
-- There is deliberately nowhere to PUT such a value, which is a stronger
-- guarantee than a policy saying we would not fill one in.
--
-- The primary keys are the full set of dimensions, so a write is an UPSERT that
-- increments a count. Two different people hitting the same bug on the same
-- browser are INDISTINGUISHABLE: they bump the same row. That is the privacy
-- property, expressed as the schema.
--
-- The key space is small and fixed BY CONSTRUCTION (the check constraints):
--   game_failures : 7 browsers x 2 platforms x 5 kinds = 70 rows per game, max.
--   web_vitals    : 5 metrics x 3 buckets x 6 routes x 2 platforms = 180 rows
--                   for the entire site, forever.
-- A table that cannot exceed 180 rows cannot be re-identified, and cannot grow
-- into a storage problem either.
--
-- The check constraints are not decoration. lib/telemetry.mjs validates the
-- same closed vocabularies in code; these are the copy that survives a bug in
-- the application, and they are what makes free text structurally unable to
-- become a row.
--
-- RLS: deny-by-default. The public anon key can neither read nor write these.
-- Writes arrive through the server with the service-role key (it aggregates in
-- memory and flushes once a minute), and reads are an admin-console concern
-- gated by the `telemetry.read` permission.
--
--   Dashboard -> SQL Editor -> New query -> paste -> Run.
-- =====================================================================

-- ── 1. Game render failures ─────────────────────────────────────────────
create table if not exists public.game_failures (
  slug       text not null,

  -- Server-derived from the request's User-Agent and then DISCARDED. The raw
  -- UA string is never stored; only which of seven families it belongs to.
  browser    text not null check (browser in
               ('chrome','edge','safari','firefox','samsung','opera','other')),

  -- Two values on purpose. Not a device model, not a screen size.
  platform   text not null check (platform in ('desktop','mobile')),

  -- How it failed. Client-supplied, so the API refuses anything not in this
  -- list rather than coercing it — see normalizeFailure() in lib/telemetry.mjs.
  kind       text not null check (kind in
               ('blank','timeout','refused','http_error','script_error')),

  count      bigint not null default 0 check (count >= 0),

  -- Coarse, and about the ROW, not about a visit. `last_seen` is what makes
  -- the data actionable: it separates "broken last March" from "broken now".
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),

  primary key (slug, browser, platform, kind)
);

-- "What is broken right now, worst first" — the one query the admin console runs.
create index if not exists game_failures_recent_idx
  on public.game_failures (last_seen desc, count desc);

-- "Is THIS game broken?" — used when reviewing a single game in the CMS.
create index if not exists game_failures_slug_idx
  on public.game_failures (slug);

-- ── 2. Core Web Vitals, bucketed ────────────────────────────────────────
create table if not exists public.web_vitals (
  -- No raw measurement is stored. A value arrives as a number and is reduced to
  -- one of three buckets before it ever reaches this table: an exact LCP of
  -- 2473.84ms is a much stronger identifier than the bucket anyone acts on.
  metric     text not null check (metric in ('LCP','CLS','INP','FCP','TTFB')),
  bucket     text not null check (bucket in ('good','needs_improvement','poor')),

  -- A page CLASS, never a URL. A query string on this site can carry a search
  -- term, so the path is reduced before storage and the query is dropped.
  route      text not null check (route in
               ('home','play','category','ai','browser','other')),

  platform   text not null check (platform in ('desktop','mobile')),

  count      bigint not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),

  primary key (metric, bucket, route, platform)
);

-- ── 3. Row-level security: deny by default ──────────────────────────────
alter table public.game_failures enable row level security;
alter table public.web_vitals    enable row level security;

-- No policies are created, and that is the point. With RLS on and no policy,
-- PostgREST with the anon key can neither select nor insert. The service-role
-- key bypasses RLS, which is how the server's flush writes. If you later want
-- a public "known issues" page, add a narrow SELECT policy for exactly the
-- columns it needs -- do not grant the anon role write access to a counter,
-- or anyone with the public key can inflate it.

-- ── 4. Atomic increment ─────────────────────────────────────────────────
-- Why a function instead of an upsert from the application: two server
-- instances flushing the same slug at the same moment would each read-then-
-- write and one increment would be lost. `count + excluded.count` inside the
-- database makes the increment atomic, so this is correct with any number of
-- instances -- which matters because the server aggregates in memory and the
-- flush is the only place those numbers become durable.
create or replace function public.bump_game_failure(
  p_slug text, p_browser text, p_platform text, p_kind text, p_n bigint
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.game_failures (slug, browser, platform, kind, count, last_seen)
  values (p_slug, p_browser, p_platform, p_kind, greatest(p_n, 0), now())
  on conflict (slug, browser, platform, kind) do update
    set count     = public.game_failures.count + greatest(p_n, 0),
        last_seen = now();
$$;

create or replace function public.bump_web_vital(
  p_metric text, p_bucket text, p_route text, p_platform text, p_n bigint
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.web_vitals (metric, bucket, route, platform, count, updated_at)
  values (p_metric, p_bucket, p_route, p_platform, greatest(p_n, 0), now())
  on conflict (metric, bucket, route, platform) do update
    set count      = public.web_vitals.count + greatest(p_n, 0),
        updated_at = now();
$$;

-- These run as the definer, so make sure the anon role cannot call them
-- directly and bump a counter without going through the server.
revoke all on function public.bump_game_failure(text, text, text, text, bigint) from public, anon;
revoke all on function public.bump_web_vital(text, text, text, text, bigint)    from public, anon;

-- ── 5. Retention: deliberately none ────────────────────────────────────
-- There is no prune function here, and that is a decision rather than an
-- omission. These are COUNTERS, not an event log: game_failures is capped at 70
-- rows per game by its own check constraints and web_vitals at 180 rows for the
-- whole site, forever, so neither can grow into a storage or a privacy problem.
--
-- The real concern -- "a game fixed a year ago should stop showing as broken" --
-- is answered by READING `last_seen` (that is what game_failures_recent_idx is
-- for), not by deleting history. An earlier draft shipped a SECURITY DEFINER
-- prune_game_failures() with no caller; `npm run audit:ci` correctly flagged it,
-- because elevated-privilege code nobody calls can only ever be invoked by
-- accident or by someone who should not be invoking it. If a retention sweep is
-- ever genuinely wanted, add it together with the job that calls it.

-- =====================================================================
-- Verify:
--   select count(*) from public.game_failures;   -- 0 on a fresh install
--   select count(*) from public.web_vitals;      -- 0, and <= 180 forever
--
-- The server degrades gracefully if you never run this file: telemetry stays
-- in memory, is visible in the admin console, and is lost on restart. Nothing
-- breaks and no request fails -- the same posture as game_stats.
-- =====================================================================
