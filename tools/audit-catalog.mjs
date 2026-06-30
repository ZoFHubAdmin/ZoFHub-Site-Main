// tools/audit-catalog.mjs
// ---------------------------------------------------------------------------
// FULL-CATALOG audit: scans EVERY game and reports
//   • broken embeds        — game_url that is missing/malformed or returns 4xx/5xx
//   • inconclusive         — timeout / DNS / network blip (NOT removed — could be a hiccup)
//   • needs-proxy          — loads (200) but blocks iframes (X-Frame-Options / CSP);
//                            playable via ZoFHub's /embed proxy, so NOT broken
//   • missing thumbnail    — no thumbnail_url (or the default placeholder)
//   • broken thumbnail     — thumbnail_url that doesn't return an image (with --thumbs)
//   • duplicates           — same slug or same game_url
//
// It writes a full report to data/audit-report.json and prints a summary.
//
// MODES
//   --from-export   OFFLINE structural pass only (reads data/games-export.json,
//                   no network, no Supabase). Good for a quick first look.
//   (default)       LIVE sweep against Supabase: probes every game_url. DRY by
//                   default — reports only, changes nothing.
//   --apply         after probing, SOFT-REMOVE broken games (is_working=false).
//                   They vanish from the site immediately (games_public filters
//                   is_working=true) and it's reversible.
//   --delete        HARD-DELETE broken games from the table (permanent).
//   --thumbs        also HTTP-probe every thumbnail_url (doubles the requests).
//   --concurrency N parallel probes (default 24).
//
// Broken = definitive only (missing/malformed URL, or a real 4xx/5xx). Timeouts
// are reported but never removed, matching the cautious cron policy.
//
//   First look (no network):  npm run audit -- --from-export
//   Live preview:             npm run audit
//   Apply (hide broken):      npm run audit -- --apply --thumbs
//   Permanent delete:         npm run audit -- --delete --thumbs
// ---------------------------------------------------------------------------
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const f of ['.env', '.env.example']) {
  const p = join(root, f);
  if (existsSync(p) && typeof process.loadEnvFile === 'function') { try { process.loadEnvFile(p); } catch {} break; }
}

const args = process.argv.slice(2);
const FROM_EXPORT = args.includes('--from-export');
const APPLY = args.includes('--apply');
const DELETE = args.includes('--delete');
const THUMBS = args.includes('--thumbs');
const PURGE_FLAGGED = args.includes('--purge-flagged'); // remove rows already is_working=false
const DEDUPE = args.includes('--dedupe');               // remove duplicate game_url rows (keep lowest id)
const NO_PROBE = args.includes('--no-probe');           // skip the network sweep (fast cleanup only)
const REVIVE = args.includes('--revive');               // re-enable is_working=false games that load again
const CONC = Math.max(1, parseInt((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1]) ||
  (args.includes('--concurrency') ? parseInt(args[args.indexOf('--concurrency') + 1]) : 0) || 24);
const WRITE = (APPLY || DELETE) && !FROM_EXPORT;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const reportPath = join(root, 'data', 'audit-report.json');

const isHttp = u => /^https?:\/\//i.test(String(u || ''));
const isPlaceholderThumb = u => !u || !String(u).trim() || /default-placeholder/i.test(u);
function hostOf(u) { try { return new URL(u).host.toLowerCase(); } catch { return '(invalid)'; } }

// ── Load every row (export file or Supabase, paged) ────────────────────────
let games = [];
let supabase = null;
if (FROM_EXPORT) {
  const p = join(root, 'data', 'games-export.json');
  if (!existsSync(p)) { console.error('✗ data/games-export.json not found. Run: npm run export-games'); process.exit(1); }
  games = JSON.parse(readFileSync(p, 'utf8'));
  console.log(`Loaded ${games.length} rows from games-export.json (offline structural pass).\n`);
} else {
  const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SB_KEY) { console.error('✗ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env (or use --from-export)'); process.exit(1); }
  const { createClient } = await import('@supabase/supabase-js');
  supabase = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('games')
      .select('id, slug, title, game_url, thumbnail_url, category, is_working').range(from, from + 999);
    if (error) { console.error('✗ Supabase read error:', error.message); process.exit(1); }
    games.push(...(data || []));
    process.stdout.write(`  loaded ${games.length}\r`);
    if (!data || data.length < 1000) break;
  }
  console.log(`Loaded ${games.length} rows from Supabase.\n`);
}

// ── Structural checks (no network) ─────────────────────────────────────────
const report = {
  generatedAt: new Date().toISOString(),
  total: games.length,
  badUrl: [], dead: [], blocked: [], inconclusive: [], needsProxy: [], revivable: [], ok: 0,
  missingThumb: [], brokenThumb: [],
  flaggedNotWorking: [], duplicateSlugs: [], duplicateUrls: [],
  hostHistogram: {},
};

const bySlug = new Map(), byUrl = new Map();
for (const g of games) {
  if (g.is_working === false) report.flaggedNotWorking.push(slim(g));
  if (isPlaceholderThumb(g.thumbnail_url)) report.missingThumb.push(slim(g));
  const s = (g.slug || '').toLowerCase(); if (s) bySlug.set(s, (bySlug.get(s) || 0) + 1);
  const u = (g.game_url || '').trim(); if (u) byUrl.set(u, (byUrl.get(u) || 0) + 1);
  report.hostHistogram[hostOf(g.game_url)] = (report.hostHistogram[hostOf(g.game_url)] || 0) + 1;
}
for (const [s, n] of bySlug) if (n > 1) report.duplicateSlugs.push({ slug: s, count: n });
for (const [u, n] of byUrl) if (n > 1) report.duplicateUrls.push({ game_url: u, count: n });

// Dedupe set: for each duplicate game_url keep the LOWEST id, mark the rest.
report.dedupeRemovable = [];
{
  const groups = new Map();
  for (const g of games) { const u = (g.game_url || '').trim(); if (!u) continue; if (!groups.has(u)) groups.set(u, []); groups.get(u).push(g); }
  for (const grp of groups.values()) {
    if (grp.length < 2) continue;
    grp.sort((a, b) => (a.id || 0) - (b.id || 0));
    for (const g of grp.slice(1)) report.dedupeRemovable.push(slim(g));
  }
}

function slim(g) { return { id: g.id, slug: g.slug, title: g.title, game_url: g.game_url, thumbnail_url: g.thumbnail_url ?? null }; }

// ── Live probing ───────────────────────────────────────────────────────────
function bHeaders(url) {
  let origin = '';
  try { origin = new URL(url).origin + '/'; } catch {}
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': origin,
    'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site',
  };
}
async function probe(url, timeoutMs = 6000) {
  const once = async (method) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method, redirect: 'follow', signal: ctrl.signal, headers: bHeaders(url) });
      return { status: r.status, xfo: (r.headers.get('x-frame-options') || '').toLowerCase(), csp: (r.headers.get('content-security-policy') || '').toLowerCase() };
    } finally { clearTimeout(t); }
  };
  try {
    let r = await once('HEAD');
    if ([401, 403, 405, 429, 501].includes(r.status)) r = await once('GET'); // host may block HEAD / bots
    return { ok: r.status >= 200 && r.status < 400, status: r.status, xfo: r.xfo, csp: r.csp };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}
async function pool(items, n, worker) {
  const q = items.slice(); let done = 0;
  const runners = Array.from({ length: n }, async () => {
    while (q.length) {
      const it = q.shift();
      if (it !== undefined) { await worker(it); if (++done % 500 === 0) process.stdout.write(`  probed ${done}/${items.length}\r`); }
    }
  });
  await Promise.all(runners);
}

if (!FROM_EXPORT && !NO_PROBE) {
  console.log(`Probing ${games.length} game URLs (concurrency=${CONC}, timeout=6s)…`);
  await pool(games, CONC, async (g) => {
    if (!isHttp(g.game_url)) { report.badUrl.push(slim(g)); return; }
    const r = await probe(g.game_url);
    if (r.ok) {
      report.ok++;
      if (g.is_working === false) report.revivable.push(slim(g)); // was flagged dead but loads now
      if ((r.xfo && /deny|sameorigin/.test(r.xfo)) || /frame-ancestors/.test(r.csp || '')) report.needsProxy.push(slim(g));
    } else if (r.status === 404 || r.status === 410) {
      report.dead.push({ ...slim(g), status: r.status });               // genuinely gone — removable
    } else if ([401, 403, 429, 451].includes(r.status)) {
      report.blocked.push({ ...slim(g), status: r.status });            // host blocked us — NOT dead
    } else {
      report.inconclusive.push({ ...slim(g), error: r.error || ('http-' + r.status) }); // 5xx / timeout
    }
  });
  process.stdout.write('\n');

  if (THUMBS) {
    const withThumb = games.filter(g => isHttp(g.thumbnail_url));
    console.log(`Probing ${withThumb.length} thumbnails…`);
    await pool(withThumb, CONC, async (g) => {
      const r = await probe(g.thumbnail_url, 5000);
      if (!r.ok) report.brokenThumb.push({ ...slim(g), status: r.status });
    });
    process.stdout.write('\n');
  }
}

// removal set = definitive broken (+ optional dedupe / purge-flagged)
const removableIds = new Set([...report.badUrl, ...report.dead].map(g => g.id));
if (DEDUPE) for (const g of report.dedupeRemovable) removableIds.add(g.id);
if (PURGE_FLAGGED) for (const g of report.flaggedNotWorking) removableIds.add(g.id);
const removable = [...removableIds];

// ── Apply / delete ─────────────────────────────────────────────────────────
if (WRITE && removable.length) {
  const ids = removable;
  const verb = DELETE ? 'DELETE' : 'SOFT-REMOVE (is_working=false)';
  console.log(`\n${verb} ${ids.length} broken games…`);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const q = DELETE
      ? supabase.from('games').delete().in('id', chunk)
      : supabase.from('games').update({ is_working: false, last_checked: new Date().toISOString() }).in('id', chunk);
    const { error } = await q;
    if (error) console.warn('  write error:', error.message);
  }
  console.log('  done. Restart the server (npm run restart) to clear the catalog cache.');
}

// ── Revive: re-enable games that were flagged is_working=false but load again ─
const writeRevive = REVIVE && !FROM_EXPORT;
if (writeRevive && report.revivable.length) {
  const ids = report.revivable.map(g => g.id);
  console.log(`\nREVIVE ${ids.length} games that load again (is_working=true)…`);
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await supabase.from('games')
      .update({ is_working: true, last_checked: new Date().toISOString() }).in('id', ids.slice(i, i + 200));
    if (error) console.warn('  revive error:', error.message);
  }
  console.log('  done. Restart the server (npm run restart) to clear the catalog cache.');
}

// ── Output ─────────────────────────────────────────────────────────────────
writeFileSync(reportPath, JSON.stringify(report, null, 2));
const topHosts = Object.entries(report.hostHistogram).sort((a, b) => b[1] - a[1]).slice(0, 12);

console.log('\n──────────── AUDIT SUMMARY ────────────');
console.log(`total games............ ${report.total}`);
console.log(`already is_working=false ${report.flaggedNotWorking.length}`);
console.log(`missing thumbnail...... ${report.missingThumb.length}`);
if (!FROM_EXPORT && !NO_PROBE) {
  console.log(`reachable (ok)......... ${report.ok}`);
  console.log(`BROKEN url (malformed). ${report.badUrl.length}`);
  console.log(`DEAD (404/410)......... ${report.dead.length}   (removable)`);
  console.log(`blocked (401/403/429).. ${report.blocked.length}   (NOT removed — host block, plays via /embed)`);
  console.log(`needs proxy (XFO/CSP).. ${report.needsProxy.length}   (NOT removed — plays via /embed)`);
  console.log(`inconclusive (5xx/t.o.) ${report.inconclusive.length}   (NOT removed)`);
  console.log(`revivable (now load)... ${report.revivable.length}${writeRevive ? '  (REVIVED)' : (REVIVE ? '' : '  — add --revive to re-enable')}`);
  if (THUMBS) console.log(`broken thumbnail....... ${report.brokenThumb.length}`);
}
console.log(`duplicate slugs........ ${report.duplicateSlugs.length}`);
console.log(`duplicate game_urls.... ${report.duplicateUrls.length}  (${report.dedupeRemovable.length} redundant${DEDUPE ? '' : ' — use --dedupe'})`);
if (!FROM_EXPORT) console.log(`→ to remove............ ${removable.length}${WRITE ? (DELETE ? '  (DELETED)' : '  (SOFT-REMOVED)') : '  (dry-run — nothing changed)'}`);
console.log('\ntop hosts:');
for (const [h, n] of topHosts) console.log(`  ${String(n).padStart(6)}  ${h}`);
console.log(`\nFull report written to data/audit-report.json`);
if (!WRITE && !FROM_EXPORT) console.log('Re-run with --apply (hide) or --delete (remove) once the list looks right.');
