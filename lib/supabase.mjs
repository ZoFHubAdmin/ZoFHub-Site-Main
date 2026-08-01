// lib/supabase.mjs
//
// Lazy-init Supabase clients. Every accessor returns `null` when the relevant
// env vars are missing, so the rest of the app can defensively check
// `if (!supa) { ...fallback }` without crashing in environments where Supabase
// isn't configured yet.
//
// ── TWO SECURITY CONTEXTS, ONE MODULE ──────────────────────────────────────
// This app is an Express monolith and the browser NEVER talks to Supabase
// directly — every read and write goes through this server's own API routes.
// There is therefore no browser Supabase client, and adding one would widen the
// attack surface for no gain. What we do need is a clean split between the two
// contexts the SERVER uses:
//
//   getSupabaseAdmin()  — the `sb_secret_…` key. Bypasses RLS. Writes.
//   getSupabasePublic() — the `sb_publishable_…` key. Subject to RLS. Reads.
//   getSupabase()       — the historical accessor: admin if available, else
//                         public. Kept because ~40 call sites use it and
//                         renaming them all would be churn, not a fix.
//
// The reason the split now exists: getSupabase() degraded from the secret key to
// the publishable key SILENTLY. Deploy with only a publishable key and the
// server boots, isSupabaseConfigured() reports true, reads work (RLS permits
// them) — and every write fails at runtime with an opaque RLS error. The site
// looks healthy while nothing it records is saved. Verified against production:
// the publishable key gets 42501 on INSERT into `games`. So the degradation is
// still allowed (a read-only deployment is legitimate) but it is now LOUD, and
// `writable` is reported through /api/health.

import { createClient } from '@supabase/supabase-js';
import { adminKey } from './supabase-keys.mjs';

// ── Key resolution — ONE definition, deliberately ──────────────────────────
// getSupabase() and isSupabaseConfigured() used to hand-repeat this fallback
// chain. They drifted: SUPABASE_SECRET_KEY was missing from the second copy, so
// on a host that set ONLY the new-style key, isSupabaseConfigured() returned
// false while getSupabase() returned a WORKING client. That contradiction gated
// cron registration and the initial link-check off on a correctly configured
// deployment, and made /api/health report "not configured" while the site served
// live Supabase data. Two copies of a precedence list is the bug; this is the
// fix, so they cannot disagree again.

/** Project URL. `NEXT_PUBLIC_` aliases are accepted because hosts often set them. */
export function supabaseUrl() {
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
}

/** The browser-safe key: publishable (new) or anon (legacy). Never the secret. */
export function publicKey() {
  return process.env.SUPABASE_PUBLISHABLE_KEY
      || process.env.SUPABASE_ANON_KEY
      || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
      || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      || '';
}

// The admin key comes from lib/supabase-keys.mjs so there is exactly one place
// that knows SUPABASE_SECRET_KEY and SUPABASE_SERVICE_ROLE_KEY are equivalent
// and that placeholders like `sb_secret_your-secret-key` mean "not set".

/** Resolved key + privilege level, admin first. */
function resolveKey() {
  const admin = adminKey();
  if (admin) return { key: admin, level: 'admin' };
  const pub = publicKey();
  if (pub) return { key: pub, level: 'public' };
  return { key: '', level: 'none' };
}

function buildClient(url, key) {
  return createClient(url, key, {
    auth: { persistSession: false },
    // Reasonable defaults: respect the free-tier rate limits, but
    // don't block forever on a network hiccup.
    global: {
      fetch: (input, init = {}) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        return fetch(input, { ...init, signal: ctrl.signal })
          .finally(() => clearTimeout(t));
      }
    }
  });
}

let cached = null;
let triedOnce = false;
let cachedAdmin = null;
let triedAdmin = false;
let cachedPublic = null;
let triedPublic = false;

export function getSupabase() {
  if (cached) return cached;
  if (triedOnce) return null; // don't re-warn on every call
  triedOnce = true;

  const url = supabaseUrl();
  const { key, level } = resolveKey();

  if (!url || !key) {
    console.warn('[zofhub] Supabase env vars not set — falling back to bundled JSON.');
    return null;
  }

  try {
    cached = buildClient(url, key);
    console.log(`[zofhub] Supabase client ready (${level} key).`);
    // The failure this warning exists to prevent: reads succeed, writes don't,
    // and nothing says why until someone notices scores stopped saving.
    if (level === 'public') {
      console.warn('[zofhub] NO ADMIN KEY — running on the publishable key. Reads work; every WRITE (score submission, play counters, link-check, ingest) will be refused by RLS. Set SUPABASE_SECRET_KEY to enable writes.');
    }
    return cached;
  } catch (e) {
    console.warn('[zofhub] Supabase init failed:', e.message);
    return null;
  }
}

/**
 * Privileged client — the secret / service-role key ONLY. Bypasses RLS.
 * Returns null when no admin key is configured, so a caller that must write can
 * fail loudly instead of inheriting a public client and being denied by RLS.
 * NEVER hand this client, or its key, to anything that reaches the browser.
 */
export function getSupabaseAdmin() {
  if (cachedAdmin) return cachedAdmin;
  if (triedAdmin) return null;
  triedAdmin = true;
  const url = supabaseUrl();
  const key = adminKey();
  if (!url || !key) return null;
  try {
    cachedAdmin = buildClient(url, key);
    return cachedAdmin;
  } catch (e) {
    console.warn('[zofhub] Supabase admin client init failed:', e.message);
    return null;
  }
}

/**
 * Public client — the publishable / anon key ONLY, fully subject to RLS.
 * Use where a public security context is the correct one, so a bug in a query
 * cannot read or write more than an anonymous visitor could. Deliberately does
 * NOT fall back to the admin key: falling back would defeat the entire point.
 */
export function getSupabasePublic() {
  if (cachedPublic) return cachedPublic;
  if (triedPublic) return null;
  triedPublic = true;
  const url = supabaseUrl();
  const key = publicKey();
  if (!url || !key) return null;
  try {
    cachedPublic = buildClient(url, key);
    return cachedPublic;
  } catch (e) {
    console.warn('[zofhub] Supabase public client init failed:', e.message);
    return null;
  }
}

/**
 * What the default client can actually do. `writable` is the operationally
 * useful bit: false means every write will be refused by RLS.
 * Reports the key FORMAT, never any part of a key value.
 */
export function supabasePrivilege() {
  const { level } = resolveKey();
  const admin = adminKey();
  return {
    level,                                   // admin | public | none
    writable: level === 'admin',
    format: !admin ? (level === 'public' ? 'publishable' : 'none')
          : admin.startsWith('sb_secret_') ? 'secret'
          : admin.startsWith('eyJ') ? 'legacy-jwt'
          : 'unknown',
    hasPublicKey: !!publicKey(),
  };
}

export function isSupabaseConfigured() {
  return !!(supabaseUrl() && resolveKey().key);
}

// ---------------------------------------------------------------------
// Keep-alive: fire ONE tiny request at Supabase so a free-tier project never
// reaches its 7-day inactivity pause. Prefers a single-row upsert into the
// `keepalive` table (gives you a visible `last_pinged`); if that table doesn't
// exist yet, it falls back to the lightest possible HEAD read on `games` — so
// it works whether or not you've run db/keepalive.sql. Either path is a real
// API request, which is all Supabase needs to see to stay awake.
//
// Fully async and cheap. Callers should FIRE-AND-FORGET (don't await it in a
// request handler) so it can never block the event loop.
export async function supabaseKeepAlive() {
  const supa = getSupabase();
  if (!supa) return { ok: false, reason: 'supabase-not-configured' };

  // Preferred: record a heartbeat you can actually see in the dashboard.
  try {
    const { error } = await supa
      .from('keepalive')
      .upsert({ id: 1, last_pinged: new Date().toISOString() }, { onConflict: 'id' });
    if (!error) return { ok: true, mode: 'write' };
    // error (table missing / RLS) → fall through to the read below.
  } catch { /* fall through */ }

  // Fallback: a HEAD request returns no rows/body but still counts as activity.
  try {
    const { error } = await supa.from('games').select('id', { head: true }).limit(1);
    return error ? { ok: false, error: error.message } : { ok: true, mode: 'read' };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ---------------------------------------------------------------------
// Read-only connectivity probe for /api/health. Turns a vague "Supabase is
// configured but not working" into a precise, actionable status:
//   { configured, connected, keyType, games, error }
// - configured : env vars are present (client could be built)
// - connected  : a live HEAD count on `games` actually succeeded
// - keyType    : which key the server is using (service-role vs public) —
//                the usual cause of "reads work but writes fail" is a public
//                key with no INSERT/UPDATE RLS policy
// - error      : the REAL upstream reason when connected is false (paused
//                project, bad URL/key, network egress blocked, RLS, …)
// Never throws; bounded by the client's built-in 8s fetch timeout.
export async function supabaseHealth() {
  const configured = isSupabaseConfigured();
  if (!configured) return { configured: false, connected: false };
  // Report WHICH kind of key is in use, so /api/health confirms a legacy→secret
  // migration actually took effect without ever printing the key. This used to
  // re-derive the key chain by hand — the FOURTH copy of that precedence list in
  // the codebase. It now reads the single resolver, so it cannot disagree with
  // the client that is actually connected.
  const priv = supabasePrivilege();
  const keyType = priv.level === 'admin'
    ? (priv.format === 'secret' ? 'secret'
       : priv.format === 'legacy-jwt' ? 'service_role (legacy JWT — retires end of 2026)'
       : 'admin (unrecognised format)')
    : priv.level === 'public' ? 'public' : 'unknown';
  const supa = getSupabase();
  if (!supa) return { configured: true, connected: false, keyType, writable: priv.writable, error: 'client-init-failed' };
  try {
    const { count, error } = await supa.from('games').select('id', { count: 'exact', head: true });
    if (error) return { configured: true, connected: false, keyType, writable: priv.writable, error: error.message };
    // `writable` is the field that answers the real question. `connected: true`
    // with `writable: false` is the exact shape of "the site looks fine but
    // nothing is being saved", and it was previously invisible.
    return { configured: true, connected: true, keyType, writable: priv.writable, games: count ?? null };
  } catch (e) {
    return { configured: true, connected: false, keyType, writable: priv.writable, error: e?.message || String(e) };
  }
}
