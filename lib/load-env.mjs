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
