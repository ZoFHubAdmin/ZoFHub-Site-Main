-- ==========================================================================
-- ZoFHub migration: subscriber_emails
-- Source of truth: db/14_subscriber_emails.sql
--
-- Mirror-update list: two columns, RLS deny-by-default, anon granted INSERT and nothing else. Runs BEFORE schema_hardening (which must stay the last file that creates objects) and before grants (the final privilege sweep).
--
-- Applied by the Supabase GitHub integration to every preview branch and,
-- on merge, to production. This file is a VERBATIM copy of db/14_subscriber_emails.sql —
-- edit that file and re-run `npm run sync-migrations`, so the two cannot
-- drift.
--
-- Idempotent (IF NOT EXISTS / OR REPLACE / guarded DROPs), so applying it to
-- a database that already has this schema is a no-op rather than an error.
-- ==========================================================================

-- =====================================================================
-- ZoFHub · subscriber_emails   (run ONCE in the Supabase SQL editor)
-- =====================================================================
-- CENSORSHIP INSURANCE. If this domain is blocked, the only way to tell
-- anyone where the mirror is, is to already have a way to reach them.
-- That is the entire purpose of this table and it is why it holds so little.
--
-- TWO COLUMNS, ON PURPOSE. No IP, no user agent, no signup timestamp, no
-- referrer, no confirmation state. The homepage promises "no accounts, zero
-- tracking", and a schema is the only place that promise can actually be kept:
-- a column that does not exist cannot be logged, joined, correlated or
-- subpoenaed. Anything added here later makes that sentence a lie, so it should
-- not be added here later.
--
-- A WRITE-ONLY VAULT. RLS is deny-by-default and the public (anon) key is
-- granted INSERT and nothing else. A browser can drop an address in; a browser
-- cannot read one back, cannot enumerate, cannot count, and cannot amend. Even
-- with the publishable key in hand — and it ships to every visitor, by design —
-- there is no query that returns somebody else's address. The server reads this
-- table with the secret key, which bypasses RLS, and that key never leaves the
-- backend.
--
--   Dashboard -> SQL Editor -> New query -> paste -> Run.
-- =====================================================================

create table if not exists public.subscriber_emails (
  id    uuid primary key default gen_random_uuid(),
  email text not null
);

comment on table public.subscriber_emails is
  'Mirror-update list. Deliberately two columns: no IP, no timestamp, no consent log — the homepage promises zero tracking and this schema is what keeps that true. Write-only to the anon key.';

-- One row per address. Without this, the insert endpoint is a free way to grow
-- the table without bound by resubmitting the same address.
-- Case-insensitive: Foo@x.com and foo@x.com are one person.
create unique index if not exists subscriber_emails_lower_email_uniq
  on public.subscriber_emails (lower(email));

-- ── Row-Level Security: deny by default ──────────────────────────────────
alter table public.subscriber_emails enable row level security;
alter table public.subscriber_emails force row level security;

-- Clear any earlier policy so re-running this file is safe and the final
-- posture is exactly what is written below, not whatever accumulated.
drop policy if exists "anon can insert a subscriber email" on public.subscriber_emails;
drop policy if exists "public can read subscribers"        on public.subscriber_emails;

-- INSERT only. There is deliberately NO select, update or delete policy, so
-- every other operation is refused by RLS for anon and authenticated alike.
create policy "anon can insert a subscriber email"
  on public.subscriber_emails
  for insert
  to anon, authenticated
  with check (
    -- Enforced in the database as well as the server: a shape check here still
    -- applies to a direct PostgREST insert that never touched our Express route.
    email is not null
    and length(email) between 6 and 254
    and position('@' in email) > 1
  );

-- ── Grants ───────────────────────────────────────────────────────────────
-- RLS decides WHICH rows; grants decide WHICH VERBS. Both have to say yes, so
-- the verbs are narrowed here too rather than relying on policies alone.
revoke all on table public.subscriber_emails from anon, authenticated;
grant insert on table public.subscriber_emails to anon, authenticated;
grant all    on table public.subscriber_emails to service_role;

-- A sequence grant is not needed: the primary key is a uuid default, not a
-- serial, so an inserting role never touches a sequence.
