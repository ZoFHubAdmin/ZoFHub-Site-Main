-- =====================================================================
-- ZoFHub · Rewarded proxy access ("Boost")   (run ONCE in the Supabase SQL editor)
-- =====================================================================
-- A visitor who completes a reward campaign (today: a mocked "watch N
-- rewarded videos" flow — see lib/reward-mock-provider.mjs) is granted a
-- temporary "boost" tier on the proxy tunnel: a higher per-tunnel stream cap
-- than the free tier gets. See lib/proxy-control.mjs (freeStreamsPerTunnel)
-- and server.js's handleProxyUpgrade for how the tier is actually enforced.
--
-- NOT "premium". public/js/support-gate.js already uses "premium engines" for
-- a completely different thing (the ad-block-gated standalone companion
-- browsers). Reusing that word here would collide in UI copy, logs and the
-- admin console. This feature is called "Boost" everywhere: tier value
-- 'boost', table/column prefix reward_* / proxy_entitlements.
--
-- OFF BY DEFAULT. The whole feature is gated behind REWARDS_ENABLED (and the
-- admin console's rewards.enabled kill-switch) — see lib/reward-policy.mjs.
-- This migration can be applied safely with the feature left off; it creates
-- no rows and every function fails closed if called while disabled upstream.
--
-- WHY THIS IS NOT AN "OFFER TO UNLOCK" GATE (docs/README.md's documented
-- "no offer-to-unlock gates, no forced surveys" principle). Nothing here ever
-- gates the games hub, the catalog, or any built-in proxy engine. The ONLY
-- thing a grant changes is a stream-count ceiling on one anonymous tunnel.
-- Free-tier access is full access, just at the default cap every visitor has
-- always had (see lib/proxy-control.mjs's DEFAULT_POLICY.streamsPerTunnel).
--
-- DESIGN RULES THIS FILE FOLLOWS (same as db/control-plane.sql)
--
--   1. SERVER-ONLY, FAIL CLOSED. Every table here has RLS enabled and NO
--      policy, and anon/authenticated are explicitly revoked. Only the Node
--      server, holding the secret key, can read or write any of this.
--   2. REPLAY IS REJECTED AT THE DATABASE, NOT JUST IN APPLICATION CODE. The
--      unique index on (provider, provider_event_id) is what actually makes a
--      replayed postback impossible to double-spend, even under concurrency.
--   3. NO BROWSING RECORD. player_id is identity.js's existing persistent,
--      anonymous, device-local id — already used bare for score/leaderboard
--      attribution elsewhere on this site. Nothing here adds a stronger
--      identity than what already exists; see lib/reward-routes.mjs for the
--      trust-model note.
--   4. grant_reward_entitlement() is the ONLY way an entitlement is ever
--      written. It is SECURITY DEFINER, with a pinned search_path, and
--      execute is revoked from every role except the server's.
--
-- Idempotent: every CREATE is guarded, every constraint is added inside an
-- exception handler, and re-running the file is a no-op.
-- =====================================================================

-- ── 1. Campaigns (admin-configured, not hardcoded) ──────────────────────
create table if not exists public.reward_campaigns (
  id                    text primary key,                    -- slug, e.g. 'proxy-boost-1'
  title                 text        not null,
  description           text,
  tier                  text        not null default 'boost',
  required_events       integer     not null default 3,
  grant_minutes         integer     not null default 60,
  session_ttl_minutes   integer     not null default 15,
  max_sessions_per_day  integer     not null default 6,       -- per player; app-enforced, recorded here for the admin console
  status                text        not null default 'active', -- active | paused | retired
  created_at            timestamptz not null default now(),
  created_by            text,
  updated_at            timestamptz not null default now(),
  updated_by            text
);

do $$ begin
  alter table public.reward_campaigns add constraint reward_campaigns_tier_check
    check (tier in ('boost'));                 -- extend this list if a second tier is ever added
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.reward_campaigns add constraint reward_campaigns_status_check
    check (status in ('active', 'paused', 'retired'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.reward_campaigns add constraint reward_campaigns_required_events_check
    check (required_events between 1 and 20);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.reward_campaigns add constraint reward_campaigns_grant_minutes_check
    check (grant_minutes between 5 and 1440);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.reward_campaigns add constraint reward_campaigns_session_ttl_check
    check (session_ttl_minutes between 2 and 60);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.reward_campaigns add constraint reward_campaigns_max_sessions_check
    check (max_sessions_per_day between 1 and 50);
exception when duplicate_object then null; end $$;

-- ── 2. Reward sessions (one claim attempt) ──────────────────────────────
create table if not exists public.reward_sessions (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       text        not null references public.reward_campaigns(id) on delete restrict,
  player_id         text        not null,       -- identity.js's crypto.randomUUID() (or its fallback shape)
  status            text        not null default 'pending',  -- pending | completed | expired
  events_required   integer     not null,       -- snapshot of campaign.required_events at creation time
  events_completed  integer     not null default 0,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  completed_at      timestamptz,
  client_tag        text        -- an admin-auth.mjs hashIp()-style tag, correlation only, never a raw IP
);

do $$ begin
  alter table public.reward_sessions add constraint reward_sessions_status_check
    check (status in ('pending', 'completed', 'expired'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.reward_sessions add constraint reward_sessions_events_check
    check (events_completed >= 0 and events_required >= 1 and events_completed <= events_required);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.reward_sessions add constraint reward_sessions_player_id_check
    check (char_length(player_id) between 8 and 64);
exception when duplicate_object then null; end $$;

create index if not exists reward_sessions_player_idx   on public.reward_sessions (player_id, created_at desc);
create index if not exists reward_sessions_campaign_idx on public.reward_sessions (campaign_id, created_at desc);
create index if not exists reward_sessions_expiry_idx   on public.reward_sessions (expires_at) where status = 'pending';

-- ── 3. Reward events — the idempotency / replay-rejection ledger ────────
-- The unique index below is the real security property of this file: it is
-- what makes a replayed provider postback impossible to double-spend, even
-- under concurrent requests, because the second INSERT raises unique_violation
-- rather than racing a read-then-write check in application code.
create table if not exists public.reward_events (
  id                 bigint generated by default as identity primary key,
  session_id         uuid        not null references public.reward_sessions(id) on delete cascade,
  campaign_id        text        not null references public.reward_campaigns(id) on delete restrict,
  provider           text        not null,        -- 'mock' today; a real provider's id later
  provider_event_id  text        not null,         -- the idempotency key the provider's postback carries
  status             text        not null default 'verified',
  received_at        timestamptz not null default now(),
  verified_at        timestamptz
);

do $$ begin
  alter table public.reward_events add constraint reward_events_status_check
    check (status in ('verified'));
exception when duplicate_object then null; end $$;

create unique index if not exists reward_events_provider_event_uidx
  on public.reward_events (provider, provider_event_id);
create index if not exists reward_events_session_idx on public.reward_events (session_id);

-- ── 4. The entitlement itself — one row per visitor, independent of any one tunnel ──
-- Deliberately its OWN table, not folded into the in-memory tunnel tracker in
-- lib/proxy-control.mjs: an entitlement must outlive any one tunnel and be
-- readable before a tunnel even opens, where db/control-plane.sql's rule #4
-- ("proxy sessions are deliberately not persisted — a browsing record") does
-- not apply, because this table holds no destination, no browsing record and
-- no per-tunnel detail — only "this player has this tier until this time".
create table if not exists public.proxy_entitlements (
  player_id         text primary key,
  tier              text        not null default 'none',   -- none | boost
  granted_at        timestamptz,
  expires_at        timestamptz,
  last_campaign_id  text references public.reward_campaigns(id),
  updated_at        timestamptz not null default now()
);

do $$ begin
  alter table public.proxy_entitlements add constraint proxy_entitlements_tier_check
    check (tier in ('none', 'boost'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.proxy_entitlements add constraint proxy_entitlements_player_id_check
    check (char_length(player_id) between 8 and 64);
exception when duplicate_object then null; end $$;

create index if not exists proxy_entitlements_expiry_idx on public.proxy_entitlements (expires_at);

-- No reward_audit_events table. Reward-related security/audit events (session
-- created, entitlement granted, replay rejected, invalid signature, abuse cap
-- hit) are recorded through the EXISTING admin_security_events sink via
-- lib/admin-auth.mjs's securityEvent() — the same table server.js's
-- noteProxyPrivateRefusal() already writes a different kind of automatic,
-- non-admin-action event into. No parallel log.

-- ── 5. Row-level security: deny by default ──────────────────────────────
alter table public.reward_campaigns   enable row level security;
alter table public.reward_sessions    enable row level security;
alter table public.reward_events      enable row level security;
alter table public.proxy_entitlements enable row level security;

do $$
declare
  server_only constant text[] := array[
    'reward_campaigns', 'reward_sessions', 'reward_events', 'proxy_entitlements'
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
end $$;

-- ── 6. grant_reward_entitlement() — the only way an entitlement is written ──
-- Atomic: locks the session row, rejects an already-completed or expired
-- session, rejects an inactive campaign, rejects a replayed provider_event_id
-- (the unique index above, caught as unique_violation), advances the
-- session's event count, and — once events_completed reaches events_required
-- — stacks the grant onto the LATER of "now" or the player's existing
-- expiry, and marks the session completed. All in one statement-level
-- transaction, so two concurrent postbacks for the same session cannot both
-- "complete" it or double-grant the minutes.
create or replace function public.grant_reward_entitlement(
  p_session_id        uuid,
  p_provider           text,
  p_provider_event_id  text,
  p_event_timestamp    timestamptz
)
-- Output columns are prefixed out_* so that NONE of them bare-collide with a
-- real column name on reward_sessions/reward_campaigns/proxy_entitlements —
-- RETURNS TABLE makes each one an implicit PL/pgSQL variable, and a bare
-- column reference matching one, anywhere in the body (an UPDATE's SET/
-- RETURNING, an INSERT's target list, an ON CONFLICT target), is genuinely
-- ambiguous to Postgres. Confirmed by running this function, not by
-- inspection — see the long NOTE ON ALIASING comment below for exactly where
-- it broke and why. lib/reward-sessions.mjs's applyRewardEvent() reads these
-- same out_* names back from the RPC result.
returns table (
  ok bool, reason text, out_player_id text, out_tier text, out_expires_at timestamptz,
  out_events_completed int, out_events_required int, session_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session  public.reward_sessions;
  v_campaign public.reward_campaigns;
  v_now      timestamptz := now();
  v_expiry   timestamptz;
  v_completed int;
begin
  -- NOTE ON ALIASING: this function's RETURNS TABLE column names (player_id,
  -- tier, expires_at, events_completed, events_required) are plain words that
  -- ALSO name real columns on these tables. A RETURNS TABLE function makes
  -- each output column an implicit PL/pgSQL variable, so a BARE reference to
  -- one of those names inside an embedded SQL statement's expression/WHERE/
  -- RETURNING position is genuinely ambiguous to Postgres ("could refer to
  -- either a PL/pgSQL variable or a table column") — not a style problem. The
  -- table aliases below (rs/rc/pe) are therefore load-bearing, not decorative:
  -- every one of them resolves a real ambiguity, verified by actually running
  -- this function (test/reward-sessions.test.mjs, PGlite) and watching it
  -- fail with exactly that Postgres error before they were added.
  select * into v_session from public.reward_sessions rs where rs.id = p_session_id for update;
  if v_session is null then
    return query select false, 'session_not_found', null::text, null::text, null::timestamptz, 0, 0, null::text;
    return;
  end if;

  if v_session.status = 'completed' then
    return query select false, 'session_already_completed', v_session.player_id, null::text, null::timestamptz,
      v_session.events_completed, v_session.events_required, v_session.status;
    return;
  end if;

  if v_session.expires_at <= v_now then
    update public.reward_sessions rs set status = 'expired' where rs.id = p_session_id and rs.status <> 'expired';
    return query select false, 'session_expired', v_session.player_id, null::text, null::timestamptz,
      v_session.events_completed, v_session.events_required, 'expired';
    return;
  end if;

  select * into v_campaign from public.reward_campaigns rc where rc.id = v_session.campaign_id for update;
  if v_campaign is null or v_campaign.status <> 'active' then
    return query select false, 'campaign_inactive', v_session.player_id, null::text, null::timestamptz,
      v_session.events_completed, v_session.events_required, v_session.status;
    return;
  end if;

  -- The atomic replay-rejection gate. A replayed provider_event_id raises
  -- unique_violation on this INSERT, caught below — no read-then-write race.
  begin
    insert into public.reward_events (session_id, campaign_id, provider, provider_event_id, status, verified_at)
    values (p_session_id, v_session.campaign_id, p_provider, p_provider_event_id, 'verified', v_now);
  exception when unique_violation then
    return query select false, 'event_already_consumed', v_session.player_id, null::text, null::timestamptz,
      v_session.events_completed, v_session.events_required, v_session.status;
    return;
  end;

  update public.reward_sessions rs set events_completed = rs.events_completed + 1
    where rs.id = p_session_id
    returning rs.events_completed into v_completed;
  v_session.events_completed := v_completed;

  if v_session.events_completed < v_session.events_required then
    return query select true, 'event_recorded', v_session.player_id, null::text, null::timestamptz,
      v_session.events_completed, v_session.events_required, 'pending';
    return;
  end if;

  update public.reward_sessions rs set status = 'completed', completed_at = v_now where rs.id = p_session_id;

  insert into public.proxy_entitlements as pe (player_id, tier, granted_at, expires_at, last_campaign_id, updated_at)
  values (v_session.player_id, v_campaign.tier, v_now,
          v_now + (v_campaign.grant_minutes || ' minutes')::interval, v_campaign.id, v_now)
  on conflict (player_id) do update
    set tier             = v_campaign.tier,
        granted_at       = v_now,
        expires_at       = greatest(pe.expires_at, v_now) + (v_campaign.grant_minutes || ' minutes')::interval,
        last_campaign_id = v_campaign.id,
        updated_at       = v_now
  returning pe.expires_at into v_expiry;

  return query select true, 'entitlement_granted', v_session.player_id, v_campaign.tier, v_expiry,
    v_session.events_completed, v_session.events_required, 'completed';
end;
$$;

revoke all on function public.grant_reward_entitlement(uuid, text, text, timestamptz) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.grant_reward_entitlement(uuid, text, text, timestamptz) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.grant_reward_entitlement(uuid, text, text, timestamptz) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.grant_reward_entitlement(uuid, text, text, timestamptz) to service_role';
  end if;
end $$;

-- =====================================================================
-- Verify:
--   select count(*) from public.reward_campaigns;    -- 0 until an admin adds one
--   select count(*) from public.proxy_entitlements;   -- 0 until the first grant
--
-- The server degrades gracefully if you never run this file, or never set
-- REWARDS_ENABLED: the feature stays entirely off, every visitor is 'free'
-- tier (the same cap every visitor has always had), and nothing fails.
-- =====================================================================
