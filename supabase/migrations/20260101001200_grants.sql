-- ==========================================================================
-- ZoFHub migration: grants
-- Source of truth: db/grants.sql
--
-- Role privileges for service_role / anon / authenticated. MUST BE LAST: it grants over whatever tables exist at the end, so it has to run after feedback.sql drops the retired ones. Without it every table is 42501 "permission denied" on a project whose default privileges were not pre-provisioned.
--
-- Applied by the Supabase GitHub integration to every preview branch and,
-- on merge, to production. This file is a VERBATIM copy of db/grants.sql —
-- edit that file and re-run `npm run sync-migrations`, so the two cannot
-- drift.
--
-- Idempotent (IF NOT EXISTS / OR REPLACE / guarded DROPs), so applying it to
-- a database that already has this schema is a no-op rather than an error.
-- ==========================================================================

-- =====================================================================
-- ZoFHub · role grants   (MUST RUN LAST — after every table exists)
-- =====================================================================
-- WHY THIS FILE EXISTS
--
-- Creating a table grants nobody anything. Postgres gives a new table's
-- privileges to its owner and to nobody else; every other role needs an
-- explicit GRANT. Supabase normally papers over this with ALTER DEFAULT
-- PRIVILEGES set up at project creation, so tables made in the SQL editor
-- silently arrive with anon / authenticated / service_role grants already
-- attached — and this schema was written against a project where that was
-- true, so it never issued a single GRANT for service_role.
--
-- That assumption did not survive moving to a new project. Every table came
-- up unreadable:
--
--     GET /rest/v1/games  ->  403
--     {"code":"42501","message":"permission denied for table games",
--      "hint":"Grant the required privileges to the current role with:
--              GRANT SELECT ON public.games TO service_role;"}
--
-- Note the hint names service_role. The key was correct and the role was
-- correct; the grant was simply never made. `npm run restore-games` failed
-- all 34 batches with 0 rows written, and the schema audit still reported
-- clean, because the tables genuinely did exist — nothing could read them.
--
-- Depending on inherited default privileges is depending on how a project
-- happened to be provisioned. This file states the privileges outright, so
-- the schema is complete on any project, old or new.
--
-- PRIVILEGE MODEL
--
--   service_role  The Node server's identity (SUPABASE_SECRET_KEY). Full DML
--                 on everything; bypasses RLS. This is the only role the
--                 application actually uses — public/ contains no Supabase
--                 client, so the browser never talks to PostgREST directly.
--
--   anon /        Granted SELECT on exactly the five relations that already
--   authenticated carry a permissive read policy, and INSERT on feedback.
--                 The GRANT is the outer gate and RLS is the inner one; both
--                 must pass. Granting no more than the policies already allow
--                 keeps the two consistent, so neither is load-bearing alone.
--                 Explicitly revoked on everything else — admin tables, the
--                 discovery tables, and feedback reads.
--
-- Idempotent: GRANT/REVOKE are declarative, so re-running changes nothing.
-- Every role is probed before use, so this also runs on a plain Postgres that
-- has no Supabase roles at all.
-- =====================================================================

do $$
declare
  -- Relations a permissive SELECT policy already exposes:
  --   games            RLS: is_working = true
  --   games_public     SECURITY INVOKER view over games (needs both grants)
  --   recommendations  RLS: is_visible = true
  --   keepalive        RLS: true
  --   game_stats       RLS: true
  public_read constant text[] := array[
    'games', 'games_public', 'recommendations', 'keepalive', 'game_stats'
  ];

  -- Server-only. No public policy exists for these, and none should: the
  -- admin tables are the audit trail and session store, the discovery tables
  -- hold provider fingerprints, and feedback is private correspondence.
  -- feedback keeps its INSERT grant (that is how the contact form works) but
  -- must never become readable.
  private_read constant text[] := array[
    'feedback', 'admin_sessions', 'admin_audit_logs', 'admin_login_attempts',
    'admin_security_events', 'game_fingerprints', 'game_duplicates',
    'rejected_submissions'
  ];

  rel          text;
  -- Not named `role`: that is a Postgres keyword, and a variable sharing a
  -- name with SQL syntax is how a working DO block turns into a parse error
  -- the next time someone edits a statement inside it.
  grantee_role text;
begin
  -- ── The server ────────────────────────────────────────────────────────
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema public to service_role';
    execute 'grant all privileges on all tables    in schema public to service_role';
    execute 'grant all privileges on all sequences in schema public to service_role';
    execute 'grant all privileges on all functions in schema public to service_role';

    -- ...and for tables added by future migrations, so the next person to add
    -- one does not rediscover this bug. Default privileges are recorded per
    -- granting role; the SQL editor and the Supabase GitHub integration both
    -- run as the owner, which is the role that matters here.
    execute 'alter default privileges in schema public grant all privileges on tables    to service_role';
    execute 'alter default privileges in schema public grant all privileges on sequences to service_role';
    execute 'alter default privileges in schema public grant all privileges on functions to service_role';

    raise notice 'granted public schema to service_role';
  else
    raise notice 'no service_role on this database — skipped (not a Supabase project?)';
  end if;

  -- ── The public keys ───────────────────────────────────────────────────
  foreach grantee_role in array array['anon', 'authenticated'] loop
    continue when not exists (select 1 from pg_roles where rolname = grantee_role);

    execute format('grant usage on schema public to %I', grantee_role);

    foreach rel in array public_read loop
      -- to_regclass returns NULL rather than raising, so a relation an
      -- earlier migration dropped (scores, retired with the leaderboard)
      -- or has not created yet is skipped instead of failing the deploy.
      continue when to_regclass('public.' || rel) is null;
      execute format('grant select on public.%I to %I', rel, grantee_role);
    end loop;

    foreach rel in array private_read loop
      continue when to_regclass('public.' || rel) is null;
      execute format('revoke all on public.%I from %I', rel, grantee_role);
    end loop;

    -- Restored after the blanket revoke above: anonymous visitors must be
    -- able to send feedback, they just must not be able to read it back.
    -- RLS ("Anyone may send feedback") still applies on top.
    if to_regclass('public.feedback') is not null then
      execute format('grant insert on public.feedback to %I', grantee_role);
    end if;
  end loop;
end $$;


-- ---------------------------------------------------------------------
-- Sanity check — what each role can actually reach now.
-- ---------------------------------------------------------------------
-- Expect: service_role on every table; anon/authenticated only on the five
-- policy-backed relations plus INSERT on feedback.
select
  grantee,
  table_name,
  string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated', 'service_role')
group by grantee, table_name
order by grantee, table_name;
