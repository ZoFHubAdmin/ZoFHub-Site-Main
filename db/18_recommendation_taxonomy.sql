-- =====================================================================
-- 18_recommendation_taxonomy.sql — a usable taxonomy for game requests.
-- ---------------------------------------------------------------------
-- WHAT THIS FIXES. public.recommendations had a single `category` column, and
-- the form offered ten hardcoded <option> values written directly into
-- public/community.html. The server accepted ANY 40-character string as a
-- category, so the menu and the validation could not agree — "Platfromer" would
-- have been stored without complaint — and a game that is genuinely two things
-- (a puzzle platformer) had to be filed as one.
--
-- WHAT THIS ADDS, ALL ADDITIVE
--   genres        text[]  the chosen genres, validated against the shared list
--                         in public/js/recommendation-taxonomy.js (the ONE file
--                         the form renders from and the server validates
--                         against, so they cannot drift apart)
--   other_text    text    required when 'other' is among the genres, because
--                         "Other" with no explanation carries no information
--   official_url  text    the game's own page, if the submitter knows it —
--                         distinct from embed_url, which must be an embeddable
--                         link from a supported host
--   extra         text    anything else worth knowing (controls, age
--                         suitability, known issues)
--
-- `category` IS KEPT AND STILL WRITTEN, set to the first chosen genre. Every
-- existing row stays valid and every existing reader of that column keeps
-- working; nothing is dropped and nothing is rewritten. The server also retries
-- its insert without these columns if this migration has not run, so deploying
-- the code first degrades to the old shape rather than rejecting submissions.
--
-- A REQUEST IS STILL ONLY A REQUEST. Nothing here touches the published
-- catalog: a row in this table creates no game, triggers no import and grants no
-- visibility. Additions go through the admin console and the catalog freeze
-- (lib/catalog-lock.mjs), which is exactly what the disclosure beside the form
-- tells the submitter.
-- =====================================================================

alter table public.recommendations add column if not exists genres       text[] not null default '{}';
alter table public.recommendations add column if not exists other_text   text;
alter table public.recommendations add column if not exists official_url text;
alter table public.recommendations add column if not exists extra        text;

comment on column public.recommendations.genres is
  'Chosen genres, validated server-side against public/js/recommendation-taxonomy.js. '
  'Up to 3. The legacy `category` column holds the first of these.';
comment on column public.recommendations.other_text is
  'Required when ''other'' is among the genres — an unexplained "Other" is not a category.';
comment on column public.recommendations.official_url is
  'The game''s own page, if known. NOT an embed link: embed_url is the embeddable one and is host-checked.';

-- Bounds in the database as well as the application. The application is the
-- place that produces good error messages; this is the place that makes the
-- guarantee true no matter which code path wrote the row.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'recommendations_genres_len_chk') then
    alter table public.recommendations
      add constraint recommendations_genres_len_chk
      check (array_length(genres, 1) is null or array_length(genres, 1) <= 3);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'recommendations_other_text_len_chk') then
    alter table public.recommendations
      add constraint recommendations_other_text_len_chk
      check (other_text is null or length(other_text) <= 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'recommendations_extra_len_chk') then
    alter table public.recommendations
      add constraint recommendations_extra_len_chk
      check (extra is null or length(extra) <= 280);
  end if;
end $$;

-- Moderators filter the queue by genre, so that read gets an index. GIN because
-- the predicate is array containment (genres && '{puzzle}'), which btree cannot
-- serve.
create index if not exists recommendations_genres_idx on public.recommendations using gin (genres);
