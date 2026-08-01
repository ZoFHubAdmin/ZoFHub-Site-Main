// Unit tests for Supabase key resolution and privilege separation.
//
// These cover the exact class of bug this module has already had once: two
// hand-written copies of the key-precedence chain that drifted, so
// isSupabaseConfigured() said "no" while getSupabase() returned a working
// client. The functions under test are pure env readers, so they can be driven
// through every configuration a real deployment might have.
//
// No network and no credentials: each test sets process.env itself and restores
// it afterwards.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSupabaseKeys, adminKey } from '../lib/supabase-keys.mjs';
import {
  supabaseUrl, publicKey, supabasePrivilege, isSupabaseConfigured,
} from '../lib/supabase.mjs';

const KEYS = [
  'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
];

let saved;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// Shapes only — these are not real keys and authenticate against nothing.
const SECRET = 'sb_secret_' + 'A'.repeat(24);
const PUBLISHABLE = 'sb_publishable_' + 'B'.repeat(24);
const LEGACY_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'C'.repeat(40) + '.' + 'D'.repeat(40);

describe('key precedence — one resolver, no drift', () => {
  test('isSupabaseConfigured() and supabasePrivilege() always agree', () => {
    // The regression: these disagreed when only the new-style secret key was
    // set, because the second copy of the chain never listed it.
    const cases = [
      {},
      { SUPABASE_SECRET_KEY: SECRET },
      { SUPABASE_SERVICE_ROLE_KEY: LEGACY_JWT },
      { SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE },
      { SUPABASE_ANON_KEY: LEGACY_JWT },
      { NEXT_PUBLIC_SUPABASE_ANON_KEY: LEGACY_JWT },
      { SUPABASE_SECRET_KEY: SECRET, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE },
    ];
    for (const env of cases) {
      for (const k of KEYS) delete process.env[k];
      process.env.SUPABASE_URL = 'https://ref.supabase.co';
      Object.assign(process.env, env);
      const configured = isSupabaseConfigured();
      const priv = supabasePrivilege();
      assert.equal(configured, priv.level !== 'none',
        `disagreement for ${JSON.stringify(Object.keys(env))}`);
    }
  });

  test('no URL means not configured, whatever keys are set', () => {
    process.env.SUPABASE_SECRET_KEY = SECRET;
    assert.equal(isSupabaseConfigured(), false);
    assert.equal(supabaseUrl(), '');
  });

  test('NEXT_PUBLIC_ aliases are accepted for the URL', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://ref.supabase.co';
    process.env.SUPABASE_ANON_KEY = LEGACY_JWT;
    assert.equal(supabaseUrl(), 'https://ref.supabase.co');
    assert.equal(isSupabaseConfigured(), true);
  });
});

describe('privilege separation', () => {
  beforeEach(() => { process.env.SUPABASE_URL = 'https://ref.supabase.co'; });

  test('a secret key grants admin and marks the deployment writable', () => {
    process.env.SUPABASE_SECRET_KEY = SECRET;
    const p = supabasePrivilege();
    assert.equal(p.level, 'admin');
    assert.equal(p.writable, true);
    assert.equal(p.format, 'secret');
  });

  test('a publishable key alone is NOT writable', () => {
    // The failure this guards: reads succeed, writes are refused by RLS, and
    // the site looks healthy while nothing it records is saved. Verified
    // against production — the publishable key gets 42501 on INSERT.
    process.env.SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE;
    const p = supabasePrivilege();
    assert.equal(p.level, 'public');
    assert.equal(p.writable, false, 'a public key must never be reported writable');
    assert.equal(p.format, 'publishable');
  });

  test('publicKey() never returns the secret key', () => {
    // If this ever regressed, the "browser-safe" key would be an admin key.
    process.env.SUPABASE_SECRET_KEY = SECRET;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
    assert.equal(publicKey(), '', 'a secret key must not be offered as the public key');
    process.env.SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE;
    assert.equal(publicKey(), PUBLISHABLE);
    assert.notEqual(publicKey(), SECRET);
  });

  test('the legacy JWT is recognised and flagged as legacy', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_JWT;
    const p = supabasePrivilege();
    assert.equal(p.level, 'admin');
    assert.equal(p.format, 'legacy-jwt');
  });

  test('nothing configured reports level none and not writable', () => {
    const p = supabasePrivilege();
    assert.equal(p.level, 'none');
    assert.equal(p.writable, false);
  });
});

describe('normalizeSupabaseKeys — mirroring without breaking the CLI tools', () => {
  test('the new secret key is mirrored onto the legacy name', () => {
    // Ten CLI tools read SUPABASE_SERVICE_ROLE_KEY by name. Pasting a new key
    // into the other slot must not silently break every one of them.
    process.env.SUPABASE_SECRET_KEY = SECRET;
    const info = normalizeSupabaseKeys();
    assert.equal(info.source, 'SUPABASE_SECRET_KEY');
    assert.equal(info.format, 'secret');
    assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY, SECRET);
  });

  test('the secret key wins when both slots are filled', () => {
    process.env.SUPABASE_SECRET_KEY = SECRET;
    process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_JWT;
    const info = normalizeSupabaseKeys();
    assert.equal(info.bothSet, true);
    assert.equal(info.format, 'secret');
    assert.equal(adminKey(), SECRET, 'migrating TO the secret key must take effect immediately');
  });

  test('placeholders never shadow a real key', () => {
    // .env ships with empty/dummy slots and .env.example carries obvious ones.
    // If a placeholder counted as "set", a host-provided real key would be
    // ignored and the deployment would silently lose write access.
    for (const dummy of ['your-service-role-key', 'sb_secret_your-secret-key',
                         '<paste-here>', 'change-me', '   ']) {
      delete process.env.SUPABASE_SECRET_KEY;
      process.env.SUPABASE_SERVICE_ROLE_KEY = dummy;
      assert.equal(adminKey(), '', `"${dummy}" must be treated as unset`);
      assert.equal(normalizeSupabaseKeys().present, false);
    }
  });

  test('is idempotent — a second call reports no conflict the first one created', () => {
    // Regression: this function MIRRORS the winning key onto both env names, so
    // after one call both names are always populated. bothSet used to be
    // `secret && legacy`, which made the second call report a conflict that only
    // the first call had manufactured — and server.js logs "both slots set, the
    // new secret key wins" off that flag. An operator who set exactly one key
    // was told they had set two.
    process.env.SUPABASE_SECRET_KEY = SECRET;
    const a = normalizeSupabaseKeys();
    const b = normalizeSupabaseKeys();
    assert.deepEqual(a, b, 'repeat calls must agree');
    assert.equal(a.bothSet, false, 'one key set is not a conflict');
    assert.equal(adminKey(), SECRET);
  });

  test('bothSet means a real conflict, not merely two populated names', () => {
    process.env.SUPABASE_SECRET_KEY = SECRET;
    process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_JWT;
    assert.equal(normalizeSupabaseKeys().bothSet, true, 'two different keys is a conflict');
  });
});
