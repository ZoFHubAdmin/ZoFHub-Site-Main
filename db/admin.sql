-- db/admin.sql
--
-- Storage for the administrator console: sessions, audit trail, login attempts
-- and security events.
--
-- WHY THESE LIVE IN POSTGRES AND NOT IN MEMORY
-- The app already carries four in-memory structures that make it correct only on
-- a single instance (score sessions, rate-limit buckets, presence, play counts).
-- Admin state must not join that list: an in-memory session table means every
-- deploy silently logs the operator out, and a second replica would accept a
-- session the first one never issued. It also means the audit trail — the one
-- record that has to survive an incident — would be erased by the restart that
-- often FOLLOWS an incident.
--
-- FAIL CLOSED. Every table here is reachable only with the server's secret key.
-- If the database is unavailable the admin console cannot create or validate a
-- session, so it refuses logins rather than falling back to something weaker.
--
-- Idempotent (IF NOT EXISTS / guarded DROPs), so re-applying is a no-op.

-- ── Sessions ───────────────────────────────────────────────────────────────
-- The cookie carries a random token; this table stores only its SHA-256 HASH.
-- A dump of this table therefore grants nobody a session, exactly as a password
-- table stores hashes rather than passwords.
create table if not exists public.admin_sessions (
  id             bigserial primary key,
  -- sha256(token) — never the token itself
  token_hash     text        not null,
  username       text        not null,
  -- HMAC of the client IP, not the IP. Enough to spot a session moving between
  -- networks; useless for locating anyone.
  ip_hash        text,
  user_agent     text,
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  -- Absolute cap: a session dies at this time no matter how active it is.
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoked_reason text
);

create unique index if not exists admin_sessions_token_uidx
  on public.admin_sessions (token_hash);
-- The sweep and the "active sessions" panel both read this.
create index if not exists admin_sessions_live_idx
  on public.admin_sessions (expires_at desc) where revoked_at is null;

-- ── Audit trail ────────────────────────────────────────────────────────────
-- APPEND ONLY. Nothing in the dashboard can edit or delete a row here: the API
-- exposes no update or delete path, and the trigger below refuses both at the
-- database level, so even a bug in application code cannot rewrite history.
create table if not exists public.admin_audit_logs (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  username     text,
  action       text        not null,   -- 'score.approve', 'game.hide', …
  target       text,                   -- what it acted on
  outcome      text        not null,   -- success | failure | denied
  ip_hash      text,
  user_agent   text,
  detail       jsonb
);

create index if not exists admin_audit_at_idx     on public.admin_audit_logs (at desc);
create index if not exists admin_audit_action_idx on public.admin_audit_logs (action, at desc);

-- Immutability enforced where it cannot be argued with.
create or replace function public.admin_audit_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'admin_audit_logs is append-only (attempted %)', tg_op;
end $$;

drop trigger if exists trg_admin_audit_no_update on public.admin_audit_logs;
create trigger trg_admin_audit_no_update
  before update or delete on public.admin_audit_logs
  for each row execute function public.admin_audit_is_append_only();

-- ── Login attempts ─────────────────────────────────────────────────────────
-- Drives lockout and gives the Security Centre something factual to show. Both
-- successes and failures are recorded: a success from an unfamiliar network is
-- the more interesting event of the two.
create table if not exists public.admin_login_attempts (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  username   text,                    -- as SUPPLIED; never proves the account exists
  ok         boolean     not null,
  ip_hash    text,
  user_agent text,
  reason     text                     -- bad_password | unknown_user | locked | ok
);

create index if not exists admin_login_at_idx on public.admin_login_attempts (at desc);
create index if not exists admin_login_ip_idx on public.admin_login_attempts (ip_hash, at desc);

-- ── Security events ────────────────────────────────────────────────────────
-- Anything worth an operator's attention that is not a plain login: a session
-- whose IP or user agent changed mid-life, a CSRF rejection, a lockout starting.
create table if not exists public.admin_security_events (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  kind       text        not null,    -- session_ip_change | csrf_reject | lockout | …
  severity   text        not null default 'info',   -- info | warn | critical
  username   text,
  ip_hash    text,
  detail     jsonb
);

create index if not exists admin_sec_at_idx   on public.admin_security_events (at desc);
create index if not exists admin_sec_kind_idx on public.admin_security_events (kind, at desc);

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Deny by default, with NO permissive policy. The publishable key that reaches
-- browsers gets nothing at all; the server reaches these with the secret key,
-- which bypasses RLS. This is operational security data — there is no version of
-- "the public may read some of it" that makes sense.
alter table public.admin_sessions        enable row level security;
alter table public.admin_audit_logs      enable row level security;
alter table public.admin_login_attempts  enable row level security;
alter table public.admin_security_events enable row level security;

drop policy if exists "No public access to admin_sessions"        on public.admin_sessions;
drop policy if exists "No public access to admin_audit_logs"      on public.admin_audit_logs;
drop policy if exists "No public access to admin_login_attempts"  on public.admin_login_attempts;
drop policy if exists "No public access to admin_security_events" on public.admin_security_events;

-- ── Retention ──────────────────────────────────────────────────────────────
-- Called by the daily cron. Expired sessions and stale attempt rows are noise;
-- the AUDIT TRAIL IS NEVER TOUCHED by this function, deliberately — it is the
-- record you need long after everything else has aged out.
create or replace function public.prune_admin_state(
  session_grace_days integer default 7,
  attempt_days       integer default 30,
  event_days         integer default 180
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.admin_sessions
    where expires_at < now() - make_interval(days => session_grace_days);
  delete from public.admin_login_attempts
    where at < now() - make_interval(days => attempt_days);
  delete from public.admin_security_events
    where at < now() - make_interval(days => event_days);
end $$;

-- Only the service role may prune; never the publishable key.
revoke all on function public.prune_admin_state(integer, integer, integer) from public, anon, authenticated;
