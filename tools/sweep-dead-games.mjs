// tools/sweep-dead-games.mjs
//
// Full-catalog liveness sweep. Probes EVERY served game's embed URL and flags
// the ones that are DEFINITIVELY dead, then (with --apply) marks is_working=false
// in Supabase so they drop out of games_public.
//
// "Definitively dead" is deliberately conservative to avoid nuking working games
// on a flaky network / anti-bot block:
//   - HTTP 404 / 410
//   - GameDistribution "Not found at origin!" body (49-byte sentinel, HTTP 200)
//   - GameMonetize invalid-id marketing placeholder (404, already covered)
// A 401/403/429/timeout/5xx is INCONCLUSIVE (anti-bot / transient) → kept alive.
//
// Skips hosts already blocked at serve time (htmlgames/gamezop/onlinegames/s3) —
// no point probing games users never see.
//
//   node tools/sweep-dead-games.mjs            # dry run: report only
//   node tools/sweep-dead-games.mjs --apply    # mark dead rows is_working=false
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env');
// adminKey() accepts the new `sb_secret_…` key as well as the legacy JWT, so a
// key migration doesn't silently break this tool. Fail loudly if neither is set:
// createClient(url, undefined) would otherwise construct a broken client and the
// first query would fail with a confusing "Invalid API key" instead.
const { adminKey } = await import('../lib/supabase-keys.mjs');
const SB_URL = process.env.SUPABASE_URL, SB_KEY = adminKey();
if (!SB_URL || !SB_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) in .env');
  process.exit(1);
}
const APPLY = process.argv.includes('--apply');
const CONCURRENCY = 24;
const TIMEOUT_MS = 5000;
const supa = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

// Hosts already hidden by data/catalog-overrides.json — skip probing them.
const SKIP_HOSTS = ['htmlgames.com', 'play.gamezop.com', 'onlinegames.io', 'unblocked-games.s3.amazonaws.com'];

function browserHeaders(url) {
  let origin = ''; try { origin = new URL(url).origin + '/'; } catch {}
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': origin, 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site',
  };
}

// Returns { dead:boolean, reason:string } — only true when DEFINITIVELY gone.
async function probe(url) {
  const isGD = /(^|\.)gamedistribution\.com/i.test(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // GameDistribution returns HTTP 200 with a tiny "Not found at origin!" body
    // for dead hashes, so it needs a GET+body check; everyone else: HEAD status.
    const method = isGD ? 'GET' : 'HEAD';
    let r = await fetch(url, { method, signal: ctrl.signal, redirect: 'follow', headers: browserHeaders(url) });
    if (!isGD && [401, 403, 405, 429, 501].includes(r.status)) {
      r = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'follow', headers: browserHeaders(url) });
    }
    if (r.status === 404 || r.status === 410) return { dead: true, reason: 'http-' + r.status };
    if (isGD && r.status >= 200 && r.status < 300) {
      const body = (await r.text()).slice(0, 400);
      if (/not found at origin/i.test(body)) return { dead: true, reason: 'gd-not-found' };
    }
    return { dead: false, reason: 'ok-' + r.status };
  } catch (e) {
    return { dead: false, reason: e.name === 'AbortError' ? 'timeout' : 'neterr' }; // inconclusive → keep
  } finally { clearTimeout(t); }
}

async function fetchAll() {
  const rows = []; let from = 0;
  while (true) {
    const { data, error } = await supa.from('games').select('id, slug, title, game_url')
      .eq('is_working', true).order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data.length) break;
    rows.push(...data); from += 1000;
    if (data.length < 1000) break;
  }
  return rows;
}

const all = await fetchAll();
const targets = all.filter(g => { const u = (g.game_url || '').toLowerCase(); return u && !SKIP_HOSTS.some(h => u.includes(h)); });
console.log(`[sweep] ${all.length} working games; probing ${targets.length} (skipped ${all.length - targets.length} on already-blocked hosts). apply=${APPLY}`);

let checked = 0, dead = 0; const deadList = []; const reasons = {};
const queue = targets.slice();
async function worker() {
  while (queue.length) {
    const g = queue.shift();
    const res = await probe(g.game_url);
    checked++;
    reasons[res.reason] = (reasons[res.reason] || 0) + 1;
    if (res.dead) { dead++; deadList.push({ ...g, reason: res.reason }); }
    if (checked % 500 === 0) console.log(`[sweep]   ${checked}/${targets.length} checked, ${dead} dead so far`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`\n[sweep] DONE. checked=${checked} dead=${dead}`);
console.log('[sweep] reason tally:', JSON.stringify(reasons));
writeFileSync('sweep-dead.json', JSON.stringify(deadList, null, 2));
console.log(`[sweep] dead list written to sweep-dead.json (${deadList.length})`);
console.log('[sweep] sample dead:', deadList.slice(0, 15).map(g => g.slug + '(' + g.reason + ')').join(', '));

if (APPLY && deadList.length) {
  let done = 0;
  for (let i = 0; i < deadList.length; i += 200) {
    const ids = deadList.slice(i, i + 200).map(g => g.id);
    const { error } = await supa.from('games').update({ is_working: false, last_checked: new Date().toISOString() }).in('id', ids);
    if (error) console.warn('[sweep] update batch failed:', error.message); else done += ids.length;
  }
  console.log(`[sweep] APPLIED: marked ${done} games is_working=false.`);
} else if (deadList.length) {
  console.log('[sweep] dry run — nothing written. Re-run with --apply to mark these dead.');
}
process.exit(0);
