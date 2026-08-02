// lib/load-env.mjs
// ---------------------------------------------------------------------------
// Side-effect module: load .env (or .env.example as a last-resort fallback)
// into process.env for STANDALONE CLI TOOLS.
//
// The server does this inline at boot (server.js), but a tool run as
// `node tools/whatever.mjs` (i.e. every `npm run …` script) does NOT get it —
// so any tool that reaches Supabase through the lib/ modules (which read
// process.env) would see NOTHING and report "Supabase not configured — skipping"
// even though your .env is perfectly valid.
//
// Fix: import THIS first, before importing anything that reads process.env:
//     import '../lib/load-env.mjs';                 // must be the FIRST import
//     import { runLinkCheck } from '../lib/link-checker.mjs';
//
// Uses Node 20.6+'s built-in process.loadEnvFile — no dependency, same code
// path the server uses, so tools and server read creds identically.
// ---------------------------------------------------------------------------
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSupabaseKeys } from './supabase-keys.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let loaded = false;
for (const f of ['.env', '.env.example']) {
  const p = join(ROOT, f);
  if (existsSync(p) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(p);
      loaded = true;
      if (f === '.env.example') {
        console.warn('[env] no .env found — using .env.example (placeholders only; copy it to .env for real creds).');
      }
      break;
    } catch (e) {
      console.warn(`[env] failed to load ${f}:`, e.message);
    }
  }
}
if (!loaded && typeof process.loadEnvFile !== 'function') {
  console.warn('[env] Node < 20.6 has no process.loadEnvFile — run with `node --env-file=.env` instead.');
}

// Make the admin key readable under BOTH names. Ten tools read
// SUPABASE_SERVICE_ROLE_KEY by name, so pasting a new-style sb_secret_… key
// into SUPABASE_SECRET_KEY would otherwise break every one of them while the
// server kept working — see lib/supabase-keys.mjs.
const keys = normalizeSupabaseKeys();

// This project's legacy `anon`/`service_role` pair has been deactivated in the
// Supabase dashboard: presenting the old key now returns
// 401 {"message":"Legacy API keys are disabled"}.
//
// Without this warning the failure mode is genuinely baffling — the key looks
// present, the config check passes, the client builds fine, and then every query
// fails with an auth error that names nothing. Anyone restoring an old .env, or
// copying a stale value out of git history or another host's dashboard, lands
// straight in it. One line at boot turns a debugging session into a fix.
if (keys.format === 'legacy-jwt') {
  console.warn(
    `[env] ${keys.source} holds a LEGACY JWT (eyJ…). Legacy API keys are disabled on this\n`
    + '      Supabase project, so every query will fail with HTTP 401. Replace it with the\n'
    + '      new-style secret key from Settings → API Keys (sb_secret_…), set as\n'
    + '      SUPABASE_SECRET_KEY.',
  );
}
