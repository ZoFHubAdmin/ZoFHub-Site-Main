import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { exec } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ========================================================================
// Crash safety — keep the site UP. A single stray async error (a background
// fetch, a cron tick, a proxy upgrade) must never take the whole server down.
// We log it loudly (so problems are visible) but do NOT exit: for a public
// games hub, staying online is the priority and these almost always originate
// in best-effort background work, not in request-handling that corrupts state.
// (Per-request errors are still caught by the Express error handler.)
// ========================================================================
process.on('unhandledRejection', (reason) => {
  console.error('[zofhub] unhandledRejection (continuing):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[zofhub] uncaughtException (continuing):', err);
});

// ========================================================================
// env — auto-load .env (or .env.example as last-resort fallback) BEFORE
// importing any module that reads process.env at import time.
// ------------------------------------------------------------------------
// Without this, `npm start` boots without seeing your Supabase creds
// because Node 20+'s `--env-file=` flag isn't applied by the start script.
// `process.loadEnvFile()` is the Node 20.6+ built-in equivalent.
// ========================================================================
for (const f of ['.env', '.env.example']) {
  const p = join(__dirname, f);
  if (existsSync(p) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(p);
      console.log(`[zofhub] loaded env from ${f}`);
      if (f === '.env.example') {
        console.warn('[zofhub] WARNING: no .env found — reading .env.example. Copy .env.example → .env for production.');
      }
      break;
    } catch (e) {
      console.warn(`[zofhub] failed to load ${f}:`, e.message);
    }
  }
}

// These modules read process.env at import time, so they must be imported
// AFTER the env-file load above.
const { getSupabase, isSupabaseConfigured, supabaseKeepAlive, supabaseHealth } = await import('./lib/supabase.mjs');
const { startCronJobs, isTrademarkTitle }  = await import('./lib/cron-jobs.mjs');
const { getCache }                         = await import('./lib/cache.mjs');
const { publicProviderList, MODEL_FALLBACKS }               = await import('./lib/ai-providers.mjs');
const { applyCatalogOverrides }            = await import('./lib/catalog-overrides.mjs');

// Open a URL in the user's default browser — best-effort, no-op on failure.
// Only fires for interactive local dev (TTY + not production + not NO_OPEN=1).
function openInBrowser(url) {
  if (process.env.NO_OPEN === '1' || process.env.NODE_ENV === 'production') return;
  if (!process.stdout.isTTY) return;
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
            : process.platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// ========================================================================
// env
// ========================================================================
const PORT = process.env.PORT || 8080;
// Bind DUAL-STACK ('::' = all IPv6 + IPv4-mapped) so that BOTH http://localhost
// (which resolves to IPv6 ::1 first on Windows) and http://127.0.0.1 connect
// instantly. Plain IPv4 '0.0.0.0' made the browser try [::1]:PORT, fail, then
// fall back to 127.0.0.1 — a ~210 ms penalty on EVERY connection that made the
// whole site feel slow. We upgrade the common '0.0.0.0' to '::' (which still
// serves all IPv4 clients); a real IPv6-less host falls back below via 'error'.
let HOST = process.env.HOST || '::';
if (HOST === '0.0.0.0') HOST = '::';
const PUBLIC_DIR = join(__dirname, 'public');

// ========================================================================
// Catalog — bundled JSON is the source of truth
// (Rebuild with: npm run build-mvp — it writes api/games.json)
// ========================================================================
let CATALOG = { games: [], generatedAt: null, source: 'pending' };
const bySlug     = new Map();   // slug → game
const byCategory = new Map();   // category → game[]
let   cachedCategoriesPayload = null; // pre-built /api/categories JSON

// ── Popularity / "how much it's played" ────────────────────────────────────
// Real play counts (lifetime) per slug, the dominant ranking signal once data
// accrues. Bumped by POST /api/play, attached to each game as g.plays, folded
// into a popularity WEIGHT, and persisted to the optional `game_stats` table so
// counts survive restarts. Everything degrades gracefully if that table or
// Supabase isn't there — the site just ranks on the cold-start priors instead.
const playCounts   = new Map();  // slug -> lifetime plays
const playsDirty   = new Set();  // slugs changed since last flush
const playDedup    = new Map();  // `${ip}|${slug}` -> ts (anti rapid-refresh)
let   playStatsTable = true;     // flips false if game_stats doesn't exist yet
// Per-(category, seed) ordering cache so paging within one visit is O(1) and
// stable. Cleared whenever the catalog is rebuilt. Capped + TTL'd so memory
// can't grow without bound under many distinct visitor seeds.
const orderCache   = new Map();  // `${cat}|${seed}` -> { games, exp }
const ORDER_TTL_MS = 10 * 60 * 1000;
const ORDER_CACHE_MAX = 120;

// Some htmlgames.com entries are stored as their raw EMBED SNIPPET, e.g.
//   <div><script src="https://cdn.htmlgames.com/embed.js?game=TetrisDimensions&width=800&height=480"></script></div>
// That is NOT a valid iframe src (the game shows a blank frame). Convert it to
// the direct, framable game page. Any non-snippet URL is returned untouched.
function coerceEmbedUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.trimStart()[0] !== '<') return url;
  const m = url.match(/embed\.js\?game=([A-Za-z0-9_]+)/i);
  return m ? `https://cdn.htmlgames.com/${m[1]}/index.html` : url;
}

// Normalize a raw entry from any source file into the bundled-catalog shape.
// Accepts both snake_case (embed_url) and camelCase (embedUrl) fields, and
// auto-generates a slug if one isn't provided. Returns null if unusable.
function normalizeRuntimeEntry(g) {
  if (!g || typeof g !== 'object') return null;
  const title    = g.title || g.name;
  const game_url = coerceEmbedUrl(g.embed_url || g.embedUrl || g.embed || g.url || g.link || g.game_url);
  if (!title || !game_url) return null;
  if (typeof game_url !== 'string' || !/^https?:\/\//i.test(game_url)) return null;
  const slug = g.slug || String(title).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return {
    slug,
    title,
    embed_url: game_url,
    thumbnail: g.thumbnail || g.thumbnail_url || g.thumbnailUrl || g.image || g.imageUrl || '',
    category:  (g.category || g.type || g.genre || 'arcade').toString().toLowerCase(),
    category_label: g.category_label,
    platform:  g.platform,
    orientation: g.orientation || 'landscape',
    tags: g.tags
  };
}

// Bulk sources (finalgames.json) label categories in free display form
// ("Puzzle & Logic", "Puzzles", ".Io", "Sports & Racing") which — after a plain
// lowercase — would fragment the nav into several near-duplicate pages. Collapse
// them into the app's canonical slug set (the same slugs the curated catalog
// uses: puzzle-logic / io-games / sports-racing …). Idempotent: a slug that is
// already canonical maps to itself.
const CATEGORY_ALIASES = {
  'puzzles': 'puzzle',
  'puzzle-and-logic': 'puzzle-logic',
  'sports-and-racing': 'sports-racing',
  'io': 'io-games',
  'card-games': 'card',
  'hidden-object-games': 'puzzle',
  'hidden-object': 'puzzle',
  'car': 'racing',
  'cars': 'racing',
  'traffic': 'racing',
  'bike': 'racing',
  'board': 'strategy',
  'sandbox': 'simulator',
  'training': 'arcade',
  'music': 'arcade',
  'horror': 'adventure',
  'observation': 'puzzle',
  'tripeaks-and-golf': 'card',
  'pyramid': 'card',
  'other': 'arcade',
};
function canonCategory(raw) {
  const c = String(raw || 'arcade').toLowerCase().trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'arcade';
  return CATEGORY_ALIASES[c] || c;
}

function loadCatalog() {
  // Primary source: api/games.json (built by build-curated.mjs from data/top_games.json).
  let games = [];
  const f = join(__dirname, 'api', 'games.json');
  if (!existsSync(f)) {
    console.warn('[zofhub] api/games.json missing — run: npm run build-mvp');
  } else {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    games = raw.games || raw;
  }

  // Secondary source: ai_gaming_hub_final.json — curated additions that
  // haven't been baked into api/games.json yet. Merged by slug; the
  // primary catalog wins on conflict (it's the proven catalog).
  const aiFile = join(__dirname, 'ai_gaming_hub_final.json');
  let aiAdded = 0;
  if (existsSync(aiFile)) {
    try {
      const aiRaw = JSON.parse(readFileSync(aiFile, 'utf8'));
      const aiGames = Array.isArray(aiRaw) ? aiRaw : (aiRaw.games || []);
      const existingSlugs = new Set(games.map(g => g.slug));
      for (const raw of aiGames) {
        const norm = normalizeRuntimeEntry(raw);
        if (!norm) continue;
        if (existingSlugs.has(norm.slug)) continue;
        games.push(norm);
        existingSlugs.add(norm.slug);
        aiAdded++;
      }
    } catch (e) {
      console.warn('[zofhub] ai_gaming_hub_final.json read failed (skipping):', e.message);
    }
  }

  // NOTE: finalgames.json (the large master catalog at the repo root) is merged
  // separately inside setCatalog(), so its games are added no matter whether the
  // catalog came from these bundled files OR from Supabase (which replaces the
  // bundled set ~2s after boot). See mergeFinalGames().
  const source = aiAdded > 0
    ? `bundled (${games.length}, +${aiAdded} from ai_gaming_hub_final.json)`
    : `bundled (${games.length})`;
  setCatalog(games, source);
}

// finalgames.json — the large master catalog at the repo root. Parsed + normalized
// ONCE and cached (hot-reloads when the file's mtime changes), so replacing the
// file just works with no build step. De-duped within itself by slug.
let _finalGamesCache = { mtime: -1, games: [] };
function loadFinalGames() {
  const file = join(__dirname, 'finalgames.json');
  try {
    if (!existsSync(file)) { _finalGamesCache = { mtime: 0, games: [] }; return _finalGamesCache.games; }
    const mt = statSync(file).mtimeMs;
    if (mt === _finalGamesCache.mtime) return _finalGamesCache.games;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw.games || []);
    const seen = new Set();
    const out = [];
    for (const entry of list) {
      const norm = normalizeRuntimeEntry(entry);
      if (!norm || seen.has(norm.slug)) continue;
      norm.category = canonCategory(norm.category);
      seen.add(norm.slug);
      out.push(norm);
    }
    _finalGamesCache = { mtime: mt, games: out };
    console.log(`[zofhub] finalgames.json: ${out.length} unique games loaded.`);
  } catch (e) {
    console.warn('[zofhub] finalgames.json read failed (skipping):', e.message);
  }
  return _finalGamesCache.games;
}

// Append every finalgames entry whose slug isn't already present. Runs against
// WHATEVER catalog is being installed (bundled OR Supabase), so finalgames' games
// always appear. The installed catalog wins on slug conflict (it carries richer
// metadata / flags); finalgames only fills gaps. Licensing removals still run
// afterward in applyCatalogOverrides, so hidden hosts (HTMLGames/Gamezop/…) never
// survive — they're added here and dropped there, netting zero.
function mergeFinalGames(games) {
  const extra = loadFinalGames();
  if (!extra.length) return games;
  const present = new Set(games.map(g => g.slug));
  let added = 0;
  for (const g of extra) {
    if (present.has(g.slug)) continue;
    games.push({ ...g });
    present.add(g.slug);
    added++;
  }
  if (added) console.log(`[zofhub] +${added} game(s) merged from finalgames.json`);
  return games;
}

// Replace the live catalog + rebuild the slug/category indexes. Shared by the
// bundled-JSON loader (loadCatalog) and the Supabase refresher so both paths
// produce identical in-memory structures.
// Evenly distribute Y8 games through the catalog so a freshly-ingested batch
// (hundreds at once, all carrying the newest ids) never clumps at the top of the
// homepage. Non-Y8 order is preserved (newest-first); Y8 games are sprinkled in
// at a regular stride. Deterministic — same input → same output — so the order
// stays stable across the 30-min refreshes (games don't jump between reloads).
function spreadCatalog(games) {
  if (!Array.isArray(games) || games.length < 2) return games;
  const y8 = [], rest = [];
  for (const g of games) {
    const u = (g.embed_url || g.game_url || g.url || '');
    (/y8\.com\/embed\//i.test(u) ? y8 : rest).push(g);
  }
  if (!y8.length || !rest.length) return games;
  const out = [];
  const step = rest.length / y8.length; // non-Y8 games between each Y8
  let yi = 0, nextAt = step;
  for (let i = 0; i < rest.length; i++) {
    out.push(rest[i]);
    while (yi < y8.length && (i + 1) >= nextAt) { out.push(y8[yi++]); nextAt += step; }
  }
  while (yi < y8.length) out.push(y8[yi++]); // flush any remainder
  return out;
}

// Precomputed mood/genre tags per game (slug -> [tags]), built OFFLINE by
// tools/build-mood-index.py from the whole catalog. Loaded once at boot. The Vibe
// Finder scores games by these tags, so a game can match a mood its TITLE never
// mentions (e.g. a racing game with a bland name still surfaces for "energetic").
// Optional: if the file is absent the Vibe Finder falls back to category matching,
// with no error — so the site never depends on the Python step having been run.
let MOOD_TAGS = new Map();
try {
  const mtFile = join(__dirname, 'data', 'mood-tags.json');
  if (existsSync(mtFile)) {
    MOOD_TAGS = new Map(Object.entries(JSON.parse(readFileSync(mtFile, 'utf8'))));
    console.log(`[zofhub] mood-tags loaded: ${MOOD_TAGS.size} games`);
  } else {
    console.log('[zofhub] no data/mood-tags.json — Vibe Finder uses category matching. Build it with: python tools/build-mood-index.py');
  }
} catch (e) { console.warn('[zofhub] mood-tags load failed:', e.message); }

function setCatalog(games, source) {
  // Merge in finalgames.json (the repo-root master list) FIRST, so its games are
  // present whether this catalog came from the bundled JSON or from Supabase.
  games = mergeFinalGames(games);
  // Apply in-repo display overrides (rename/re-thumbnail/hide) BEFORE indexing,
  // so the homepage grid, category pages, /play, search and counts are all
  // consistent — no DB write required. See lib/catalog-overrides.mjs.
  games = applyCatalogOverrides(games);
  // Interleave Y8 games evenly so a big batch doesn't dominate the first pages.
  games = spreadCatalog(games);
  CATALOG = { games, generatedAt: new Date().toISOString(), source };
  bySlug.clear();
  byCategory.clear();
  for (const g of CATALOG.games) {
    if (g.slug) bySlug.set(g.slug, g);
    // Re-attach the live play count (catalog objects are rebuilt each refresh).
    g.plays = playCounts.get(g.slug) || 0;
    // Canonicalize every game's category here (one place for ALL sources) so the
    // nav never fragments into near-duplicate pages (e.g. "car"/"traffic" → racing,
    // "card games" → card) regardless of whether it came from Supabase or a file.
    const cat = canonCategory(g.category);
    g.category = cat;
    // Attach precomputed mood tags (if built) so the Vibe Finder can match moods
    // the title never mentions. Merge with any existing tags (curated fallback).
    const mtags = MOOD_TAGS.get(g.slug);
    if (mtags) g.tags = (Array.isArray(g.tags) && g.tags.length) ? [...new Set([...g.tags, ...mtags])] : mtags;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(g);
    const plat = g.platform ? g.platform.toLowerCase() : null;
    if (plat && plat !== cat) {
      if (!byCategory.has(plat)) byCategory.set(plat, []);
      byCategory.get(plat).push(g);
    }
  }
  // Pre-compute the categories list so /api/categories is O(1).
  cachedCategoriesPayload = null;
  // Old per-seed orderings point at the previous game objects — drop them.
  orderCache.clear();
}

// ========================================================================
// Popularity ranking + per-visit shuffle
// ------------------------------------------------------------------------
// GOAL (what the site owner asked for): every game is ranked by how popular /
// played it is, AND the order changes for every user and every visit — across
// the homepage, every category, and every page.
//
// These two goals pull against each other (pure ranking = identical every time;
// pure random = ignores popularity), so we BLEND them per game:
//
//     sortKey = POP_WEIGHT · popNorm(game)        // how much it's played (0..1)
//             + random(seed, slug)                // per-visit variety (0..1)
//             + thumbnailBonus                    // gentle quality nudge
//   …sorted high → low.
//
// • Cold start (no plays yet): popNorm = 0 for everyone, so the order is driven
//   purely by the per-visit random term → genuinely different every visit and
//   per user (with only a mild preference for games that have a real image).
// • As real plays accumulate: popNorm rises toward 1 and POP_WEIGHT lifts those
//   games clearly above the random baseline — so the most-played games reach the
//   first screen — while the random term keeps the popular cluster (and the long
//   tail) rotating, so it never feels static.
// Same seed → identical full order (pagination is consistent within a visit);
// new seed → new order. POP_WEIGHT is the one knob: higher = popularity matters
// more; lower = more shuffle.
// ------------------------------------------------------------------------
const POP_WEIGHT  = 3.0;  // how strongly plays can lift a game over the random baseline
const POP_LOG_CAP = 3.0;  // ≈1000 plays reaches the top of the popularity scale
const THUMB_BONUS = 0.3;  // mild nudge so real-image tiles tend to lead (vs blanks)

function hashUnit(str) {
  // FNV-1a + avalanche → uniform (0,1). Deterministic for a given string.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15; h >>>= 0;
  return (h % 1000000 + 0.5) / 1000000;
}
const hasThumb = (g) => !!(g.thumbnail && /^(https?:|\/)/.test(g.thumbnail));

// Popularity in [0,1] — 0 for everyone at cold start, rising with real plays.
function popNorm(g) {
  const plays = g.plays || playCounts.get(g.slug) || 0;
  let p = Math.min(1, Math.log10(1 + plays) / POP_LOG_CAP); // the real "how much it's played"
  if (g.is_featured) p = Math.min(1, p + 0.15);             // small curated bump
  return p;
}

// Deterministic popularity order (no seed) — used for search so the most-played
// matches surface first and the result stays edge-cacheable.
function rankByPopularity(list) {
  return [...list].sort((a, b) =>
    popNorm(b) - popNorm(a) ||
    (hasThumb(b) - hasThumb(a)) ||
    String(a.title).localeCompare(String(b.title)));
}

// Per-visit blended order for a given seed.
function weightedShuffle(list, seed) {
  const keyed = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    const k = POP_WEIGHT * popNorm(g)
            + hashUnit(seed + '|' + (g.slug || g.title || i))
            + (hasThumb(g) ? THUMB_BONUS : 0);
    keyed[i] = { g, k };
  }
  keyed.sort((a, b) => b.k - a.k);
  const out = new Array(keyed.length);
  for (let i = 0; i < keyed.length; i++) out[i] = keyed[i].g;
  return out;
}

// The ordered list for a (category, seed). Cached per visit so every page of an
// infinite scroll / every "Next" click reuses the SAME order (no dupes, nothing
// skipped). With no seed we fall back to the stable popularity order.
function orderedList(cat, seed) {
  const base = (cat && cat !== 'all') ? (byCategory.get(cat) || []) : CATALOG.games;
  if (!seed) return rankByPopularity(base);
  const key = (cat || 'all') + '|' + seed;
  const now = Date.now();
  const hit = orderCache.get(key);
  if (hit && hit.exp > now) return hit.games;
  const games = weightedShuffle(base, seed);
  orderCache.set(key, { games, exp: now + ORDER_TTL_MS });
  if (orderCache.size > ORDER_CACHE_MAX) {
    const oldest = orderCache.keys().next().value; // Map preserves insertion order
    orderCache.delete(oldest);
  }
  return games;
}

// ------------------------------------------------------------------------
// Refresh the in-memory catalog FROM Supabase (the scalable write store the
// 36-hour grow cron feeds). This is what makes auto-grown games actually
// appear on the homepage + category pages, which read the in-memory CATALOG.
//
// Scale note: this runs at boot + every CATALOG_REFRESH_MS — NOT per request.
// So a million homepage views still hit Supabase ~twice an hour; everything
// users see is served from memory (and edge-cached). If Supabase is empty or
// unreachable, we keep whatever CATALOG we already had (bundled JSON) — the
// site never goes blank.
// ------------------------------------------------------------------------
const CATALOG_REFRESH_MS = 30 * 60 * 1000; // 30 minutes

async function refreshCatalogFromSupabase() {
  const supa = getSupabase();
  if (!supa) return false;
  // Fetch one 1000-row page with up to 3 attempts — the home-network → Supabase
  // hop occasionally aborts at the client's 8s timeout; a retry almost always
  // succeeds. (In datacenter deploys this never trips.)
  const fetchPage = async (from) => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { data, error } = await supa
          .from('games_public')
          .select('slug, title, game_url, thumbnail_url, category')
          .order('id', { ascending: false })
          .range(from, from + 999);
        if (error) throw new Error(error.message || 'supabase error');
        return data || [];
      } catch (e) {
        lastErr = e;
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastErr;
  };
  try {
    let rows = [], from = 0;
    while (true) {
      const data = await fetchPage(from);
      if (!data.length) break;
      rows = rows.concat(data);
      from += 1000;
      if (data.length < 1000) break;
    }
    if (!rows.length) {
      console.warn('[zofhub] Supabase returned 0 games — keeping current catalog.');
      return false;
    }
    // rows come back ordered by id DESC (newest first), so the first slice are
    // the most recently added games — flag them so the homepage "New" row has
    // real content instead of rendering an empty section.
    const NEW_COUNT = 36;
    const games = rows.map((g, i) => ({
      slug: g.slug,
      title: g.title,
      embed_url: coerceEmbedUrl(g.game_url),
      thumbnail: g.thumbnail_url || '',
      category: (g.category || 'arcade').toString().toLowerCase(),
      orientation: 'landscape',
      is_new: i < NEW_COUNT,
    }));
    setCatalog(games, `supabase (${games.length})`);
    console.log(`[zofhub] catalog refreshed from Supabase: ${games.length} games`);
    return true;
  } catch (e) {
    console.warn('[zofhub] Supabase catalog refresh failed (keeping current):', e.message);
    return false;
  }
}

// ------------------------------------------------------------------------
// Play-count persistence (optional `game_stats` table).
//   * loadPlayStats() — at boot, pull lifetime counts into memory + attach to
//     the catalog. If the table doesn't exist, log once and stay in-memory.
//   * flushPlayStats() — every minute, upsert the slugs that changed. Single
//     writer (one Render instance) so absolute-value upsert can't double-count.
// Both are best-effort: a DB hiccup never affects serving.
// ------------------------------------------------------------------------
async function loadPlayStats() {
  const supa = getSupabase();
  if (!supa) return;
  try {
    let from = 0;
    while (true) {
      const { data, error } = await supa.from('game_stats').select('slug, plays').range(from, from + 999);
      if (error) {
        if (/relation|does not exist|could not find|schema cache/i.test(error.message || '')) {
          playStatsTable = false;
          console.warn('[plays] game_stats table not found — play counts are in-memory only (run db/stats.sql to make them persist).');
          return;
        }
        throw error;
      }
      for (const r of (data || [])) playCounts.set(r.slug, Number(r.plays) || 0);
      if (!data || data.length < 1000) break;
      from += 1000;
    }
    for (const g of CATALOG.games) g.plays = playCounts.get(g.slug) || 0;
    orderCache.clear();
    console.log(`[plays] loaded ${playCounts.size} play counts from game_stats`);
  } catch (e) {
    console.warn('[plays] load failed (in-memory only):', e.message);
  }
}

async function flushPlayStats() {
  // Prune the dedup map regardless so it can't grow forever.
  const cutoff = Date.now() - 60000;
  for (const [k, ts] of playDedup) if (ts < cutoff) playDedup.delete(k);

  if (!playStatsTable || !playsDirty.size) return;
  const supa = getSupabase();
  if (!supa) return;
  const slugs = [...playsDirty];
  playsDirty.clear();
  const rows = slugs.map(s => ({ slug: s, plays: playCounts.get(s) || 0, updated_at: new Date().toISOString() }));
  try {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supa.from('game_stats').upsert(rows.slice(i, i + 500), { onConflict: 'slug' });
      if (error) throw error;
    }
  } catch (e) {
    console.warn('[plays] flush failed (will retry next tick):', e.message);
    for (const s of slugs) playsDirty.add(s); // requeue
  }
}

// ========================================================================
// Express + middleware
// ========================================================================
const app = express();
const httpServer = createServer();

// Behind a CDN / PaaS load balancer (Cloudflare, Render, Railway, Fly), the
// real client protocol + IP arrive in X-Forwarded-* headers. Trusting the
// first proxy hop makes req.protocol/req.secure correct (so the GD referrer
// and any future rate-limiting see the real https origin + client IP).
app.set('trust proxy', 1);
// JSON responses are identical for identical inputs — let Express emit weak
// ETags so conditional requests (304 Not Modified) save bandwidth at scale.
app.set('etag', 'weak');

// ------------------------------------------------------------------------
// Companion "standalone browser" engines.
// ------------------------------------------------------------------------
// Ultraviolet, Scramjet and GUST are embedded directly in this app and proxy
// from this same origin.  The other open-source proxy browsers the project
// ships (NautilusOS, Interstellar, DayDream, Nebula) are *whole* self-contained
// apps that assume they own the site root (absolute /uv/, /style.css, /a, …),
// so they can't be nested under a sub-path without service-worker scope and
// path collisions.  Instead each runs as its own self-contained service on its
// own origin; the browser page lists the ones that are reachable and loads them
// Companion browsers (Interstellar, Nebula, NautilusOS, DayDream) are SEPARATE
// third-party apps — NOT part of this server, NOT deployed with the site, and
// redundant with the built-in Scramjet/Ultraviolet/GUST engines (which are
// same-origin and always work). They are therefore fully OPT-IN: a companion
// appears in the /browser dropdown ONLY when its PROXY_*_URL is explicitly set
// to a reachable instance. With none set (the default — normal `npm start` and
// every deploy), the dropdown shows just the three built-in engines: clean, no
// "offline" clutter, no errors. `npm run dev:all` sets these locally so a
// developer who wants to tinker still sees whichever companions are running.
const COMPANION_ENGINES = [
  { id: 'nautilus',     label: 'NautilusOS',   url: (process.env.PROXY_NAUTILUS_URL     || '').trim() },
  { id: 'interstellar', label: 'Interstellar', url: (process.env.PROXY_INTERSTELLAR_URL || '').trim() },
  { id: 'daydream',     label: 'DayDream',     url: (process.env.PROXY_DAYDREAM_URL     || '').trim() },
  { id: 'nebula',       label: 'Nebula',       url: (process.env.PROXY_NEBULA_URL       || '').trim() },
].filter(e => e.url);

// Origins we must allow in frame-src so the stage iframe can embed a companion.
const companionFrameOrigins = (() => {
  const set = new Set();
  for (const e of COMPANION_ENGINES) {
    try { set.add(new URL(e.url).origin); } catch {}
  }
  // Convenience for local development with the bundled launcher.
  set.add('http://localhost:*');
  set.add('http://127.0.0.1:*');
  return [...set];
})();

const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: [
    // 'wasm-unsafe-eval' lets GUST's libcurl.js compile its embedded WebAssembly
    // even on browsers that no longer accept plain 'unsafe-eval' for wasm.
    "'self'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'",
    'https://cdn.jsdelivr.net', 'https://esm.sh', 'https://unpkg.com',
    'https://*.googlesyndication.com', 'https://*.google.com', 'https://*.googletagmanager.com',
    'https://*.adsafeprotected.com', 'https://*.playwire.com',
    'https://*.poki.com', 'https://*.y8.com',
    'https://*.supabase.co'
  ],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc:  ["'self'", 'https://fonts.gstatic.com', 'data:'],
  imgSrc:   ["'self'", 'https:', 'data:', 'blob:'],
  // blob: + data: let GUST read its own embedded wasm/blob payloads via fetch/XHR;
  // wss:/ws: carry the Wisp tunnel (same-origin /wisp/ by default).
  connectSrc: ["'self'", 'https:', 'wss:', 'ws:', 'blob:', 'data:'],
  // Permissive frame-src — the user controls which URLs end up in the catalog,
  // so any HTTPS game host should be loadable.  This also covers ad networks,
  // the panic-button cloak destinations, and the companion browser services
  // (their own origins, added so the proxy stage iframe can embed them).
  frameSrc: ["'self'", 'https:', 'data:', 'blob:', ...companionFrameOrigins],
  mediaSrc:    ["'self'", 'https:', 'data:', 'blob:'],
  workerSrc:   ["'self'", 'blob:'],
  manifestSrc: ["'self'"]
};

app.use(helmet({
  contentSecurityPolicy: { useDefaults: true, directives: CSP_DIRECTIVES },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // Default helmet sends `Referrer-Policy: no-referrer`, which makes
  // document.referrer empty inside game iframes — most publisher SDKs
  // treat that as bot traffic and refuse to start.  Send the origin only.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
// Only compress responses larger than 2KB — smaller payloads get bigger when compressed.
// NEVER compress Server-Sent Events: gzip buffers each tiny `data:` frame instead of
// flushing it, so the live presence stream would arrive in delayed BATCHES (that was
// the "online count takes 8-11s to update / flickers" bug). The filter runs on the
// first write, by which point the SSE handler has set Content-Type: text/event-stream.
app.use(compression({
  level: 6,
  threshold: 2048,
  filter: (req, res) => {
    const type = res.getHeader('Content-Type');
    if (typeof type === 'string' && type.includes('text/event-stream')) return false;
    return compression.filter(req, res);
  }
}));
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Permissions-Policy: explicitly delegate every capability a game iframe
// might need to ALL embedded origins.  Modern Chrome enforces this even
// when the iframe has an allow= attribute — without the header it silently
// drops fullscreen / autoplay / gamepad / etc., which makes splash Play
// buttons hang.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', [
    'autoplay=*',
    'fullscreen=*',
    'gamepad=*',
    'clipboard-read=*',
    'clipboard-write=*',
    'web-share=*',
    'encrypted-media=*',
    'payment=*',
    'accelerometer=*',
    'gyroscope=*',
    'xr-spatial-tracking=*',
    'picture-in-picture=*',
    'sync-xhr=*'
  ].join(', '));
  next();
});

// ========================================================================
// Optional proxy stack
// ========================================================================
const proxyStatus = { gust: false, ultraviolet: false, scramjet: false, bare: false, wisp: false, epoxy: false };

// ── Always-on proxy + proxy-friendly ads ────────────────────────────────────
// ZoFHub is ALWAYS a proxy site. There is NO hub / Google-AdSense mode: Google
// bans proxy / anonymizer domains at the ACCOUNT level, so the site earns solely
// via proxy-friendly ad networks (Adsterra / HilltopAds / Monetag / …) wired
// through PROXY_AD_SCRIPTS + PROXY_BANNER_TAG. The web proxy stack (GUST /
// Ultraviolet / Scramjet / Wisp) is always enabled. PROXY_ENABLED is kept as a
// named constant (always true) so the proxy setup below stays readable.
const PROXY_ENABLED = true;

let wisp = null;
{
  // GUST — self-contained libcurl.js + Wisp proxy (NO service worker). Lives as a
  // single vendored HTML file in public/gust/ with all of its assets (libcurl,
  // font-awesome, pdf.js, iso-639-1) served from our own origin. Its default Wisp
  // target is rewritten to our same-origin /wisp/ endpoint, so when it's reachable
  // every byte of proxy traffic stays on this domain. We just flag availability
  // here; the static mount below serves the files.
  if (existsSync(join(PUBLIC_DIR, 'gust', 'index.html'))) proxyStatus.gust = true;
  else console.warn('[zofhub] GUST: public/gust/index.html missing — engine unavailable.');

  // Custom UV config in public/ must win over the package default.
  app.get('/uv/uv.config.js', (req, res) => res.sendFile(join(PUBLIC_DIR, 'uv', 'uv.config.js')));

  try {
    const { uvPath } = require('@titaniumnetwork-dev/ultraviolet');
    if (uvPath && existsSync(uvPath)) { app.use('/uv/', express.static(uvPath)); proxyStatus.ultraviolet = true; }
  } catch (e) { console.warn('[zofhub] Ultraviolet:', e.message); }

  const findNodeModulesDir = (pkg) => {
    const candidates = require.resolve.paths('') || [];
    for (const root of candidates) { const p = join(root, ...pkg.split('/')); if (existsSync(p)) return p; }
    const local = join(__dirname, 'node_modules', ...pkg.split('/'));
    return existsSync(local) ? local : null;
  };
  const bareRoot  = findNodeModulesDir('@mercuryworkshop/bare-mux');
  const epoxyRoot = findNodeModulesDir('@mercuryworkshop/epoxy-transport');
  if (bareRoot  && existsSync(join(bareRoot,  'dist'))) { app.use('/baremux/', express.static(join(bareRoot, 'dist'))); proxyStatus.bare  = true; }
  if (epoxyRoot && existsSync(join(epoxyRoot, 'dist'))) { app.use('/epoxy/',   express.static(join(epoxyRoot,'dist'))); proxyStatus.epoxy = true; }

  // Scramjet — interception-based successor to Ultraviolet.  It shares the SAME
  // transport as UV (bare-mux → epoxy → our /wisp/ endpoint); only the in-page
  // rewriting engine and its service worker differ.  The wasm + js bundle is
  // served straight from the package dist; the fetch-handling SW lives in
  // public/scram/ so it can wrap the packaged worker factory.  The explicit SW
  // route must be registered BEFORE the /scram/ static mount so it wins.
  app.get('/scram/scramjet.sw.js', (req, res) => res.sendFile(join(PUBLIC_DIR, 'scram', 'scramjet.sw.js')));
  const scramjetRoot = findNodeModulesDir('@mercuryworkshop/scramjet');
  if (scramjetRoot && existsSync(join(scramjetRoot, 'dist'))) {
    app.use('/scram/', express.static(join(scramjetRoot, 'dist')));
    proxyStatus.scramjet = true;
  }

  try { wisp = require('@mercuryworkshop/wisp-js/server').server; proxyStatus.wisp = true; } catch (e) { console.warn('[zofhub] Wisp:', e.message); }
}

// ========================================================================
// Static + APIs
// ========================================================================
// The proxy front-end assets (gust, uv, scram, …) are ALWAYS served — this is a
// proxy site with no hub mode that would ever hide them.

app.use(express.static(PUBLIC_DIR, {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  setHeaders: (res, path) => {
    // Always revalidate the app shell + its code/assets so a deploy or edit is
    // picked up immediately — no stale CSS or stale ES-module imports (the usual
    // "my changes aren't showing" cause). ETag/Last-Modified still make unchanged
    // files return a cheap 304, so this costs a tiny conditional request, not a
    // full re-download. Hashed-filename caching is the future perf upgrade.
    if (/\.(html|css|js|mjs|svg)$/.test(path)) res.setHeader('Cache-Control', 'no-cache');
    // GUST vendors pdf.js as ES modules (.mjs). Some Express/send builds don't
    // map .mjs, and a wrong MIME makes the browser refuse the module import.
    if (path.endsWith('.mjs')) res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  }
}));

app.get('/api/health', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Live Supabase connectivity probe — so "configured but not working" becomes a
  // precise reason (paused project / bad key / RLS / egress). Bounded (8s client
  // timeout); if the probe itself hiccups we still return the rest of the health.
  let supabase;
  try { supabase = await supabaseHealth(); }
  catch (e) { supabase = { configured: isSupabaseConfigured(), connected: false, error: e?.message || String(e) }; }
  res.json({
    status: 'ok', uptime: process.uptime(), node: process.version,
    catalog: { source: CATALOG.source, games: CATALOG.games.length },
    supabase,
    proxy: proxyStatus
  });
});

// ── Keep-alive endpoint (free-tier uptime) ───────────────────────────────────
// Point an external uptime monitor (cron-job.org, UptimeRobot, …) at
// GET /healthz every ~10 min so Render's free tier never spins the service down.
// Each AUTHORIZED hit also pokes Supabase (throttled to ~once/12h) so the
// free-tier database never reaches its 7-day inactivity pause — one monitor
// keeps BOTH platforms awake.
//
// Auth: set CRON_SECRET in the environment, then have the monitor send it as
// `Authorization: Bearer <secret>`, header `x-cron-secret: <secret>`, or
// `?key=<secret>`. If CRON_SECRET is unset the route stays open (so it works
// before you configure it) but logs a one-time warning.
const CRON_SECRET = (process.env.CRON_SECRET || '').trim();
const KEEPALIVE_THROTTLE_MS = 12 * 60 * 60 * 1000; // at most ~2 Supabase pokes/day
let lastSupabaseKeepAliveAt = 0;
let warnedNoCronSecret = false;

function keepAliveAuthorized(req) {
  if (!CRON_SECRET) {
    if (!warnedNoCronSecret) {
      warnedNoCronSecret = true;
      console.warn('[keepalive] CRON_SECRET is not set — /healthz is UNPROTECTED. Set CRON_SECRET in your env.');
    }
    return true; // fail open until you configure it
  }
  const bearer   = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const provided = bearer || req.get('x-cron-secret') || req.query.key || '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(CRON_SECRET);
  return a.length === b.length && timingSafeEqual(a, b); // constant-time compare
}

// Fire-and-forget — NEVER awaited in the request path, so it can't block the
// event loop. Throttled so 10-min pings don't hammer the DB.
function pokeSupabaseThrottled() {
  const now = Date.now();
  if (now - lastSupabaseKeepAliveAt < KEEPALIVE_THROTTLE_MS) return;
  lastSupabaseKeepAliveAt = now;
  supabaseKeepAlive()
    .then(r => { if (!r.ok) console.warn('[keepalive] supabase poke:', r.error || r.reason); })
    .catch(() => {});
}

app.get(['/healthz', '/ping'], (req, res) => {
  if (!keepAliveAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  pokeSupabaseThrottled();
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, uptime: Math.round(process.uptime()), ts: new Date().toISOString() });
});
app.head(['/healthz', '/ping'], (req, res) => {
  if (!keepAliveAuthorized(req)) return res.sendStatus(401);
  pokeSupabaseThrottled();
  res.set('Cache-Control', 'no-store').sendStatus(200);
});

// Companion standalone-browser reachability.  The browser page calls this to
// learn which of the external proxy browsers (NautilusOS, Interstellar, …) are
// online right now and should appear in the engine dropdown.  Results are
// cached briefly so a page refresh doesn't re-probe every service.
const companionCache = { at: 0, data: null };
async function probeCompanion(e) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(e.url, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
    clearTimeout(timer);
    return { id: e.id, label: e.label, url: e.url, up: r.status < 500 };
  } catch {
    return { id: e.id, label: e.label, url: e.url, up: false };
  }
}
app.get('/api/proxies', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  if (companionCache.data && now - companionCache.at < 5000) {
    return res.json({ engines: companionCache.data });
  }
  const engines = await Promise.all(COMPANION_ENGINES.map(probeCompanion));
  companionCache.at = now;
  companionCache.data = engines;
  res.json({ engines });
});

// Public catalog of free AI providers (text + image).  Returns a list
// stripped of any private keys.  The /ai page can `fetch('/api/ai/providers')`
// to populate a remote-model selector.  Cached with no-store since the
// data is tiny and we want updates to ship immediately.
app.get('/api/ai/providers', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicProviderList());
});

// Hands the browser the PUBLISHABLE Pollinations key (pk_) so the AI runs
// browser-direct (gen.pollinations.ai) on the visitor's own IP — no AI ever
// processed here. A pk_ key is designed to be public (scoped budget), so serving
// it is safe; only ever expose POLLINATIONS_PUBLIC_KEY (never a secret sk_ key).
// Get a free key at https://enter.pollinations.ai and set POLLINATIONS_PUBLIC_KEY
// in .env. Empty when unset → the client falls back to anonymous/dev routes.
app.get('/api/ai/key', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const key = (process.env.POLLINATIONS_PUBLIC_KEY || '').trim();
  res.json({ key: key.startsWith('pk_') ? key : '' });
});

// ========================================================================
// AI proxies — free generation that works on ANY device with no 250MB
// in-browser model download. Text + image use Pollinations.ai. It's FREE but
// NOT unlimited: the keyless tier is ~1 request / 15s PER IP, and because these
// requests are proxied server-side, every visitor shares this one server IP's
// quota. We mitigate that three ways: (1) honor the upstream Retry-After and
// retry with backoff, (2) fall back to AI Horde (a different network) on 429,
// and (3) optionally authenticate with a free POLLINATIONS_TOKEN (Seed tier =
// ~1 req/5s + no watermark; get one at auth.pollinations.ai) — set it in .env
// to lift the shared limit. Web search uses whichever provider key is in .env.
// Every handler returns a clean JSON error on a flaky upstream, never a crash.
// ========================================================================
const AI_TIMEOUT_MS = 30_000;
function aiFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || AI_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}
// Optional Pollinations auth (all FREE). A token (auth.pollinations.ai) lifts the
// keyless ~1 req/15s limit to the Seed tier (~1 req/5s) and removes watermarks;
// a referrer attributes requests to this app. Both are read from .env if present.
const POLLINATIONS_TOKEN = (process.env.POLLINATIONS_TOKEN || '').trim();
const POLLINATIONS_REFERRER = (process.env.POLLINATIONS_REFERRER || 'zofhub.app').trim();
function pollinationsHeaders(extra = {}) {
  const h = { Referer: `https://${POLLINATIONS_REFERRER}/`, ...extra };
  if (POLLINATIONS_TOKEN) h.Authorization = `Bearer ${POLLINATIONS_TOKEN}`;
  return h;
}

// Pollinations rate-limits anonymous bursts (429). Retry up to 3× — honoring the
// upstream Retry-After header when present, otherwise exponential backoff.
async function pollinationsText(promptUrl, timeoutMs = AI_TIMEOUT_MS) {
  let last = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await aiFetch(promptUrl, { timeoutMs, headers: pollinationsHeaders({ Accept: 'text/plain' }) });
    if (r.ok) return (await r.text()).trim();
    last = r.status;
    if (r.status === 429 || r.status >= 500) {
      const ra = parseInt(r.headers.get('retry-after'), 10);
      await new Promise(s => setTimeout(s, ra > 0 ? ra * 1000 : 1200 * (attempt + 1)));
      continue;
    }
    break; // other statuses won't improve on retry
  }
  throw new Error('upstream ' + last);
}

// OpenAI-compatible POST endpoint. Cleaner structured output that respects the
// prompt better than the GET path, and returns the reasoning trace separately so
// `content` is already clean. Used as the primary on the server shield; the GET
// endpoint above is the internal fallback. Same 429/5xx backoff.
async function pollinationsChat(messages, timeoutMs = AI_TIMEOUT_MS) {
  let last = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await aiFetch('https://text.pollinations.ai/openai', {
      method: 'POST', timeoutMs,
      headers: pollinationsHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      // 'openai-fast' (= gpt-oss-20b, a reasoning model) is the only keyless model
      // left; reasoning_effort:'low' cuts its time-to-first-token from ~20s to ~1.5s.
      body: JSON.stringify({ model: 'openai-fast', messages, referrer: POLLINATIONS_REFERRER, private: true, reasoning_effort: 'low' }),
    });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const txt = j?.choices?.[0]?.message?.content;
      if (txt) return String(txt).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      throw new Error('empty reply');
    }
    last = r.status;
    if (r.status === 429 || r.status >= 500) {
      const ra = parseInt(r.headers.get('retry-after'), 10);
      await new Promise(s => setTimeout(s, ra > 0 ? ra * 1000 : 1200 * (attempt + 1)));
      continue;
    }
    break;
  }
  throw new Error('upstream ' + last);
}

// AI Horde — the second keyless text provider from ai_gaming_hub_final.json.
// Async (submit job → poll), slower than Pollinations but a different network
// so it covers Pollinations rate-limits. Anonymous key '0000000000'.
async function aiHordeText(prompt, timeoutMs = 45_000) {
  const submit = await aiFetch('https://aihorde.net/api/v2/generate/text/async', {
    method: 'POST', timeoutMs: 15_000,
    headers: { 'Content-Type': 'application/json', apikey: '0000000000', 'Client-Agent': 'ZoFHub:1.0:zofhub.app' },
    body: JSON.stringify({ prompt, params: { max_length: 220, max_context_length: 1024 } })
  });
  const sj = await submit.json().catch(() => ({}));
  if (!sj.id) throw new Error('horde submit failed');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(s => setTimeout(s, 2500));
    const st = await aiFetch(`https://aihorde.net/api/v2/generate/text/status/${sj.id}`, { timeoutMs: 10_000 });
    const stj = await st.json().catch(() => ({}));
    if (stj.faulted) throw new Error('horde faulted');
    if (stj.done && Array.isArray(stj.generations) && stj.generations.length) {
      return (stj.generations[0].text || '').trim();
    }
  }
  throw new Error('horde timeout');
}

// POST /api/ai/text { prompt, messages? } → { reply }
// Builds a short, bounded context string and asks Pollinations for a reply.
// ── Dynamic model registry with hardcoded failsafes ───────────────────────
// Query Pollinations' live model lists so we adapt if a model is renamed or
// retired; if the call fails OR the JSON shape changes, fall back to the
// hardcoded MODEL_FALLBACKS so generation (and the whole site) never breaks.
// Cached for 30 min and only hit on AI requests, so page/game loads are never
// blocked by it.
let _modelCache = { text: MODEL_FALLBACKS.text, image: MODEL_FALLBACKS.image, at: 0 };
const MODEL_TTL_MS = 30 * 60 * 1000;
function extractModelNames(data) {
  const arr = Array.isArray(data) ? data : (Array.isArray(data?.models) ? data.models : []);
  const out = [];
  for (const m of arr) {
    if (typeof m === 'string') out.push(m);
    else if (m && typeof m === 'object') {
      if (m.name) out.push(m.name);
      if (m.id) out.push(m.id);
      if (Array.isArray(m.aliases)) out.push(...m.aliases);
    }
  }
  return out.map(s => String(s).toLowerCase());
}
function pickModel(names, preferred, fallback) {
  for (const p of preferred) if (names.includes(p)) return p;
  return names[0] || fallback;   // preferred gone → first live model → hardcoded fallback
}
async function resolveModels() {
  if (Date.now() - _modelCache.at < MODEL_TTL_MS) return _modelCache;
  const next = { text: MODEL_FALLBACKS.text, image: MODEL_FALLBACKS.image, at: Date.now() };
  try {
    const r = await aiFetch('https://text.pollinations.ai/models', { timeoutMs: 6000, headers: pollinationsHeaders() });
    if (r.ok) { const n = extractModelNames(await r.json()); if (n.length) next.text = pickModel(n, ['openai', 'openai-fast'], MODEL_FALLBACKS.text); }
  } catch { /* keep fallback */ }
  try {
    const r = await aiFetch('https://image.pollinations.ai/models', { timeoutMs: 6000, headers: pollinationsHeaders() });
    if (r.ok) { const n = extractModelNames(await r.json()); if (n.length) next.image = pickModel(n, ['flux'], MODEL_FALLBACKS.image); }
  } catch { /* keep fallback */ }
  _modelCache = next;
  return next;
}

// POST /api/ai/text { prompt, messages? } → { reply }
// Builds a short, bounded context string and asks Pollinations for a reply.
// ── Scaling the (free, shared) AI to large traffic ────────────────────────
// Pollinations' keyless quota is per-IP and we proxy, so EVERY visitor shares
// this one server IP. Three layers keep the AI responsive under heavy load and
// stop us from self-DDoSing the upstream:
//   1) Response cache — identical prompts (the per-game "help" prompts repeat
//      across huge numbers of visitors) collapse to ONE upstream call; the rest
//      are served from cache in <1ms and bypass every limit below. This is what
//      lets the common load scale to millions.
//   2) Per-IP token bucket — one client can't drain the shared quota.
//   3) Global concurrency cap — never more than N in-flight upstream calls; when
//      saturated we shed load fast with 429 + Retry-After (no unbounded queue,
//      no memory blow-up), and the client already retries with backoff.
const AI_CACHE_TTL = 6 * 60 * 60;                     // 6h — replies are stable enough
const AI_MAX_CONCURRENT = 8;                          // simultaneous upstream calls
const AI_IP_BUCKET = { capacity: 5, refillMs: 4000 }; // ~1 req / 4s per IP, burst 5

function aiCacheKey(system, ctx) {
  return 'ai:text:' + createHash('sha1').update(system + '\n' + ctx).digest('hex');
}

// Per-IP token bucket in a bounded Map (swept) so millions of distinct IPs over
// time can't grow memory without limit.
const _ipBuckets = new Map(); // ip -> { tokens, last }
function ipAllow(ip) {
  const now = Date.now();
  if (_ipBuckets.size > 50_000) { let drop = 25_000; for (const k of _ipBuckets.keys()) { _ipBuckets.delete(k); if (--drop <= 0) break; } }
  let b = _ipBuckets.get(ip);
  if (!b) { b = { tokens: AI_IP_BUCKET.capacity, last: now }; _ipBuckets.set(ip, b); }
  const refill = Math.floor((now - b.last) / AI_IP_BUCKET.refillMs);
  if (refill > 0) { b.tokens = Math.min(AI_IP_BUCKET.capacity, b.tokens + refill); b.last = now; }
  if (b.tokens <= 0) return false;
  b.tokens--; return true;
}

// Generic per-IP token bucket for abuse-prone WRITE endpoints (recommendations,
// scores, view-bumps). Same bounded/swept design as the AI limiter, so a bot
// can't flood the database from a single IP. Dependency-free.
const _writeBuckets = new Map(); // ip -> { tokens, last }
function writeAllow(ip, capacity = 8, refillMs = 5000) {
  const now = Date.now();
  if (_writeBuckets.size > 50_000) { let drop = 25_000; for (const k of _writeBuckets.keys()) { _writeBuckets.delete(k); if (--drop <= 0) break; } }
  let b = _writeBuckets.get(ip);
  if (!b) { b = { tokens: capacity, last: now }; _writeBuckets.set(ip, b); }
  const add = Math.floor((now - b.last) / refillMs);
  if (add > 0) { b.tokens = Math.min(capacity, b.tokens + add); b.last = now; }
  if (b.tokens <= 0) return false;
  b.tokens--; return true;
}

// Global concurrency gate — immediate accept/reject, no queue.
let _aiActive = 0;
function aiGateEnter() { if (_aiActive >= AI_MAX_CONCURRENT) return false; _aiActive++; return true; }
function aiGateLeave() { if (_aiActive > 0) _aiActive--; }

app.post('/api/ai/text', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { prompt, messages } = req.body || {};
  const history = Array.isArray(messages) ? messages.filter(m => m && m.content) : [];
  const latest = (prompt || history.filter(m => m.role === 'user').slice(-1)[0]?.content || '').toString();
  if (!latest.trim()) return res.json({ reply: '', error: 'empty prompt' });

  // Bounded conversation context (last 6 turns, 700 chars each) to stay well
  // under any URL-length limit on the Pollinations GET endpoint.
  const ctx = (history.length
    ? history.slice(-6).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content).slice(0, 700)}`).join('\n') + '\nAssistant:'
    : latest
  ).slice(0, 3500);
  const system = 'You are ZoFHub AI, a friendly, concise assistant for students. Reply in clear markdown.';

  const cache = getCache();
  const key = aiCacheKey(system, ctx);

  // 1) Cache hit → instant, unlimited, no upstream call.
  try {
    const hit = await cache.get(key);
    if (hit && hit.reply) { res.setHeader('X-Cache', 'HIT'); return res.json({ ...hit, cached: true }); }
  } catch { /* cache miss/err → fall through */ }

  // 2) Per-IP limit (cache misses only).
  if (!ipAllow(req.ip || 'unknown')) return res.status(429).json({ reply: '', error: 'rate_limited', retryAfter: 4 });
  // 3) Global concurrency cap — shed load fast when saturated.
  if (!aiGateEnter()) return res.status(429).json({ reply: '', error: 'busy', retryAfter: 5 });

  // Primary: Pollinations (fast). Fallback: AI Horde (slower, different net).
  res.setHeader('X-Cache', 'MISS');
  try {
    const { text: textModel } = await resolveModels();
    // Prefer the OpenAI-compatible POST (cleaner, prompt-faithful); on any
    // failure fall back to the GET endpoint. Build a proper messages array from
    // the conversation (drop any client-sent system turn; we set our own).
    const turns = history.filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-6).map(m => ({ role: m.role, content: String(m.content).slice(0, 700) }));
    if (!turns.length && latest) turns.push({ role: 'user', content: latest });
    let text;
    try {
      text = await pollinationsChat([{ role: 'system', content: system }, ...turns]);
    } catch {
      const url = `https://text.pollinations.ai/${encodeURIComponent(ctx)}?model=${encodeURIComponent(textModel)}&system=${encodeURIComponent(system)}`;
      text = await pollinationsText(url);
    }
    const payload = { reply: text || '(no response)', provider: 'pollinations' };
    if (text) cache.set(key, payload, AI_CACHE_TTL).catch(() => {});
    return res.json(payload);
  } catch (e1) {
    try {
      const text = await aiHordeText(`${system}\n\n${ctx}`);
      const payload = { reply: text || '(no response)', provider: 'ai-horde' };
      if (text) cache.set(key, payload, AI_CACHE_TTL).catch(() => {});
      return res.json(payload);
    } catch (e2) {
      // Surface rate-limiting (429) as a real status so the client can show a
      // "cooling down" message and retry, instead of silently failing.
      if (/\b429\b/.test(e1.message) || /\b429\b/.test(e2.message)) {
        return res.status(429).json({ reply: '', error: 'rate_limited', retryAfter: 8 });
      }
      return res.json({ reply: '', error: `pollinations:${e1.message}; horde:${e2.message}` });
    }
  } finally {
    aiGateLeave();
  }
});

// GET /api/ai/image?prompt=...&seed=... → STREAMS the generated image THROUGH
// our server (masked). The browser only ever connects to our own origin over
// TLS, so it never contacts image.pollinations.ai directly — a network/firewall
// that blocks Pollinations can't see or block it, and the upstream token/referrer
// stay server-side. Cached hard so re-viewing a generated image never regenerates.
app.get('/api/ai/image', async (req, res) => {
  const prompt = (req.query.prompt || '').toString().slice(0, 1000).trim();
  if (!prompt) { res.setHeader('Cache-Control', 'no-store'); return res.status(400).json({ error: 'missing prompt' }); }
  // Per-user throttle (their own IP) so one client can't spam image gen.
  if (!ipAllow(req.ip || 'unknown')) { res.setHeader('Cache-Control', 'no-store'); return res.status(429).json({ error: 'rate_limited', retryAfter: 4 }); }
  // Stable seed per prompt (unless supplied) so the same prompt → cacheable image.
  let seed = parseInt(req.query.seed, 10);
  if (!Number.isFinite(seed)) seed = parseInt(createHash('sha1').update(prompt).digest('hex').slice(0, 8), 16);
  const { image: imageModel } = await resolveModels();
  const upstream = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=768&nologo=true&model=${encodeURIComponent(imageModel)}&seed=${seed}&referrer=${encodeURIComponent(POLLINATIONS_REFERRER)}`;
  try {
    // 60s — image generation can be slow. aiFetch clears its timeout once the
    // response headers arrive, so the streamed body isn't cut off mid-transfer.
    const r = await aiFetch(upstream, { timeoutMs: 60_000, headers: pollinationsHeaders({ Accept: 'image/*' }) });
    if (!r.ok || !r.body) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ error: 'upstream ' + r.status }); }
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(504).json({ error: 'image proxy failed' });
  }
});

// GET /api/ai/audio?prompt=...&voice=nova → { url }. Text-to-speech via
// Pollinations' openai-audio model (free, keyless — verified working). The
// browser plays the URL directly (CSP media-src allows https:), so no audio
// bytes pass through us and the keyless limit spreads across users' own IPs.
const AUDIO_VOICES = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
app.get('/api/ai/audio', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const prompt = (req.query.prompt || '').toString().slice(0, 800).trim();
  if (!prompt) return res.json({ url: null, error: 'missing prompt' });
  let voice = (req.query.voice || 'nova').toString().toLowerCase().replace(/[^a-z]/g, '');
  if (!AUDIO_VOICES.has(voice)) voice = 'nova';
  const url = `https://text.pollinations.ai/${encodeURIComponent(prompt)}?model=openai-audio&voice=${voice}&referrer=${encodeURIComponent(POLLINATIONS_REFERRER)}`;
  res.json({ url, voice, provider: 'pollinations' });
});

// GET /api/ai/video?prompt=... → { url|null }. HONEST: the free keyless AI
// (Pollinations) has NO video model, so this stays disabled unless you wire a
// paid provider. Set VIDEO_API_KEY in .env and implement the provider call
// below (e.g. Replicate / fal.ai / Luma / Runway) to enable it.
app.get('/api/ai/video', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const prompt = (req.query.prompt || '').toString().slice(0, 800).trim();
  if (!prompt) return res.json({ url: null, error: 'missing prompt' });
  if (!process.env.VIDEO_API_KEY) {
    return res.json({ url: null, error: 'unavailable',
      note: 'Video generation isn’t available on the free AI — no free video model exists. To enable it, add a paid provider key (VIDEO_API_KEY) for Replicate / fal.ai / Luma / Runway in .env.' });
  }
  // Provider integration goes here once a key is configured (tell me which
  // provider and I’ll wire the request + result polling).
  return res.json({ url: null, error: 'not_implemented',
    note: 'VIDEO_API_KEY is set but the provider call isn’t wired yet.' });
});

// (Web search removed from the AI.)

// POST /api/ai/echo — last-resort fallback ai.js calls if both the local
// engine and the primary text path fail. Tries Pollinations once more.
app.post('/api/ai/echo', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const prompt = (req.body?.prompt || '').toString().slice(0, 2000);
  // Same shared-upstream protection as /api/ai/text so this fallback can't be
  // used to bypass the limiter.
  if (!ipAllow(req.ip || 'unknown')) return res.json({ reply: 'AI is busy right now — please try again in a moment.' });
  if (!aiGateEnter()) return res.json({ reply: 'AI is busy right now — please try again in a moment.' });
  try {
    const text = await pollinationsText(`https://text.pollinations.ai/${encodeURIComponent(prompt)}?model=openai`, 20_000);
    return res.json({ reply: text || "I'm here, but couldn't generate a response just now." });
  } catch {
    return res.json({ reply: 'AI is temporarily unavailable. Please try again in a moment.' });
  } finally {
    aiGateLeave();
  }
});

// ========================================================================
// Community: recommendations + leaderboard (Supabase: recommendations, scores)
// ------------------------------------------------------------------------
// Run db/community.sql once to create the tables. Until then these endpoints
// return empty/needs-setup responses instead of crashing.
//
// SECURITY: submitted embed URLs are restricted to the SAME trusted, iframe-
// licensed hosts the grow validator uses. This stops the recommendations box
// from becoming an open "render any URL in an iframe for every visitor" hole
// (phishing / malware / NSFW). Text fields are length-capped here and HTML-
// escaped on render in the browser.
// ========================================================================
const REC_TRUSTED_HOSTS = [
  'gamedistribution.com', 'onlinegames.io', 'gamemonetize.com',
  'gamemonetize.co', 'htmlgames.com', 'y8.com',
];
function recHostOk(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    const h = u.host.toLowerCase();
    if (!REC_TRUSTED_HOSTS.some(s => h === s || h.endsWith('.' + s))) return false;
    // y8.com is only embeddable via its /embed/ path
    if ((h === 'y8.com' || h.endsWith('.y8.com')) && !u.pathname.startsWith('/embed/')) return false;
    return true;
  } catch { return false; }
}
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, n);
// Treat "table missing" (PostgREST 42P01) as a setup-needed signal, not a crash.
const needsSetup = (e) => /relation .* does not exist|42P01|could not find the table/i.test(e?.message || e?.code || '');

// --- POST /api/recommendations ---------------------------------------------
app.post('/api/recommendations', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Posting a game is rare per user — a tight limit blocks spam without ever
  // bothering a real contributor (burst 6, then ~1 every 10s).
  if (!writeAllow(req.ip || 'unknown', 6, 10_000)) {
    return res.status(429).json({ ok: false, error: 'Too many requests — please slow down and try again shortly.' });
  }
  const b = req.body || {};
  const title     = clean(b.title, 120);
  const embed_url = clean(b.embed_url || b.embedUrl || b.url, 600);
  const note      = clean(b.note, 280);
  const author    = clean(b.author, 40) || 'Anonymous';
  const category  = clean(b.category, 40).toLowerCase() || 'arcade';

  if (!title)               return res.status(400).json({ ok: false, error: 'A title is required.' });
  if (!recHostOk(embed_url)) return res.status(400).json({ ok: false, error: 'Embed link must be an https URL from a supported game host (GameDistribution, OnlineGames.io, GameMonetize, HTMLGames, or a y8.com/embed/ link).' });
  if (isTrademarkTitle(title)) return res.status(400).json({ ok: false, error: 'That game appears to use a trademarked name we can’t host.' });

  const supa = getSupabase();
  if (!supa) return res.status(503).json({ ok: false, error: 'Community storage is not configured yet.' });
  try {
    const { data, error } = await supa.from('recommendations')
      .insert({ title, embed_url, note, author, category })
      .select('id, title, author, category, created_at').single();
    if (error) throw error;
    return res.json({ ok: true, recommendation: data });
  } catch (e) {
    if (needsSetup(e)) return res.status(503).json({ ok: false, error: 'Run db/community.sql in Supabase to enable recommendations.' });
    console.warn('[recommendations] insert failed:', e.message);
    return res.status(500).json({ ok: false, error: 'Could not save recommendation.' });
  }
});

// --- GET /api/recommendations ---------------------------------------------
app.get('/api/recommendations', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=20, s-maxage=60, stale-while-revalidate=300');
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const supa = getSupabase();
  if (!supa) return res.json({ recommendations: [], source: 'no-supabase' });
  try {
    const { data, error } = await supa.from('recommendations')
      .select('id, title, embed_url, note, author, category, views, created_at')
      .eq('is_visible', true)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return res.json({ recommendations: data || [] });
  } catch (e) {
    if (needsSetup(e)) return res.json({ recommendations: [], setup: 'Run db/community.sql to enable this page.' });
    console.warn('[recommendations] list failed:', e.message);
    return res.json({ recommendations: [], error: 'unavailable' });   // no internal detail to clients
  }
});

// --- POST /api/recommendations/:id/seen  (bump views — powers the cleanup) --
app.post('/api/recommendations/:id/seen', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Lenient cap (it fires on every play-open) but still bounded against abuse.
  if (!writeAllow(req.ip || 'unknown', 40, 1000)) return res.json({ ok: false });
  const id = parseInt(req.params.id);
  if (!id) return res.json({ ok: false });
  const supa = getSupabase();
  if (!supa) return res.json({ ok: false });
  try {
    // Atomic increment via RPC-less read-modify-write is racy but fine for a
    // popularity signal; bump views and refresh last_seen_at.
    const { data } = await supa.from('recommendations').select('views').eq('id', id).single();
    await supa.from('recommendations')
      .update({ views: ((data?.views) || 0) + 1, last_seen_at: new Date().toISOString() })
      .eq('id', id);
    return res.json({ ok: true });
  } catch { return res.json({ ok: false }); }
});

// --- Proof-of-play score token ---------------------------------------------
// A signed, slug-bound, time-limited token is embedded in each /play page. A
// score can only be saved if the request carries a valid token for that game —
// so scores can't be blindly scripted/curled against /api/scores; you have to
// actually load the game page. (Stateless HMAC; secret rotates on restart.)
const SCORE_SECRET = process.env.SCORE_SECRET || randomBytes(32).toString('hex');
const SCORE_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;   // 6 hours
function issueScoreToken(slug) {
  const exp = Date.now() + SCORE_TOKEN_TTL_MS;
  const sig = createHmac('sha256', SCORE_SECRET).update(`${slug}.${exp}`).digest('base64url');
  return `${exp}.${sig}`;
}
function verifyScoreToken(token, slug) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const i = token.indexOf('.');
  const exp = Number(token.slice(0, i));
  const sig = token.slice(i + 1);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const good = createHmac('sha256', SCORE_SECRET).update(`${slug}.${exp}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(good);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Play SESSIONS: single-use, IP-bound, play-time-gated ------------------
// The static token above only proves "the page was loaded" — a cheater could
// open the page once and fire thousands of scores. A real submission now needs
// a SESSION: minted per play (POST /api/scores/session, itself gated by the
// static token), bound to the caller's IP, usable ONCE, and only after the
// player has actually been in the game for >= MIN_PLAY_MS. That turns "curl any
// number" into "load the page, wait, and burn a one-time token for each score"
// — rate-limited and trivial to detect. HMAC-signed + a bounded used-nonce set.
const SCORE_SESSIONS = new Map();                 // nonce -> { slug, ip, iat, exp }
const SESSION_TTL_MS  = 3 * 60 * 60 * 1000;       // a session stays usable for 3h
const MIN_PLAY_MS     = 8000;                     // must play >= 8s before a score counts
const MAX_SESSIONS    = 20000;                    // hard memory bound
const ipTag = (ip) => createHmac('sha256', SCORE_SECRET).update(String(ip || '')).digest('base64url').slice(0, 16);
function issueSession(slug, ip) {
  if (SCORE_SESSIONS.size >= MAX_SESSIONS) {       // drop expired, then oldest, to stay bounded
    const now = Date.now();
    for (const [k, v] of SCORE_SESSIONS) if (v.exp < now) SCORE_SESSIONS.delete(k);
    while (SCORE_SESSIONS.size >= MAX_SESSIONS) { const k = SCORE_SESSIONS.keys().next().value; if (k === undefined) break; SCORE_SESSIONS.delete(k); }
  }
  const nonce = randomBytes(16).toString('base64url');
  const iat = Date.now();
  SCORE_SESSIONS.set(nonce, { slug, ip: ipTag(ip), iat, exp: iat + SESSION_TTL_MS });
  const sig = createHmac('sha256', SCORE_SECRET).update(`${slug}.${nonce}.${iat}`).digest('base64url');
  return `${nonce}.${iat}.${sig}`;
}
function consumeSession(token, slug, ip) {
  if (typeof token !== 'string') return { ok: false, code: 'no-session' };
  const p = token.split('.');
  if (p.length !== 3) return { ok: false, code: 'bad-session' };
  const [nonce, iatStr, sig] = p;
  const iat = Number(iatStr);
  const good = createHmac('sha256', SCORE_SECRET).update(`${slug}.${nonce}.${iat}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(good);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: 'bad-session' };
  const s = SCORE_SESSIONS.get(nonce);
  if (!s) return { ok: false, code: 'used' };                          // single-use (or server restarted)
  if (s.slug !== slug || s.ip !== ipTag(ip)) return { ok: false, code: 'mismatch' };
  if (Date.now() > s.exp) { SCORE_SESSIONS.delete(nonce); return { ok: false, code: 'expired' }; }
  const played = Date.now() - s.iat;
  if (played < MIN_PLAY_MS) return { ok: false, code: 'too-fast', wait: Math.ceil((MIN_PLAY_MS - played) / 1000) };
  SCORE_SESSIONS.delete(nonce);                                        // consume
  return { ok: true, played };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of SCORE_SESSIONS) if (v.exp < now) SCORE_SESSIONS.delete(k); }, 10 * 60 * 1000).unref?.();

// --- Per-game plausibility ceilings (data/score-limits.json) ---------------
// Replaces the useless global 2-billion cap: any score above a game's ceiling
// is rejected outright. Edit the JSON to tune a game as you learn its real top.
let SCORE_LIMITS = { default: 5_000_000, perGame: {} };
function loadScoreLimits() {
  try {
    const f = join(__dirname, 'data', 'score-limits.json');
    if (!existsSync(f)) return;
    const j = JSON.parse(readFileSync(f, 'utf8'));
    SCORE_LIMITS = {
      default: Number(j.default) > 0 ? Number(j.default) : 5_000_000,
      perGame: (j.perGame && typeof j.perGame === 'object') ? j.perGame : {},
    };
  } catch (e) { console.warn('[scores] score-limits.json load failed:', e.message); }
}
loadScoreLimits();
const scoreCeiling = (slug) => { const g = Number(SCORE_LIMITS.perGame[slug]); return Number.isFinite(g) && g > 0 ? g : SCORE_LIMITS.default; };

// Outlier quarantine tuning + a one-time probe for the `status` column, so this
// all keeps working BEFORE the user runs db/community-scores-integrity.sql
// (quarantine simply stays off until the column exists).
const OUTLIER_FACTOR = 6;         // a new score > 6x the current game-best ...
const OUTLIER_BASELINE = 50;      // ... but only once the board has a real baseline
let scoresStatusCol = null;       // null=unknown, true/false after probe
async function ensureStatusCap(supa) {
  if (scoresStatusCol !== null) return scoresStatusCol;
  try {
    const { error } = await supa.from('scores').select('status').limit(1);
    scoresStatusCol = !error;
    if (error) console.warn('[scores] `status` column not found — run db/community-scores-integrity.sql to enable outlier quarantine. Proof-of-play + ceilings are active regardless.');
  } catch { scoresStatusCol = false; }
  return scoresStatusCol;
}

// --- POST /api/scores/session  { slug, token } -----------------------------
// Mint a one-time play session. Gated by the static per-page token so only a
// real page-load can start one. The clock starts NOW (MIN_PLAY_MS is measured
// from here), so the client requests this as the game begins.
app.post('/api/scores/session', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!writeAllow(req.ip || 'unknown', 20, 1500)) {
    return res.status(429).json({ ok: false, error: 'Too many requests — slow down.' });
  }
  const b = req.body || {};
  const slug = clean(b.slug, 80).toLowerCase();
  if (!slug || !bySlug.has(slug)) return res.status(400).json({ ok: false, error: 'unknown game' });
  if (!verifyScoreToken(b.token, slug)) return res.status(403).json({ ok: false, error: 'Open and play the game first.' });
  return res.json({ ok: true, session: issueSession(slug, req.ip), minPlaySeconds: Math.ceil(MIN_PLAY_MS / 1000) });
});

// --- POST /api/scores  { slug, name, score, session } ----------------------
app.post('/api/scores', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Scores are submitted after a game ends — generous burst, then 1 every ~4s.
  if (!writeAllow(req.ip || 'unknown', 12, 4000)) {
    return res.status(429).json({ ok: false, error: 'Too many requests — please slow down.' });
  }
  const b = req.body || {};
  const slug  = clean(b.slug, 80).toLowerCase();
  const name  = clean(b.name || b.player_name, 40) || 'Player';
  const score = Math.max(0, Math.min(2_000_000_000, Math.floor(Number(b.score) || 0)));
  if (!slug)  return res.status(400).json({ ok: false, error: 'missing slug' });
  if (!bySlug.has(slug)) return res.status(400).json({ ok: false, error: 'unknown game' });

  // Proof-of-play SESSION — single-use, IP-bound, and only after real play time.
  const sess = consumeSession(b.session, slug, req.ip);
  if (!sess.ok) {
    if (sess.code === 'too-fast') return res.status(403).json({ ok: false, error: `Keep playing — scores can be submitted after ${Math.ceil(MIN_PLAY_MS / 1000)}s.`, retryAfter: sess.wait });
    if (sess.code === 'used' || sess.code === 'expired') return res.status(409).json({ ok: false, error: 'That score session was already used — play a round and submit again.', renew: true });
    return res.status(403).json({ ok: false, error: 'Open and play the game before submitting a score.', renew: true });
  }

  // Plausibility ceiling — reject impossible scores outright.
  const ceiling = scoreCeiling(slug);
  if (score > ceiling) {
    return res.status(422).json({ ok: false, error: `That score is above this game's allowed range (max ${ceiling.toLocaleString()}).` });
  }

  const supa = getSupabase();
  if (!supa) return res.status(503).json({ ok: false, error: 'Leaderboard not configured.' });
  const hasStatus = await ensureStatusCap(supa);
  try {
    // Outlier quarantine: a wild leap past an ESTABLISHED game-best is held for
    // review (status='flagged') instead of shown. Only active once the column
    // exists (post-migration); harmless no-op before that.
    let flagged = false;
    if (hasStatus) {
      const { data: topRow } = await supa.from('scores')
        .select('score').eq('slug', slug).eq('status', 'ok')
        .order('score', { ascending: false }).limit(1).maybeSingle();
      const best = topRow?.score || 0;
      if (best >= OUTLIER_BASELINE && score > best * OUTLIER_FACTOR) flagged = true;
    }
    if (flagged) {
      const { error } = await supa.from('scores').insert({ slug, player_name: name, score, status: 'flagged', flag_reason: 'outlier' });
      if (error) throw error;
      return res.json({ ok: true, best: score, pending: true });
    }

    // Keep ONE row per (game, player) — the player's BEST score. This stops a
    // single identity flooding the board and keeps the leaderboard clean.
    let exQ = supa.from('scores').select('id, score').eq('slug', slug).eq('player_name', name);
    if (hasStatus) exQ = exQ.eq('status', 'ok');
    const { data: existing, error: selErr } = await exQ.order('score', { ascending: false }).limit(1).maybeSingle();
    if (selErr) throw selErr;

    const patch = hasStatus ? { status: 'ok', flag_reason: null } : {};
    if (existing) {
      if (score <= existing.score) return res.json({ ok: true, best: existing.score, updated: false });
      const { error } = await supa.from('scores')
        .update({ score, created_at: new Date().toISOString(), ...patch }).eq('id', existing.id);
      if (error) throw error;
      return res.json({ ok: true, best: score, updated: true });
    }
    const { error } = await supa.from('scores').insert({ slug, player_name: name, score, ...patch });
    if (error) throw error;
    return res.json({ ok: true, best: score, created: true });
  } catch (e) {
    if (needsSetup(e)) return res.status(503).json({ ok: false, error: 'Run db/community.sql to enable the leaderboard.' });
    console.warn('[scores] insert failed:', e.message);
    return res.status(500).json({ ok: false, error: 'Could not save score.' });
  }
});

// --- GET /api/scores?slug=  (per-game)  OR  /api/scores (global top) --------
app.get('/api/scores', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=15, s-maxage=45, stale-while-revalidate=120');
  const slug = clean(req.query.slug, 80).toLowerCase();
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const supa = getSupabase();
  if (!supa) return res.json({ scores: [], source: 'no-supabase' });
  try {
    const hasStatus = await ensureStatusCap(supa);
    let q = supa.from('scores').select('slug, player_name, score, created_at').order('score', { ascending: false }).limit(limit);
    if (hasStatus) q = q.eq('status', 'ok');       // hide flagged/quarantined scores from the public board
    if (slug) q = q.eq('slug', slug);
    const { data, error } = await q;
    if (error) throw error;
    return res.json({ scores: data || [], slug: slug || 'global' });
  } catch (e) {
    if (needsSetup(e)) return res.json({ scores: [], setup: 'Run db/community.sql to enable the leaderboard.' });
    console.warn('[scores] list failed:', e.message);
    return res.json({ scores: [], error: 'unavailable' });           // no internal detail to clients
  }
});

// ========================================================================
// Live presence — total visitors + per-game player counts
// ------------------------------------------------------------------------
// Honest, ZoFHub-only counts.  No simulation.  A session is anyone who has
// posted a heartbeat in the last PRESENCE_TTL_MS milliseconds.  Sessions
// expire automatically; a sweep runs every PRESENCE_SWEEP_MS.
//
// The client POLLS: it beats every ~2s and the beat RESPONSE is a fresh snapshot,
// which is the live-update path (see public/js/presence.js). We keep a TTL of 8s
// (4× the beat) so a live session can never expire between beats; the TTL is just
// the backstop for a MISSED leave beacon (crash / network drop) — a normal
// tab-close drops instantly via the leave beacon.
//
// NOTE: the SSE endpoint below (/api/presence/stream + presenceBroadcast) still
// exists but is no longer used by the bundled client — per-tab SSE saturated the
// browser's 6-connections-per-origin limit and starved these very POSTs (the
// "count takes 8-11s to update" bug), so the client switched to polling. Kept as a
// harmless no-op (sseClients stays empty) for any external/future consumer.
// ========================================================================
const PRESENCE_TTL_MS       = 8_000;
const PRESENCE_SWEEP_MS     = 1_500;
const PRESENCE_BROADCAST_MS = 1_200;
const PRESENCE_MAX_SESSIONS = 20_000;

const presence = new Map();          // sessionId -> { slug, lastSeen, ip }
const sseClients = new Set();        // res objects subscribed to the stream

function presenceSnapshot() {
  const games = {};
  let total = 0;
  const now = Date.now();
  for (const [, s] of presence) {
    if (now - s.lastSeen > PRESENCE_TTL_MS) continue;
    total++;
    if (s.slug) games[s.slug] = (games[s.slug] || 0) + 1;
  }
  return { total, games, t: now };
}

function presenceSweep() {
  const now = Date.now();
  for (const [id, s] of presence) {
    if (now - s.lastSeen > PRESENCE_TTL_MS) presence.delete(id);
  }
  // Hard cap so a flood of unique IDs can't blow memory.
  if (presence.size > PRESENCE_MAX_SESSIONS) {
    const sorted = [...presence.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    const drop = sorted.slice(0, presence.size - PRESENCE_MAX_SESSIONS);
    for (const [id] of drop) presence.delete(id);
  }
}

function presenceBroadcast() {
  if (sseClients.size === 0) return;
  const snap = presenceSnapshot();
  const payload = `data: ${JSON.stringify(snap)}\n\n`;
  // res.flush() forces the bytes out NOW (belt-and-suspenders vs any buffering
  // layer); the compression filter above already skips event-streams.
  for (const res of sseClients) { try { res.write(payload); res.flush?.(); } catch {} }
}

setInterval(() => { presenceSweep(); presenceBroadcast(); }, PRESENCE_SWEEP_MS).unref();
setInterval(presenceBroadcast, PRESENCE_BROADCAST_MS).unref();

// Burst-throttled broadcaster: when a beat/leave fires we'd like the SSE
// stream to push the new snapshot RIGHT NOW so connected tabs see the
// change in <100ms.  But many beats can land in a 100ms window — so we
// coalesce them with a short debounce.
let bcastPending = false;
function broadcastSoon() {
  if (bcastPending) return;
  bcastPending = true;
  setImmediate(() => { bcastPending = false; presenceBroadcast(); });
}

function recordBeat(sessionId, slug) {
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 64) return null;
  const safeSlug = slug && typeof slug === 'string' && slug.length <= 80 ? slug : null;
  const s = presence.get(sessionId);
  const changed = !s || s.slug !== safeSlug;   // new session OR slug switched
  if (s) { s.lastSeen = Date.now(); s.slug = safeSlug; }
  else   presence.set(sessionId, { lastSeen: Date.now(), slug: safeSlug });
  return changed;
}

app.post('/api/presence/beat', (req, res) => {
  const { sessionId, slug, action } = req.body || {};
  let mutated = false;
  if (action === 'leave' && sessionId && presence.has(sessionId)) {
    presence.delete(sessionId);
    mutated = true;
  } else {
    mutated = recordBeat(sessionId, slug);
  }
  // Immediate broadcast for joins, slug changes, leaves — keeps counts feeling live.
  if (mutated) broadcastSoon();
  res.json(presenceSnapshot());
});

// sendBeacon on page-hide hits this. The beacon's Blob type is application/json,
// so the GLOBAL express.json() has usually ALREADY parsed req.body into an object
// by the time we get here — the express.text() below then no-ops. So accept BOTH:
// an already-parsed object OR a raw string. (The old code did JSON.parse() on the
// object, which threw → the session was never deleted → leaves only dropped via
// the 8s TTL. THAT was the "count takes ~11s to show 1 after closing tabs" bug.)
app.post('/api/presence/leave', express.text({ type: '*/*', limit: '4kb' }), (req, res) => {
  let sessionId;
  const b = req.body;
  if (b && typeof b === 'object') sessionId = b.sessionId;
  else { try { sessionId = JSON.parse(b || '{}').sessionId; } catch {} }
  if (sessionId && presence.has(sessionId)) { presence.delete(sessionId); broadcastSoon(); }
  res.status(204).end();
});

app.get('/api/presence', (req, res) => res.json(presenceSnapshot()));

app.get('/api/presence/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  res.write(`retry: 3000\n\n`);
  res.write(`data: ${JSON.stringify(presenceSnapshot())}\n\n`);
  res.flush?.();
  sseClients.add(res);
  req.on('close', () => { sseClients.delete(res); });
});

// ============================================================
// /api/games — two modes:
//
//   1. NEW (spec-compliant) page/limit mode — used when ?page= is present.
//      Queries Supabase: WHERE is_working = true ORDER BY id DESC
//      LIMIT N OFFSET (page-1)*N. Defaults: page=1, limit=24.
//      On ANY Supabase failure (network blip, env unconfigured, RLS
//      misconfig, table missing) it returns { games: [], ... } — never
//      a 500. The Node process can't crash from this handler.
//
//   2. LEGACY offset/limit/category/q mode — used when ?page= is absent.
//      Reads from the bundled JSON catalog (CATALOG.games). Same shape
//      as before, kept so the existing category pages keep working.
// ============================================================
// Edge-cache directive for the paginated catalog. Browsers hold it 60s;
// a CDN (Cloudflare) holds the SHARED copy 5 min and may serve a stale copy
// for up to 10 min while it revalidates in the background. With this header
// in place, a million identical /api/games?page=1 requests collapse into ~1
// origin hit per 5 min per edge POP — the database barely notices.
const PAGE_CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';

// Single-flight: when N requests miss the SAME cache key at the SAME instant
// (cold cache / right after a TTL expiry), only ONE hits Supabase; the rest
// await that one promise. Without this, a traffic spike on a cold key sends
// a thundering herd of identical queries at the free-tier database.
const pageInFlight = new Map(); // cacheKey -> Promise<payload>

async function loadCatalogPage(page, limit, offset, cacheKey, cache) {
  if (pageInFlight.has(cacheKey)) return pageInFlight.get(cacheKey);
  const work = (async () => {
    const supa = getSupabase();
    if (!supa) return { games: [], page, limit, total: 0, source: 'no-supabase' };
    // games_public is the safe, frontend-shaped view from schema.sql.
    const { data, error, count } = await supa
      .from('games_public')
      .select('id, slug, title, game_url, thumbnail_url, category', { count: 'exact' })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    // Same in-repo display overrides as the in-memory catalog (rename / hide).
    // Only inject `add` games on page 1 so they aren't duplicated across pages.
    const games = applyCatalogOverrides(data || [], { injectAdds: page === 1 });
    const payload = { games, page, limit, total: count || 0, source: 'supabase' };
    // Best-effort cache write — failure logged but doesn't block the response.
    cache.set(cacheKey, payload, 3600).catch(e =>
      console.warn('[api/games] cache.set failed:', e.message));
    return payload;
  })();
  pageInFlight.set(cacheKey, work);
  try { return await work; }
  finally { pageInFlight.delete(cacheKey); }
}

app.get('/api/games', async (req, res) => {
  // -------- Mode 1: page-based (cache-aside → Supabase) --------
  if (req.query.page !== undefined) {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 24));
    const offset = (page - 1) * limit;
    const cacheKey = `games:page:${page}:limit:${limit}`;
    const cache = getCache();

    // ---- Cache HIT path ----
    try {
      const hit = await cache.get(cacheKey);
      if (hit) {
        res.setHeader('Cache-Control', PAGE_CACHE_CONTROL);
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Backend', cache.backend);
        // hit is already JSON-deserialized by RedisCache.get / MemoryCache.get
        return res.json(hit);
      }
    } catch (e) {
      // Cache failure must never block the request — fall through to DB.
      console.warn('[api/games] cache.get failed:', e.message);
    }

    // ---- Cache MISS → Supabase (single-flighted) ----
    try {
      const payload = await loadCatalogPage(page, limit, offset, cacheKey, cache);
      if (payload.source === 'no-supabase') {
        // No DB configured — don't let a CDN cache the empty result for long.
        res.setHeader('Cache-Control', 'public, max-age=15');
        res.setHeader('X-Cache', 'BYPASS');
      } else {
        res.setHeader('Cache-Control', PAGE_CACHE_CONTROL);
        res.setHeader('X-Cache', 'MISS');
        res.setHeader('X-Cache-Backend', cache.backend);
      }
      return res.json(payload);
    } catch (e) {
      // Spec: empty array, not a crash, 200 status — UI never breaks.
      console.warn('[zofhub] /api/games supabase failed, returning []:', e.message);
      res.setHeader('Cache-Control', 'no-store'); // don't cache a transient failure
      res.setHeader('X-Cache', 'BYPASS');
      return res.json({ games: [], page, limit, total: 0, source: 'fallback-empty', error: e.message });
    }
  }

  // -------- Mode 2: in-memory, popularity-ranked + per-visit shuffle --------
  const limit  = Math.min(parseInt(req.query.limit) || 200, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const cat    = req.query.category;
  const q      = (req.query.q || '').toLowerCase();
  // `seed` makes the order popularity-WEIGHTED-RANDOM and stable for this visit;
  // sanitized to a short token. Absent → deterministic popularity order.
  const seed   = (req.query.seed || '').toString().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || null;

  if (q) {
    // Search: deterministic, most-played matches first; edge-cacheable.
    let list = (cat && cat !== 'all') ? (byCategory.get(cat) || []) : CATALOG.games;
    list = rankByPopularity(list.filter(g => g.title.toLowerCase().includes(q)));
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.json({ total: list.length, limit, offset, games: list.slice(offset, offset + limit) });
  }

  // Popularity-ranked, per-visit weighted shuffle (homepage + categories + more).
  const list = orderedList(cat, seed);
  // A per-user order must NOT be shared by a CDN; let the user's own browser
  // hold it briefly so paging is snappy. Without a seed it's shareable.
  res.setHeader('Cache-Control', seed
    ? 'private, max-age=60'
    : 'public, max-age=120, s-maxage=600, stale-while-revalidate=600');
  res.json({ total: list.length, limit, offset, games: list.slice(offset, offset + limit) });
});

// ========================================================================
// POST /api/play  — record that a game was opened (the "how much it's played"
// signal that drives ranking). Cheap: bumps an in-memory counter, deduped per
// IP+slug for 30s so a refresh-masher can't inflate a game. Persistence is the
// once-a-minute flush. Always 200 — a tracking blip must never break play.
// ========================================================================
app.post('/api/play', (req, res) => {
  try {
    const slug = String(req.body?.slug || '').toLowerCase().slice(0, 80);
    if (!slug || !bySlug.has(slug)) return res.json({ ok: false });
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
      .split(',')[0].trim();
    const key = ip + '|' + slug;
    const now = Date.now();
    if (now - (playDedup.get(key) || 0) < 30000) return res.json({ ok: true, deduped: true });
    playDedup.set(key, now);
    const n = (playCounts.get(slug) || 0) + 1;
    playCounts.set(slug, n);
    playsDirty.add(slug);
    const g = bySlug.get(slug);
    if (g) g.plays = n; // keep ranking weight live without waiting for a refresh
    return res.json({ ok: true, plays: n });
  } catch {
    return res.json({ ok: false });
  }
});

// ========================================================================
// /api/vibe — "describe your mood, get games."
// ------------------------------------------------------------------------
// Why the old client-only version failed: mood words ("chill", "competitive")
// almost NEVER appear in game titles ("Zombie Fps Survival 3d"), and it only
// pulled 400 games. So matches were rare → "no proper game". This server-side
// version maps the mood to GENRE keywords that DO appear in titles/categories
// (a built-in mood map + optional Pollinations refinement) and searches the
// FULL in-memory catalog (~14k games). It ALWAYS returns matches fast — the AI
// is a bonus with a hard timeout, so a slow/down model never stalls the result.
// ========================================================================
const VIBE_BUCKETS = [
  { t: ['chill','relax','calm','tired','sleep','peace','unwind','stress','cozy','soothing','mellow','bored and calm','wind down','lazy'],
    k: ['bubble','match','jelly','jigsaw','puzzle','color','coloring','garden','bake','cook','candy','merge','sort','idle','zen','water','fish','farm','bubble'] },
  { t: ['compet','win','intense','sweaty','tryhard','challenge','hard','pvp','versus','beat','rage'],
    k: ['race','racing','soccer','football','fight','battle','shooter','shoot','sniper','gun','war','boxing','arena','strike','fps','drift','speed','kombat'] },
  { t: ['brain','think','smart','focus','study','learn','concentrate','logic','clever','mind'],
    k: ['puzzle','word','sudoku','chess','mahjong','math','logic','brain','memory','block','sort','escape','quiz','connect','merge','2048'] },
  { t: ['silly','fun','funny','laugh','random','crazy','weird','goofy','dumb','meme'],
    k: ['baby','cat','dog','food','troll','prank','draw','crazy','party','run','jump','noob','slap','ragdoll'] },
  { t: ['quick','short','fast','bored','kill time','waiting','one more','time pass','quick game'],
    k: ['run','jump','dash','tap','flappy','hyper','stack','helix','ball','roll','slice','fall','color','escape'] },
  { t: ['adventure','explore','epic','story','quest','rpg','journey','immersive'],
    k: ['adventure','world','quest','dragon','hero','ninja','war','tower','dungeon','escape','knight','monster','survival','craft'] },
  { t: ['sport','active','energetic','athletic'],
    k: ['soccer','football','basketball','pool','golf','bowling','tennis','ball','ride','bike','skate','sport','boxing','dunk'] },
  { t: ['scary','horror','spooky','dark','halloween','creepy','fear'],
    k: ['zombie','scary','horror','dark','survival','fps','monster','evil','ghost','night','granny','haunt'] },
  { t: ['car','drive','driving','speed','cars','racing','vroom'],
    k: ['car','drift','race','racing','parking','drive','truck','bike','traffic','moto','wheel','road','speed'] },
  { t: ['creative','build','design','make','draw','art','imagine'],
    k: ['build','craft','draw','design','color','paint','decorate','merge','tycoon','city','dress','style','salon','makeover'] },
  { t: ['cute','girly','dress','fashion','makeover','pretty','princess','beauty'],
    k: ['dress','makeover','salon','fashion','princess','baby','style','hair','nail','wedding','beauty','design'] },
  // --- Raw EMOTIONS → comforting / cathartic / energizing genres -------------
  // (so "I feel sad" or "I'm so angry" returns fitting games instantly, without
  //  waiting on the AI). Triggers avoid false hits like "made"/"download".
  { t: ['sad','lonely','cry','crying','heartbroken','heartbreak','depress','unhappy','gloomy','miserable','upset','homesick','grief'],
    k: ['bubble','match','jelly','cat','dog','pet','puppy','kitten','garden','bake','cook','color','coloring','jigsaw','farm','fish','candy','merge','zen','cozy'] },
  { t: ['happy','joy','joyful','cheerful','excited','ecstatic','delighted','good mood','great mood','feeling good','pumped'],
    k: ['run','jump','party','dance','color','hyper','dash','arcade','candy','bubble','pop','bounce','stack','slice'] },
  { t: ['angry','anger','furious','rage','raging','frustrat','pissed','annoyed','irritated','mad at'],
    k: ['smash','fight','punch','kick','boxing','shoot','shooter','war','battle','destroy','slap','ragdoll','stickman','kombat','gun','tank','crush','demolition'] },
  { t: ['anxious','stressed','nervous','overwhelmed','worried','panic','restless','tense','can\'t sleep','cant sleep'],
    k: ['bubble','jigsaw','coloring','color','garden','match','sort','zen','water','jelly','merge','idle','fish','puzzle','mahjong'] },
  { t: ['energetic','hyper','wired','buzzing','hyped','amped','full of energy'],
    k: ['run','dash','race','racing','jump','parkour','speed','bike','moto','stack','ball','flappy','helix','subway'] },
  { t: ['romantic','love','crush','valentine','date night','couple','in love','lovey'],
    k: ['dress','makeover','salon','wedding','princess','couple','kiss','date','style','hair','beauty','baby','love'] },
  { t: ['nostalgic','nostalgia','retro','classic','old school','oldschool','throwback','childhood'],
    k: ['retro','classic','arcade','pixel','snake','tetris','block','brick','pinball','bubble','pac','8'] },
];
const VIBE_ALLOWED = ['racing','car','drift','parking','bike','puzzle','word','sudoku','mahjong','chess','match','jigsaw','block','merge','2048','shooting','shooter','sniper','gun','zombie','war','soccer','football','basketball','sports','golf','pool','bubble','jelly','candy','color','coloring','dress','makeover','salon','baby','cooking','bake','adventure','rpg','dragon','ninja','tower','idle','clicker','run','jump','dash','flappy','helix','stack','ball','escape','horror','survival','draw','build','craft','city','fight','battle','arcade','smash','punch','boxing','ragdoll','stickman','tank','pet','dog','cat','dance','party','retro','pixel','snake','love','wedding','couple','garden','farm','fish','zen'];

// Filler words to ignore when harvesting the user's own words as keywords.
const VIBE_STOP = new Set(['want','something','really','feel','feeling','like','some','that','with','this','your','have','play','game','games','just','need','give','please','today','right','now','about','kind','type','mood','vibe','into','from','what','when','make','more','wanna','gonna','being']);
function vibeKeywords(text) {
  // Normalize to a space-padded, letters-only string. Match triggers on a WORD
  // BOUNDARY (\b + prefix) — naive substring matching wrongly fired the "car"
  // trigger on "s-car-y" and returned racing games for a scary mood.
  const t = ' ' + String(text).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const out = new Set();
  let matched = 0;   // how many mood buckets fired — lets the route skip the AI when the local map already nailed it
  for (const b of VIBE_BUCKETS) {
    if (b.t.some(tr => new RegExp('\\b' + tr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(t))) {
      matched += 1;
      b.k.forEach(k => out.add(k));
    }
  }
  // also take the user's own meaningful words (so "zombie" typed directly works)
  t.trim().split(' ').forEach(w => { if (w.length >= 4 && !VIBE_STOP.has(w)) out.add(w); });
  if (!out.size) ['arcade','puzzle','run','race','shoot','ball','jump','adventure'].forEach(k => out.add(k));
  return { keywords: [...out], matched };
}

// Genre/mood keyword → the REAL catalog category slug it implies. Category is the
// ONE field every one of the ~16k games reliably has (the bulk catalog carries no
// tags or description), so mapping a mood's keywords onto categories is what lets
// the Vibe Finder pull from the WHOLE database instead of only games whose TITLE
// happens to contain the word. Only confident, unambiguous mappings live here.
const KW_TO_CAT = {
  race:'racing', racing:'racing', drift:'racing', car:'racing', cars:'racing', parking:'racing', truck:'racing', moto:'racing', traffic:'racing', drive:'racing',
  shoot:'shooting', shooter:'shooting', sniper:'shooting', gun:'shooting', fps:'shooting', strike:'shooting',
  soccer:'sports', football:'sports', basketball:'sports', golf:'sports', bowling:'sports', tennis:'sports', sport:'sports', dunk:'sports',
  puzzle:'puzzle', sudoku:'puzzle', word:'puzzle', jigsaw:'puzzle', logic:'puzzle', brain:'puzzle', memory:'puzzle', quiz:'puzzle', chess:'puzzle',
  mahjong:'mahjong-solitaire', solitaire:'mahjong-solitaire',
  bubble:'bubble-shooter',
  dress:'girls', makeover:'girls', salon:'girls', fashion:'girls', princess:'girls', wedding:'girls', beauty:'girls', hair:'girls', nail:'girls', baby:'girls',
  adventure:'adventure', quest:'adventure', dragon:'adventure', ninja:'adventure', dungeon:'adventure', knight:'adventure', survival:'adventure',
  zombie:'adventure', horror:'adventure', scary:'adventure', ghost:'adventure', granny:'adventure',
  fight:'action', battle:'action', boxing:'action', punch:'action', ragdoll:'action', kombat:'action', smash:'action', stickman:'action',
  run:'hypercasual', jump:'hypercasual', dash:'hypercasual', flappy:'hypercasual', hyper:'hypercasual', stack:'hypercasual', helix:'hypercasual', parkour:'hypercasual',
  idle:'clicker', clicker:'clicker', tycoon:'clicker',
  tetris:'retro', pixel:'retro', snake:'retro', pinball:'retro', retro:'retro',
};

// Rank the FULL in-memory catalog against a mood's keywords. Scoring blends three
// signals, strongest first: (1) the game's CATEGORY matches a category the mood
// implies — reliable for every one of the ~16k games, so this is what makes a mood
// span the whole database instead of a handful of title matches; (2) TAGS match
// (only the curated fallback carries tags — a free bonus when present, ignored
// otherwise); (3) the TITLE contains the word. Then we shuffle a generous top
// slice so repeat searches feel fresh.
function rankCatalogByKeywords(keywords, limit = 18) {
  const kw = [...new Set(keywords.map(k => String(k).toLowerCase().trim()).filter(k => k.length >= 3))];
  if (!kw.length) return [];
  const moodCats = new Set();
  for (const k of kw) { const c = KW_TO_CAT[k]; if (c) moodCats.add(c); }
  const scored = [];
  for (const g of CATALOG.games) {
    const title = (g.title || '').toLowerCase();
    const cat = (g.category || '').toLowerCase();
    const tags = Array.isArray(g.tags) ? g.tags.map(t => String(t).toLowerCase()) : [];
    let score = 0;
    if (moodCats.has(cat)) score += 4;                          // mood→category: spans the whole DB
    for (const k of kw) {
      if (cat === k) score += 3;                                // keyword IS the exact category
      if (title.includes(k)) score += 3;                        // title mention
      if (tags.length) { if (tags.includes(k)) score += 4; else if (tags.some(t => t.includes(k))) score += 2; }
    }
    if (score > 0) scored.push({ g, score });
  }
  scored.sort((a, b) => b.score - a.score);
  // Shuffle within a generous top slice so repeat searches feel fresh.
  const top = scored.slice(0, Math.max(limit * 3, 60));
  for (let i = top.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [top[i], top[j]] = [top[j], top[i]]; }
  return top.slice(0, limit).map(({ g }) => ({
    slug: g.slug, title: g.title,
    thumbnail: g.thumbnail || g.thumbnail_url || '',
    category: g.category || 'arcade',
  }));
}

async function vibeKeywordsFromAI(text) {
  const messages = [
    { role: 'system', content: 'You translate a player\'s mood into video-game genres. Reply with ONLY comma-separated keywords chosen from the allowed list — no sentences, no extra words.' },
    { role: 'user', content: `Allowed keywords: ${VIBE_ALLOWED.join(', ')}\nMood: "${String(text).slice(0, 200)}"\nPick the 4-8 best-matching keywords from the allowed list:` },
  ];
  // Tight budget — the curated mood map is the source of truth, so the AI is a
  // quick optional refinement, never something the user waits on. 2.5s keeps the
  // whole request snappy even when Pollinations is slow.
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('ai-timeout')), 2500));
  const reply = await Promise.race([pollinationsChat(messages), timeout]);
  const allow = new Set(VIBE_ALLOWED);
  return (reply || '').toLowerCase().replace(/[^a-z, ]/g, ' ').split(/[,\s]+/).map(s => s.trim()).filter(w => allow.has(w));
}

app.get('/api/vibe', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = (req.query.q || '').toString().trim().slice(0, 200);
  if (!q) return res.json({ games: [], keywords: [], source: 'empty' });
  const { keywords: local, matched } = vibeKeywords(q);
  let keywords = local;
  let source = 'local';
  // Only spend time on the AI when the local mood map came up weak (no bucket
  // fired). When a mood bucket matched, the curated keywords are already great,
  // so we respond INSTANTLY instead of waiting on a network round-trip. This is
  // the fix for "Vibe Finder takes too long / times out".
  if (!matched) {
    try {
      const ai = await vibeKeywordsFromAI(q);
      if (ai.length) { keywords = [...new Set([...ai, ...local])]; source = 'ai'; }
    } catch { /* AI slow/down → built-in mood map carries it */ }
  }
  let games = rankCatalogByKeywords(keywords, 18);
  if (!games.length) games = rankCatalogByKeywords(['arcade','puzzle','run','race','ball','jump'], 18);
  res.json({ games, keywords: keywords.slice(0, 10), source, count: games.length });
});

app.get('/api/categories', (req, res) => {
  // Build once; invalidated by loadCatalog() which sets cachedCategoriesPayload = null.
  if (!cachedCategoriesPayload) {
    const labels = {};
    for (const g of CATALOG.games) {
      if (!labels[g.category]) labels[g.category] = g.category_label || g.category;
    }
    const cats = [...byCategory.entries()]
      // Exclude platform-alias entries that duplicate real categories
      .filter(([id]) => labels[id] !== undefined)
      .map(([id, games]) => ({ id, label: labels[id] || id, count: games.length, url: `/category/${id}` }))
      .sort((a, b) => b.count - a.count);
    cachedCategoriesPayload = { categories: [{ id: 'all', label: 'All', count: CATALOG.games.length, url: '/' }, ...cats] };
  }
  // Categories change only when the catalog reloads — cache hard at the edge.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
  res.json(cachedCategoriesPayload);
});

// ========================================================================
// /api/game-of-the-day — ONE featured game, the SAME for everyone all day.
// Deterministic: a hash of today's (UTC) date indexes into the popular,
// thumbnailed games, so it rotates once per calendar day and is stable across
// server restarts and across users (no per-visit randomness). Cached for the
// day in-process.
// ========================================================================
let gotdCache = { day: '', payload: null };
const hashStr = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h; };
function gameOfTheDay() {
  const day = new Date().toISOString().slice(0, 10);          // UTC YYYY-MM-DD
  if (gotdCache.day === day && gotdCache.payload) return gotdCache.payload;
  // Feature only games worth featuring: has a thumbnail.
  const withThumb = CATALOG.games.filter(g => g.thumbnail || g.thumbnail_url);
  // Privacy-preserving analytics: bias the feature toward the GENRES visitors
  // actually play most. Aggregate play counts per category (no personal data,
  // just totals), rotate deterministically among the top genres for the day,
  // then pick a popular game in that genre — so the daily feature tracks real
  // demand while staying stable + identical for everyone.
  let base = [];
  if (withThumb.length) {
    const genrePlays = new Map();
    for (const g of withThumb) { const c = g.category || 'arcade'; genrePlays.set(c, (genrePlays.get(c) || 0) + (g.plays || 0)); }
    const topGenres = [...genrePlays.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c).slice(0, 8);
    if (topGenres.length) {
      const genre = topGenres[hashStr(day) % topGenres.length];
      base = rankByPopularity(withThumb.filter(g => (g.category || 'arcade') === genre)).slice(0, 120);
    }
    if (!base.length) base = rankByPopularity(withThumb).slice(0, 500);
  }
  if (!base.length) base = CATALOG.games;
  let payload = null;
  if (base.length) {
    const g = base[hashStr(day + '|game') % base.length];
    payload = {
      date: day,
      game: {
        slug: g.slug, title: g.title,
        thumbnail: g.thumbnail || g.thumbnail_url || '',
        category: g.category || 'arcade',
        category_label: g.category_label || g.category || 'Arcade',
        plays: g.plays || 0,
      },
    };
  }
  gotdCache = { day, payload };
  return payload;
}
app.get('/api/game-of-the-day', (req, res) => {
  const p = gameOfTheDay();
  // The pick only changes at UTC midnight, so it's safe to cache a while.
  res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=1800, stale-while-revalidate=3600');
  if (!p) return res.json({ game: null });
  res.json(p);
});

// ========================================================================
// /embed/:slug — server-side iframe shim
// Fetches the publisher's HTML, injects <base href> so relative AND absolute
// URLs still resolve to the upstream (sub-resources stream direct from their
// CDN — no proxy traffic), then injects a tiny guard script that rewrites
// window.open() and target="_blank" clicks so the game stays inside our
// iframe. Strips X-Frame-Options + CSP so the iframe always loads.
// ========================================================================
// ---------- UA pool: rotate when an upstream blocks the default UA ----------
const UA_POOL = [
  // Chrome 131 / Windows 11 — the default that publishers expect
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // Safari 17 / macOS — used as the second-attempt UA on 403/5xx
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  // Firefox 131 — third-tier
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'
];

const EMBED_GUARD = `
<script>
(function () {
  // -- 0. Cross-origin fetch/XHR auto-routing.
  // Many publisher games make XHR/fetch calls to their own API for high
  // scores, asset manifests, multiplayer lobbies, etc.  Those requests hit
  // CORS errors in the iframe because ZoFHub ≠ publisher origin.  Solution:
  // transparently rewrite any cross-origin GET to go through /asset?u=...,
  // which strips Cross-Origin-Resource-Policy and returns ACAO:*.
  // POST/PUT/DELETE are left alone (most game endpoints are GET; mutating
  // routes usually require cookies that the asset proxy can't carry).
  var ZOFHUB_ORIGIN = window.location.origin;
  var ASSET = ZOFHUB_ORIGIN + '/asset?u=';
  function isCrossOrigin(u) {
    try {
      var a = new URL(u, document.baseURI);
      return a.origin && a.origin !== ZOFHUB_ORIGIN && /^https?:$/.test(a.protocol);
    } catch (_) { return false; }
  }
  // Patch fetch() — wrap only when the URL is cross-origin and method is GET-ish.
  if (window.fetch) {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var method = (init && init.method) || (input && input.method) || 'GET';
        if (url && method.toUpperCase() === 'GET' && isCrossOrigin(url)) {
          return origFetch(ASSET + encodeURIComponent(new URL(url, document.baseURI).href), init);
        }
      } catch (_) {}
      return origFetch(input, init);
    };
  }
  // Patch XMLHttpRequest — same logic.
  if (window.XMLHttpRequest) {
    var XHR = window.XMLHttpRequest;
    var origOpen = XHR.prototype.open;
    XHR.prototype.open = function (method, url, async, user, pwd) {
      try {
        if ((method || '').toUpperCase() === 'GET' && url && isCrossOrigin(url)) {
          url = ASSET + encodeURIComponent(new URL(url, document.baseURI).href);
        }
      } catch (_) {}
      return origOpen.call(this, method, url, async, user, pwd);
    };
  }

  // -- 1. Force new-tab opens to stay in this iframe.
  window.open = function (u) {
    try { if (u) window.location.href = String(u); } catch (e) {}
    return { closed: false, close: function () {}, focus: function () {}, postMessage: function () {} };
  };

  // -- 2. target=_blank / _top on links and forms → same-frame navigation.
  function fixTarget(el) {
    if (!el || !el.target) return;
    if (el.target !== '_self' && el.target !== '_parent') el.target = '_self';
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[target]');
    if (a) {
      fixTarget(a);
      if (a.target === '_self' && a.href) {
        // explicit href set — let it navigate normally
      }
    }
    var b = e.target && e.target.closest && e.target.closest('button[formtarget],input[formtarget]');
    if (b) b.removeAttribute('formtarget');
  }, true);
  document.addEventListener('submit', function (e) {
    if (e.target && e.target.target && e.target.target !== '_self') fixTarget(e.target);
  }, true);

  // -- 3. Pretend to be the top window so anti-iframe scripts give up.
  try { Object.defineProperty(window, 'top',          { configurable: true, get: function () { return window; } }); } catch (_) {}
  try { Object.defineProperty(window, 'parent',       { configurable: true, get: function () { return window; } }); } catch (_) {}
  try { Object.defineProperty(window, 'frameElement', { configurable: true, get: function () { return null;   } }); } catch (_) {}

  // -- 4. Sweep existing target=_blank from the DOM as it appears.
  function sweep(root) {
    root.querySelectorAll && root.querySelectorAll('a[target=_blank],a[target="_blank"],form[target=_blank],form[target="_blank"]').forEach(fixTarget);
  }
  document.addEventListener('DOMContentLoaded', function () { sweep(document); });
  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      muts[i].addedNodes && muts[i].addedNodes.forEach(function (n) {
        if (n.nodeType === 1) {
          if (n.target === '_blank') fixTarget(n);
          sweep(n);
        }
      });
    }
  }).observe(document.documentElement, { subtree: true, childList: true });
})();
</script>`;

// ---------- Shared upstream fetcher ----------
// One pass: pick UA, set realistic browser headers, follow redirects, time out.
// Caller decides whether to retry with a different UA.
async function fetchAsBrowser(targetUrl, { ua, timeoutMs = 20_000, accept } = {}) {
  const upstream = new URL(targetUrl);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(targetUrl, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': ua || UA_POOL[0],
        'Accept': accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        // Pretend the request comes from the upstream itself — bypasses anti-hotlinking + framing CTAs.
        'Referer': upstream.origin + '/',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
  } finally {
    clearTimeout(t);
  }
}

// Y8 fit-to-frame CSS. Y8's /embed/ pages hard-code the game into a nested
// <iframe> fixed at 900x600 inside `.container`, so on our (differently sized)
// frame the game sits small/centered and doesn't fill the rectangle. Since we
// serve the Y8 page through this proxy (same-origin), we can inject CSS that
// forces the wrapper + its game iframe to fill 100% of our frame. `!important`
// beats the inline width/height. Injected ONLY for y8.com pages.
// High specificity (`html body …`) + `!important` so it beats the game's own CSS
// AND the iframe's inline width/height, regardless of source order. Covers the
// game surface whether it's a direct child of `.container`, nested deeper, or a
// top-level `<iframe>` — and no longer keys on the inner host (some Y8 games nest
// a gamedistribution.com iframe, which the old `src*="y8.com"` rule missed).
const Y8_FIT_CSS = `<style id="zofhub-y8-fit">
html body>.container,html body .container,html body div.container{position:absolute!important;left:0!important;top:0!important;right:0!important;bottom:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;min-width:0!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important;transform:none!important;}
html body .container>iframe,html body .container iframe,html body>iframe{position:absolute!important;left:0!important;top:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;min-width:0!important;min-height:0!important;border:0!important;margin:0!important;display:block!important;}
</style>`;

// Applied to EVERY proxied /embed page: fill the viewport, kill default margins &
// scrollbars, black backdrop — so no game is offset by page chrome or shows a
// scrollbar. (HTMLGames et al. self-scale their own container; this only frames
// the viewport, WITHOUT touching the game's own transform.)
const BASE_FIT_CSS = `<style id="zofhub-fit-base">
html,body{margin:0!important;padding:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;overflow:hidden!important;background:#000!important;}
</style>`;

// ---------- Embed HTML cache ----------
// Publisher game-loader pages change rarely, so caching the rewritten HTML makes
// proxy-by-default fast: the FIRST open of a game fetches + rewrites it; every
// repeat open (by ANY user) serves from memory instantly. Keyed by slug|ua,
// 15-min TTL, LRU-capped. We ALSO send `cache-control: public, max-age=300` so
// the browser caches it too — re-opening the same game skips the server entirely.
const EMBED_CACHE = new Map();                 // key -> { html, status, at }
const EMBED_CACHE_TTL = 15 * 60 * 1000;
const EMBED_CACHE_MAX = 400;
function embedCacheGet(key) {
  const hit = EMBED_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > EMBED_CACHE_TTL) { EMBED_CACHE.delete(key); return null; }
  EMBED_CACHE.delete(key); EMBED_CACHE.set(key, hit);   // refresh LRU position
  return hit;
}
function embedCacheSet(key, html, status) {
  EMBED_CACHE.set(key, { html, status, at: Date.now() });
  if (EMBED_CACHE.size > EMBED_CACHE_MAX) {
    const oldest = EMBED_CACHE.keys().next().value;
    if (oldest !== undefined) EMBED_CACHE.delete(oldest);
  }
}

app.get('/embed/:slug', async (req, res) => {
  const game = bySlug.get(req.params.slug);
  if (!game) return res.status(404).type('html').send('Game not found');

  const upstreamUrl = game.embed_url;
  let upstream;
  try { upstream = new URL(upstreamUrl); } catch { return res.status(400).send('Invalid embed URL'); }

  // ── CSP override for this proxy route ────────────────────────────────────
  // This route serves THIRD-PARTY game HTML same-origin and injects a
  // cross-origin `<base href>` so the game's RELATIVE assets resolve to the
  // publisher CDN. The site-wide helmet CSP sets `base-uri 'self'`, which
  // SILENTLY neutralizes that <base> — the browser keeps document.baseURI on our
  // origin, so every relative `css/…`, `js/…`, `img/…` request hits OUR server,
  // 404s, and the game renders as a black page with broken images (the recurring
  // "chess is broken" bug). Games also legitimately pull code/assets from many
  // CDNs. So for THIS route only, replace the strict CSP with one appropriate for
  // a game sandbox: allow cross-origin base + resources, but keep
  // `frame-ancestors 'self'` so only ZoFHub can embed it (the iframe that loads
  // this is already sandboxed in game.html). Set it up-front so it covers every
  // return path below (cache hit, HTML, binary, error).
  res.setHeader('Content-Security-Policy',
    "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; " +
    "img-src * data: blob:; media-src * data: blob:; " +
    "base-uri *; frame-ancestors 'self';");

  // Base href must point at the DIRECTORY of the embed URL so the game's
  // RELATIVE assets (e.g. Unity's Build/UnityLoader.js, TemplateData/…) resolve
  // correctly. The old code blindly appended "/", turning ".../index.html" into
  // ".../index.html/" — so every relative asset 404'd and the game never painted
  // (you'd see only the blurred thumbnail backdrop through the empty iframe).
  let baseHref;
  const lastSeg = upstream.pathname.slice(upstream.pathname.lastIndexOf('/') + 1);
  if (lastSeg.includes('.')) {
    // URL ends in a filename (index.html, game.php, …) → base is its directory.
    const dir = new URL(upstream.toString());
    dir.search = '';
    dir.hash = '';
    dir.pathname = dir.pathname.slice(0, dir.pathname.lastIndexOf('/') + 1);
    baseHref = dir.toString();
  } else {
    // Directory-style URL (Y8 /embed/slug, GD /HASH/…): keep the original
    // append-a-slash behavior so those keep resolving exactly as before.
    baseHref = upstream.pathname.endsWith('/') ? upstream.toString() : upstream.toString() + '/';
  }

  // Y8 embed pages nest the game in a fixed-size <iframe> inside .container — they
  // need the extra fill CSS (see Y8_FIT_CSS). Every /embed page also gets BASE_FIT_CSS.
  const isY8 = /(^|\.)y8\.com$/i.test(upstream.host);

  // ?ua=N lets game-page.js force a different UA on retry (when first attempt 403/5xx'd).
  const uaPick = Math.max(0, Math.min(UA_POOL.length - 1, parseInt(req.query.ua) || 0));

  // Fast path: serve the rewritten HTML straight from cache.
  const cacheKey = `${req.params.slug}|${uaPick}`;
  const cached = embedCacheGet(cacheKey);
  if (cached) {
    res.status(cached.status);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cache-control', 'public, max-age=300');
    return res.send(cached.html);
  }

  let lastErr = null;
  // Up to 2 attempts: first with the requested UA, then with the next UA in the pool if 4xx/5xx.
  for (let attempt = 0; attempt < 2; attempt++) {
    const ua = UA_POOL[(uaPick + attempt) % UA_POOL.length];
    try {
      const r = await fetchAsBrowser(upstreamUrl, { ua });

      // Retry on hard failures with a different UA (some publishers UA-block aggressively).
      if (attempt === 0 && (r.status === 403 || r.status === 429 || (r.status >= 500 && r.status < 600))) {
        console.warn(`[embed] ${upstream.host} returned ${r.status} on UA[${uaPick}], retrying with UA[${(uaPick+1)%UA_POOL.length}]`);
        continue;
      }

      const ct = (r.headers.get('content-type') || 'text/html').toLowerCase();
      res.setHeader('access-control-allow-origin', '*');
      // Strip Set-Cookie so publisher session cookies never reach our domain.
      // (Browser would silently drop them anyway because of SameSite, but stripping
      //  removes the bytes and the surprise.)

      if (ct.includes('text/html') || ct.includes('application/xhtml')) {
        let html = await r.text();

        // Strip headers-as-meta that would block our injected script.
        html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
        html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');
        html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?x-frame-options["']?[^>]*>/gi, '');
        html = html.replace(/<base[^>]*>/gi, '');

        const inject = `<base href="${baseHref}">${BASE_FIT_CSS}${isY8 ? Y8_FIT_CSS : ''}${EMBED_GUARD}`;
        if (/<head[^>]*>/i.test(html))      html = html.replace(/(<head[^>]*>)/i,  `$1${inject}`);
        else if (/<html[^>]*>/i.test(html)) html = html.replace(/(<html[^>]*>)/i, `$1<head>${inject}</head>`);
        else                                html = `<!doctype html><html><head>${inject}</head><body>${html}</body></html>`;

        // Only cache real success HTML — never a 4xx/5xx error body.
        if (r.status >= 200 && r.status < 400) embedCacheSet(cacheKey, html, r.status);
        res.status(r.status);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('cache-control', 'public, max-age=300');
        return res.send(html);
      }

      // Binary pass-through (rare for top-level embeds).
      const buf = Buffer.from(await r.arrayBuffer());
      res.status(r.status);
      res.setHeader('content-type', ct);
      return res.send(buf);
    } catch (e) {
      lastErr = e;
      console.warn(`[embed] ${upstreamUrl} attempt ${attempt + 1}: ${e.message}`);
      // Try once more with a different UA — most failures here are TLS/cert
      // or DNS, neither of which UA helps with, but the second attempt also
      // resets the AbortController.
    }
  }

  console.error('[embed] permanently failed:', upstreamUrl, lastErr?.message);
  res.status(502).type('html').send(
    `<!doctype html><html><body style="margin:0;font-family:Inter,system-ui,sans-serif;background:#1a0b3d;color:#fff;padding:48px;text-align:center;display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:100vh">
      <h2 style="margin:0 0 8px;font-weight:800">Couldn’t reach the game</h2>
      <p style="color:#b4abe0;margin:0 0 18px">${htmlEscape(lastErr?.message || 'upstream failed')}</p>
      <a href="${htmlEscape(upstreamUrl)}" target="_blank" rel="noopener" style="color:#ffe000;font-weight:700;border:1px solid rgba(255,224,0,.45);padding:10px 16px;border-radius:10px;text-decoration:none">Open directly →</a>
    </body></html>`
  );
});

// ========================================================================
// /asset?u=<url> — cross-origin asset proxy
// ------------------------------------------------------------------------
// Used by:
//   - the embed guard's fetch/XHR patches (auto-routes game's GET requests
//     when they're cross-origin)
//   - the WebGL canvas tainting fixer (call `/asset?u=` on images/audio
//     that need to be CORS-clean)
//
// Restrictions (kept tight to avoid being abused as an open relay):
//   - GET only
//   - HTTPS only (no HTTP, no file://, no data: — those don't need a proxy)
//   - Refuses to proxy our own origin (no loops)
//   - Refuses to proxy localhost / 127.* / 10.* / 192.168.* / 172.16-31.*
//     (block SSRF to internal infra)
//   - 8s timeout
//   - 25 MB max response body (most game assets are <5 MB)
// ========================================================================
function isInternalHost(host) {
  if (!host) return true;
  host = host.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (host === 'localhost' || host === 'localhost.' || host === '0.0.0.0') return true;
  if (host.startsWith('127.')) return true;
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  // 172.16.0.0/12 = 172.16-172.31
  const m = host.match(/^172\.(\d+)\./);
  if (m) { const n = +m[1]; if (n >= 16 && n <= 31) return true; }
  if (host.startsWith('169.254.')) return true; // IPv4 link-local (cloud metadata)
  // IPv6 loopback / link-local / unique-local (fc00::/7 = fc/fd, fe80::/10 = fe8-feb)
  if (host === '::1' || host === '::' ) return true;
  if (/^(fc|fd)[0-9a-f]{0,2}:/i.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
  if (host.includes(':') && /(^|:)(0*:)*0*1$/.test(host)) return true; // ::1 variants
  // Block obfuscated IPv4 literals (decimal/hex/octal) that DNS would still
  // resolve to a private/loopback address — e.g. 2130706433 or 0x7f000001 = 127.0.0.1.
  // Any all-numeric or 0x-prefixed "hostname" is not a real domain; reject it.
  if (/^\d+$/.test(host)) return true;            // decimal-encoded IP
  if (/^0x[0-9a-f]+$/i.test(host)) return true;   // hex-encoded IP
  if (/^0[0-7]+(\.|$)/.test(host)) return true;   // octal-leading IP
  return false;
}

const ASSET_MAX_BYTES = 25 * 1024 * 1024;

app.get('/asset', async (req, res) => {
  const raw = req.query.u;
  if (!raw || typeof raw !== 'string') return res.status(400).type('text').send('missing ?u=');

  let target;
  try { target = new URL(raw); } catch { return res.status(400).type('text').send('bad url'); }
  if (target.protocol !== 'https:') return res.status(400).type('text').send('https only');
  if (isInternalHost(target.hostname)) return res.status(403).type('text').send('blocked host');

  try {
    const r = await fetchAsBrowser(target.toString(), {
      ua: UA_POOL[0],
      timeoutMs: 8_000,
      accept: req.headers['accept'] || '*/*'
    });

    // Streamed size cap — abort if upstream tries to send more than the limit.
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > ASSET_MAX_BYTES) {
      return res.status(413).type('text').send('asset too large');
    }

    const ct = r.headers.get('content-type') || 'application/octet-stream';
    res.status(r.status);
    res.setHeader('content-type', ct);
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-expose-headers', '*');
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
    res.setHeader('cache-control', 'public, max-age=300');
    return res.send(buf);
  } catch (e) {
    return res.status(502).type('text').send('asset proxy failed: ' + (e.message || 'unknown'));
  }
});

// ========================================================================
// /api/frame-check?slug=<slug> — pre-flight embeddability check
// ------------------------------------------------------------------------
// game-page.js fires this in PARALLEL with the direct iframe timer.
// If the URL is dead (404/410) or framing-blocked (XFO / CSP) we return
// embeddable:false and game-page.js skips straight to the /embed proxy,
// cutting the dark-screen wait from 4 s down to <1 s.
//
// We use HEAD for all games (fast, reads only headers, no body download).
// GD games never set X-Frame-Options so they always pass through as
// embeddable:true; fake/broken hashes that return 200 are caught later
// by the game-page.js extended-loading state (6 s → "Try proxy" link).
// ========================================================================
app.get('/api/frame-check', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=600');
  const slug = req.query.slug;
  if (!slug) return res.json({ embeddable: null, error: 'missing slug' });
  const game = bySlug.get(slug);
  if (!game) return res.json({ embeddable: null, error: 'not found' });

  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 4_000);

  try {
    const r = await fetch(game.embed_url, {
      method: 'HEAD',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA_POOL[0],
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Referer': (() => { try { return new URL(game.embed_url).origin + '/'; } catch { return ''; } })()
      }
    });
    clearTimeout(t);

    if (r.status === 404 || r.status === 410) {
      return res.json({ embeddable: false, dead: true, reason: 'not-found', status: r.status });
    }

    const xfo = r.headers.get('x-frame-options') || '';
    const csp = r.headers.get('content-security-policy') || '';
    if (/\b(deny|sameorigin)\b/i.test(xfo)) {
      return res.json({ embeddable: false, reason: 'x-frame-options' });
    }
    if (/frame-ancestors\b/i.test(csp) && !/frame-ancestors\s+['"]?\*/i.test(csp)) {
      return res.json({ embeddable: false, reason: 'csp-frame-ancestors' });
    }

    return res.json({ embeddable: true, status: r.status });
  } catch (e) {
    clearTimeout(t);
    return res.json({ embeddable: null, error: e.name === 'AbortError' ? 'timeout' : e.message });
  }
});

// ========================================================================
// /api/proxy/diag?u=<url> — proxy self-test
// Returns a JSON report of whether each path can reach the URL.
// Useful for "why isn't this game loading" debugging without leaking server
// internals.  All checks have a hard 5s ceiling.
// ========================================================================
app.get('/api/proxy/diag', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Rate-limit: this endpoint fetches a caller-supplied URL server-side, so cap
  // it to stop it being used as a fast internal port-scanner / traffic amplifier.
  if (!writeAllow(req.ip || 'unknown', 10, 3000)) {
    return res.status(429).json({ ok: false, error: 'Too many requests — slow down.' });
  }
  const raw = req.query.u;
  if (!raw) return res.json({ ok: false, error: 'missing ?u=' });
  let target;
  try { target = new URL(raw); } catch { return res.json({ ok: false, error: 'bad url' }); }
  // SSRF guard: only ever probe PUBLIC https game hosts. Refuse http/other
  // schemes and any internal/loopback/link-local/cloud-metadata address — the
  // same block the /embed asset proxy uses — so a crafted ?u= can't reach the
  // Render metadata service or scan the server's private network.
  if (target.protocol !== 'https:') return res.status(400).json({ ok: false, error: 'https URLs only' });
  if (isInternalHost(target.hostname)) return res.status(403).json({ ok: false, error: 'blocked host' });

  const report = { url: target.toString(), checks: {}, ts: new Date().toISOString() };

  // 1) Direct HEAD — does the publisher respond at all?
  try {
    const r = await fetchAsBrowser(target.toString(), { ua: UA_POOL[0], timeoutMs: 5_000 });
    report.checks.direct = { ok: r.ok, status: r.status, contentType: r.headers.get('content-type') || null };
  } catch (e) {
    report.checks.direct = { ok: false, error: e.message };
  }

  // 2) Asset proxy — does our /asset path succeed locally?  (Internal sanity check.)
  report.checks.assetProxy = { ok: !isInternalHost(target.hostname) && target.protocol === 'https:' };

  // 3) Proxy stack availability
  report.checks.proxies = proxyStatus;

  report.ok = !!report.checks.direct?.ok;
  res.json(report);
});

// ========================================================================
// /play/:slug — server-templates the wrapper HTML
// ========================================================================
const GAME_TEMPLATE = readFileSync(join(PUBLIC_DIR, 'game.html'), 'utf8');
const htmlEscape = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

// IFRAME_SRC: the iframe loads through the server-side /embed PROXY by default.
// One consistent, cacheable load — no "loads direct, then reloads through the
// proxy" double-load, and no per-game X-Frame-Options surprises. The embed HTML
// is cached server-side + at the browser, so repeat opens are effectively
// instant. `?direct=1` forces the raw publisher URL (debugging / escape hatch);
// if the proxy ever fails for a game, the page JS falls back to direct on its own.
//
// For any GameDistribution URL, rewrite (or set) the gd_sdk_referrer_url
// query param to the LIVE host + /play path.  This is the load-bearing fix
// behind getting GD analytics + premium games to work on whatever domain
// you deploy to — the static value baked into the JSON catalogs would only
// be right on one domain.  Non-GD URLs are returned untouched.
function injectGdReferrer(rawUrl, originUrl, slug) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (u.host.toLowerCase() !== 'html5.gamedistribution.com') return rawUrl;
    u.searchParams.set('gd_sdk_referrer_url', `${originUrl}/play/${encodeURIComponent(slug)}`);
    return u.toString();
  } catch {
    return rawUrl;
  }
}

// Look a single game up LIVE in Supabase by slug. Used as a fallback when the
// in-memory catalog doesn't have it yet — e.g. a game added to the DB since the
// last 30-min refresh, or the brief window right after a restart when we're still
// serving the bundled set. Guarantees a tapped game always opens. Result is
// cached into bySlug so the next tap is instant.
async function fetchGameBySlug(slug) {
  const supa = getSupabase();
  if (!supa || !slug) return null;
  try {
    const { data, error } = await supa
      .from('games_public')
      .select('slug, title, game_url, thumbnail_url, category')
      .eq('slug', slug)
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const game = normalizeRuntimeEntry(data);
    if (!game) return null;
    // Respect serve-layer overrides (licensing removals) on this direct-DB
    // fallback too — otherwise a bookmarked or search-indexed /play/<slug> for a
    // deliberately-hidden game (e.g. HTMLGames' license-blocked titles) would
    // still load it, bypassing the catalog filter.
    const [kept] = applyCatalogOverrides([game], { injectAdds: false });
    if (!kept) return null;
    if (kept.slug) bySlug.set(kept.slug, kept);    // warm the cache for next time
    return kept;
  } catch (e) {
    console.warn('[zofhub] fetchGameBySlug failed:', e.message);
    return null;
  }
}

app.get('/play/:gameSlug', async (req, res) => {
  let game = bySlug.get(req.params.gameSlug);
  if (!game) game = await fetchGameBySlug(req.params.gameSlug);   // live DB fallback
  if (!game) return send404(req, res);
  // Live origin from the actual request — handles localhost dev, custom
  // domains, and proxied production (Render/Railway/Fly set
  // x-forwarded-proto + x-forwarded-host that Express respects when
  // `trust proxy` is on; here we read both with a sensible fallback).
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host  = req.headers['x-forwarded-host']  || req.get('host');
  const liveOrigin = `${proto}://${host}`;

  const dynamicEmbedUrl = injectGdReferrer(game.embed_url, liveOrigin, game.slug);
  const proxySrc = `/embed/${game.slug}`;

  // ── Load-path routing ────────────────────────────────────────────────────
  // Two goals pull in opposite directions, so routing is per-BUILD + per-HOST:
  //
  //  1) HUB build (SITE_MODE=hub, ads on) → load games the FAST, reliable way:
  //     GameDistribution/GameMonetize DIRECT (their SDK does origin/referrer
  //     checks that FAIL when re-served through our proxy → black screen; direct
  //     is also their intended, ad-supported method). Y8 stays proxied because
  //     it needs the injected fit-to-frame CSS (see Y8_FIT_CSS).
  //
  //  2) PROXY build (SITE_MODE=full, the "unblock at school" domain) → load
  //     games SAME-ORIGIN through /embed so a network filter only ever sees THIS
  //     domain, never the game CDN. EXCEPTION: GameDistribution + GameMonetize
  //     stay DIRECT even here — proxying black-screens them, and their assets
  //     come from generic HTML5 game CDNs that content filters almost never
  //     block, so a direct embed still loads behind a school filter.
  //
  // ?direct=1 / ?proxy=1 force a path (per-game escape hatch).
  let embedHost = '';
  try { embedHost = new URL(game.embed_url).host.toLowerCase(); } catch {}
  const isY8 = /(^|\.)y8\.com$/.test(embedHost);
  // HTMLGames ship as a full self-scaling page whose CSS/JS are RELATIVE — served
  // through /embed they get a corrected <base href> (so styles actually load) +
  // fit CSS + a same-origin context. Direct-embedding them worked on the hub but
  // broke on the proxy build (relative assets 404'd → unstyled). Proxy on EVERY
  // build so htmlgames renders identically and correctly everywhere.
  const isHtmlGames = /(^|\.)htmlgames\.com$/.test(embedHost);
  // Famobi games render in-frame direct, BUT their title-screen "Play" button
  // and in-game links use target=_blank / window.open, so direct-embedded they
  // pop the game into a NEW TAB. Route them through /embed on every build so the
  // injected EMBED_GUARD rewrites those to same-frame navigation (in-iframe, no
  // new tab). Verified the proxy renders Famobi identically to direct.
  const isFamobi = /(^|\.)famobi\.com$/.test(embedHost);
  // SDK-sensitive publishers that black-screen when proxied — always DIRECT.
  const isSdkDirectOnly = /(^|\.)(gamedistribution\.com|gamemonetize\.(com|co))$/.test(embedHost);
  let iframeSrc;
  if (req.query.direct === '1')                 iframeSrc = dynamicEmbedUrl;
  else if (req.query.proxy === '1')             iframeSrc = proxySrc;
  else if (isY8 || isHtmlGames || isFamobi)     iframeSrc = proxySrc;      // fit CSS + same-origin relative-asset resolution + EMBED_GUARD (no new-tab) on every build
  else if (PROXY_ENABLED && !isSdkDirectOnly)   iframeSrc = proxySrc;      // unblock build → same-origin everything safe to proxy
  else                                          iframeSrc = dynamicEmbedUrl;

  // Preconnect to the publisher origin so the browser opens TCP+TLS in parallel
  // with the rest of the page HTML — shaves 200-600ms off iframe first byte.
  let preconnectOrigin = '';
  try { preconnectOrigin = new URL(game.embed_url).origin; } catch {}
  // Absolute og:image for social crawlers (Facebook/LinkedIn reject relative
  // URLs). CDN thumbnails are already absolute; local /thumbs/* get the request
  // origin prepended; thumbnail-less games fall back to the brand favicon.
  const ogImage = (() => {
    const t = (game.thumbnail || '').trim();
    if (/^https?:\/\//i.test(t)) return t;
    const origin = requestOrigin(req);
    if (!t) return origin + '/assets/favicon.png';
    return origin + (t.startsWith('/') ? t : '/' + t);
  })();
  const html = GAME_TEMPLATE
    .replace(/\{\{OG_IMAGE\}\}/g,     htmlEscape(ogImage))
    .replace(/\{\{TITLE\}\}/g,        htmlEscape(game.title))
    .replace(/\{\{SLUG\}\}/g,         htmlEscape(game.slug))
    .replace(/\{\{IFRAME_SRC\}\}/g,   htmlEscape(iframeSrc))
    .replace(/\{\{SRC\}\}/g,          htmlEscape(iframeSrc))
    .replace(/\{\{UPSTREAM_URL\}\}/g, htmlEscape(dynamicEmbedUrl))
    .replace(/\{\{PROXY_URL\}\}/g,    htmlEscape(`/embed/${game.slug}`))
    .replace(/\{\{PRECONNECT_ORIGIN\}\}/g, htmlEscape(preconnectOrigin))
    .replace(/\{\{CATEGORY\}\}/g,     htmlEscape(game.category || 'Game'))
    .replace(/\{\{PLATFORM\}\}/g,     htmlEscape(game.platform || ''))
    .replace(/\{\{ORIENTATION\}\}/g,  htmlEscape(game.orientation || 'landscape'))
    .replace(/\{\{THUMBNAIL\}\}/g,    htmlEscape(game.thumbnail || ''))
    // directOnly = GameMonetize/GameDistribution — the client loader must NEVER
    // fall back to the proxy for these (it black-screens them). Emitted as a bare
    // JS boolean into window.ZOFHUB_GAME, so no htmlEscape.
    .replace(/\{\{DIRECT_ONLY\}\}/g,  isSdkDirectOnly ? 'true' : 'false')
    .replace(/\{\{SCORE_TOKEN\}\}/g,  htmlEscape(issueScoreToken(game.slug)));
  res.set('Cache-Control', 'no-cache').send(html);
});

// ========================================================================
// /ads.txt — IAB authorized-digital-sellers declaration.
// ZoFHub is a proxy site and uses NO Google AdSense. It monetizes via
// proxy-friendly networks (Adsterra / HilltopAds / Monetag / …). Most of those
// use popunder/push formats that need no ads.txt entry; if a network DOES give
// you one, add it via the ADS_TXT_EXTRA env var (\n-separated). In-game ads run
// under each game publisher's own domain/ads.txt, not here.
app.get('/ads.txt', (req, res) => {
  const lines = [
    '# ads.txt — Authorized Digital Sellers (IAB Tech Lab).',
    '# ZoFHub uses proxy-friendly ad networks, not Google AdSense.',
    '# In-game ads run under each game publisher\'s own domain/ads.txt, not here.',
  ];
  const extra = (process.env.ADS_TXT_EXTRA || '').replace(/\\n/g, '\n').trim();
  if (extra) lines.push(extra);
  res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(lines.join('\n') + '\n');
});

// ========================================================================
// /robots.txt — keep proxy/utility + internal routes out of search indexing.
// The web-proxy pages can get a domain classified as a proxy/anonymizer, and the
// internal API/embed/asset routes shouldn't be crawled — but the games/content
// pages stay fully crawlable (and the sitemap is advertised) for SEO.
function requestOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.get('host') || '';
  return `${String(proto).split(',')[0]}://${host}`.replace(/\/+$/, '');
}

app.get('/robots.txt', (req, res) => {
  const lines = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /embed/',
    'Disallow: /asset',
    'Disallow: /browser',
    'Disallow: /gust',
    'Disallow: /proxy',
    'Disallow: /uv/',
    'Disallow: /scram/',
    'Disallow: /epoxy/',
    'Disallow: /baremux/',
    'Disallow: /bare/',
    'Disallow: /wisp/',
  ];
  // Advertise the sitemap so search engines discover the games catalog (the
  // proxy routes above are already disallowed, so only content pages get crawled).
  lines.push('', `Sitemap: ${requestOrigin(req)}/sitemap.xml`);
  res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(lines.join('\n') + '\n');
});

// ---- /sitemap.xml — lists the home, hub sections, every category, and every
// game page so search engines discover the whole catalog (SEO → organic traffic
// → ad revenue). Built from the in-memory catalog, cached ~30 min per origin. ----
let _sitemap = { xml: '', at: 0, origin: '', gen: null };
app.get('/sitemap.xml', (req, res) => {
  const origin = requestOrigin(req);
  const now = Date.now();
  // Cache is keyed on the catalog's generation stamp so it regenerates the moment
  // the live Supabase set replaces the bundled fallback (otherwise the first hit
  // right after a deploy would freeze a tiny bundled-catalog sitemap for 30 min).
  if (_sitemap.xml && _sitemap.origin === origin && _sitemap.gen === CATALOG.generatedAt && now - _sitemap.at < 30 * 60 * 1000) {
    return res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(_sitemap.xml);
  }
  const esc = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  const rows = [];
  const add = (path, priority, changefreq) =>
    rows.push(`  <url><loc>${esc(origin + path)}</loc><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`);
  add('/', '1.0', 'daily');
  add('/leaderboard', '0.6', 'daily');
  add('/community', '0.5', 'weekly');
  add('/ai', '0.5', 'monthly');
  const cats = new Set();
  for (const g of CATALOG.games) { const c = (g.category || '').toLowerCase(); if (c) cats.add(c); }
  for (const c of cats) add(`/category/${encodeURIComponent(c)}`, '0.7', 'weekly');
  for (const g of CATALOG.games) if (g.slug) add(`/play/${encodeURIComponent(g.slug)}`, '0.8', 'weekly');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
  _sitemap = { xml, at: now, origin, gen: CATALOG.generatedAt };
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(xml);
});

// Browsers auto-request /favicon.ico; our icon is a PNG under /assets. Serve it
// so the request isn't a 404 (some crawlers/ad reviewers flag missing favicons).
app.get('/favicon.ico', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(join(PUBLIC_DIR, 'assets', 'favicon.png'), err => { if (err) res.status(404).end(); });
});

// Frontend config read at load. ZoFHub is always a proxy site monetized by
// proxy-friendly ad networks (no AdSense). Google ad code is filtered out of both
// the page-level scripts and the footer banner so it can never load on a proxy
// domain. layout.js reads this to wire up proxy-ads.js + the footer banner.
app.get('/api/site-config', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  // PROXY_AD_SCRIPTS — page-level loader script URL(s), comma-separated (Adsterra
  // popunder, Monetag push, etc.). https only; any Google ad URL is dropped.
  const proxyAdScripts = (process.env.PROXY_AD_SCRIPTS || '').split(',').map(s => s.trim())
    .filter(s => /^https:\/\//i.test(s) && !/googlesyndication|googleadservices|adsbygoogle|doubleclick/i.test(s));
  // PROXY_BANNER_TAG — optional raw footer banner tag (e.g. a HilltopAds / Adsterra
  // 728×90 unit). Refused outright if it contains Google ad code.
  const rawBanner = (process.env.PROXY_BANNER_TAG || '').trim();
  const proxyBannerTag = /googlesyndication|googleadservices|adsbygoogle|doubleclick/i.test(rawBanner) ? '' : rawBanner;
  res.json({ proxy: true, proxyAdScripts, proxyBannerTag });
});

app.get('/',         (req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));
app.get('/ai',       (req, res) => res.sendFile(join(PUBLIC_DIR, 'ai.html')));
app.get('/browser',  (req, res) => res.sendFile(join(PUBLIC_DIR, 'browser.html')));
// GUST — the primary, service-worker-free proxy browser. `/gust` and `/proxy`
// both resolve to the vendored single-file app (its sub-assets live under
// /gust/vendor/ and are served by the static mount above).
app.get(['/gust', '/proxy'], (req, res) => res.sendFile(join(PUBLIC_DIR, 'gust', 'index.html')));
app.get('/community',(req, res) => res.sendFile(join(PUBLIC_DIR, 'community.html')));
app.get('/leaderboard',(req, res) => res.sendFile(join(PUBLIC_DIR, 'leaderboard.html')));

// ========================================================================
// Legal pages — Privacy / Terms / DMCA / Cookies.
// Sources live OUTSIDE /public (in ./legal) so the raw {{tokens}} are never
// served statically; we template them here once at boot. The contact details
// come from ONE env var (CONTACT_EMAIL) so you never hard-code your inbox.
// Always served — legal pages (privacy / terms / DMCA / cookies) are required.
// ========================================================================
const LEGAL_DIR = join(__dirname, 'legal');
const REPO_URL  = 'https://github.com/ZSM1010/ZoFHub-Gaming-AI-Browser-Hub';
const contactEmail = (process.env.CONTACT_EMAIL || '').trim();
const CONTACT_HTML = contactEmail
  ? `<a href="mailto:${htmlEscape(contactEmail)}">${htmlEscape(contactEmail)}</a>`
  : `<a href="${REPO_URL}/issues" target="_blank" rel="noopener">our GitHub Issues page</a>`;
const SITE_URL_HTML = (process.env.SITE_URL || '').trim()
  ? htmlEscape(process.env.SITE_URL.trim())
  : 'this website';
function renderLegal(file) {
  const raw = readFileSync(join(LEGAL_DIR, file), 'utf8');
  return raw.replace(/\{\{CONTACT\}\}/g, CONTACT_HTML)
            .replace(/\{\{SITE_URL\}\}/g, SITE_URL_HTML);
}
const LEGAL_PAGES = {
  '/privacy': 'privacy.html',
  '/terms':   'terms.html',
  '/dmca':    'dmca.html',
  '/cookies': 'cookies.html',
  '/credits': 'credits.html',
};
for (const [route, file] of Object.entries(LEGAL_PAGES)) {
  if (!existsSync(join(LEGAL_DIR, file))) continue;
  const html = renderLegal(file);           // template once at boot
  app.get(route, (req, res) => res.set('Cache-Control', 'public, max-age=3600').send(html));
}

// ========================================================================
// /category/:catSlug — server-templates a per-category page
// (each is its own URL — DOM only ever holds one page of <=60 tiles)
// ========================================================================
const CATEGORY_TEMPLATE = readFileSync(join(PUBLIC_DIR, 'category.html'), 'utf8');
app.get('/category/:catSlug', (req, res) => {
  const slug = String(req.params.catSlug).toLowerCase();
  const matching = CATALOG.games.filter(g => g.category === slug);
  if (!matching.length) return send404(req, res);
  const label = matching[0].category_label
              || (slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '));
  const html = CATEGORY_TEMPLATE
    .replace(/\{\{CAT_SLUG\}\}/g,  htmlEscape(slug))
    .replace(/\{\{CAT_LABEL\}\}/g, htmlEscape(label))
    .replace(/\{\{CAT_COUNT\}\}/g, String(matching.length));
  res.set('Cache-Control', 'no-cache').send(html);
});

// Shared 404 responder: a styled full page for browser navigations, compact JSON
// for API/asset/XHR requests. Declared here (hoisted) so the /play and /category
// not-found branches above can reuse it for one consistent look site-wide.
function send404(req, res) {
  res.status(404);
  const wantsHtml = (req.headers.accept || '').includes('text/html') && !req.path.startsWith('/api/');
  if (wantsHtml) {
    res.set('Cache-Control', 'no-store');
    return res.sendFile(join(PUBLIC_DIR, '404.html'));
  }
  return res.json({ error: 'not found' });
}

// Catch-all 404 — any route that matched nothing above. MUST stay last, right
// before the error handler, so real routes and express.static win first.
app.use((req, res) => send404(req, res));

app.use((err, req, res, _next) => {
  // Log the full error server-side; return a generic message so internal details
  // (stack traces, DB/driver strings) are never disclosed to clients.
  console.error('[zofhub] error:', err);
  res.status(err.status || 500).json({ error: 'Something went wrong. Please try again.' });
});

// ========================================================================
// HTTP + WebSocket
// ========================================================================
httpServer.on('request', app);
httpServer.on('upgrade', (req, socket, head) => {
  try {
    if (req.url?.startsWith('/wisp/') && wisp?.routeRequest) wisp.routeRequest(req, socket, head);
    else socket.end();
  } catch (err) { console.error('[zofhub] upgrade error:', err); try { socket.end(); } catch {} }
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  [zofhub] port ${PORT} is already in use.`);
    console.error(`  Run:  npm run kill-port      then  npm start`);
    console.error(`  Or:   npm run restart        (does both in one step)\n`);
    process.exit(1);
  }
  throw err;
});

loadCatalog();                       // synchronous bundled load — guarantees a catalog
startCronJobs();
// Upgrade to the live Supabase catalog (best-effort; bundled stays if it fails),
// then keep it fresh so auto-grown games appear without a restart.
refreshCatalogFromSupabase().then(ok => {
  if (ok) console.log(`  → catalog upgraded to live Supabase set`);
  // Load persisted play counts AFTER the catalog exists so we can attach them.
  return loadPlayStats();
});
setInterval(() => { refreshCatalogFromSupabase().catch(() => {}); }, CATALOG_REFRESH_MS).unref();
// Flush changed play counts to Supabase once a minute (also prunes the dedup map).
setInterval(() => { flushPlayStats().catch(() => {}); }, 60 * 1000).unref();
function startListening(host) {
  httpServer.listen(PORT, host, () => {
    const enabled = Object.entries(proxyStatus).filter(([, v]) => v).map(([k]) => k);
    const url = `http://localhost:${PORT}`;
    console.log(`\n  ZoFHub v3 running`);
    console.log(`  → Open in your browser: ${url}`);
    console.log(`  → catalog: ${CATALOG.source}`);
    console.log(`  → proxy:   ${enabled.length ? enabled.join(', ') : 'offline'}`);
    console.log(`  → press Ctrl+C in this terminal to stop the server\n`);
    openInBrowser(url);
  });
}
// Some environments disable IPv6; fall back to IPv4 if dual-stack bind fails.
httpServer.once('error', (e) => {
  if (HOST === '::' && (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL')) {
    console.warn('[zofhub] IPv6 bind failed — falling back to 0.0.0.0 (IPv4).');
    httpServer.removeAllListeners('error');
    startListening('0.0.0.0');
  } else {
    console.error('[zofhub] listen error:', e.message);
    process.exit(1);
  }
});
startListening(HOST);
