-- db/game-fingerprints.sql
--
-- Storage for the game discovery engine (lib/game-discovery.mjs): the provider
-- identity of every catalog entry, plus a record of duplicates it finds.
--
-- WHY A FINGERPRINT COLUMN AND NOT A UNIQUE INDEX ON game_url
-- The same game reaches us under many URLs — different portals, different
-- partner subdomains, tracking parameters, www or not. A unique index on
-- game_url would treat every one of those as a distinct game, which is exactly
-- how the catalog ended up with 4,691 rows (27.7%) sharing a title. The
-- fingerprint is `provider:id`, which is stable across all of that, so the
-- constraint can live where the real identity is.
--
-- The gamezop case is the clearest example: the partner id sits in the
-- SUBDOMAIN, so 4665.play.gamezop.com and zv1y2i8p.play.gamezop.com are
-- different hosts serving the same game. This catalog holds 129 games on one
-- and 99 on the other.
--
-- Idempotent (IF NOT EXISTS / guarded DROPs), so re-applying it to a database
-- that already has this schema is a no-op rather than an error.

create table if not exists public.game_fingerprints (
  id           bigserial primary key,
  slug         text not null,
  -- `provider:id` — e.g. gamezop:xyz789, y8:turn_and_hit
  fingerprint  text not null,
  provider     text not null,
  provider_id  text not null,
  -- Canonical URL: https, no www, no tracking params, sorted query, no hash.
  canonical_url text not null,
  -- Title reduced to a comparison key, for the weaker title-only signal.
  title_key    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One row per catalog game.
create unique index if not exists game_fingerprints_slug_uidx
  on public.game_fingerprints (slug);

-- The lookup that answers "do we already have this game?" in one indexed hit,
-- instead of scanning 16,913 rows in application code.
create index if not exists game_fingerprints_fp_idx
  on public.game_fingerprints (fingerprint);
create index if not exists game_fingerprints_canonical_idx
  on public.game_fingerprints (canonical_url);
create index if not exists game_fingerprints_title_idx
  on public.game_fingerprints (title_key);

-- Duplicate relationships found by the engine. Kept as a RELATION rather than
-- deleting the loser, because "same title" is evidence and not proof — two
-- different games really are both called "Bubble Shooter". A human resolves
-- `status`; nothing is destroyed by the detector.
create table if not exists public.game_duplicates (
  id            bigserial primary key,
  slug          text not null,          -- the newer / candidate entry
  duplicate_of  text not null,          -- the entry it appears to duplicate
  -- same_url | same_provider_id | same_title
  match_kind    text not null,
  -- exact | likely
  confidence    text not null default 'likely',
  -- pending | confirmed | rejected
  status        text not null default 'pending',
  detected_at   timestamptz not null default now(),
  resolved_at   timestamptz,
  constraint game_duplicates_not_self check (slug <> duplicate_of)
);

create unique index if not exists game_duplicates_pair_uidx
  on public.game_duplicates (slug, duplicate_of);
create index if not exists game_duplicates_status_idx
  on public.game_duplicates (status, detected_at desc);

-- Submitted URLs that failed safety validation. Worth keeping: a spike of
-- rejected submissions from one source is an abuse signal, and without a record
-- the only evidence a submission was ever made is that it silently vanished.
create table if not exists public.rejected_submissions (
  id          bigserial primary key,
  url         text not null,
  reason      text not null,            -- not_https | internal_address | ...
  submitted_at timestamptz not null default now()
);

create index if not exists rejected_submissions_at_idx
  on public.rejected_submissions (submitted_at desc);

-- ── RLS ───────────────────────────────────────────────────────────────────
-- These tables are operational metadata, not public content. The anon key gets
-- nothing; the server reaches them with the service key, which bypasses RLS.
-- Enabling RLS with no permissive policy is therefore deny-by-default, which is
-- the correct posture for a table the public has no reason to read.
alter table public.game_fingerprints   enable row level security;
alter table public.game_duplicates     enable row level security;
alter table public.rejected_submissions enable row level security;

drop policy if exists "No public access to fingerprints" on public.game_fingerprints;
drop policy if exists "No public access to duplicates"   on public.game_duplicates;
drop policy if exists "No public access to rejections"   on public.rejected_submissions;

-- updated_at maintenance, matching the pattern used by public.games.
create or replace function public.touch_game_fingerprints()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_game_fingerprints_updated_at on public.game_fingerprints;
create trigger trg_game_fingerprints_updated_at
  before update on public.game_fingerprints
  for each row execute function public.touch_game_fingerprints();
