-- ==========================================================================
-- ZoFHub migration: control_plane
-- Source of truth: db/control-plane.sql
--
-- Admin control plane: staff accounts, a Draft→Published lifecycle for games (the public RLS policy and games_public view now require status = published), providers, categories and tags with foreign keys, typed site settings, the proxy approved-target model, a hash-chained audit trail, and atomic bulk-status / tag RPCs. Every new table is RLS deny-by-default and revoked from anon/authenticated inside this file, because on a live database it runs AFTER grants. Runs before schema_hardening and grants for the same reason as 14 and 15.
--
-- Applied by the Supabase GitHub integration to every preview branch and,
-- on merge, to production. This file is a VERBATIM copy of db/control-plane.sql —
-- edit that file and re-run `npm run sync-migrations`, so the two cannot
-- drift.
--
-- Idempotent (IF NOT EXISTS / OR REPLACE / guarded DROPs), so applying it to
-- a database that already has this schema is a no-op rather than an error.
-- ==========================================================================

-- =====================================================================
-- ZoFHub · control plane   (run ONCE in the Supabase SQL editor, or let the
--                           GitHub integration apply supabase/migrations/)
-- =====================================================================
-- The storage behind the admin control centre: staff accounts, a real content
-- lifecycle for games, providers, categories and tags, typed site settings, and
-- the approved-target model that governs the proxy.
--
-- DESIGN RULES THIS FILE FOLLOWS
--
--   1. SERVER-ONLY, FAIL CLOSED. Every table created here has RLS enabled and
--      NO policy, and the public roles are explicitly revoked. The publishable
--      key that ships to browsers can read none of it; only the Node server,
--      holding the secret key, can. That is stated here rather than left to
--      grants.sql, because on a database where grants.sql already ran this
--      file is applied AFTER it and would otherwise inherit Supabase's default
--      "anon may do anything RLS allows" privileges.
--
--   2. THE DATABASE ENFORCES INTEGRITY, NOT JUST THE APP. Status values are
--      CHECK constraints, categories are a foreign key, provider references are
--      a foreign key with ON DELETE RESTRICT, and a category that still holds
--      games cannot be deleted. Application validation sits in front of these;
--      it does not replace them.
--
--   3. NOTHING HERE DESTROYS DATA. Existing games default to `published`, so the
--      public catalog is unchanged the moment this runs. Backfills only fill
--      columns that are NULL.
--
--   4. NO REDUNDANT TABLES. Proxy sessions and health are deliberately NOT
--      tables: a per-tunnel session row is a browsing record of an anonymous
--      visitor, and keeping it would contradict the privacy model. They live in
--      server memory with a bounded history. Proxy audit events go to the
--      existing admin_audit_logs rather than a parallel log.
--
-- Idempotent: every CREATE is guarded, every constraint is added inside an
-- exception handler, and re-running the file is a no-op.
-- =====================================================================


-- ── 1. Staff accounts ─────────────────────────────────────────────────────
-- ZoFHub has no public user accounts, and this does not add any: visitors are
-- anonymous by design. These are STAFF — the people who run the site. The
-- owner configured in the environment (ADMIN_USERNAME / ADMIN_PASSWORD_HASH)
-- remains the break-glass account and is deliberately NOT a row here, so no
-- database edit and no admin screen can lock the owner out or demote them.
create table if not exists public.admin_users (
  id                   uuid primary key default gen_random_uuid(),
  username             text        not null,
  display_name         text,
  role                 text        not null,
  status               text        not null default 'active',
  -- scrypt$N$r$p$salt$hash — the same versioned format as ADMIN_PASSWORD_HASH.
  -- NULL once an account is deleted: a deleted account can never log in again.
  password_hash        text,
  must_change_password boolean     not null default true,
  status_reason        text,
  created_at           timestamptz not null default now(),
  created_by           text        not null,
  updated_at           timestamptz not null default now(),
  updated_by           text,
  last_login_at        timestamptz,
  deleted_at           timestamptz
);

do $$ begin
  alter table public.admin_users add constraint admin_users_role_check
    check (role in ('super_admin', 'admin', 'content_manager', 'moderator', 'analyst', 'support'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.admin_users add constraint admin_users_status_check
    check (status in ('active', 'suspended', 'deactivated', 'deleted'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.admin_users add constraint admin_users_username_check
    check (username ~ '^[a-z0-9][a-z0-9._-]{2,39}$');
exception when duplicate_object then null; end $$;
-- A deleted account keeps its username RESERVED. The audit trail records who did
-- what by username, and letting a new account reuse a deleted one's name would
-- make every historical entry ambiguous.
create unique index if not exists admin_users_username_uidx on public.admin_users (lower(username));
create index if not exists admin_users_status_idx on public.admin_users (status, role);

comment on table public.admin_users is
  'Staff accounts for the admin console. Not visitors — ZoFHub has no public accounts. The environment-configured owner is intentionally not a row here.';

-- Sessions learn which staff account they belong to. NULL = the environment
-- owner. ON DELETE CASCADE is safe because accounts are soft-deleted in normal
-- operation; a hard delete of the row should take its sessions with it.
alter table public.admin_sessions add column if not exists user_id   uuid references public.admin_users (id) on delete cascade;
-- When the holder last re-entered their password. Destructive actions require
-- this to be recent, so a stolen-but-idle session cannot delete anything.
alter table public.admin_sessions add column if not exists reauth_at timestamptz;
create index if not exists admin_sessions_user_idx on public.admin_sessions (user_id) where revoked_at is null;


-- ── 2. The audit trail learns structure, and becomes tamper-evident ────────
-- The existing table is append-only (a trigger refuses UPDATE and DELETE). What
-- it lacked was structure to answer "everything that happened to game 4421"
-- without string-matching a free-text target, and any way to DETECT a row that
-- was inserted out of band or rewritten by someone who disabled the trigger.
alter table public.admin_audit_logs add column if not exists actor_id      uuid;
alter table public.admin_audit_logs add column if not exists actor_role    text;
alter table public.admin_audit_logs add column if not exists resource_type text;
alter table public.admin_audit_logs add column if not exists resource_id   text;
alter table public.admin_audit_logs add column if not exists request_id    text;
alter table public.admin_audit_logs add column if not exists prev_hash     text;
alter table public.admin_audit_logs add column if not exists row_hash      text;

create index if not exists admin_audit_resource_idx on public.admin_audit_logs (resource_type, resource_id, id desc);
create index if not exists admin_audit_actor_idx    on public.admin_audit_logs (actor_id, id desc);

-- Hash chain. Each new row stores sha256(previous row_hash | its own fields).
-- Rewriting or removing a chained row breaks every hash after it, which
-- admin_audit_verify() below reports. The advisory lock serialises appends so
-- two concurrent inserts cannot both chain onto the same predecessor.
create or replace function public.admin_audit_chain()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  prev text;
begin
  perform pg_advisory_xact_lock(7340031);
  select l.row_hash into prev
    from public.admin_audit_logs l
   where l.row_hash is not null
   order by l.id desc
   limit 1;
  new.prev_hash := prev;
  new.row_hash := encode(sha256(convert_to(concat_ws('|',
      coalesce(prev, ''), new.id::text,
      to_char(new.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
      coalesce(new.username, ''), new.action, coalesce(new.target, ''), new.outcome,
      coalesce(new.actor_id::text, ''), coalesce(new.actor_role, ''),
      coalesce(new.resource_type, ''), coalesce(new.resource_id, ''),
      coalesce(new.detail::text, '')), 'UTF8')), 'hex');
  return new;
end $$;

drop trigger if exists trg_admin_audit_chain on public.admin_audit_logs;
create trigger trg_admin_audit_chain
  before insert on public.admin_audit_logs
  for each row execute function public.admin_audit_chain();

-- Re-derive the newest p_limit chained rows and report the first one whose
-- stored hash does not match its contents or whose link to its predecessor is
-- broken. The oldest row in the window is the anchor: its predecessor may have
-- aged out through retention, which is not tampering.
create or replace function public.admin_audit_verify(p_limit integer default 1000)
returns table (checked integer, first_bad_id bigint)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  r record;
  expected text;
  last_hash text := null;
  n integer := 0;
  lim integer := least(greatest(coalesce(p_limit, 1000), 1), 100000);
begin
  first_bad_id := null;
  for r in
    select * from (
      select * from public.admin_audit_logs
       where row_hash is not null
       order by id desc
       limit lim
    ) w order by w.id asc
  loop
    expected := encode(sha256(convert_to(concat_ws('|',
        coalesce(r.prev_hash, ''), r.id::text,
        to_char(r.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
        coalesce(r.username, ''), r.action, coalesce(r.target, ''), r.outcome,
        coalesce(r.actor_id::text, ''), coalesce(r.actor_role, ''),
        coalesce(r.resource_type, ''), coalesce(r.resource_id, ''),
        coalesce(r.detail::text, '')), 'UTF8')), 'hex');
    if expected is distinct from r.row_hash
       or (n > 0 and r.prev_hash is distinct from last_hash) then
      first_bad_id := r.id;
      checked := n + 1;
      return next;
      return;
    end if;
    last_hash := r.row_hash;
    n := n + 1;
  end loop;
  checked := n;
  return next;
end $$;


-- ── 3. Game providers ─────────────────────────────────────────────────────
-- The auditable chain the admin console enforces:
--     game → provider → approved origin → embedding policy
-- A game may only be created or re-pointed at an embed URL whose origin this
-- provider lists, and only while the provider is `approved`. A `suspended` or
-- `revoked` provider's games are withheld from the public catalog.
create table if not exists public.game_providers (
  id             text primary key,
  name           text        not null,
  status         text        not null default 'pending',
  embed_origins  text[]      not null default '{}',
  asset_origins  text[]      not null default '{}',
  -- direct: the visitor's browser frames the provider itself (required for the
  -- SDK-based distributors). proxied: framed through this site's /embed route.
  embed_mode     text        not null default 'direct',
  -- NULL = no sandbox attribute. Adding one to a third-party game is a
  -- behaviour change that has to be revalidated per provider, so it is opt-in.
  sandbox_policy text,
  allow_features text[]      not null default '{}',
  terms_url      text,
  license_basis  text,
  notes          text,
  reviewed_at    timestamptz,
  reviewed_by    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     text
);

do $$ begin
  alter table public.game_providers add constraint game_providers_id_check
    check (id ~ '^[a-z0-9][a-z0-9-]{1,39}$');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.game_providers add constraint game_providers_status_check
    check (status in ('approved', 'restricted', 'pending', 'suspended', 'revoked'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.game_providers add constraint game_providers_embed_mode_check
    check (embed_mode in ('direct', 'proxied'));
exception when duplicate_object then null; end $$;

-- Seeded from the licensing audit (tools/audit-licensing.mjs), not invented:
--   SAFE       → approved     ACCOUNT / GRAY → restricted (existing games keep
--   PARTNER-ID → suspended                     serving; no new ones)
-- ON CONFLICT DO NOTHING: an operator's later decision is never overwritten.
insert into public.game_providers
  (id, name, status, embed_origins, asset_origins, embed_mode, terms_url, license_basis, notes, reviewed_by)
values
  ('gamedistribution', 'GameDistribution', 'approved',
   '{https://html5.gamedistribution.com}', '{https://img.gamedistribution.com}', 'direct',
   'https://gamedistribution.com/publishers/partnership/',
   'Distributes its catalog to third-party portals at no cost through its official feed. Games must run unmodified in GameDistribution''s own iframe with its SDK and ads intact.',
   'Seeded from the licensing audit (tier SAFE).', 'migration'),
  ('gamemonetize', 'GameMonetize', 'approved',
   '{https://html5.gamemonetize.co,https://html5.gamemonetize.com}', '{https://img.gamemonetize.com}', 'direct',
   'https://gamemonetize.com/',
   'Licensed for third-party embedding through its own iframe and SDK.',
   'Seeded from the licensing audit (tier SAFE).', 'migration'),
  ('y8', 'Y8 (embed directory)', 'approved',
   '{https://www.y8.com,https://y8.com}', '{https://cdn.y8.com,https://cdn2.y8.com,https://img.y8.com}', 'proxied',
   'https://www.y8.com/games_for_your_website',
   'Y8''s own "Games for your website" embed directory.',
   'Seeded from the licensing audit (tier SAFE).', 'migration'),
  ('onlinegames', 'OnlineGames.io', 'restricted',
   '{https://www.onlinegames.io,https://cloud.onlinegames.io}', '{https://www.onlinegames.io}', 'direct',
   null, 'Permits embedding via its own codes; hotlink-protected.',
   'Tier GRAY: existing canonical titles keep serving; no new games until verified.', 'migration'),
  ('htmlgames', 'HTMLGames', 'restricted',
   '{https://cdn.htmlgames.com,https://www.htmlgames.com}', '{https://cdn.htmlgames.com,https://www.htmlgames.com}', 'proxied',
   null, 'Free to embed only through its official embed programme.',
   'Tier ACCOUNT: needs a publisher account before new games are added.', 'migration'),
  ('famobi', 'Famobi', 'restricted',
   '{https://play.famobi.com}', '{https://img.cdn.famobi.com}', 'proxied',
   null, 'Free to embed through a publisher account and its feed.',
   'Tier ACCOUNT: needs a publisher account before new games are added.', 'migration'),
  ('gameflare', 'GameFlare', 'restricted',
   '{https://distribution.gameflare.com}', '{https://data.gameflare.com}', 'direct',
   null, 'Requires GameFlare''s distribution programme.',
   'Tier ACCOUNT: needs a publisher account before new games are added.', 'migration'),
  ('gamezop', 'Gamezop', 'suspended',
   '{}', '{https://static.gamezop.com}', 'direct',
   null, 'Embeds carry ANOTHER publisher''s partner id — not licensed to this site.',
   'Tier PARTNER-ID: withheld until the site has its own partner id.', 'migration')
on conflict (id) do nothing;


-- ── 4. Categories and tags ────────────────────────────────────────────────
create table if not exists public.game_categories (
  slug        text primary key,
  label       text        not null,
  description text,
  parent_slug text references public.game_categories (slug) on update cascade on delete restrict,
  sort_order  integer     not null default 0,
  visible     boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- Legacy keys are free-form ("puzzle games", "2048 & merge") and the public
-- category URLs are built from them, so they are accepted as they are. The admin
-- console only ever CREATES strict slugs; this constraint just keeps the column
-- lowercase and bounded.
do $$ begin
  alter table public.game_categories add constraint game_categories_slug_check
    check (slug = lower(slug) and char_length(slug) between 1 and 40 and slug !~ '[\r\n\t]');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.game_categories add constraint game_categories_label_check
    check (char_length(label) between 1 and 60);
exception when duplicate_object then null; end $$;

insert into public.game_categories (slug, label)
select distinct g.category, initcap(replace(g.category, '-', ' '))
  from public.games g
 where g.category = lower(g.category) and char_length(g.category) between 1 and 40
on conflict (slug) do nothing;
insert into public.game_categories (slug, label) values ('arcade', 'Arcade')
on conflict (slug) do nothing;

-- The foreign key. Added NOT VALID so a row with an unusual legacy value can
-- never make this migration fail, then validated when every row conforms — which
-- the seed above guarantees for any lowercase value.
do $$ begin
  alter table public.games add constraint games_category_fk
    foreign key (category) references public.game_categories (slug)
    on update cascade on delete restrict not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  if not exists (
    select 1 from public.games g
     where not exists (select 1 from public.game_categories c where c.slug = g.category)
  ) then
    alter table public.games validate constraint games_category_fk;
  end if;
end $$;

create table if not exists public.game_tags (
  slug       text primary key,
  label      text        not null,
  created_at timestamptz not null default now()
);
do $$ begin
  alter table public.game_tags add constraint game_tags_slug_check
    check (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$');
exception when duplicate_object then null; end $$;

create table if not exists public.game_tag_links (
  game_id  bigint not null references public.games (id)      on delete cascade,
  tag_slug text   not null references public.game_tags (slug) on update cascade on delete cascade,
  primary key (game_id, tag_slug)
);
create index if not exists game_tag_links_tag_idx on public.game_tag_links (tag_slug);


-- ── 5. The games table gains a lifecycle ──────────────────────────────────
-- `is_working` stays exactly what it was: the link checker's verdict on whether
-- the embed still loads. `status` is the EDITORIAL state. A game is public only
-- when both say so — a published game that stops loading is hidden by the link
-- checker, and a working game that was never approved is hidden by its status.
alter table public.games add column if not exists status            text     not null default 'published';
alter table public.games add column if not exists provider_id       text     references public.game_providers (id) on update cascade on delete restrict;
alter table public.games add column if not exists external_id       text;
alter table public.games add column if not exists description       text;
alter table public.games add column if not exists short_description text;
alter table public.games add column if not exists publisher         text;
alter table public.games add column if not exists developer         text;
alter table public.games add column if not exists featured          boolean  not null default false;
alter table public.games add column if not exists sort_order        integer  not null default 0;
alter table public.games add column if not exists embed_width       smallint;
alter table public.games add column if not exists embed_height      smallint;
alter table public.games add column if not exists license_review    jsonb;
alter table public.games add column if not exists review_note       text;
alter table public.games add column if not exists created_by        text;
alter table public.games add column if not exists updated_by        text;
alter table public.games add column if not exists published_at      timestamptz;
alter table public.games add column if not exists archived_at       timestamptz;

do $$ begin
  alter table public.games add constraint games_status_check
    check (status in ('draft', 'pending_review', 'approved', 'published', 'unpublished', 'archived', 'rejected'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.games add constraint games_text_len_check
    check (coalesce(char_length(description), 0) <= 4000
       and coalesce(char_length(short_description), 0) <= 280
       and coalesce(char_length(review_note), 0) <= 1000);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.games add constraint games_embed_size_check
    check ((embed_width is null or embed_width between 100 and 4096)
       and (embed_height is null or embed_height between 100 and 4096));
exception when duplicate_object then null; end $$;

create index if not exists games_status_id_idx on public.games (status, id desc);
create index if not exists games_provider_idx  on public.games (provider_id, id desc);
create index if not exists games_updated_idx   on public.games (updated_at desc, id desc);
create index if not exists games_featured_idx  on public.games (sort_order, id desc) where featured;
-- One row per provider game. Partial, so the thousands of legacy rows without a
-- provider id are unconstrained.
create unique index if not exists games_provider_external_uidx
  on public.games (provider_id, external_id) where external_id is not null;

-- Backfill provider_id from the embed host. Only NULL rows are touched, so an
-- operator's later reassignment survives a re-run.
update public.games set provider_id = case
    when game_url ~* '^https://html5\.gamedistribution\.com/'                 then 'gamedistribution'
    when game_url ~* '^https://html5\.gamemonetize\.(co|com)/'                then 'gamemonetize'
    when game_url ~* '^https://(www\.)?y8\.com/embed/'                        then 'y8'
    when game_url ~* '^https://(www|cloud)\.onlinegames\.io/'                 then 'onlinegames'
    when game_url ~* '^https://(cdn|www)\.htmlgames\.com/'                    then 'htmlgames'
    when game_url ~* '^https://play\.famobi\.com/'                            then 'famobi'
    when game_url ~* '^https://distribution\.gameflare\.com/'                 then 'gameflare'
    when game_url ~* '^https://[a-z0-9]+\.play\.gamezop\.com/'                then 'gamezop'
  end
 where provider_id is null
   and game_url ~* '^https://(html5\.gamedistribution\.com|html5\.gamemonetize\.(co|com)|(www\.)?y8\.com/embed|(www|cloud)\.onlinegames\.io|(cdn|www)\.htmlgames\.com|play\.famobi\.com|distribution\.gameflare\.com|[a-z0-9]+\.play\.gamezop\.com)/';

-- GameDistribution ids are the 32-hex path segment. Only the OLDEST row per id
-- receives it, so a duplicate already in the table cannot violate the unique
-- index above; the importer then recognises that game instead of re-adding it.
update public.games g
   set external_id = m.gd_id
  from (
    select min(id) as id, lower(substring(game_url from 'gamedistribution\.com/([0-9a-fA-F]{32})')) as gd_id
      from public.games
     where provider_id = 'gamedistribution'
       and game_url ~* 'gamedistribution\.com/[0-9a-f]{32}'
     group by 2
  ) m
 where g.id = m.id and g.external_id is null
   and not exists (
     select 1 from public.games x
      where x.provider_id = 'gamedistribution' and x.external_id = m.gd_id
   );

-- The public read path now requires BOTH verdicts. Without this a draft, a game
-- held for licensing review, or a rejected game would be readable straight from
-- the publishable key, however carefully the server filtered its own queries.
drop policy if exists "Public can read working games" on public.games;
create policy "Public can read working games"
  on public.games for select
  using (is_working = true and status = 'published');

create or replace view public.games_public
with (security_invoker = true) as
  select
    id,
    slug,
    title,
    game_url,
    coalesce(nullif(thumbnail_url, ''), '/default-placeholder.svg') as thumbnail_url,
    category,
    last_checked
  from public.games
  where is_working = true and status = 'published';


-- ── 6. Atomic operations the API cannot express safely ────────────────────
-- A bulk status change must be all-or-nothing. PostgREST offers no multi-
-- statement transaction, so the check-then-write happens inside one function
-- call, which is one transaction: if ANY target is missing or not in an allowed
-- source state, it raises and nothing changes.
create or replace function public.cms_bulk_transition(
  p_ids   bigint[],
  p_to    text,
  p_from  text[],
  p_actor text
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n integer;
  wanted integer := coalesce(array_length(p_ids, 1), 0);
begin
  if wanted = 0 then return 0; end if;
  if wanted > 500 then
    raise exception 'bulk operations are limited to 500 games (got %)', wanted;
  end if;
  if (select count(distinct x) from unnest(p_ids) x) <> wanted then
    raise exception 'duplicate ids in bulk request';
  end if;
  if (select count(*) from public.games where id = any (p_ids) and status = any (p_from)) <> wanted then
    raise exception 'one or more games are missing or not in an allowed state for %', p_to;
  end if;
  update public.games
     set status       = p_to,
         updated_by   = p_actor,
         published_at = case when p_to = 'published' then now() else published_at end,
         archived_at  = case when p_to = 'archived' then now() when p_to <> 'archived' then null else archived_at end
   where id = any (p_ids);
  get diagnostics n = row_count;
  return n;
end $$;

-- Replace a game's tag set in one transaction, creating unknown tags.
create or replace function public.cms_set_game_tags(p_game_id bigint, p_tags text[])
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n integer;
begin
  if coalesce(array_length(p_tags, 1), 0) > 30 then
    raise exception 'a game may carry at most 30 tags';
  end if;
  insert into public.game_tags (slug, label)
  select t, initcap(replace(t, '-', ' ')) from unnest(p_tags) t
  on conflict (slug) do nothing;
  delete from public.game_tag_links where game_id = p_game_id;
  insert into public.game_tag_links (game_id, tag_slug)
  select distinct p_game_id, t from unnest(p_tags) t;
  get diagnostics n = row_count;
  return n;
end $$;

-- One round trip for the dashboard's content summary.
create or replace function public.cms_status_counts()
returns table (status text, games bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select g.status, count(*) from public.games g group by g.status
$$;


-- ── 7. Typed site settings ────────────────────────────────────────────────
-- The KEYS are defined in code (lib/settings-registry.mjs), each with a type and
-- bounds. This table only stores values. A key the code does not define is
-- ignored on read and refused on write, so this can never become a way to set
-- arbitrary configuration — and nothing stored here is ever executed.
create table if not exists public.site_settings (
  key        text primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
do $$ begin
  alter table public.site_settings add constraint site_settings_key_check
    check (key ~ '^[a-z][a-z0-9_.]{2,63}$');
exception when duplicate_object then null; end $$;


-- ── 8. Proxy governance ───────────────────────────────────────────────────
-- Engines: Ultraviolet, Scramjet, GUST, AnuraOS. Whether each is served, and
-- operator notes. The engine CODE is not configurable from here — only whether
-- it is offered.
create table if not exists public.proxy_providers (
  id         text primary key,
  enabled    boolean     not null default true,
  notes      text,
  updated_at timestamptz not null default now(),
  updated_by text
);
do $$ begin
  alter table public.proxy_providers add constraint proxy_providers_id_check
    check (id ~ '^[a-z0-9][a-z0-9-]{1,39}$');
exception when duplicate_object then null; end $$;

-- Approved destinations. The tunnel may open a connection ONLY to a host that
-- matches an `approved`, unexpired row here, on one of that row's ports. There
-- is no wildcard-everything pattern: the CHECK below requires at least two DNS
-- labels, and the application additionally refuses public-suffix wildcards
-- such as *.co.uk.
create table if not exists public.proxy_targets (
  id          bigint generated by default as identity primary key,
  pattern     text        not null,
  ports       integer[]   not null default '{443}',
  status      text        not null default 'pending',
  purpose     text        not null,
  owner       text,
  expires_at  timestamptz,
  approved_by text,
  approved_at timestamptz,
  created_by  text        not null,
  created_at  timestamptz not null default now(),
  updated_by  text,
  updated_at  timestamptz not null default now()
);
do $$ begin
  alter table public.proxy_targets add constraint proxy_targets_pattern_check
    check (pattern ~ '^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
       and pattern !~ '^(\*\.)?[0-9.]+$'            -- a destination names a site, never an address
       and char_length(pattern) <= 253);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.proxy_targets add constraint proxy_targets_status_check
    check (status in ('pending', 'approved', 'revoked'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.proxy_targets add constraint proxy_targets_ports_check
    check (cardinality(ports) between 1 and 4 and ports <@ array[80, 443, 8080, 8443]);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.proxy_targets add constraint proxy_targets_purpose_check
    check (char_length(purpose) between 3 and 300);
exception when duplicate_object then null; end $$;
create unique index if not exists proxy_targets_pattern_uidx on public.proxy_targets (lower(pattern));
create index if not exists proxy_targets_status_idx on public.proxy_targets (status, expires_at);

-- Resource limits and access mode. One row, id 'default'; the application
-- validates every field against hard bounds before it is applied.
create table if not exists public.proxy_policies (
  id         text primary key default 'default',
  policy     jsonb       not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by text
);
do $$ begin
  alter table public.proxy_policies add constraint proxy_policies_single_row
    check (id = 'default');
exception when duplicate_object then null; end $$;


-- ── 9. Every new table is server-only ─────────────────────────────────────
alter table public.admin_users      enable row level security;
alter table public.game_providers   enable row level security;
alter table public.game_categories  enable row level security;
alter table public.game_tags        enable row level security;
alter table public.game_tag_links   enable row level security;
alter table public.site_settings    enable row level security;
alter table public.proxy_providers  enable row level security;
alter table public.proxy_targets    enable row level security;
alter table public.proxy_policies   enable row level security;

do $$
declare
  server_only constant text[] := array[
    'admin_users', 'game_providers', 'game_categories', 'game_tags',
    'game_tag_links', 'site_settings', 'proxy_providers', 'proxy_targets',
    'proxy_policies'
  ];
  rel text;
  grantee_role text;
begin
  foreach rel in array server_only loop
    foreach grantee_role in array array['anon', 'authenticated'] loop
      continue when not exists (select 1 from pg_roles where rolname = grantee_role);
      execute format('revoke all on public.%I from %I', rel, grantee_role);
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant all privileges on public.%I to service_role', rel);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage, select on all sequences in schema public to service_role';
  end if;
end $$;

-- The functions are the server's, not the public's.
revoke all on function public.cms_bulk_transition(bigint[], text, text[], text) from public;
revoke all on function public.cms_set_game_tags(bigint, text[])                  from public;
revoke all on function public.cms_status_counts()                                from public;
revoke all on function public.admin_audit_verify(integer)                        from public;
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.cms_bulk_transition(bigint[], text, text[], text)',
    'public.cms_set_game_tags(bigint, text[])',
    'public.cms_status_counts()',
    'public.admin_audit_verify(integer)'
  ] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', fn);
    end if;
  end loop;
end $$;
