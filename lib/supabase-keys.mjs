// lib/supabase-keys.mjs
// ---------------------------------------------------------------------------
// Make the server-side Supabase admin key work under EITHER name.
//
// Supabase is replacing the legacy JWT keys (`anon` / `service_role`, the long
// `eyJ…` strings) with a new pair: `sb_publishable_…` and `sb_secret_…`. The
// legacy ones can no longer be rotated individually — the only way to retire a
// leaked `service_role` key is to create a new secret key, move everything onto
// it, and then deactivate the legacy pair in the dashboard. Legacy keys are
// deprecated at the end of 2026.
//
// Both key types do the same job here: a secret key bypasses Row Level Security
// exactly like `service_role` did, so it is a drop-in replacement.
//
// THE PROBLEM this module solves: ten CLI tools (export-games, migrate,
// audit-catalog, fetch-y8-thumbs, restore-games, set-gamezop-partner, …) read
// `process.env.SUPABASE_SERVICE_ROLE_KEY` by name. Pasting a new key into a
// differently-named slot would silently break every one of them — they'd report
// "Supabase not configured" while the server itself worked fine, which is a
// miserable thing to debug.
//
// So instead of renaming the variable in ten files, we normalise once at
// startup: whichever slot is filled in, BOTH names end up holding the key.
// SUPABASE_SECRET_KEY wins when both are set, because that is the one you are
// migrating TO — it lets you paste the new key, confirm the site still works,
// and only then deactivate the legacy key, with no window where tools break.
// ---------------------------------------------------------------------------

// Values that mean "not filled in yet" — .env ships with an empty slot, and
// .env.example carries obvious dummies. Treat them as absent so a placeholder
// can never shadow a real key that's set in the host dashboard.
const PLACEHOLDER = /^(your[-_]|<|\.\.\.|change-me|sb_secret_your|paste)/i;

const clean = (v) => {
  const s = String(v ?? '').trim();
  return (!s || PLACEHOLDER.test(s)) ? '' : s;
};

/**
 * Mirror SUPABASE_SECRET_KEY <-> SUPABASE_SERVICE_ROLE_KEY in process.env.
 * Safe to call more than once. Returns a small summary for logging.
 */
export function normalizeSupabaseKeys() {
  const secret = clean(process.env.SUPABASE_SECRET_KEY);
  const legacy = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Drop placeholders so downstream `if (process.env.X)` checks stay honest.
  if (!secret) delete process.env.SUPABASE_SECRET_KEY;
  if (!legacy) delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  let source = 'none';
  if (secret) {
    process.env.SUPABASE_SECRET_KEY = secret;
    process.env.SUPABASE_SERVICE_ROLE_KEY = secret;   // so the ten tools keep working
    source = 'SUPABASE_SECRET_KEY';
  } else if (legacy) {
    process.env.SUPABASE_SERVICE_ROLE_KEY = legacy;
    process.env.SUPABASE_SECRET_KEY = legacy;
    source = 'SUPABASE_SERVICE_ROLE_KEY';
  }

  const key = secret || legacy;
  return {
    source,
    present: !!key,
    // sb_secret_… = new-style, eyJ… = legacy JWT. Reported by /api/health so you
    // can confirm a migration actually took effect without printing the key.
    format: !key ? 'none'
          : key.startsWith('sb_secret_') ? 'secret'
          : key.startsWith('eyJ') ? 'legacy-jwt'
          : 'unknown',
    bothSet: !!(secret && legacy),
  };
}

/** The resolved server-side admin key, or '' when none is configured. */
export function adminKey() {
  return clean(process.env.SUPABASE_SECRET_KEY) || clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
}
