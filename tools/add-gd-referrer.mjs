// tools/add-gd-referrer.mjs
//
// One-shot maintenance script: append `?gd_sdk_referrer_url=...` to every
// GameDistribution URL (html5.gamedistribution.com/<hash>/) in the source
// catalogs that doesn't already have one.
//
// Why a real URL value instead of the literal `{YOUR_SITE_URL}` template:
//   GameDistribution's SDK parses the value as a URL.  A curly-braced
//   placeholder fails parsing and the SDK silently falls back to no
//   attribution — same as if we omitted the param entirely.  Using a
//   real URL (https://zofhub.com/) gives their analytics a valid value.
//
// Why the runtime injector in server.js still matters:
//   The static value here is fine for analytics, but the LIVE referrer
//   should match the request's actual host (localhost in dev, real
//   domain in prod).  /play/:slug rewrites the param at render time, so
//   the value below is effectively a fallback.
//
// Idempotent: re-running this won't add the param twice.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const FILES = [
  'ai_gaming_hub_final.json',
  'api/games.json',
  'data/top_games.json',
  'somethingrandom.json',
  'master_games.json',
  'everygame.json',
];

const REFERRER_DEFAULT = 'https://zofhub.com/';
const GD_URL_RE = /^https?:\/\/html5\.gamedistribution\.com\//i;
const URL_FIELDS = ['embed_url', 'embedUrl', 'embed', 'url', 'link', 'game_url', 'iframe', 'iframeUrl', 'gameUrl'];

function rewriteIfGd(value) {
  if (typeof value !== 'string' || !GD_URL_RE.test(value)) {
    return { value, touched: false, alreadyHadParam: false };
  }
  try {
    const u = new URL(value);
    if (u.searchParams.has('gd_sdk_referrer_url')) {
      return { value, touched: false, alreadyHadParam: true };
    }
    u.searchParams.set('gd_sdk_referrer_url', REFERRER_DEFAULT);
    return { value: u.toString(), touched: true, alreadyHadParam: false };
  } catch {
    return { value, touched: false, alreadyHadParam: false };
  }
}

function processEntries(arr) {
  let gdTotal = 0, modified = 0, alreadyHad = 0;
  for (const g of arr) {
    if (!g || typeof g !== 'object') continue;
    for (const k of URL_FIELDS) {
      if (!g[k]) continue;
      if (!GD_URL_RE.test(g[k])) continue;
      gdTotal++;
      const { value, touched, alreadyHadParam } = rewriteIfGd(g[k]);
      if (touched)        { g[k] = value; modified++; }
      if (alreadyHadParam) { alreadyHad++; }
      // Only one URL field per entry — break out so we don't double-count.
      break;
    }
  }
  return { gdTotal, modified, alreadyHad };
}

let grandTotal = 0, grandModified = 0;
for (const f of FILES) {
  const full = join(ROOT, f);
  if (!existsSync(full)) {
    console.log(`[skip] ${f}: not found`);
    continue;
  }
  try {
    const raw = await readFile(full, 'utf8');
    const data = JSON.parse(raw);
    const arr = Array.isArray(data) ? data : (data.games || data.data || []);
    if (!Array.isArray(arr) || arr.length === 0) {
      console.log(`[${f}] no games array — skipping`);
      continue;
    }
    const { gdTotal, modified, alreadyHad } = processEntries(arr);
    grandTotal    += gdTotal;
    grandModified += modified;

    if (modified > 0) {
      await writeFile(full, JSON.stringify(data, null, 2) + '\n');
      console.log(`[${f}] GD URLs=${gdTotal}, +param=${modified}, had-param=${alreadyHad} ✓ written`);
    } else {
      console.log(`[${f}] GD URLs=${gdTotal}, had-param=${alreadyHad}, +param=0 (no changes)`);
    }
  } catch (e) {
    console.error(`[${f}] ERROR:`, e.message);
  }
}

console.log(`\nDone. Total GD URLs processed: ${grandTotal}.  URLs modified: ${grandModified}.`);
