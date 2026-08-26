// tools/verify-catalog.mjs — does every served game actually load?
//
//   npm run verify-catalog                 sample 120 per host (safe default)
//   npm run verify-catalog -- --all        probe every served game
//   npm run verify-catalog -- --sample 400 bigger sample per host
//   npm run verify-catalog -- --live       read the catalog from Supabase
//   npm run verify-catalog -- --json out.json
//
// WHY THIS EXISTS SEPARATELY FROM link-checker.mjs
// The cron link-checker answers one question — did the URL 404? — and writes
// is_working back to Supabase. That is necessary and not sufficient: a game can
// return a clean HTTP 200 and still be a black rectangle for every visitor,
// because the response says it may not be framed. GameFlare did exactly that
// (200 for a browser, 403 + SAMEORIGIN for an iframe) and 108 games rendered
// blank while the link checker reported them healthy.
//
// So this probes the four things that independently produce a broken game:
//   1. status      — after redirects, is it there at all?
//   2. framing     — X-Frame-Options / CSP frame-ancestors. The #1 black-screen.
//   3. content     — HTML, or did the CDN hand back JSON/an image/a download?
//   4. soft-404    — 200 OK whose body is a "not found" or parked-domain shell.
//
// It writes NOTHING. Diagnosis and mutation are kept apart on purpose: a
// verifier that edits the catalog cannot be run casually, and this one should
// be runnable any time.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyCatalogOverrides } from '../lib/catalog-overrides.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const TIMEOUT_MS = 8000;   // generous: a slow CDN is not a broken game
const PARALLEL = 10;       // per-run ceiling; also see PER_HOST_GAP
const PER_HOST_GAP = 60;   // ms between requests to the SAME host — these are
                           // other people's servers, not a load-test target
const BODY_BYTES = 4096;   // enough to recognise a soft-404 shell

// Browser-shaped headers. Several publisher CDNs 403 a bare datacenter GET but
// serve a real iframe navigation fine, so probing without these invents
// failures that no visitor would ever see.
function browserHeaders(url) {
  let origin = '';
  try { origin = new URL(url).origin + '/'; } catch { /* relative url */ }
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': origin,
    'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site',
  };
}

/**
 * Would this response render inside our iframe?
 *
 * X-Frame-Options DENY/SAMEORIGIN is absolute for a cross-origin frame.
 * CSP frame-ancestors is subtler: 'none' blocks everyone, and an allowlist
 * blocks us unless it names a wildcard. We cannot know the deploy hostname
 * here, so an allowlist is reported as a WARNING rather than a failure —
 * calling it broken would flag every publisher who legitimately allowlists
 * their own partners.
 */
export function framingVerdict(headers) {
  const xfo = String(headers.get('x-frame-options') || '').toLowerCase();
  if (/\b(deny|sameorigin)\b/.test(xfo)) return { ok: false, why: `x-frame-options: ${xfo.trim()}` };

  const csp = String(headers.get('content-security-policy') || '');
  const m = /frame-ancestors([^;]*)/i.exec(csp);
  if (m) {
    const value = m[1].trim().toLowerCase();
    if (/\bnone\b/.test(value)) return { ok: false, why: 'csp frame-ancestors none' };
    if (!/\*/.test(value)) return { ok: true, warn: `csp frame-ancestors allowlist: ${value.slice(0, 60)}` };
  }
  return { ok: true };
}

// A 200 that is really a "nothing here" page. Deliberately narrow: matching on
// the word "error" alone would flag any game with an error handler in its
// bootstrap HTML.
const SOFT_404 = [
  /not\s+found\s+at\s+origin/i,
  /<title>\s*(404|not found|page not found|error)\s*<\/title>/i,
  /this domain (is for sale|has expired)/i,
  /\bdomain (parking|for sale)\b/i,
  /access denied/i,
  /internet allowance is over/i,   // HTMLGames' unlicensed-domain message
];

export function bodyVerdict(text) {
  if (!text || !text.trim()) return { ok: false, why: 'empty body' };
  for (const re of SOFT_404) if (re.test(text)) return { ok: false, why: `soft-404: ${re.source.slice(0, 34)}` };
  return { ok: true };
}

async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: browserHeaders(url) });

    const out = { status: r.status, finalUrl: r.url, issues: [], warns: [] };
    if (r.status >= 400) out.issues.push(`http ${r.status}`);

    const frame = framingVerdict(r.headers);
    if (!frame.ok) out.issues.push(frame.why);
    if (frame.warn) out.warns.push(frame.warn);

    const ct = String(r.headers.get('content-type') || '').toLowerCase();
    out.contentType = ct.split(';')[0];
    if (r.status < 400 && ct && !/html|xml/.test(ct)) out.issues.push(`content-type ${out.contentType}`);

    // Read only the head of the body — enough to spot a placeholder page, and
    // it means we never pull a 40 MB Unity payload just to check a header.
    if (r.status < 400 && /html/.test(ct)) {
      let text = '';
      try {
        const reader = r.body?.getReader();
        if (reader) {
          const dec = new TextDecoder();
          while (text.length < BODY_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            text += dec.decode(value, { stream: true });
          }
          await reader.cancel().catch(() => {});
        }
      } catch { /* stream died; treat as no body evidence */ }
      const body = bodyVerdict(text);
      if (!body.ok) out.issues.push(body.why);
    } else {
      try { await r.body?.cancel(); } catch { /* already closed */ }
    }
    return out;
  } catch (e) {
    return { status: 0, warns: [], issues: [e.name === 'AbortError' ? `timeout over ${TIMEOUT_MS}ms` : `network: ${e.message.slice(0, 50)}`] };
  } finally {
    clearTimeout(timer);
  }
}

const hostOf = (u) => { try { return new URL(String(u)).host.toLowerCase(); } catch { return '(unparseable)'; } };
const urlOf = (g) => g.game_url || g.embed_url || g.url || '';

async function loadCatalog({ live }) {
  if (live) {
    const p = join(ROOT, '.env');
    if (existsSync(p) && typeof process.loadEnvFile === 'function') { try { process.loadEnvFile(p); } catch { /* optional */ } }
    const { adminKey } = await import(pathToFileURL(join(ROOT, 'lib', 'supabase-keys.mjs')).href);
    const url = process.env.SUPABASE_URL, key = adminKey();
    if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY not set — drop --live to use the export.');
    const { createClient } = await import('@supabase/supabase-js');
    const supa = createClient(url, key, { auth: { persistSession: false } });
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supa.from('games')
        .select('slug, title, game_url, thumbnail_url, category, is_working').range(from, from + 999);
      if (error) throw new Error(error.message);
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return out.filter(g => g.is_working !== false);
  }
  const p = join(ROOT, 'data', 'games-export.json');
  if (!existsSync(p)) throw new Error('data/games-export.json not found. Run: npm run export-games (or pass --live)');
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** Deterministic stratified pick, so two runs compare like for like. */
export function pickSample(games, perHost) {
  const byHost = new Map();
  for (const g of games) {
    const h = hostOf(urlOf(g));
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(g);
  }
  const picked = [];
  for (const [, list] of byHost) {
    if (list.length <= perHost) { picked.push(...list); continue; }
    // Even stride across the host's games rather than the first N — the first
    // N share an ingest batch, and an ingest batch fails or succeeds together.
    const stride = list.length / perHost;
    for (let i = 0; i < perHost; i++) picked.push(list[Math.floor(i * stride)]);
  }
  return picked;
}

async function runPool(items, worker, { parallel }) {
  const results = new Array(items.length);
  let next = 0;
  const lastHitByHost = new Map();
  async function lane() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const g = items[i];
      const h = hostOf(urlOf(g));
      // Space out same-host requests. Politeness, and it also stops a single
      // rate-limited host from producing a wall of fake failures.
      const since = Date.now() - (lastHitByHost.get(h) || 0);
      if (since < PER_HOST_GAP) await new Promise(r => setTimeout(r, PER_HOST_GAP - since));
      lastHitByHost.set(h, Date.now());
      results[i] = await worker(g);
      if ((i + 1) % 100 === 0) process.stderr.write(`  ...${i + 1}/${items.length}\r`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, lane));
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

  const live = has('--live');
  const all = has('--all');
  const perHost = Number(val('--sample', '120'));
  const jsonOut = val('--json', '');

  let catalog;
  try { catalog = await loadCatalog({ live }); }
  catch (e) { console.error('x ' + e.message); process.exit(1); }

  const served = applyCatalogOverrides(catalog.map(g => ({ ...g })));
  const targets = all ? served : pickSample(served, perHost);

  console.log('-------- CATALOG VERIFICATION --------');
  console.log(`source............ ${live ? 'live Supabase' : 'data/games-export.json'}`);
  console.log(`served games...... ${served.length}`);
  console.log(`probing........... ${targets.length}${all ? ' (every game)' : ` (up to ${perHost} per host)`}`);
  console.log(`concurrency....... ${PARALLEL}, ${TIMEOUT_MS}ms timeout, ${PER_HOST_GAP}ms per-host gap\n`);

  const started = Date.now();
  const results = await runPool(targets, async (g) => ({ game: g, host: hostOf(urlOf(g)), url: urlOf(g), ...(await probe(urlOf(g))) }), { parallel: PARALLEL });
  process.stderr.write('                              \r');

  const byHost = new Map();
  for (const r of results) {
    if (!byHost.has(r.host)) byHost.set(r.host, { total: 0, bad: 0, warn: 0, reasons: new Map(), examples: [] });
    const h = byHost.get(r.host);
    h.total++;
    if (r.issues.length) {
      h.bad++;
      for (const why of r.issues) h.reasons.set(why, (h.reasons.get(why) || 0) + 1);
      if (h.examples.length < 3) h.examples.push(`${r.game.slug} -> ${r.issues.join('; ')}`);
    }
    if (r.warns.length) h.warn++;
  }

  console.log('host                                probed   bad   warn   health');
  console.log('-'.repeat(70));
  let totalBad = 0;
  for (const [host, h] of [...byHost].sort((a, b) => b[1].total - a[1].total)) {
    totalBad += h.bad;
    const health = h.total ? ((h.total - h.bad) / h.total * 100).toFixed(1) : '0.0';
    const flag = h.bad === 0 ? '  ok' : (h.bad / h.total > 0.2 ? ' ***' : '  ! ');
    console.log(`${host.padEnd(34)} ${String(h.total).padStart(6)} ${String(h.bad).padStart(5)} ${String(h.warn).padStart(6)}  ${health.padStart(5)}%${flag}`);
  }
  console.log('-'.repeat(70));
  console.log(`TOTAL ${results.length} probed - ${totalBad} with problems - ${(100 - totalBad / results.length * 100).toFixed(2)}% healthy - ${((Date.now() - started) / 1000).toFixed(0)}s\n`);

  for (const [host, h] of [...byHost].sort((a, b) => b[1].bad - a[1].bad)) {
    if (!h.bad) continue;
    console.log(`${host} — ${h.bad}/${h.total} failing`);
    for (const [why, n] of [...h.reasons].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)} x ${why}`);
    for (const e of h.examples) console.log(`         e.g. ${e}`);
    console.log('');
  }

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({
      at: new Date().toISOString(), served: served.length, probed: results.length, bad: totalBad,
      failures: results.filter(r => r.issues.length).map(r => ({ slug: r.game.slug, url: r.url, status: r.status, issues: r.issues })),
    }, null, 2));
    console.log(`wrote ${jsonOut}`);
  }

  // Exit 1 only on a SYSTEMIC failure — a whole host down. Scattered dead games
  // are normal catalog decay the cron link-checker already handles, and failing
  // CI on those would make the check something people learn to ignore.
  const systemic = [...byHost].filter(([, h]) => h.total >= 10 && h.bad / h.total > 0.2);
  if (systemic.length) {
    console.log(`x SYSTEMIC: ${systemic.map(([h]) => h).join(', ')} — over 20% of probes failing.`);
    process.exit(1);
  }
  console.log('ok - no host is systemically broken.');
}
