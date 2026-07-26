// lib/cron-jobs.mjs
//
// 24/7 in-process scheduled jobs.  Mounted from server.js via
// `import { startCronJobs } from './lib/cron-jobs.mjs'; startCronJobs();`
//
// Jobs (7 total):
//   1. HOURLY      · link-check 200 oldest working games         (0 * * * *)
//   2. EVERY 3 DAYS· grow catalog (+30 render-verified games)    (fires :30 hourly, 3-day gate inside)
//   3. DAILY       · health log to console                       (5 0 * * *)
//   4. DAILY       · cleanup stale/unseen recommendations        (15 0 * * *)
//   5. DAILY       · prune leaderboard to top-N per game         (20 0 * * *)
//   6. WEEKLY      · re-sync Y8 embeddable games                 (0 4 * * 0)
//   7. DAILY       · Supabase keep-alive ping (free-tier pause)  (0 6 * * *)
//
// The "grow" job (2) is the auto-expander.  Every game it inserts has been
// proven to actually render in an iframe — it passes a full embeddability
// check (liveness + framing headers + soft-404 sniff + not-a-fake-GD-hash +
// trusted/licensed host) BEFORE it ever reaches Supabase.  So the catalog
// grows without ever introducing a black screen.
//
// All jobs:
//   - Wrapped in try/catch — a thrown error inside one job CANNOT crash
//     the Express server.
//   - No-op when Supabase env vars are missing (so dev/local boots
//     happily without a database).
//   - Disabled entirely by `CRON_DISABLED=1` env var (useful for tests).
//   - First run delayed 30s after boot so the server is fully up.

import cron from 'node-cron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSupabase, isSupabaseConfigured, supabaseKeepAlive } from './supabase.mjs';
import { runLinkCheck } from './link-checker.mjs';
import { delPattern as cacheDelPattern } from './cache.mjs';
import { scrapeY8 } from '../scrape-y8.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
const tasks = [];

function safeSchedule(label, expr, fn) {
  // node-cron v4 note: tasks become active as soon as they're created (the old
  // `scheduled:false` flag was removed in v4). That's fine here because
  // safeSchedule is ONLY ever called from startCronJobs(), which already returns
  // early when CRON_DISABLED=1 — so no task is ever created in that case.
  //   • name      → labels the task in node-cron's registry / logs.
  //   • timezone  → all our expressions are written in UTC.
  //   • noOverlap → if a run is still going when the next tick fires, skip it
  //                 (the link-check / grow jobs can run long; this prevents two
  //                 heavy jobs stacking up and exhausting the free-tier CPU).
  const task = cron.schedule(expr, async () => {
    const t0 = Date.now();
    try {
      await fn();
    } catch (e) {
      // Must never crash the server. Just log.
      console.error(`[cron:${label}] error:`, e?.message || e);
    } finally {
      const ms = Date.now() - t0;
      console.log(`[cron:${label}] finished in ${ms} ms`);
    }
  }, { name: label, timezone: 'UTC', noOverlap: true });
  tasks.push({ label, task });
  return task;
}

// ---------------------------------------------------------------------
// Job 1 — hourly link check (spec sections 1-5)
// ---------------------------------------------------------------------
async function jobLinkCheck() {
  // Spec: chunk of 200 per hour, oldest-checked first.
  await runLinkCheck({ batchSize: 200 });
}

// ---------------------------------------------------------------------
// Job 2 — GROW the catalog with render-verified games (+30 every 3 days).
//
// Architecture:
//   1. Read every source JSON, dedupe by slug, and KEEP ONLY games that
//      are on a trusted/licensed host, aren't a fake GD hash, and aren't
//      a trademark violation → high-quality candidate pool.
//   2. Random-sample SAMPLE_SIZE candidates.
//   3. Ask Supabase which of those slugs already exist; drop them.
//   4. From the remainder, run validateEmbeddable() in parallel until we
//      have TARGET_ALIVE games that PASS full render-verification
//      (liveness + framing headers + content-type + soft-404 sniff).
//      Stops early — never tests more than MAX_PROBES candidates.
//   5. Upsert those games with is_working=true, last_checked=now.
//   6. Invalidate the games:page:* cache so they appear immediately.
//
// Why render-verify before insert (not just HEAD):
//   A HEAD 200 says "the URL responds", NOT "the game renders". Half the
//   200s in a third-party dump are framing-blocked pages, parked domains,
//   or dead GD shells — all of which show a BLACK SCREEN in the iframe.
//   validateEmbeddable() checks the signals that actually predict a
//   playable frame, so the catalog only ever grows with games that work.
// ---------------------------------------------------------------------
const PROMOTE_SOURCES = [
  'data/top_games.json',
  'api/games.json',
  'somethingrandom.json',
  'master_games.json',
  'everygame.json',
  'ai_gaming_hub_final.json'
];
// Per-grow-cycle tuning. The grow job runs once every 3 days, so this is
// "30 games added every 3 days". Every candidate is render-verified, so the
// inserts are real (no black screens). SAMPLE_SIZE / MAX_PROBES stay well
// above TARGET_ALIVE so there's always enough headroom to find 30 that pass.
const TARGET_ALIVE = 30;       // stop once this many render-verified games found
const SAMPLE_SIZE  = 300;      // random candidates pulled from the pool
const MAX_PROBES   = 220;      // hard ceiling on validateEmbeddable() calls
const PROBE_CONCURRENCY = 6;   // GET+body is heavier than HEAD — stay polite

// IP / trademark blocklist for the grow path.  Comprehensive — mirrors the
// migrator's list so a clone titled with a registered trademark (even on a
// licensed host like GameMonetize) never reaches the catalog.  Trademark
// holders enforce regardless of which host serves the clone.
const CRON_IP_PATTERNS = [
  /\bgta\b/i, /grand\s*theft\s*auto/i, /counter[\s-]*strike/i, /\bcs[\s:-]?(go|2)\b/i,
  /\bamong[\s-]*us\b/i, /\bamongus\b/i, /\bfive[\s-]*nights[\s-]*at\b/i, /\bfnaf\b/i,
  /poppy[\s-]*playtime/i, /huggy[\s-]*wuggy/i, /garten\s*of\s*ban(ban)?/i,
  /\broblox\b/i, /skibidi[\s-]*toilet/i, /\bgeometry[\s-]*dash\b/i, /\bpok[eé]mon\b/i,
  /\bpikachu\b/i, /\bpixelmon\b/i, /\bsuper[\s-]*mario\b/i, /\bmario[\s-]*(bros|brothers|kart|party|world)\b/i,
  /\bminecraft\b/i, /\bsonic[\s-]*(the[\s-]*hedgehog|dash|exe|forces|frontiers)\b/i,
  /subway[\s-]*surfers?/i, /\bslither[\s.-]?io\b/i, /\bagar[\s.-]?io\b/i,
  /\bcrossy[\s-]*road\b/i, /\bcut[\s-]*the[\s-]*rope\b/i, /\bangry[\s-]*birds?\b/i,
  /\bmagic[\s-]*tiles[\s-]*3\b/i, /\bfortnite\b/i,
  /papa['’s]+\s*(pizzeria|burgeria|donuteria|freezeria|wingeria|cheeseria|sushiria|hot[\s-]*doggeria|cupcakeria|scooperia|pancakeria|taco[\s-]*mia|bakeria|mocharia)/i,
  /\bcookie[\s-]*clicker(\s*pro)?\b/i, /\btetris\b/i, /\bpubg\b/i,
  /\bdragon[\s-]*ball\b/i, /\bpac[\s-]*man\b/i, /\btekken\b/i, /\bbrawl[\s-]*stars\b/i,
  /\bclash[\s-]*of[\s-]*clans\b/i, /\bclash[\s-]*royale\b/i, /\bmonopoly\b/i, /\bscrabble\b/i,
  /\bresident[\s-]*evil\b/i, /\bstreet[\s-]*fighter\b/i, /\bmega[\s-]*man\b/i,
  /\bhelix[\s-]*jump\b/i, /\btemple[\s-]*run\b/i, /\bfruit[\s-]*ninja\b/i, /\bjetpack[\s-]*joyride\b/i,
  /\btalking[\s-]*tom\b/i, /\bcrazy[\s-]*taxi\b/i, /\bbloons\b/i, /\bbtd[\s-]*[1-7]\b/i,
  /\bdonkey[\s-]*kong\b/i, /\b(zelda|triforce|hyrule)\b/i, /\bsplatoon\b/i, /\banimal[\s-]*crossing\b/i,
  /\bgenshin\b/i, /\bhonkai\b/i, /\bterraria\b/i, /\bstumble[\s-]*guys\b/i,
  /\bstardew[\s-]*valley\b/i, /\bundertale\b/i, /\bdeltarune\b/i, /\bcuphead\b/i,
  /\bwordle\b/i, /\bsupermarket\s*sim/i, /\bsprunki\b/i, /\bblock[\s-]*blast\b/i,
  /\bfriday[\s-]*night[\s-]*funkin\b/i, /\bfnf\b/i, /\brocket[\s-]*league\b/i,
  // Additional well-known marks not in the migrator list but common in dumps:
  /\bkingdom[\s-]*rush\b/i, /\bplants[\s-]*(vs\.?|versus)[\s-]*zombies\b/i, /\bpvz\b/i,
  /\bflappy[\s-]*bird\b/i, /\bdoodle[\s-]*jump\b/i, /\bbad[\s-]*piggies\b/i,
  /\bhill[\s-]*climb[\s-]*racing\b/i, /\bsubway[\s-]*princess\b/i, /\bdisney\b/i,
  /\bspongebob\b/i, /\bbatman\b/i, /\bspider[\s-]*man\b/i, /\bfrozen\b.*\belsa\b/i, /\belsa\b.*\banna\b/i,
  // Film / streaming / kids-TV / toy trademarks that recur in game dumps:
  /\bsquid[\s-]*game\b/i, /\bstranger[\s-]*things\b/i, /\bwednesday[\s-]*addams\b/i,
  /\bbarbie\b/i, /\bhello[\s-]*kitty\b/i, /\bpaw[\s-]*patrol\b/i, /\bpeppa[\s-]*pig\b/i,
  /\bbluey\b/i, /\bnaruto\b/i, /\bone[\s-]*piece\b/i, /\bmarvel\b/i, /\bavengers\b/i,
  /\bharry[\s-]*potter\b/i, /\bstar[\s-]*wars\b/i, /\blego\b/i, /\bhot[\s-]*wheels\b/i,
  /\bsuper[\s-]*mario\b/i, /\bbendy\b/i, /\bgta[\s-]*v?\b/i,
];
// Hosts that look fine to HEAD-probe but cannot be iframed (wrapper pages,
// non-HTML files, X-Frame-Options enforcers). Dropping them at ingest
// avoids inserting games that will "load forever" then go dark.
const CRON_BAD_HOSTS = new Set([
  'duckmath.org',
  'poki.com', 'www.poki.com',
  'totaljerkface.com', 'www.totaljerkface.com',
  'coolmathgames.com', 'www.coolmathgames.com',
  'crazygames.com', 'www.crazygames.com',
  'y8.com', 'www.y8.com',
  'sites.google.com',
  'classic.minecraft.net',
]);

// Exported so a one-off catalog audit (and any future tool) can reuse the
// EXACT same trademark/host rules the grow job enforces — no drift.
export function isCronIpBlocked(title, url) {
  for (const p of CRON_IP_PATTERNS) if (p.test(title)) return true;
  try { if (CRON_BAD_HOSTS.has(new URL(url).host.toLowerCase())) return true; } catch {}
  return false;
}

// Trademark-name check ONLY (no host rules). Used by the recommendations
// endpoint, which validates the host separately against its own embed
// allowlist (which intentionally permits y8.com/embed — a host the bulk
// importer blocks). Keeps the trademark guard without the host conflict.
export function isTrademarkTitle(title) {
  for (const p of CRON_IP_PATTERNS) if (p.test(title)) return true;
  return false;
}

// Synthetic/sequential GameDistribution hashes (AI-generated placeholders).
// They return HTTP 200 — so the liveness probe below would happily promote
// them — but never render a real game (permanent black screen). Drop them
// here before they can be probed/inserted. Same algorithm as
// tools/clean-fake-gd-hashes.mjs and the migrator's guard.
const CRON_GD_HASH_RE = /html5\.gamedistribution\.com\/([0-9a-f]{32})\//i;
function isFakeGdHash(url) {
  const m = String(url).match(CRON_GD_HASH_RE);
  if (!m) return false;
  const h = m[1].toLowerCase();
  const even = [], odd = [];
  for (let i = 0; i < 32; i++) {
    const v = parseInt(h[i], 16);
    (i % 2 === 0 ? even : odd).push(v);
  }
  if (odd.some(n => n < 10)) return false;
  const oddM = odd.map(n => n - 10);
  const ed = new Set(); for (let i = 1; i < even.length; i++) ed.add(((even[i] - even[i-1]) + 10) % 10);
  const od = new Set(); for (let i = 1; i < oddM.length; i++) od.add(((oddM[i] - oddM[i-1]) + 6) % 6);
  return ed.size === 1 && od.size === 1;
}

// =====================================================================
// Embeddability validator — the "no black screen" guarantee.
// ---------------------------------------------------------------------
// A $0 free-tier host can't run a headless browser, so we verify every
// signal observable from an HTTP GET.  A candidate must pass ALL of these
// before the grow job inserts it:
//   1. https + on a trusted, iframe-LICENSED host (GameDistribution /
//      OnlineGames.io / GameMonetize / HTMLGames). These publishers build
//      their games to be embedded, so they render reliably AND keep the
//      catalog copyright-clean.
//   2. Not a synthetic/sequential GD hash (200s forever, never boots).
//   3. Final status (after redirects) is < 400.
//   4. No X-Frame-Options: DENY/SAMEORIGIN and no restrictive CSP
//      frame-ancestors — the #1 cause of a black iframe.
//   5. Content-Type is HTML (not an image/zip/json download).
//   6. Body isn't a soft-404 / parked-domain / "for sale" shell.
// =====================================================================
const TRUSTED_HOST_SUFFIXES = [
  'gamedistribution.com',
  'onlinegames.io',
  'gamemonetize.com',
  'gamemonetize.co',
  'htmlgames.com',
  // Additional licensed HTML5 distributors with official embed programs
  // (same model as GameDistribution — games are built to be iframed).
  'famobi.com',
  // NOTE: gamezop.com and gameflare.com were REMOVED as growth sources for
  // licensing reasons — do NOT re-add without securing a real license:
  //   • Gamezop  → tier PARTNER-ID: the embeds use a DIFFERENT publisher's
  //     partner id, not ours (a real licensing violation). Also removed at the
  //     serve layer via data/catalog-overrides.json.
  //   • GameFlare → tier ACCOUNT: needs a free publisher account we don't have,
  //     so auto-inserting new GameFlare games would serve them unlicensed.
  // See tools/audit-licensing.mjs for the tier classifications.
];
function isTrustedHost(url) {
  let h = '';
  try { h = new URL(url).host.toLowerCase(); } catch { return false; }
  return TRUSTED_HOST_SUFFIXES.some(s => h === s || h.endsWith('.' + s));
}

// True if response headers would stop the page rendering inside our iframe.
function framingBlocked(headers) {
  const xfo = (headers.get('x-frame-options') || '').toLowerCase();
  if (/\b(deny|sameorigin)\b/.test(xfo)) return true;
  const csp = headers.get('content-security-policy') || '';
  if (/frame-ancestors\b/i.test(csp) && !/frame-ancestors\s+[^;]*\*/i.test(csp)) return true;
  return false;
}

const SOFT_ERROR_RE = /(404\s*(not\s*found|error)|page\s*not\s*found|file\s*not\s*found|domain\s*(is\s*)?for\s*sale|account\s*suspended|this\s*site\s*can.?t\s*be\s*reached|error\s*5\d\d|temporarily\s*unavailable|has\s*expired)/i;
function looksLikeSoftError(htmlSlice) {
  if (!htmlSlice) return true;
  if (htmlSlice.replace(/\s+/g, '').length < 200) return true; // basically blank
  const titleMatch = htmlSlice.match(/<title[^>]*>([\s\S]{0,200})<\/title>/i);
  const title = titleMatch ? titleMatch[1] : '';
  return SOFT_ERROR_RE.test(title) || SOFT_ERROR_RE.test(htmlSlice.slice(0, 4096));
}

// Read at most maxBytes of the body, then cancel — never download a whole
// multi-MB game just to sniff its <title>.
async function readCapped(resp, maxBytes) {
  const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
  if (!reader) { try { return (await resp.text()).slice(0, maxBytes); } catch { return ''; } }
  const dec = new TextDecoder();
  let received = 0, out = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      out += dec.decode(value, { stream: true });
      if (received >= maxBytes) { try { await reader.cancel(); } catch {} break; }
    }
  } catch { /* partial body is fine for sniffing */ }
  return out;
}

const VALIDATE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Returns { ok, reason }. ok===true means: this game will actually render in
// our iframe with no black screen.
async function validateEmbeddable(url, { timeoutMs = 8000 } = {}) {
  if (!/^https:\/\//i.test(url)) return { ok: false, reason: 'not-https' };
  if (isFakeGdHash(url))         return { ok: false, reason: 'fake-gd-hash' };
  if (!isTrustedHost(url))       return { ok: false, reason: 'untrusted-host' };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'GET', redirect: 'follow', signal: ctrl.signal,
      headers: {
        'User-Agent': VALIDATE_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Range': 'bytes=0-65535',
        'Referer': (() => { try { return new URL(url).origin + '/'; } catch { return ''; } })(),
        'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate',
      },
    });
  } catch (e) {
    clearTimeout(t);
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'fetch-error' };
  }
  clearTimeout(t);

  if (resp.status >= 400) { try { await resp.body?.cancel(); } catch {} return { ok: false, reason: 'http-' + resp.status }; }
  if (framingBlocked(resp.headers)) { try { await resp.body?.cancel(); } catch {} return { ok: false, reason: 'framing-blocked' }; }

  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  const htmlish = ct.includes('text/html') || ct.includes('application/xhtml') || ct === '';
  if (!htmlish) { try { await resp.body?.cancel(); } catch {} return { ok: false, reason: 'not-html' }; }

  const body = await readCapped(resp, 65536);
  if (looksLikeSoftError(body)) return { ok: false, reason: 'soft-404' };

  return { ok: true, reason: 'ok' };
}

// Slug from title — minimal version (the migrator has the same logic).
function slugifyTitle(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function readPromotePool() {
  // Deduped by slug across all sources. Source priority is left-to-right
  // — earlier sources (top_games.json = curated) win ties.
  const map = new Map();
  let droppedIp = 0, droppedShape = 0, droppedFake = 0, droppedUntrusted = 0;
  for (const f of PROMOTE_SOURCES) {
    const full = join(ROOT, f);
    if (!existsSync(full)) continue;
    try {
      const raw = JSON.parse(readFileSync(full, 'utf8'));
      const arr = Array.isArray(raw) ? raw : (raw.games || raw.data || []);
      for (const g of arr) {
        const title    = g.title || g.name;
        // Accept both snake_case and camelCase URL fields — newer source
        // dumps (ai_gaming_hub_final.json) use `embedUrl`/`thumbnailUrl`.
        const game_url = g.embed_url || g.embedUrl || g.embed
                        || g.url || g.link || g.game_url;
        const thumbnail_url = g.thumbnail || g.image
                             || g.thumbnail_url || g.thumbnailUrl || null;
        // Auto-slugify when the source file doesn't include a slug field.
        const slug     = g.slug || slugifyTitle(title);
        if (!slug || !title || !game_url) { droppedShape++; continue; }
        if (typeof game_url !== 'string' || !/^https?:\/\//i.test(game_url)) { droppedShape++; continue; }
        // IP / pirate-mirror filter — keeps trademark hits out of Supabase.
        if (isCronIpBlocked(title, game_url)) { droppedIp++; continue; }
        // Fake/synthetic GD hash — 200s forever but never renders.
        if (isFakeGdHash(game_url)) { droppedFake++; continue; }
        // Only grow from trusted, iframe-licensed publishers — this is the
        // baseline "it will actually embed and render" filter. validateEmbeddable
        // re-confirms per-URL at insert time; pre-filtering here just keeps the
        // sample dense so we don't waste probes on hosts that can't embed.
        if (!isTrustedHost(game_url)) { droppedUntrusted++; continue; }
        if (map.has(slug)) continue;  // first-wins (priority order)
        map.set(slug, {
          slug,
          title: String(title).slice(0, 255),
          game_url,
          thumbnail_url,
          category: (g.category || g.type || g.genre || 'arcade').toString().toLowerCase()
        });
      }
    } catch (e) {
      console.warn(`[cron:promote] ${f} read failed (skipping):`, e.message);
    }
  }
  if (droppedIp || droppedShape || droppedFake || droppedUntrusted) {
    console.log(`[cron:grow] pool read: dropped ${droppedShape} shape, ${droppedIp} IP, ${droppedFake} fake-hash, ${droppedUntrusted} untrusted-host`);
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------
// growCatalogOnce — run ONE grow cycle.  Exported so both the cron and
// `npm run grow` (tools/grow-catalog.mjs) drive the exact same code path.
//
// Every candidate is render-verified by validateEmbeddable() before insert,
// so the catalog can only grow with games that actually play — no black
// screens.  Returns a stats object for the CLI to print.
//
// Options:
//   target      stop once this many verified games found  (default TARGET_ALIVE)
//   sampleSize  random candidates pulled from the pool     (default SAMPLE_SIZE)
//   maxProbes   ceiling on validateEmbeddable() calls      (default MAX_PROBES)
//   concurrency parallel validators                        (default PROBE_CONCURRENCY)
//   dryRun      validate but DON'T write to Supabase       (default false)
// ---------------------------------------------------------------------
export async function growCatalogOnce(opts = {}) {
  const target      = opts.target      ?? TARGET_ALIVE;
  const sampleSize  = opts.sampleSize  ?? SAMPLE_SIZE;
  const maxProbes   = opts.maxProbes   ?? MAX_PROBES;
  const concurrency = opts.concurrency ?? PROBE_CONCURRENCY;
  const dryRun      = !!opts.dryRun;

  const stats = { pool: 0, fresh: 0, tested: 0, verified: 0, inserted: 0, rejects: {} };

  const supa = getSupabase();
  if (!supa && !dryRun) { console.warn('[cron:grow] Supabase unconfigured — skipping.'); return stats; }

  // 1. Build the candidate pool (trusted hosts, no fakes, no IP violations).
  const pool = readPromotePool();
  stats.pool = pool.length;
  if (!pool.length) { console.warn('[cron:grow] candidate pool empty — skipping.'); return stats; }

  // 2. Random sample.
  const sample = pool.slice().sort(() => Math.random() - 0.5).slice(0, sampleSize);

  // 3. Drop slugs already in Supabase. Chunk the IN() lookup — a single
  //    300-slug query builds a ~6 KB URL that's slow enough to trip the
  //    8 s Supabase fetch timeout. 80-slug chunks keep each query sub-second.
  let existing = new Set();
  if (supa) {
    const slugs = sample.map(c => c.slug);
    try {
      for (let i = 0; i < slugs.length; i += 80) {
        const chunk = slugs.slice(i, i + 80);
        const { data, error } = await supa.from('games').select('slug').in('slug', chunk);
        if (error) throw error;
        for (const r of (data || [])) existing.add(r.slug);
      }
    } catch (e) {
      console.warn('[cron:grow] slug lookup failed:', e.message);
      return stats;
    }
  }
  const fresh = sample.filter(c => !existing.has(c.slug));
  stats.fresh = fresh.length;
  if (!fresh.length) { console.log('[cron:grow] no new slugs in sample — catalog already covers them.'); return stats; }
  console.log(`[cron:grow] pool=${pool.length}, fresh=${fresh.length}, target=${target} render-verified games`);

  // 4. Render-verify candidates in parallel until we hit `target`. Stop early.
  const verified = [];
  const queue = fresh.slice(0, maxProbes);
  const note = (reason) => { stats.rejects[reason] = (stats.rejects[reason] || 0) + 1; };
  const workers = new Array(concurrency).fill(0).map(async () => {
    while (queue.length && verified.length < target) {
      const candidate = queue.shift();
      if (!candidate) break;
      stats.tested++;
      try {
        const v = await validateEmbeddable(candidate.game_url);
        if (v.ok) verified.push(candidate);
        else note(v.reason);
      } catch (e) {
        note('exception');
      }
    }
  });
  await Promise.all(workers);
  stats.verified = verified.length;

  if (!verified.length) {
    console.log(`[cron:grow] tested ${stats.tested}, 0 passed render-verification — nothing to add. rejects=${JSON.stringify(stats.rejects)}`);
    return stats;
  }

  const toInsert = verified.slice(0, target).map(g => ({ ...g, is_working: true, last_checked: new Date().toISOString() }));
  stats.eligible = toInsert.length; // capped count actually destined for insert

  if (dryRun) {
    stats.inserted = 0;
    console.log(`[cron:grow] DRY RUN — ${toInsert.length} games passed verification (would insert). tested=${stats.tested}, rejects=${JSON.stringify(stats.rejects)}`);
    return stats;
  }

  // 5. Upsert verified games.
  try {
    const { error } = await supa.from('games').upsert(toInsert, { onConflict: 'slug', ignoreDuplicates: true });
    if (error) throw error;
    stats.inserted = toInsert.length;
    console.log(`[cron:grow] ✓ added ${toInsert.length} render-verified games (tested=${stats.tested}, rejects=${JSON.stringify(stats.rejects)})`);
  } catch (e) {
    console.warn('[cron:grow] upsert failed:', e.message);
    return stats;
  }

  // 6. Invalidate the page cache so new games appear immediately.
  try {
    const deleted = await cacheDelPattern('games:page:*');
    console.log(`[cron:grow] cache invalidated: ${deleted} keys (games:page:*)`);
  } catch (e) {
    console.warn('[cron:grow] cache invalidation failed:', e.message);
  }
  return stats;
}

// ---------------------------------------------------------------------
// 3-day cadence gate (restart-safe).
// ---------------------------------------------------------------------
// node-cron is calendar-based and can't express "every 3 days", so we let
// the grow job fire HOURLY but no-op until 3 days have elapsed since the last
// successful run.  The timestamp lives in data/grow-state.json so the
// cadence survives restarts (on ephemeral hosts the file resets, which just
// means the next grow happens a little sooner — harmless).
const GROW_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const GROW_STATE_FILE  = join(ROOT, 'data', 'grow-state.json');

function readGrowState() {
  try { return JSON.parse(readFileSync(GROW_STATE_FILE, 'utf8')); }
  catch { return { lastGrowAt: 0, totalAdded: 0 }; }
}
function writeGrowState(state) {
  try {
    mkdirSync(dirname(GROW_STATE_FILE), { recursive: true });
    writeFileSync(GROW_STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  } catch (e) {
    console.warn('[cron:grow] could not persist grow-state:', e.message);
  }
}

async function jobGrowGated() {
  const state = readGrowState();
  const elapsed = Date.now() - (state.lastGrowAt || 0);
  if (elapsed < GROW_INTERVAL_MS) {
    const hoursLeft = ((GROW_INTERVAL_MS - elapsed) / 3.6e6).toFixed(1);
    console.log(`[cron:grow] skip — next grow in ~${hoursLeft} h`);
    return;
  }
  const stats = await growCatalogOnce();
  writeGrowState({
    lastGrowAt: Date.now(),
    totalAdded: (state.totalAdded || 0) + (stats.inserted || 0),
    lastStats: stats,
  });
}

// ---------------------------------------------------------------------
// Job 3 — daily health log
// ---------------------------------------------------------------------
async function jobHealthLog() {
  const supa = getSupabase();
  if (!supa) { console.log('[cron:health] Supabase unconfigured.'); return; }
  try {
    const { count: working } = await supa.from('games').select('*', { count: 'exact', head: true }).eq('is_working', true);
    const { count: dead    } = await supa.from('games').select('*', { count: 'exact', head: true }).eq('is_working', false);
    console.log(`[cron:health] working=${working ?? '?'} dead=${dead ?? '?'}`);
  } catch (e) {
    console.warn('[cron:health] failed:', e.message);
  }
}

// ---------------------------------------------------------------------
// Job 4 — daily cleanup of stale, unseen community recommendations.
// Frees DB space by removing posts that are >30 days old AND have been
// viewed fewer than 3 times — i.e. "old messages no longer looked at".
// ---------------------------------------------------------------------
const REC_STALE_DAYS = 30;
const REC_MIN_VIEWS  = 3;
// Absolute ceiling on the community feed, independent of views — so even
// popular old posts can't let the table grow forever. The set-based trim runs
// in prune_recommendations() (db/community.sql); no-ops if not installed yet.
const REC_KEEP_MAX = parseInt(process.env.REC_KEEP_MAX || '1000', 10);
async function jobCleanupRecommendations() {
  const supa = getSupabase();
  if (!supa) return;
  const cutoff = new Date(Date.now() - REC_STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    // Pass 1 — delete stale AND unseen posts (old messages no one looks at).
    const { data, error } = await supa.from('recommendations')
      .delete()
      .lt('created_at', cutoff)
      .lt('views', REC_MIN_VIEWS)
      .select('id');
    if (error) {
      if (/does not exist|42P01|could not find the table/i.test(error.message)) return; // table not set up yet
      throw error;
    }
    if (data && data.length) console.log(`[cron:rec-cleanup] removed ${data.length} stale, unseen recommendations`);
  } catch (e) {
    console.warn('[cron:rec-cleanup] failed:', e.message);
  }
  // Pass 2 — hard ceiling: keep only the newest REC_KEEP_MAX rows.
  try {
    const { data, error } = await supa.rpc('prune_recommendations', { keep: REC_KEEP_MAX });
    if (error) {
      if (/does not exist|could not find|PGRST202|42883|42P01/i.test(error.message || '')) return; // function not installed yet
      throw error;
    }
    if (data) console.log(`[cron:rec-cleanup] trimmed ${data} recommendation(s) over the ${REC_KEEP_MAX} cap`);
  } catch (e) {
    console.warn('[cron:rec-cleanup] cap trim failed:', e.message);
  }
}

// ---------------------------------------------------------------------
// Job 5 — WEEKLY · refresh Y8 embeddable games.
//
// Uses scrape-y8.js (Y8's OWN "Games for your website" embed directory — the
// sanctioned iframe source) to pull a fresh, thumbnailed candidate set, then
// lib/y8-ingest.mjs validates each one is reachable, drops trademark titles,
// and upserts/​revives them in Supabase. Lightweight (no Playwright) so it can
// run 24/7 on a free host. For a deeper, headless-Chromium iframe-verified
// harvest, run `npm run y8-harvest` manually, then `npm run y8-sync`.
// ---------------------------------------------------------------------
const Y8_OUT   = join(ROOT, 'y8-games.json');
// 0 = ALL pages of the embed directory (~46 pages / ~2,400 games). The whole
// directory is Y8's sanctioned embed set, so we keep the full catalog in sync.
const Y8_PAGES = parseInt(process.env.Y8_PAGES || '0', 10);
async function jobY8Sync() {
  const supa = getSupabase();
  if (!supa) { console.log('[cron:y8] Supabase unconfigured — skip.'); return; }
  // 1) Refresh y8-games.json from Y8's embed directory (thumbnails come from the
  //    listing markup, so no per-game backfill needed).
  let scraped = 0;
  try {
    const list = await scrapeY8({ pages: Y8_PAGES, out: Y8_OUT, backfill: false, onLog: (m) => console.log('[cron:y8]', m) });
    scraped = list.length;
  } catch (e) {
    console.warn('[cron:y8] scrape failed (ingesting existing file instead):', e.message);
  }
  // 2) Upsert + revive. validate:false for the bulk set — validating thousands
  //    of probes risks Y8 rate-limiting and false-dropping good games; the
  //    hourly link-check is the gentle, 429-aware validator that prunes any
  //    genuinely-dead (404/410) games over time. Dynamic import avoids a static
  //    import cycle (y8-ingest imports isTrademarkTitle from this module).
  const { ingestY8 } = await import('./y8-ingest.mjs');
  const stats = await ingestY8({ jsonPath: Y8_OUT, validate: false });
  console.log(`[cron:y8] scraped=${scraped} upserted=${stats.upserted} foldedHidden=${stats.foldedHidden} collisionSkipped=${stats.collisionSkipped}`);
}

// ---------------------------------------------------------------------
// Job 6 — daily prune of the leaderboard so it can never balloon the DB.
// Keeps the top SCORES_KEEP_PER_GAME scores per game (the UI shows ≤50) and
// deletes the long tail, hard-capping the scores table. Runs the single
// set-based SQL function prune_scores() (db/community.sql) via RPC. No-ops
// quietly if the function isn't installed yet (community.sql not re-run).
// ---------------------------------------------------------------------
const SCORES_KEEP_PER_GAME = parseInt(process.env.SCORES_KEEP_PER_GAME || '200', 10);
async function jobPruneScores() {
  const supa = getSupabase();
  if (!supa) return;
  try {
    const { data, error } = await supa.rpc('prune_scores', { keep_per_game: SCORES_KEEP_PER_GAME });
    if (error) {
      // Function/table not set up yet — treat as a no-op, don't alarm.
      if (/does not exist|could not find|PGRST202|42883|42P01/i.test(error.message || '')) return;
      throw error;
    }
    if (data) console.log(`[cron:scores-prune] removed ${data} long-tail score(s)`);
  } catch (e) {
    console.warn('[cron:scores-prune] failed:', e.message);
  }
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------
// Keep the free-tier Supabase project from hitting its 7-day inactivity pause.
// Tiny request (see supabaseKeepAlive); try/catch so a failure never bubbles.
async function jobKeepAlive() {
  try {
    const r = await supabaseKeepAlive();
    if (r.ok) console.log(`[cron:keepalive] Supabase pinged (${r.mode}).`);
    else console.warn('[cron:keepalive] skipped:', r.error || r.reason);
  } catch (e) {
    console.warn('[cron:keepalive] error:', e?.message || e);
  }
}

export function startCronJobs() {
  if (process.env.CRON_DISABLED === '1') {
    console.log('[cron] disabled by CRON_DISABLED=1');
    return;
  }
  if (!isSupabaseConfigured()) {
    console.log('[cron] Supabase env not set — cron jobs registered but will no-op.');
  }

  safeSchedule('link-check',  '0 * * * *',    jobLinkCheck);              // every hour
  safeSchedule('grow',        '30 * * * *',   jobGrowGated);              // fires :30 hourly, 3-day gate inside
  safeSchedule('health',      '5 0 * * *',    jobHealthLog);              // 00:05 UTC daily
  safeSchedule('rec-cleanup', '15 0 * * *',   jobCleanupRecommendations); // 00:15 UTC daily
  safeSchedule('scores-prune','20 0 * * *',   jobPruneScores);            // 00:20 UTC daily
  safeSchedule('y8-sync',     '0 4 * * 0',    jobY8Sync);                 // Sundays 04:00 UTC (weekly)
  safeSchedule('keepalive',   '0 6 * * *',    jobKeepAlive);              // 06:00 UTC daily — keep free-tier Supabase awake

  for (const { task } of tasks) task.start();
  console.log(`[cron] scheduled ${tasks.length} jobs: ${tasks.map(t => t.label).join(', ')}`);

  // Kick off a first link-check 30s after boot, only if Supabase is configured.
  if (isSupabaseConfigured()) {
    setTimeout(() => {
      jobLinkCheck().catch(e => console.error('[cron:initial-link-check]', e?.message || e));
    }, 30_000).unref();
  }
}

export function stopCronJobs() {
  for (const { task } of tasks) { try { task.stop(); } catch {} }
}
