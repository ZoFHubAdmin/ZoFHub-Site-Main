// lib/supabase.mjs
//
// Lazy-init Supabase client.  Returns `null` if env vars are missing,
// so the rest of the app can defensively check `if (!supa) { ...fallback }`
// without crashing in environments where Supabase isn't configured yet.

import { createClient } from '@supabase/supabase-js';

let cached = null;
let triedOnce = false;

export function getSupabase() {
  if (cached) return cached;
  if (triedOnce) return null; // don't re-warn on every call
  triedOnce = true;

  // Accept either the bare name or the `NEXT_PUBLIC_` aliased name
  // (the latter is the Next.js convention; Express ignores the prefix
  // but reads either fine).
  const url = process.env.SUPABASE_URL
           || process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Prefer an ADMIN key on the server (full read/write, bypasses RLS).
  // SUPABASE_SECRET_KEY is the new-style `sb_secret_…`; SUPABASE_SERVICE_ROLE_KEY
  // is the legacy JWT it replaces. They are equivalent here — a secret key
  // bypasses RLS exactly like service_role — and the new one wins so a migration
  // takes effect the moment you paste it.
  // Fall back to anon / publishable if that's all the user pasted in —
  // note: writes (cron link-check, migration upsert) will fail with the
  // publishable key alone unless you add INSERT/UPDATE RLS policies.
  const key = process.env.SUPABASE_SECRET_KEY
           || process.env.SUPABASE_SERVICE_ROLE_KEY
           || process.env.SUPABASE_ANON_KEY
           || process.env.SUPABASE_PUBLISHABLE_KEY
           || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
           || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    console.warn('[zofhub] Supabase env vars not set — falling back to bundled JSON.');
    return null;
  }

  try {
    cached = createClient(url, key, {
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
    console.log('[zofhub] Supabase client ready.');
    return cached;
  } catch (e) {
    console.warn('[zofhub] Supabase init failed:', e.message);
    return null;
  }
}

export function isSupabaseConfigured() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
           || process.env.SUPABASE_ANON_KEY
           || process.env.SUPABASE_PUBLISHABLE_KEY
           || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
           || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return !!(url && key);
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
  // Report WHICH kind of admin key is in use, so /api/health confirms a
  // legacy→secret migration actually took effect without ever printing the key.
  const admin = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const keyType = admin
                  ? (admin.startsWith('sb_secret_') ? 'secret'
                     : admin.startsWith('eyJ') ? 'service_role (legacy JWT — retires end of 2026)'
                     : 'admin (unrecognised format)')
                : (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY
                   || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
                  ? 'public' : 'unknown';
  const supa = getSupabase();
  if (!supa) return { configured: true, connected: false, keyType, error: 'client-init-failed' };
  try {
    const { count, error } = await supa.from('games').select('id', { count: 'exact', head: true });
    if (error) return { configured: true, connected: false, keyType, error: error.message };
    return { configured: true, connected: true, keyType, games: count ?? null };
  } catch (e) {
    return { configured: true, connected: false, keyType, error: e?.message || String(e) };
  }
}
