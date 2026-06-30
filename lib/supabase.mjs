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
  // Prefer the service-role key on the server (full read/write, bypasses RLS).
  // Fall back to anon / publishable if that's all the user pasted in —
  // note: writes (cron link-check, migration upsert) will fail with the
  // publishable key alone unless you add INSERT/UPDATE RLS policies.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
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
