import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { exec, spawn } from 'node:child_process';
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
// process.loadEnvFile() does NOT overwrite variables already present in the real
// environment — verified, not assumed. So a host's dashboard values always win
// and a file can only FILL GAPS. Two consequences worth being explicit about:
//
//   1. .env is committed in this repo (deliberately — see .gitignore). On a host
//      it therefore acts as a silent fallback for anything the dashboard didn't
//      set. That is convenient and also how a secret quietly ends up sourced
//      from git, so in production we log exactly which keys came from the file.
//   2. .env.example is a LAST RESORT (e.g. Docker, where .dockerignore excludes
//      .env). It ships placeholders like "change-me-to-a-long-random-string".
//      Letting those through would mean ADMIN_SECRET is literally the string
//      "change-me-…" — a documented password, i.e. no password at all. So
//      placeholder values are stripped rather than used, which makes each
//      feature take its own safe path: admin auth fails CLOSED, Supabase reports
//      unconfigured, SCORE_SECRET falls back to a random per-boot value.
const PLACEHOLDER = /^(change-me|your-|YOUR_|<|\.\.\.|https:\/\/your-|sb_publishable_your)/;
// The `<` branch above exists to catch .env.example dummies written as <your-key>.
// But a REAL ad banner tag is raw HTML and always starts with "<script>", so it
// matched too — and was deleted as a placeholder. The failure was silent and
// total: the banner never rendered, its origin never reached the CSP allowlist,
// and nothing was logged. Following the documented setup
// (`PROXY_BANNER_TAG=<script>…` in .env) therefore earned exactly $0 with no
// error to explain why.
//
// These three vars are HTML by definition, so the `<` heuristic can never apply
// to them. They are still validated properly downstream: /api/site-config strips
// any Google ad code, and only https origins reach the CSP.
const HTML_VALUED_KEYS = new Set(['PROXY_BANNER_TAG', 'PROXY_HEADER_TAG', 'PROXY_SIDEBAR_TAG']);
const isPlaceholder = (key, value) => !HTML_VALUED_KEYS.has(key) && PLACEHOLDER.test(value);
const envFileKeys = [];
for (const f of ['.env', '.env.example']) {
  const p = join(__dirname, f);
  if (!existsSync(p) || typeof process.loadEnvFile !== 'function') continue;
  const before = new Set(Object.keys(process.env));
  try {
    process.loadEnvFile(p);
    for (const k of Object.keys(process.env)) {
      if (before.has(k)) continue;                       // real environment supplied it
      if (isPlaceholder(k, String(process.env[k] ?? '').trim())) { delete process.env[k]; continue; }
      envFileKeys.push(k);
    }
    console.log(`[zofhub] loaded env from ${f}`);
    if (f === '.env.example') {
      console.warn('[zofhub] WARNING: no .env found — reading .env.example. Placeholder values are ignored. Copy .env.example → .env and fill it in.');
    }
    break;
  } catch (e) {
    console.warn(`[zofhub] failed to load ${f}:`, e.message);
  }
}
if (process.env.NODE_ENV === 'production' && envFileKeys.length) {
  const SECRETISH = envFileKeys.filter(k => /SECRET|KEY|TOKEN|PASSWORD/i.test(k));
  console.warn(`[zofhub] ${envFileKeys.length} env var(s) came from the committed env file, not from this host: ${envFileKeys.join(', ')}`);
  if (SECRETISH.length) {
    console.warn(`[zofhub] ${SECRETISH.length} of those are SECRETS (${SECRETISH.join(', ')}). Set them in your host's dashboard so rotating one is not a git commit.`);
  }
}

// Supabase is replacing the legacy `service_role` JWT with a new `sb_secret_…`
// key (legacy keys can no longer be rotated, and retire at the end of 2026).
// Both do the same job — they bypass RLS — so this mirrors whichever one you
// filled in across BOTH env names before anything reads them. Without it,
// pasting the new key into SUPABASE_SECRET_KEY would leave the ten CLI tools
// that read SUPABASE_SERVICE_ROLE_KEY by name reporting "not configured" while
// the server itself worked fine. See lib/supabase-keys.mjs.
const { normalizeSupabaseKeys } = await import('./lib/supabase-keys.mjs');
const supaKeyInfo = normalizeSupabaseKeys();
if (supaKeyInfo.present) {
  console.log(`[zofhub] Supabase admin key: ${supaKeyInfo.format} (from ${supaKeyInfo.source})`
    + (supaKeyInfo.bothSet ? ' — both slots set, the new secret key wins' : ''));
  if (supaKeyInfo.format === 'legacy-jwt') {
    console.warn('[zofhub] that is a LEGACY service_role key. Supabase retires these at the end of 2026 and they cannot be rotated — create a secret key (Settings → API Keys) and paste it into SUPABASE_SECRET_KEY.');
  }
} else if (process.env.SUPABASE_URL && (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY)) {
  // Supabase IS configured, just not with an admin key. This deployment can read
  // but not write, and every symptom of that shows up far from the cause: score
  // submissions accepted then absent, play counters frozen, the link-checker
  // reporting success while updating nothing. Say it once, at boot, in the one
  // place an operator actually looks.
  console.warn('[zofhub] Supabase has NO ADMIN KEY — only the publishable key is set. Reads will work; every WRITE will be refused by RLS. Set SUPABASE_SECRET_KEY (Dashboard → Settings → API Keys) to enable writes.');
}

// These modules read process.env at import time, so they must be imported
// AFTER the env-file load above.
// getSupabase()      — read paths. Admin key if present, else publishable.
// getSupabaseAdmin() — write paths ONLY. Null unless a secret/service-role key
//                      is configured, so a write endpoint returns a clear 503
//                      instead of issuing an INSERT that RLS will refuse with
//                      an opaque 42501 the caller can do nothing about.
const { getSupabase, getSupabaseAdmin, isSupabaseConfigured, supabaseKeepAlive, supabaseHealth } = await import('./lib/supabase.mjs');
const { startCronJobs, isTrademarkTitle }  = await import('./lib/cron-jobs.mjs');
const { getCache }                         = await import('./lib/cache.mjs');
const { publicProviderList, MODEL_FALLBACKS }               = await import('./lib/ai-providers.mjs');
const { applyCatalogOverrides }            = await import('./lib/catalog-overrides.mjs');
const { healthyModels, candidateModels, markFailure, markSuccess, withRetry,
        healthSnapshot, modelPriority } = await import('./lib/ai-pipeline.mjs');
const weather = await import('./lib/weather.mjs');
const { checkUrlSafety, findDuplicates } = await import('./lib/game-discovery.mjs');
const { assessScore } = await import('./lib/score-integrity.mjs');
// The review half of the same system: parsing a reviewer's filters and turning a
// stored flag_evidence blob back into something a person can act on.
const { parseScoreQuery, searchFilter, explainEvidence, summarizePlayer }
  = await import('./lib/score-review.mjs');
// Imported EARLY on purpose: renderDependencyTable() runs while routes are
// being registered, which is before the late import block. A `const` from a
// later `await import` is still in the temporal dead zone at that point, and
// the server crashed at boot with "Cannot access 'getCredits' before
// initialization" until this moved up here.
const { getCredits, creditsSummary } = await import('./lib/credits.mjs');
// Admin authentication: scrypt password verification, database-backed sessions,
// lockout, CSRF and the append-only audit trail. See lib/admin-auth.mjs.
const adminAuth = await import('./lib/admin-auth.mjs');
const { loadSimilarityIndex, recommend: recommendGames, indexSize: simIndexSize } =
  await import('./lib/recommender.mjs');
// Loads data/game-similarity.json once, at boot. Missing file is fine — the
// recommender degrades to category affinity and logs how to build it.
loadSimilarityIndex(join(__dirname, 'data'));

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

// ========================================================================
// Thumbnail proxying — why this exists
// ------------------------------------------------------------------------
// Most of the catalog's thumbnails live on publisher CDNs whose DOMAINS are on
// ad-blocker filter lists. The big one is img.gamemonetize.com (GameMonetize is
// an ad-monetization company, so uBlock Origin / AdGuard / Brave block the host
// outright) — that's ~60% of the catalog. A blocked image is indistinguishable
// from a broken one, so those tiles fell back to the initials placeholder for
// any visitor running a blocker. Self-hosting every image would mean committing
// ~500 MB of files; instead we re-serve them from OUR origin under a neutral
// /thumb path, which no filter list can match.
//
// Only known game-CDN hosts are proxied; anything else is left untouched (so
// this can never be used as a general-purpose open image proxy).
const THUMB_PROXY_HOSTS = /(^|\.)(gamemonetize\.(com|co)|gamedistribution\.com|famobi\.com|htmlgames\.com|onlinegames\.io|y8\.com|gameflare\.com|gamezop\.com|poki\.com|cloudimage\.io)$/i;

// ── Hosts this server must never fetch on a caller's behalf ────────────────
// ZoFHub's AI runs in the visitor's browser. /asset is a deliberately general
// cross-origin GET proxy — the injected iframe shim routes game assets through
// it to fix WebGL canvas tainting — and "general" included AI providers, so
//
//     GET /asset?u=https://image.pollinations.ai/prompt/<anything>
//     GET /asset?u=https://text.pollinations.ai/<prompt>
//
// turned this server into exactly the AI proxy it is designed never to be:
// it fetched the endpoint, downloaded the response and streamed it back.
// Verified before this guard existed — the server relayed Pollinations' own
// API response body verbatim.
//
// A denylist rather than an allowlist, because /asset legitimately serves an
// open-ended set of game CDNs; an allowlist would break games. These hosts are
// refused outright rather than redirected: /asset exists for game assets, and
// 302-ing an arbitrary caller-supplied URL would turn it into an open redirect.
// No legitimate game asset lives on an inference endpoint.
const AI_PROVIDER_HOSTS = /(^|\.)(pollinations\.ai|aihorde\.net|stablehorde\.net|openai\.com|anthropic\.com|claude\.ai|generativelanguage\.googleapis\.com|api\.groq\.com|api\.mistral\.ai|api\.cohere\.(ai|com)|api\.deepseek\.com|api\.together\.xyz|api\.replicate\.com|replicate\.delivery|fal\.(ai|run)|api\.openrouter\.ai|openrouter\.ai|huggingface\.co|api-inference\.huggingface\.co|api\.stability\.ai|api\.x\.ai|api\.perplexity\.ai)$/i;

// Rewrite a remote thumbnail URL to the same-origin proxy. Local paths
// (/thumbs/…, already self-hosted) and unknown hosts pass through unchanged.
function thumbUrl(u) {
  if (!u) return '';
  const s = String(u).trim();
  if (!/^https?:\/\//i.test(s)) return s;          // already local / relative
  try {
    if (!THUMB_PROXY_HOSTS.test(new URL(s).hostname)) return s;
    return '/thumb?u=' + encodeURIComponent(s);
  } catch { return s; }
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
    thumbnail: thumbUrl(g.thumbnail || g.thumbnail_url || g.thumbnailUrl || g.image || g.imageUrl || ''),
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
  // Primary source: api/games.json — the DEPLOYED file was produced by
  // tools/build-mvp.mjs (it carries "source": "mvp-curated" and that tool's
  // hardcoded 170-game MVP list). tools/build-curated.mjs is a different,
  // unused-in-production builder with a different output shape.
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

// ------------------------------------------------------------------------
// Feed ranking artifact, from tools/analyze-catalog.py (npm run feed-rank).
//
// Two things come out of that analysis and are used below:
//   • scores          slug -> 0..1. Encodes what the catalog data actually
//                     supports: duplicate titles demoted (2,348 games share a
//                     title with another) and junk titles demoted. Deliberately
//                     COARSE — see the long note in the Python about why a
//                     fine-grained score invented category clustering that was
//                     not in the data.
//   • categoryBalance category -> 0..1, used as a per-page diversity cap so one
//                     category cannot own the grid ("arcade" is 31.7% of the
//                     catalog).
// Optional, like mood-tags: absent file means the feed ranks exactly as it did
// before, with no error.
// ------------------------------------------------------------------------
let FEED_SCORES = new Map();
let CATEGORY_BALANCE = new Map();
let FEED_PLAYS_TOTAL = 0;
try {
  const frFile = join(__dirname, 'data', 'feed-ranking.json');
  if (existsSync(frFile)) {
    const fr = JSON.parse(readFileSync(frFile, 'utf8'));
    FEED_SCORES = new Map(Object.entries(fr.scores || {}));
    CATEGORY_BALANCE = new Map(Object.entries(fr.categoryBalance || {}));
    FEED_PLAYS_TOTAL = Number(fr.stats?.playsTotal) || 0;
    console.log(`[zofhub] feed-ranking loaded: ${FEED_SCORES.size} scores, `
      + `${fr.stats?.duplicatesDemoted || 0} duplicates demoted`);
  } else {
    console.log('[zofhub] no data/feed-ranking.json — feed uses popularity only. '
      + 'Build it with: npm run feed-rank');
  }
} catch (e) { console.warn('[zofhub] feed-ranking load failed:', e.message); }

// 0..1 quality/dedup score for a game; 1.0 (neutral) when unknown, so a game
// missing from the artifact is never punished for it.
const feedScore = (g) => {
  const s = FEED_SCORES.get(g.slug);
  return s === undefined ? 1.0 : s;
};

function setCatalog(games, source) {
  // Merge in finalgames.json (the repo-root master list) FIRST, so its games are
  // present whether this catalog came from the bundled JSON or from Supabase.
  games = mergeFinalGames(games);
  // Apply in-repo display overrides (rename/re-thumbnail/hide) BEFORE indexing,
  // so the homepage grid, category pages, /play, search and counts are all
  // consistent — no DB write required. See lib/catalog-overrides.mjs.
  games = applyCatalogOverrides(games);
  // Single choke point for thumbnail proxying: every catalog path (bundled JSON,
  // Supabase refresh, finalgames merge, override `add`/`set` rules) ends up here,
  // so routing ad-blocked publisher CDNs through /thumb once here covers them all.
  // thumbUrl() is idempotent — an already-proxied or local path passes through.
  for (const g of games) {
    if (!g) continue;
    if (g.thumbnail)     g.thumbnail     = thumbUrl(g.thumbnail);
    if (g.thumbnail_url) g.thumbnail_url = thumbUrl(g.thumbnail_url);
  }
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
  // Game of the Day was keyed ONLY on the calendar date, so it survived catalog
  // rebuilds. The hourly link-check can mark today's pick is_working=false at any
  // hour; the next refresh then drops it from `bySlug`, but the cached payload
  // kept promoting it — leaving the homepage hero linking to a /play/<slug> that
  // 404s for the rest of the day. Dropping it here re-picks from the live set.
  gotdCache = { day: '', payload: null };
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
const QUALITY_WEIGHT = 1.4; // how strongly the feed-ranking artifact can sink a
                            // duplicate. A duplicate scores 0.25 vs 1.0, so it
                            // loses ~1.05 — more than the random term's full
                            // range, so a repeat title reliably falls behind its
                            // canonical copy, but not so much that it becomes
                            // unreachable.

// POPULARITY MUST EARN ITS WEIGHT.
//
// POP_WEIGHT multiplies popNorm ∈ [0,1] to [0,3] while the per-visit random term
// spans only [0,1]. So once a game passes popNorm ≈ 0.34 — about TEN plays — it
// outranks every zero-play game no matter what the random draw does. That is a
// ratchet: the first games to get any traffic are pinned to page 1, they collect
// more traffic because they are on page 1, and the remaining ~12,000 games can
// never surface. Classic rich-get-richer.
//
// It matters right now because the play data is 179 events across 71 games —
// our own testing. Without this gate, whichever handful of games we happened to
// click during development would permanently lead the feed for every visitor.
//
// So popularity's influence scales with how much evidence exists site-wide,
// mirroring the trust ramp in tools/analyze-catalog.py. At 179 plays the weight
// is ~0.01 (popularity is effectively off, which is correct); at 50k plays it
// reaches its full 3.0 with no code change.
const PLAYS_FOR_FULL_TRUST = 50000;
let _liveTotalPlays = 0;               // refreshed by the play-count loader
const popWeightNow = () =>
  POP_WEIGHT * Math.min(1, Math.max(FEED_PLAYS_TOTAL, _liveTotalPlays) / PLAYS_FOR_FULL_TRUST);

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
  // Same blend as weightedShuffle minus the per-visit randomness, so the
  // deterministic order (search results, no-seed requests) agrees with the
  // shuffled one about which games are worth showing — in particular it also
  // sinks duplicate titles instead of listing the same game three times.
  const key = (g) => popWeightNow() * popNorm(g)
                   + QUALITY_WEIGHT * feedScore(g)
                   + (hasThumb(g) ? THUMB_BONUS : 0);
  return [...list].sort((a, b) =>
    key(b) - key(a) ||
    String(a.title).localeCompare(String(b.title)));
}

// Per-visit blended order for a given seed.
function weightedShuffle(list, seed) {
  const keyed = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    const k = popWeightNow() * popNorm(g)
            + hashUnit(seed + '|' + (g.slug || g.title || i))
            + (hasThumb(g) ? THUMB_BONUS : 0)
            + QUALITY_WEIGHT * feedScore(g);
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
// 3-day grow cron feeds). This is what makes auto-grown games actually
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
      thumbnail: thumbUrl(g.thumbnail_url || ''),
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
    // Feeds the evidence gate on popularity ranking (popWeightNow). Recomputed
    // on every refresh so the feed starts trusting play data automatically as
    // real traffic arrives, without a redeploy.
    _liveTotalPlays = 0;
    for (const v of playCounts.values()) _liveTotalPlays += v;
    console.log(`[plays] loaded ${playCounts.size} play counts from game_stats `
      + `(${_liveTotalPlays} plays; popularity weight `
      + `${popWeightNow().toFixed(2)} of ${POP_WEIGHT})`);
  } catch (e) {
    console.warn('[plays] load failed (in-memory only):', e.message);
  }
}

async function flushPlayStats() {
  // Prune the dedup map regardless so it can't grow forever.
  const cutoff = Date.now() - 60000;
  for (const [k, ts] of playDedup) if (ts < cutoff) playDedup.delete(k);

  if (!playStatsTable || !playsDirty.size) return;
  const supa = getSupabaseAdmin();   // upserts game_stats
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

// ---------------------------------------------------------------------------
// Ad-network script origins, DERIVED FROM YOUR ENV — not a hardcoded list.
// ---------------------------------------------------------------------------
// The CSP below allowlists script-src. Until this existed, PROXY_AD_SCRIPTS /
// PROXY_BANNER_TAG could be filled in correctly and still earn NOTHING: the
// server happily served the URLs, proxy-ads.js happily injected them, and the
// browser then refused every one. Verified against the real loader domains
// Adsterra, HilltopAds and Monetag hand out — all four blocked, while an
// allowlisted CDN loaded fine. The only symptom is a console message, so the
// natural conclusion would have been "the ad network isn't paying out".
//
// A hardcoded list of network domains would rot: these networks rotate loader
// domains constantly (that is how they stay ahead of blocklists). So instead
// the allowlist is derived from whatever YOU configured — declare an ad script,
// and its origin is permitted; declare nothing and nothing is permitted. The
// allowlist can never drift from the config because it IS the config.
//
// Networks usually CHAIN (the loader pulls more scripts from sibling hosts), so
// each configured host also contributes a wildcard for its registrable domain —
// but only when the suffix is a plain single-label TLD. Skipping that check
// would turn a network on "ads.example.co.uk" into a wildcard for ALL of
// "*.co.uk". Anything else the chain needs goes in PROXY_AD_ORIGINS by hand.
const AD_ORIGINS = (() => {
  const set = new Set();
  const GENERIC_TLDS = new Set(['com','net','org','io','co','xyz','online','site','top','pro','info','biz','app','dev','cloud','live','media','digital','space','fun','click','link','shop','store']);
  const BANNED = /googlesyndication|googleadservices|adsbygoogle|doubleclick/i;

  const add = (raw) => {
    const s = String(raw || '').trim();
    if (!/^https:\/\//i.test(s) || BANNED.test(s)) return;   // https only; never Google's ad stack
    let u; try { u = new URL(s); } catch { return; }
    set.add(u.origin);
    const parts = u.hostname.split('.');
    if (parts.length > 2 && GENERIC_TLDS.has(parts[parts.length - 1])) {
      set.add(`https://*.${parts.slice(-2).join('.')}`);
    }
  };

  for (const s of (process.env.PROXY_AD_SCRIPTS || '').split(',')) add(s);
  // The banner slots are raw HTML tags, so pull any src="…" / src=… out of them.
  // ALL THREE must be scanned: a tag whose origin isn't allowlisted here is
  // refused by the browser with only a console message — it looks exactly like
  // the network not paying out. (PROXY_HEADER_TAG / PROXY_SIDEBAR_TAG feed the
  // header + sidebar slots in public/js/ad-slots.js.)
  for (const varName of ['PROXY_BANNER_TAG', 'PROXY_HEADER_TAG', 'PROXY_SIDEBAR_TAG']) {
    for (const m of String(process.env[varName] || '').matchAll(/src\s*=\s*["']?(https:\/\/[^"'\s>]+)/gi)) add(m[1]);
  }
  // Escape hatch: extra origins (wildcards allowed) for hosts the network's own
  // chain pulls in. Written through verbatim — still never Google's ad stack.
  for (const raw of (process.env.PROXY_AD_ORIGINS || '').split(',')) {
    const s = raw.trim();
    if (!s || !/^https:\/\//i.test(s) || BANNED.test(s)) continue;
    set.add(s);
    // A CSP wildcard does NOT cover its own apex: "https://*.foo.com" permits
    // cdn.foo.com but still blocks foo.com itself. Nobody writing this by hand
    // expects that, and the resulting failure is invisible (a console line and
    // no revenue), so accept the obvious intent and allow the apex too.
    if (s.startsWith('https://*.')) set.add('https://' + s.slice('https://*.'.length));
  }
  return [...set];
})();
if (AD_ORIGINS.length) console.log(`[ads] CSP allows ${AD_ORIGINS.length} ad origin(s): ${AD_ORIGINS.join(' ')}`);

const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: [
    // 'wasm-unsafe-eval' lets GUST's libcurl.js compile its embedded WebAssembly
    // even on browsers that no longer accept plain 'unsafe-eval' for wasm.
    "'self'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'",
    'https://cdn.jsdelivr.net', 'https://esm.sh', 'https://unpkg.com',
    // Google's ad stack is allowed here for PROXIED GAMES ONLY. A game served
    // same-origin through /embed runs under THIS policy, and many of them show
    // in-game GPT/AdSense units. ZoFHub itself never loads Google ad code — it
    // is stripped from PROXY_AD_SCRIPTS, PROXY_BANNER_TAG and AD_ORIGINS above,
    // because AdSense on a proxy domain is an account-level ban.
    'https://*.googlesyndication.com', 'https://*.google.com', 'https://*.googletagmanager.com',
    'https://*.adsafeprotected.com', 'https://*.playwire.com',
    'https://*.poki.com', 'https://*.y8.com',
    'https://*.supabase.co',
    ...AD_ORIGINS
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
// CORS: open for READS, same-origin for WRITES.
//
// This was `cors()` with no options, which sends
// `Access-Control-Allow-Origin: *` on everything — any website could POST to
// our write endpoints from a visitor's browser.
//
// What that did and did not mean matters, so it is written down rather than
// guessed at later: this app has NO cookies and NO sessions (identity lives in
// the visitor's own localStorage), so a cross-origin request carries no ambient
// credentials and classic CSRF does not apply. A CSRF token here would protect
// nothing. The real exposure was abuse — any third-party page could drive score
// submissions, community posts and AI calls through our rate limits using its
// own visitors' IPs.
//
// So: GET stays open, because the game catalog is public data and an open read
// API is a feature. Anything that writes must come from our own origin or an
// explicitly allowlisted one (CORS_ALLOWED_ORIGINS, comma-separated).
const CORS_ALLOWLIST = String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Our own public origin, derived from SITE_URL when it is set. Parsed once and
// defensively: a malformed SITE_URL must not take the server down at boot.
const SITE_URL_ORIGIN = (() => {
  try {
    const u = String(process.env.SITE_URL || '').trim();
    return u ? new URL(u).origin : null;
  } catch { return null; }
})();

app.use(cors({
  origin(origin, cb) {
    // No Origin header = same-origin navigation, curl, or a server-to-server
    // call. Never a browser cross-origin request, so nothing to block.
    if (!origin) return cb(null, true);
    if (CORS_ALLOWLIST.includes(origin)) return cb(null, true);
    if (SITE_URL_ORIGIN && origin === SITE_URL_ORIGIN) return cb(null, true);
    // Reflect for reads; the per-method gate below rejects cross-origin writes.
    return cb(null, true);
  },
  // Without credentials, a cross-origin caller can never act as a logged-in
  // user — which is the property that makes the read-open policy safe.
  credentials: false,
  methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
}));

// Enforce the write half of the policy above.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next();                                   // not a browser cross-origin call
  if (CORS_ALLOWLIST.includes(origin)) return next();
  if (SITE_URL_ORIGIN && origin === SITE_URL_ORIGIN) return next();
  try {
    // Same host as the request itself → our own frontend, whatever domain it is
    // deployed on. This keeps preview deployments working without configuration.
    if (new URL(origin).host === req.headers.host) return next();
  } catch { /* unparseable Origin → treat as cross-origin */ }
  res.set('Cache-Control', 'no-store');
  return res.status(403).json({ error: 'cross_origin_write_blocked' });
});

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
    'sync-xhr=*',

    // ── Explicitly DENIED ──────────────────────────────────────────────────
    // Permissions-Policy is an allowlist, so anything unlisted falls back to the
    // user agent's default — which for a same-origin document is generally
    // "allowed". Listing these with an EMPTY allowlist `=()` turns them off for
    // this document AND for every iframe it embeds, which matters here because
    // the site embeds thousands of third-party games and ad frames.
    //
    // Nothing ZoFHub does needs any of them: there are no accounts, no uploads,
    // no location features, and the AI runs in the browser against a public
    // endpoint. Denying them means an embedded game or ad tag cannot even
    // prompt for camera, microphone or location, and cannot silently join
    // Google's Topics interest-cohort advertising API.
    'geolocation=()',
    'camera=()',
    'microphone=()',
    'browsing-topics=()',      // Google Topics API — interest-based ad profiling
    'interest-cohort=()',      // legacy FLoC name, still honoured by some builds
    'idle-detection=()',       // reports when the user steps away from the device
    'local-fonts=()',          // enumerating installed fonts is a fingerprinting vector
    'usb=()',
    'serial=()',
    'bluetooth=()',
    'hid=()',
    'midi=()',
    'display-capture=()',      // screen recording
    'attribution-reporting=()',// ad attribution measurement
    'run-ad-auction=()',       // Protected Audience / FLEDGE on-device ad auctions
    'join-ad-interest-group=()',
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

// ---- Canonical redirects for the `.html` twins of the legal pages ----------
// MUST be registered BEFORE express.static below. The legal pages are served
// extensionless (/credits) from ./legal, templated at boot so {{CONTACT}} becomes
// the real address — which is why their source cannot live in public/, where the
// raw {{CONTACT}} token would be served to visitors.
//
// The hazard: any file that ends up at public/<name>.html is served by the static
// mount, producing a SECOND, untemplated copy of a legal page at /<name>.html.
// That is a duplicate-content problem for search engines and a broken-looking
// page for anyone who lands on it. (It happened for real with a hand-written
// public/credits.html.)
//
// Registering the 301 above the static mount makes the canonical URL win no
// matter what files exist in public/. Verified: with public/credits.html present,
// /credits.html returned 200 (the stray file) when this ran after the static
// mount, and 301 → /credits when it runs here.
const LEGAL_HTML_TWINS = ['/privacy', '/terms', '/dmca', '/cookies', '/credits', '/licenses'];
for (const route of LEGAL_HTML_TWINS) {
  app.get(`${route}.html`, (req, res) => res.redirect(301, route));
}

app.use(express.static(PUBLIC_DIR, {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  setHeaders: (res, path) => {
    // Always revalidate the app shell + its code/assets so a deploy or edit is
    // picked up immediately — no stale CSS or stale ES-module imports (the usual
    // "my changes aren't showing" cause). ETag/Last-Modified still make unchanged
    // files return a cheap 304, so this costs a tiny conditional request, not a
    // full re-download. Hashed-filename caching is the future perf upgrade.
    // …but thumbnails are CONTENT, not app shell. Some are .svg (original
    // artwork drawn for games whose CDN thumbnail died or could not be used),
    // and without this exemption every one of them would revalidate on every
    // page view while the .jpg tiles beside them cached for 7 days — a
    // per-format performance split nobody chose. Filenames are per-slug and
    // stable, so a replaced thumbnail is a new filename, not a stale cache.
    const isThumb = /[\\/]thumbs[\\/]/.test(path);
    if (!isThumb && /\.(html|css|js|mjs|svg)$/.test(path)) res.setHeader('Cache-Control', 'no-cache');
    // GUST vendors pdf.js as ES modules (.mjs). Some Express/send builds don't
    // map .mjs, and a wrong MIME makes the browser refuse the module import.
    if (path.endsWith('.mjs')) res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  }
}));

// 30s cache in front of the live Supabase probe — see the note inside the
// handler for why the uncached 1828ms was an operational problem, not just a
// slow endpoint. An in-flight probe is shared rather than duplicated, so a
// burst of health polls on a cold cache still makes exactly one round trip.
let _sbHealth = { at: 0, value: null, inflight: null };
const SB_HEALTH_TTL_MS = 30_000;
async function cachedSupabaseHealth() {
  const now = Date.now();
  if (_sbHealth.value && now - _sbHealth.at < SB_HEALTH_TTL_MS) return _sbHealth.value;
  if (_sbHealth.inflight) return _sbHealth.inflight;
  _sbHealth.inflight = (async () => {
    try {
      const v = await supabaseHealth();
      _sbHealth = { at: Date.now(), value: v, inflight: null };
      return v;
    } catch (e) {
      _sbHealth.inflight = null;
      throw e;
    }
  })();
  return _sbHealth.inflight;
}

app.get('/api/health', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Live Supabase connectivity probe — so "configured but not working" becomes a
  // precise reason (paused project / bad key / RLS / egress). Bounded (8s client
  // timeout); if the probe itself hiccups we still return the rest of the health.
  // The Supabase probe is CACHED for 30s. Measured cost without it: 1828ms per
  // call, versus 27-77ms for every other route on the site.
  //
  // That matters operationally, not just aesthetically. Render polls this
  // endpoint continuously as its health check, and CI blocks on it during the
  // boot test. A health check that takes nearly two seconds risks being scored
  // as a timeout — the endpoint whose job is to prove the service is alive
  // would be the thing reporting it dead.
  //
  // 30s is short enough that a real outage still surfaces almost immediately,
  // and long enough that a burst of health polls costs one round trip.
  let supabase;
  try { supabase = await cachedSupabaseHealth(); }
  catch (e) { supabase = { configured: isSupabaseConfigured(), connected: false, error: e?.message || String(e) }; }
  // /api/health is UNAUTHENTICATED, so it reports liveness, not configuration.
  //
  // It previously returned `keyType: "service_role (legacy JWT — retires end of
  // 2026)"` and the exact Node build to anybody who asked. Neither is a
  // credential, but both are free reconnaissance: which key class the server
  // holds, and the precise runtime version to match against CVEs. A test now
  // asserts no real secret VALUE appears in any response body; this trims the
  // metadata that was disclosed alongside it.
  //
  // The operator loses nothing — the key-type warning is already logged at boot,
  // and the full detail is still available to an authenticated admin below.
  const isAdmin = adminAuthorized(req);
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    catalog: { games: CATALOG.games.length },
    supabase: isAdmin ? supabase : {
      configured: !!supabase?.configured,
      connected: !!supabase?.connected,
    },
    proxy: proxyStatus,
    ...(isAdmin ? { node: process.version, catalogSource: CATALOG.source } : {}),
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
// `kind` is sent explicitly so every consumer can branch on it instead of
// inferring "no kind means companion" — the browser page's built-in engines
// carry kind 'sw'/'app', and its reload path compares === 'companion' to decide
// whether to offer the "open in a new tab" escape hatch (cross-origin embedding
// can be refused invisibly). Without this field that check was always false.
async function probeCompanion(e) {
  const base = { id: e.id, label: e.label, url: e.url, kind: 'companion' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(e.url, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
    clearTimeout(timer);
    return { ...base, up: r.status < 500 };
  } catch {
    return { ...base, up: false };
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
// GET /api/ai/health — provider observability.
// Exposes WHICH models are currently in cooldown and why, so "the AI is broken"
// is diagnosable from outside the process. Deliberately leaks nothing sensitive:
// model ids and upstream status codes only, never keys, prompts, or stack traces.
// These two describe the SERVER-SIDE AI pipeline — model priority, which
// upstream endpoint it would call, whether it holds a key, the full provider
// inventory with per-provider URLs and limits. In production that pipeline is
// switched off, so publishing its shape to anonymous callers is pure metadata
// leakage: it advertises capability this deployment deliberately does not offer,
// and hands a prospective abuser a map of what to aim at. Neither endpoint is
// called by ANY client code (verified with a repo-wide search of public/).
//
// So they now answer honestly and minimally in production, and stay fully
// detailed for local development and for an authenticated admin, who is the
// only party the diagnostics were ever for.
app.get('/api/ai/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!aiServerAllowed(req) && !adminAuthorized(req)) {
    return res.json({ ok: true, mode: 'client-side', serverInference: false });
  }
  const models = healthSnapshot();
  res.json({
    ok: true,
    priority: modelPriority(),
    // Which endpoint the pipeline will actually use, without revealing the key.
    endpoint: (process.env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_TOKEN)
      ? 'gen.pollinations.ai/v1/chat/completions'
      : 'text.pollinations.ai/openai',
    keyed: !!(process.env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_TOKEN),
    healthy: models.filter(m => m.healthy).length,
    total: models.length,
    models,
  });
});

app.get('/api/ai/providers', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!aiServerAllowed(req) && !adminAuthorized(req)) {
    return res.json({ mode: 'client-side', serverInference: false, text: [], image: [], web_search: [] });
  }
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
  // Chain any caller-supplied signal into ours. Without this the caller's signal
  // was silently discarded (we always overwrote `signal`), so a caller-side
  // timeout could never actually cancel the upstream request.
  const outer = opts.signal;
  const onOuterAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => {
    clearTimeout(t);
    if (outer) outer.removeEventListener('abort', onOuterAbort);
  });
}
// Optional Pollinations auth (all FREE). A token (auth.pollinations.ai) lifts the
// keyless ~1 req/15s limit to the Seed tier (~1 req/5s) and removes watermarks;
// a referrer attributes requests to this app. Both are read from .env if present.
const POLLINATIONS_TOKEN = (process.env.POLLINATIONS_TOKEN || '').trim();
// Canonicalize to a BARE hostname: the code prepends "https://" itself (line
// below) and passes it as a referrer query param elsewhere, so a value that
// already includes a scheme (e.g. someone pastes "https://mydomain.com" from
// .env.example) would otherwise produce a doubled "https://https://…/". Strip any
// leading scheme and trailing slashes so it's correct regardless of input format.
const POLLINATIONS_REFERRER = (process.env.POLLINATIONS_REFERRER || 'zofhub.app')
  .trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
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
// `opts.model`  — resolved model id (from resolveModels()). Falls back to
//   'openai-fast' only if the caller didn't resolve one. Previously this was
//   HARDCODED, so if Pollinations retired that model the primary chat path burned
//   its full 3-attempt retry/backoff before anything could fall back — defeating
//   the point of the model registry the secondary path already consults.
// `opts.signal` — caller's AbortSignal, so a caller-side timeout genuinely
//   CANCELS the upstream request instead of abandoning it to run for ~90s.
// ONE attempt against ONE model. Retry/failover live in pollinationsChat.
//
// Endpoint choice is evidence-based. gen.pollinations.ai/v1/chat/completions is
// the documented OpenAI-compatible endpoint and is preferred — but probing it
// with this deployment's credentials returned 401 anonymously and 403 with our
// pk_ key (recognised, tier too low), while text.pollinations.ai/openai — also
// OpenAI-compatible — returns 200 in ~770ms. So `gen` is used only when a
// higher-tier key is actually configured; otherwise we go straight to the
// endpoint that works, instead of burning a round-trip on a known 401.
async function pollinationsChatOnce(messages, model, timeoutMs, opts = {}) {
  if (opts.signal?.aborted) throw new Error('aborted');
  const apiKey = process.env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_TOKEN || '';
  const url = apiKey
    ? 'https://gen.pollinations.ai/v1/chat/completions'
    : 'https://text.pollinations.ai/openai';
  const headers = pollinationsHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' });
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;

  const r = await aiFetch(url, {
    method: 'POST', timeoutMs, signal: opts.signal, headers,
    // reasoning_effort:'low' cuts time-to-first-token on reasoning models
    // (openai-fast = gpt-oss-20b) from ~20s to ~1.5s.
    body: JSON.stringify({ model, messages, referrer: POLLINATIONS_REFERRER, private: true, reasoning_effort: 'low' }),
  });

  if (!r.ok) {
    // Surface the status in the message so isTransient() can classify it: 4xx
    // (bad model / no permission) must fail over to the next MODEL immediately,
    // while 429/5xx should be retried against the SAME model.
    const err = new Error('upstream ' + r.status);
    const ra = parseInt(r.headers.get('retry-after'), 10);
    if (ra > 0) err.retryAfterMs = ra * 1000;
    throw err;
  }
  const j = await r.json().catch(() => null);
  const txt = j?.choices?.[0]?.message?.content;
  if (!txt) throw new Error('empty reply');
  return String(txt).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// Model failover + exponential backoff.
//
// Before: one hardcoded model ('openai-fast'), 3 attempts, LINEAR backoff, and
// no notion of a model being down — so an unavailable model was re-probed on
// every single request forever.
//
// Now: walk the configurable priority list, skipping models in cooldown; retry
// transient failures per model with exponential backoff + jitter; record health
// so a dead model is skipped rather than hammered.
async function pollinationsChat(messages, timeoutMs = AI_TIMEOUT_MS, opts = {}) {
  // Endpoint-aware candidates: never offer a model the chosen endpoint cannot
  // serve (see KEYLESS_MODELS in lib/ai-pipeline.mjs for what that cost us).
  const keyed = !!(process.env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_TOKEN);
  const models = opts.model ? [opts.model] : healthyModels(candidateModels(keyed));

  // TOTAL TIME BUDGET — the whole failover chain, not per attempt.
  //
  // Testing caught this the hard way: with 6 models in the priority list and 3
  // retries each, a full failover could run for minutes and the HTTP request
  // simply hung. Model failover is only useful if it is bounded; past ~20s the
  // user has already given up, and holding the connection open just occupies a
  // slot in the concurrency gate that a request which COULD succeed needs.
  //
  // So: one shared deadline. Each model gets whatever time is left, retries are
  // capped at 2 (model failover is the primary resilience mechanism here, not
  // repeated attempts at the same failing model), and when the budget is gone
  // we stop immediately and let the caller fall through to AI Horde.
  const budgetMs = Number(process.env.AI_TOTAL_BUDGET_MS) || 20_000;
  const deadline = Date.now() + budgetMs;

  let lastErr = new Error('no models available');
  for (const model of models) {
    const remaining = deadline - Date.now();
    if (remaining < 1500) {                       // too little left to be useful
      lastErr = new Error('ai budget exhausted');
      break;
    }
    try {
      const txt = await withRetry(
        () => pollinationsChatOnce(messages, model, Math.min(timeoutMs, remaining), opts),
        {
          attempts: 2,
          onRetry: (n, e) => console.warn(`[ai] retry ${n} for "${model}": ${e.message}`),
        }
      );
      markSuccess(model);
      return txt;
    } catch (e) {
      lastErr = e;
      markFailure(model, e);
      if (opts.signal?.aborted) throw e;          // caller gave up; stop failing over
      // fall through to the next model in priority order
    }
  }
  throw lastErr;
}

// AI Horde — the second keyless text provider from ai_gaming_hub_final.json.
// Async (submit job → poll), slower than Pollinations but a different network
// so it covers Pollinations rate-limits. Anonymous key '0000000000'.
// Last-resort fallback when Pollinations is unavailable.
//
// AI Horde is a volunteer compute pool: the anonymous key (0000000000) gets
// whichever worker is free, and many run BASE completion models rather than
// instruction-tuned chat models. Handed a bare prompt, those models continue
// the text instead of answering it — in testing this returned things like
// "We need to output only the text to insert, no markdown fences" and
// "/ 2 / 3 / 4 / 5 / 6", presented to the user as the assistant's reply.
//
// Two defences: ask explicitly for instruct-capable models and format the
// prompt with clear turn markers, then VALIDATE what comes back. Returning
// obvious nonsense is worse than admitting the assistant is unavailable —
// a wrong answer costs the user's trust, an honest error costs them a retry.
const HORDE_INSTRUCT_MODELS = [
  'koboldcpp/Hermes-3-Llama-3.1-8B', 'koboldcpp/L3-8B-Stheno-v3.2',
  'koboldcpp/Mistral-Nemo-Instruct-2407', 'koboldcpp/gemma-2-9b-it',
];

/** Heuristic garbage filter for base-model continuations. */
function hordeLooksLikeGarbage(text, prompt) {
  const t = String(text || '').trim();
  if (t.length < 2) return true;
  // Echoing our own system prompt back at us.
  if (/you are zofhub ai/i.test(t)) return true;
  // Meta-instructions to itself — the classic base-model tell.
  if (/^(we need to|the user wants|the prefix before|output only|no markdown fences)/i.test(t)) return true;
  // Degenerate numeric or delimiter runs ("/ 2 / 3 / 4", "000,000,000").
  if (/^[\s\d.,/|:-]+$/.test(t)) return true;
  // A bare hex blob (a request id leaking through).
  if (/^[0-9a-f]{16,}\.?$/i.test(t)) return true;
  return false;
}

async function aiHordeText(prompt, timeoutMs = 45_000) {
  // Turn markers give an instruction-tuned model the shape it expects and give
  // a base model a much better chance of continuing usefully.
  const framed = `### Instruction:
${prompt}

### Response:
`;
  const submit = await aiFetch('https://aihorde.net/api/v2/generate/text/async', {
    method: 'POST', timeoutMs: 15_000,
    headers: { 'Content-Type': 'application/json', apikey: '0000000000', 'Client-Agent': 'ZoFHub:1.0:zofhub.app' },
    body: JSON.stringify({
      prompt: framed,
      models: HORDE_INSTRUCT_MODELS,
      params: { max_length: 220, max_context_length: 1024, stop_sequence: ['###', '\n\n###'] },
    })
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
      const text = (stj.generations[0].text || '').replace(/###.*$/s, '').trim();
      if (hordeLooksLikeGarbage(text, prompt)) throw new Error('horde returned unusable output');
      return text;
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
// Per-IP rate limits. Configurable via env, as required, with defaults chosen
// from what each endpoint actually costs rather than one number for everything:
//
//   AI    ~15 req/min (burst 5, one token per 4s). An AI call fans out to a
//         third-party model and can occupy an upstream slot for seconds, so it
//         is the most expensive thing an anonymous visitor can trigger.
//   WRITE ~12 req/min (burst 8, one token per 5s) for endpoints that touch the
//         database — score submission, community posts, view bumps.
//
// A flat 10/min would be simultaneously too tight for the write path (a burst
// of legitimate UI activity trips it) and too loose for AI. Both return a JSON
// 429; neither ever returns an HTML error page, which a fetch() cannot parse.
const AI_IP_BUCKET = {
  capacity: Number(process.env.AI_RATE_CAPACITY) || 5,
  refillMs: Number(process.env.AI_RATE_REFILL_MS) || 4000,
};
const WRITE_IP_BUCKET = {
  capacity: Number(process.env.WRITE_RATE_CAPACITY) || 8,
  refillMs: Number(process.env.WRITE_RATE_REFILL_MS) || 5000,
};

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
function writeAllow(ip, capacity = WRITE_IP_BUCKET.capacity, refillMs = WRITE_IP_BUCKET.refillMs) {
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

// ── AI RUNS ON THE VISITOR'S DEVICE, NOT ON THIS SERVER ────────────────────
// Every AI call the site makes in production goes browser-direct to Pollinations
// from the visitor's own machine, on their own IP: public/js/pollinations.js for
// text, an <img src> for images, and a plain URL the browser plays for audio.
// Nothing about a prompt or a generated image passes through here.
//
// The routes below exist for ONE reason: Pollinations' text endpoint fronts a
// Cloudflare Turnstile check keyed on the Origin header, and it rejects browser
// fetches from http/localhost origins. So a developer running the site on
// localhost cannot use the browser-direct path and would otherwise have no
// working AI at all. `IS_LOCAL` in pollinations.js is the client half of this;
// this is the server half, and it is deliberately stricter than the client:
//
//   * NODE_ENV=production  → always refused, no exceptions (render.yaml sets it)
//   * otherwise            → only for a LOOPBACK client, i.e. a dev on the same
//                            machine. `trust proxy` is on, so req.ip is the real
//                            client address and a genuine internet visitor can
//                            never present as 127.0.0.1.
//   * AI_SERVER_FALLBACK=1 → explicit opt-in escape hatch, for the rare case of
//                            debugging against a non-loopback dev host.
//
// Enforcing it here rather than only in the client matters: the client gate is a
// convention that a future edit could quietly drop, and these endpoints are
// reachable by anyone who knows the URL. This makes "no AI on my server" a
// property of the deployment instead of a promise in a comment.
function aiServerAllowed(req) {
  if (process.env.AI_SERVER_FALLBACK === '1') return true;
  if (process.env.NODE_ENV === 'production') return false;
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  return ip === '' || /^(::1$|::ffff:127\.|127\.)/.test(ip);
}
function refuseServerAi(res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(403).json({
    error: 'client_side_only',
    reply: '',
    message: 'ZoFHub runs AI in your browser, not on the server. This endpoint is a local-development aid only.',
  });
}

app.post('/api/ai/text', async (req, res) => {
  if (!aiServerAllowed(req)) return refuseServerAi(res);
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
  let system = 'You are ZoFHub AI, a friendly, concise assistant for students. Reply in clear markdown.';

  // LIVE WEATHER GROUNDING.
  // A language model has no idea what the weather is; asked directly it will
  // confidently invent a temperature. So when the question is clearly about
  // weather we fetch the real conditions and put them in the system prompt, and
  // the model's job becomes summarising a fact rather than guessing one.
  //
  // The weather text becomes part of the cache key (aiCacheKey hashes `system`),
  // so a cached answer expires naturally as conditions change — no separate
  // invalidation needed.
  if (weather.looksLikeWeatherQuestion(latest)) {
    try {
      const place = await weather.resolveLocation({
        city: req.body?.city ? String(req.body.city).slice(0, 80) : null,
        tz: req.body?.tz ? String(req.body.tz).slice(0, 64) : null,
      });
      if (place) {
        const wx = await weather.forecast(place.latitude, place.longitude);
        system += '\n\nLIVE WEATHER (real data, retrieved just now — use it and do '
          + 'not invent figures): ' + weather.summarize(place, wx);
      }
    } catch (e) {
      // Weather being down must never break chat. Without live data the model
      // is instructed to say so instead of fabricating.
      console.warn('[ai] weather grounding unavailable:', e.message);
      system += '\n\nNOTE: live weather is unavailable right now. If asked about '
        + 'weather, say you cannot retrieve it rather than guessing.';
    }
  }

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
    // ENDPOINT ORDER IS EVIDENCE-BASED, and it is the reverse of what the
    // OpenAI-compatible spec would suggest. Measured repeatedly:
    //
    //   GET  text.pollinations.ai/<prompt>   200 in ~0.8-1.3s, every attempt
    //   POST text.pollinations.ai/openai     402 on almost every attempt
    //   POST gen.pollinations.ai/v1/...      401 anonymous, 403 with our pk_ key
    //
    // The 402 is not about our Referer (tested with a correct one, a malformed
    // one, and none at all — all 402) and not about the key. The POST path is
    // simply gated for unkeyed callers now.
    //
    // So when we have NO key we go to the endpoint that works first. Trying POST
    // first cost ~36s per request and dumped every user onto the AI Horde
    // fallback, which returned garbage. When a real key IS configured, the
    // richer OpenAI-compatible path is tried first and this order flips.
    const keyedAi = !!(process.env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_TOKEN);
    // THE `system=` QUERY PARAM IS PAYWALLED. Isolated by testing each param
    // against the live endpoint with an identical prompt:
    //
    //   bare                     200   434ms
    //   ?model=openai-fast       200   790ms
    //   ?system=...              402 24978ms   <-- 402 Payment Required
    //   ?model=...&system=...    402 29589ms
    //
    // The server appended `&system=` on EVERY request, so every unkeyed AI call
    // hit a paywall, waited ~25-30s for the 402, then fell through to the AI
    // Horde fallback — which returned unrelated text like "/ 2 / 3 / 4 / 5".
    // That is why the assistant looked broken rather than merely slow.
    //
    // Folding the system prompt into the prompt body costs nothing and keeps
    // the same behaviour. The paid `system=` param is used only when a key is
    // configured, where it is permitted.
    const getUrl = keyedAi
      ? `https://text.pollinations.ai/${encodeURIComponent(ctx)}?model=${encodeURIComponent(textModel)}&system=${encodeURIComponent(system)}`
      : `https://text.pollinations.ai/${encodeURIComponent(system + '\n\n' + ctx)}?model=${encodeURIComponent(textModel)}`;
    let text;
    if (keyedAi) {
      try { text = await pollinationsChat([{ role: 'system', content: system }, ...turns]); }
      catch { text = await pollinationsText(getUrl); }
    } else {
      try { text = await pollinationsText(getUrl); }
      catch { text = await pollinationsChat([{ role: 'system', content: system }, ...turns]); }
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
      // Log the upstream detail for us; return a plain message to the client.
      // The old response shipped `pollinations:<msg>; horde:<msg>` straight to
      // the browser, which leaked upstream hostnames, status codes and internal
      // wording to anyone who opened devtools — and told the user nothing they
      // could act on.
      console.warn('[ai] all providers failed —', 'pollinations:', e1.message, '| horde:', e2.message);
      return res.status(503).json({
        reply: '',
        error: 'ai_unavailable',
        message: 'The AI assistant is temporarily unavailable. Please try again in a moment.',
      });
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
  // This route PIPES THE GENERATED IMAGE BYTES through this server, which is
  // exactly the traffic that is supposed to stay on the visitor's device — so it
  // is gated like /api/ai/text. In production the browser uses the direct
  // image.pollinations.ai URL (an <img> sends no Origin, so Turnstile never
  // applies) and this never runs.
  if (!aiServerAllowed(req)) return refuseServerAi(res);
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
  // Gated even though it performs no inference — it only string-builds a URL the
  // browser then plays, so no audio bytes ever pass through here.
  //
  // The reason to close it anyway: the prompt arrives in the QUERY STRING, and
  // hosting platforms log request paths. Render's access log would therefore
  // accumulate the text visitors asked to have spoken — prompts recorded in a
  // log this code never writes and cannot clear. Nothing calls this route (no
  // reference anywhere in public/), and the URL it returns is a pure template
  // with no secret in it, so a client that ever needs it can build it itself.
  if (!aiServerAllowed(req)) return refuseServerAi(res);
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
  // Same reasoning as /api/ai/audio: unreferenced, and it takes a prompt in the
  // query string, which the hosting platform's access log would retain.
  if (!aiServerAllowed(req)) return refuseServerAi(res);
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
  // Its comment claims ai.js calls this when the local engine and the primary
  // text path both fail. Nothing does — a repo-wide search of public/ finds no
  // caller. It was left behind by an earlier design in which the server owned
  // the AI. Gated rather than deleted: it is still a usable local-dev probe, and
  // gating removes the production exposure, which was the actual problem.
  if (!aiServerAllowed(req)) return refuseServerAi(res);
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
// NOTE (future work): this is the THIRD independently hand-maintained host list
// in the repo — the others are TRUSTED_HOST_SUFFIXES in lib/cron-jobs.mjs and the
// active/`.disabled` rules in data/catalog-overrides.json. Keeping them in sync by
// hand is the root cause of a recurring class of bug (this issue, and the
// gamezop/gameflare grow-job issue before it). They should be derived from ONE
// shared module exporting the canonical "currently embeddable hosts" set.
//
// onlinegames.io and htmlgames.com are DELIBERATELY absent: both have ACTIVE
// full-host blocks in data/catalog-overrides.json because they don't render when
// framed on ZoFHub (onlinegames.io black-screens / Unity "couldn't load the
// content"; htmlgames.com frame-busts via GameLib/ThirdParty.js). Accepting them
// here would publish community picks that are guaranteed dead for every visitor.
const REC_TRUSTED_HOSTS = [
  'gamedistribution.com', 'gamemonetize.com',
  'gamemonetize.co', 'y8.com',
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

  // URL SAFETY — recHostOk() checks the host is a known portal, which is an
  // allowlist, not a safety check. These are the shapes an allowlist alone does
  // not catch: credentials embedded in the URL (the https://trusted.com@evil
  // phishing form), addresses that resolve inside our own infrastructure
  // including the cloud metadata endpoint, and encoded IPv4 literals like
  // 2130706433 that read as a hostname to a string check and as 127.0.0.1 to a
  // resolver.
  const safety = checkUrlSafety(embed_url);
  if (!safety.ok) {
    return res.status(400).json({
      ok: false,
      error: 'That link cannot be embedded.',
      // Named so a legitimate submitter can fix their link; carries no internal
      // detail beyond the category of problem.
      reason: safety.reason,
    });
  }

  // CROSS-DOMAIN DUPLICATE DETECTION.
  // A plain `WHERE embed_url = ?` treats the same game on a different partner
  // subdomain as new — which is how the catalog reached 4,691 rows (27.7%)
  // sharing a title. Matching on PROVIDER IDENTITY collapses those.
  const dupe = findDuplicates({ url: embed_url, title }, CATALOG.games);
  if (dupe.status === 'exact') {
    return res.status(409).json({
      ok: false,
      error: 'We already have that game.',
      reason: dupe.reason,
      existing: dupe.matches.slice(0, 3).map(m => ({ slug: m.slug, title: m.title })),
    });
  }
  // A title-only match is evidence, not proof — two different games really are
  // both called "Bubble Shooter". Accept the submission and flag it, rather
  // than rejecting a legitimate game on a name collision.
  const possibleDuplicateOf = dupe.status === 'likely'
    ? dupe.matches.slice(0, 3).map(m => m.slug)
    : null;

  const supa = getSupabaseAdmin();   // INSERTs a recommendation
  if (!supa) return res.status(503).json({ ok: false, error: 'Community storage is not configured yet.' });
  try {
    const { data, error } = await supa.from('recommendations')
      .insert({ title, embed_url, note, author, category })
      .select('id, title, author, category, created_at').single();
    if (error) throw error;
    if (possibleDuplicateOf) {
      // Surfaced to the submitter (so they can say "no, mine is different")
      // and logged for whoever reviews the queue. Not a rejection: a name
      // collision is not proof, and rejecting on one would lose real games.
      console.log(`[recommendations] "${title}" may duplicate: ${possibleDuplicateOf.join(', ')}`);
    }
    return res.json({
      ok: true,
      recommendation: data,
      ...(possibleDuplicateOf ? {
        notice: 'Saved — but we may already have a game with this name. A moderator will check.',
        possibleDuplicateOf,
      } : {}),
    });
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
  const supa = getSupabaseAdmin();   // bumps the view counter
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
      // Per-game override for the points-per-second rule. A game that genuinely
      // scores faster than the global bound (idle/clicker curves do) gets its
      // own number here rather than forcing the global one up for everybody.
      perSecond: (j.perSecond && typeof j.perSecond === 'object') ? j.perSecond : {},
    };
  } catch (e) { console.warn('[scores] score-limits.json load failed:', e.message); }
}
loadScoreLimits();
const scoreCeiling = (slug) => { const g = Number(SCORE_LIMITS.perGame[slug]); return Number.isFinite(g) && g > 0 ? g : SCORE_LIMITS.default; };

// Outlier quarantine tuning + a one-time probe for the `status` column, so this
// all keeps working BEFORE the user runs db/community-scores-integrity.sql
// (quarantine simply stays off until the column exists).
// The quarantine rules themselves now live in lib/score-integrity.mjs, as a pure
// function — inline here they could only be exercised with a live database and a
// real play session, which meant they had no test coverage at all.
let scoresStatusCol = null;       // null=unknown, true/false after probe

// Same one-time probe, for the evidence columns added by
// db/community-scores-evidence.sql. Probed rather than assumed so the detector
// keeps quarantining on a database that has not had that migration applied yet —
// it simply cannot record WHY, which is strictly better than not flagging.
let scoresEvidenceCols = null;
async function ensureEvidenceCols(supa) {
  if (scoresEvidenceCols !== null) return scoresEvidenceCols;
  try {
    const { error } = await supa.from('scores').select('flag_evidence, ip_tag').limit(1);
    scoresEvidenceCols = !error;
    if (error) console.warn('[scores] flag_evidence/ip_tag not found — run db/community-scores-evidence.sql to record anti-cheat evidence. Quarantine itself is active regardless.');
  } catch { scoresEvidenceCols = false; }
  return scoresEvidenceCols;
}

async function ensureStatusCap(supa) {
  if (scoresStatusCol !== null) return scoresStatusCol;
  try {
    const { error } = await supa.from('scores').select('status').limit(1);
    scoresStatusCol = !error;
    if (error) console.warn('[scores] `status` column not found — run db/community-scores-integrity.sql to enable outlier quarantine. Proof-of-play + ceilings are active regardless.');
  } catch { scoresStatusCol = false; }
  return scoresStatusCol;
}

// Is the atomic submit_score() upsert available? (db/community-scores-unique.sql)
// null = not probed yet, true = use it, false = fall back to the legacy path.
let submitScoreFn = null;
const missingFn = (e) => /could not find the function|PGRST202|does not exist/i.test(e?.message || e?.code || '');

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

  // submit_score() is SECURITY DEFINER and revoked from anon/authenticated, so
  // this path is admin-only by database design, not just by convention.
  const supa = getSupabaseAdmin();
  if (!supa) return res.status(503).json({ ok: false, error: 'Leaderboard not configured.' });
  const hasStatus = await ensureStatusCap(supa);
  const hasEvidenceCols = hasStatus && await ensureEvidenceCols(supa);
  try {
    // Outlier quarantine: a wild leap past an ESTABLISHED game-best is held for
    // review (status='flagged') instead of shown. Only active once the column
    // exists (post-migration); harmless no-op before that.
    let verdict = { flagged: false, reason: null, evidence: null };
    const tag = ipTag(req.ip);
    if (hasStatus) {
      const { data: topRow } = await supa.from('scores')
        .select('score').eq('slug', slug).eq('status', 'ok')
        .order('score', { ascending: false }).limit(1).maybeSingle();
      const best = topRow?.score || 0;

      // Replay probe: this exact score, for this game, from this source, seen
      // before. Cheap — an index seek on (slug, ip_tag, score) — and it is the
      // one signal the pure detector cannot compute for itself.
      //
      // SCOPE, precisely: ip_tag is written on the quarantine path below, so
      // what this counts is REPEATED FLAGGED ATTEMPTS, not all submissions.
      // Recording it on the clean path too would mean changing the signature of
      // the submit_score() SECURITY DEFINER function, which is a schema change
      // to the one write path that must not break. Someone retrying the same
      // rejected score is exactly the behaviour worth catching, so this is
      // narrower than it sounds — but it is narrower, and that is worth knowing
      // before tuning DUPLICATE_THRESHOLD against it.
      //
      // A failed probe must never block a legitimate submission: it counts zero.
      let duplicates = 0;
      if (hasEvidenceCols) {
        const { count, error: dupeErr } = await supa.from('scores')
          .select('id', { count: 'exact', head: true })
          .eq('slug', slug).eq('ip_tag', tag).eq('score', score);
        if (!dupeErr) duplicates = count || 0;
      }

      verdict = assessScore({
        score, best,
        ceiling,
        playedMs: sess.played,
        duplicates,
        maxPerSecond: SCORE_LIMITS.perSecond?.[slug],
      });
    }
    if (verdict.flagged) {
      const row = { slug, player_name: name, score, status: 'flagged', flag_reason: verdict.reason };
      // The evidence columns arrive with db/community-scores-evidence.sql. Before
      // that migration lands the detector still runs and still quarantines — it
      // just cannot record why, which is strictly better than not quarantining.
      if (hasEvidenceCols) { row.flag_evidence = verdict.evidence; row.ip_tag = tag; }
      const { error } = await supa.from('scores').insert(row);
      if (error) throw error;
      return res.json({ ok: true, best: score, pending: true });
    }

    // Keep ONE row per (game, player) — the player's BEST score. This stops a
    // single identity flooding the board and keeps the leaderboard clean.
    //
    // PREFERRED PATH: submit_score() does the whole keep-best rule as a single
    // INSERT ... ON CONFLICT inside the database, so two concurrent submissions
    // for the same (slug, player_name) can no longer both "see no existing row"
    // and both insert. Requires db/community-scores-unique.sql; if that hasn't
    // been run yet we fall back to the original (racy) select-then-branch below,
    // so the endpoint keeps working either way.
    if (submitScoreFn !== false) {
      const { data, error } = await supa.rpc('submit_score', {
        p_slug: slug, p_player: name, p_score: score,
      });
      if (!error) {
        submitScoreFn = true;
        const r = Array.isArray(data) ? data[0] : data;
        if (r) {
          const best = Number(r.best);
          if (r.created) return res.json({ ok: true, best, created: true });
          return res.json({ ok: true, best, updated: !!r.updated });
        }
      } else if (missingFn(error)) {
        submitScoreFn = false;
        console.warn('[scores] submit_score() not found — using the non-atomic fallback. Run db/community-scores-unique.sql to make "one row per player per game" race-proof.');
      } else {
        throw error;
      }
    }

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
// PRIVATE ADMIN REVIEW  (/admin — noindex, secret-gated)
// ------------------------------------------------------------------------
// Two jobs:
//   1. Review submitted game requests, each annotated with whether that game is
//      ALREADY in the catalog (matched by embed URL first, then by title) so
//      duplicates are obvious at a glance.
//   2. Review quarantined ("flagged") scores and approve or reject them. This is
//      what makes the player-facing "pending review" promise actually true —
//      before this there was no code path anywhere that could un-flag a score,
//      so flagged scores were invisible and then silently deleted.
//
// Auth FAILS CLOSED: with no ADMIN_SECRET set the routes return 503 and do
// nothing. (Contrast with /healthz, which fails open on purpose.)
// ========================================================================
const ADMIN_SECRET = (process.env.ADMIN_SECRET || '').trim();

// ── Two ways to be an administrator, and only two ──────────────────────────
//
// 1. A SESSION, for humans. Username + password at /admin/login, verified
//    server-side against a scrypt hash, exchanged for a database-backed session
//    whose token exists in the browser only as an HttpOnly cookie.
//
// 2. A BEARER TOKEN, for machines. ADMIN_SECRET in an Authorization header, for
//    uptime monitors and CLI tooling that cannot hold a cookie.
//
// WHAT CHANGED AND WHY:
//
// `req.query.key` was accepted as a third way. A credential in a query string is
// written to the hosting platform's access log, kept in browser history, and
// forwarded in the Referer header of every off-site link on the page — three
// copies of an admin credential in places nobody thinks to clear. It is gone.
// Nothing legitimate used it: the console sent a header, and monitors send
// Authorization.
//
// The old console also kept the raw ADMIN_SECRET in sessionStorage, where any
// XSS or anyone typing in the console could read it. Sessions replace that: the
// cookie is HttpOnly, so page JavaScript cannot read the credential at all.
function adminBearerAuthorized(req) {
  if (!ADMIN_SECRET) return false;                       // fail CLOSED
  const bearer   = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const provided = bearer || req.get('x-admin-secret') || '';
  if (!provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(ADMIN_SECRET);
  return a.length === b.length && timingSafeEqual(a, b); // constant-time
}

// Kept under its original name because /api/health and several routes call it.
// Machine auth only — a cookie session is resolved asynchronously by
// resolveAdmin() below, since it needs a database round trip.
function adminAuthorized(req) { return adminBearerAuthorized(req); }

/**
 * Resolve the caller to an administrator, by session cookie or bearer token.
 * Returns null when the caller is not an admin. Never throws.
 */
async function resolveAdmin(req) {
  if (adminBearerAuthorized(req)) {
    return { username: 'service-token', via: 'bearer', session: null };
  }
  const cookies = adminAuth.parseCookies(req.headers?.cookie);
  const token = cookies[adminAuth.SESSION_COOKIE];
  if (!token) return null;
  const supa = getSupabaseAdmin();
  if (!supa) return null;                                // fail CLOSED
  const sess = await adminAuth.validateSession(supa, token, {
    ipHash: adminAuth.hashIp(req.ip), userAgent: req.get('user-agent'),
  });
  if (!sess) return null;
  return { username: sess.username, via: 'session', session: sess };
}

/**
 * Gate for admin API routes. Sync, so the many existing call sites keep their
 * shape; it accepts a caller the async middleware below already resolved.
 */
function requireAdmin(req, res) {
  if (req.admin) return true;                            // set by adminGate
  if (adminBearerAuthorized(req)) { req.admin = { username: 'service-token', via: 'bearer' }; return true; }
  res.setHeader('Cache-Control', 'no-store');
  if (!ADMIN_SECRET && !adminAuth.adminConfigStatus().ok) {
    res.status(503).json({ ok: false, error: 'Admin access is not configured. Set ADMIN_USERNAME, ADMIN_PASSWORD_HASH and ADMIN_SESSION_SECRET (run: npm run admin-hash).' });
  } else {
    res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return false;
}

// Resolves a session for every /admin and /api/admin request before the route
// runs, so requireAdmin() can stay synchronous. Registered below.
async function adminGate(req, res, next) {
  try { req.admin = await resolveAdmin(req); } catch { req.admin = null; }
  next();
}

/**
 * CSRF + Origin gate for state-changing admin requests.
 *
 * A bearer-token caller is exempt: CSRF defends a browser that carries an
 * ambient credential automatically, and an Authorization header is never sent
 * automatically by a browser, so there is nothing to forge.
 */
function requireAdminCsrf(req, res) {
  if (req.admin?.via === 'bearer') return true;
  if (!adminAuth.originOk(req)) {
    res.status(403).json({ ok: false, error: 'bad origin' });
    return false;
  }
  if (!adminAuth.csrfOk(req)) {
    const supa = getSupabaseAdmin();
    adminAuth.securityEvent(supa, {
      kind: 'csrf_reject', severity: 'warn',
      username: req.admin?.username, ipHash: adminAuth.hashIp(req.ip),
      detail: { path: req.path },
    });
    res.status(403).json({ ok: false, error: 'csrf' });
    return false;
  }
  return true;
}

/** Record an admin action. Fire-and-forget: telemetry never fails a request. */
function auditAction(req, action, target, outcome = 'success', detail) {
  adminAuth.audit(getSupabaseAdmin(), {
    username: req.admin?.username, action, target, outcome,
    ipHash: adminAuth.hashIp(req.ip), userAgent: req.get('user-agent'), detail,
  });
}

// Resolve a session before any admin route runs. Mounted on both prefixes; it
// only ever READS the request, so a non-admin caller is unaffected.
app.use(['/admin', '/api/admin'], adminGate);

// Nothing under /admin may be cached or indexed, ever.
app.use(['/admin', '/api/admin'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
});

// ── POST /api/admin/auth/login ─────────────────────────────────────────────
// Deliberate properties:
//   · One generic failure message for every rejection. "Unknown user" versus
//     "wrong password" tells an attacker which half to keep trying.
//   · The password is verified even when the username is wrong, so the response
//     time cannot be used to enumerate usernames.
//   · Lockout is checked BEFORE verification and applies to the IP regardless of
//     which username is tried, so rotating usernames does not reset it.
//   · Fails closed on missing configuration or an unreachable database.
app.post('/api/admin/auth/login', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const cfg = adminAuth.adminConfigStatus();
  const supa = getSupabaseAdmin();
  const ipHash = adminAuth.hashIp(req.ip);
  const ua = req.get('user-agent');
  const generic = { ok: false, error: 'Invalid credentials.' };

  if (!cfg.ok) {
    // The operator needs to know WHY; a visitor gets nothing actionable. This
    // detail is safe: it names which variables are unset, never their values.
    return res.status(503).json({ ok: false, error: 'Admin login is not configured.', problems: cfg.problems });
  }
  if (!supa) return res.status(503).json({ ok: false, error: 'Admin login is unavailable (no database).' });
  if (!adminAuth.originOk(req)) return res.status(403).json({ ok: false, error: 'bad origin' });

  // String-only, and non-strings fall through as '' so a malformed body still
  // pays the lockout + delay + generic-401 price. See coerceCredentials().
  const { username, password } = adminAuth.coerceCredentials(req.body);

  const lock = await adminAuth.isLockedOut(supa, ipHash);
  if (lock.locked) {
    await adminAuth.recordLoginAttempt(supa, { username, ok: false, ipHash, userAgent: ua, reason: 'locked' });
    await adminAuth.securityEvent(supa, { kind: 'lockout_hit', severity: 'warn', username, ipHash });
    res.setHeader('Retry-After', String(lock.retryAfterSec || 60));
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again later.' });
  }

  // Always run the KDF, even for a wrong username: skipping it would make a bad
  // username measurably faster to reject than a bad password.
  const expectedUser = String(process.env.ADMIN_USERNAME || '');
  const passOk = await adminAuth.verifyPassword(password, process.env.ADMIN_PASSWORD_HASH);
  const userBuf = Buffer.from(username);
  const wantBuf = Buffer.from(expectedUser);
  const userOk = userBuf.length === wantBuf.length && timingSafeEqual(userBuf, wantBuf);

  if (!userOk || !passOk) {
    await adminAuth.recordLoginAttempt(supa, {
      username, ok: false, ipHash, userAgent: ua,
      reason: userOk ? 'bad_password' : 'unknown_user',    // recorded, never returned
    });
    const after = await adminAuth.isLockedOut(supa, ipHash);
    if (after.locked) {
      await adminAuth.securityEvent(supa, { kind: 'lockout_started', severity: 'warn', username, ipHash });
    }
    // Progressive delay: cheap for a human who mistyped, expensive for a script.
    await new Promise(r => setTimeout(r, Math.min(2000, 250 * (after.failures || 1))));
    return res.status(401).json(generic);
  }

  const created = await adminAuth.createSession(supa, { username: expectedUser, ipHash, userAgent: ua });
  if (!created) return res.status(503).json({ ok: false, error: 'Could not start a session.' });

  await adminAuth.recordLoginAttempt(supa, { username, ok: true, ipHash, userAgent: ua, reason: 'ok' });
  await adminAuth.audit(supa, {
    username: expectedUser, action: 'auth.login', outcome: 'success', ipHash, userAgent: ua,
  });
  adminAuth.setSessionCookies(res, created);
  // The CSRF token is returned so the page can use it immediately; it is also in
  // a readable cookie, which is what makes the double-submit check work.
  res.json({ ok: true, username: expectedUser, csrfToken: created.csrf });
});

// ── POST /api/admin/auth/logout ────────────────────────────────────────────
// Revokes server-side. Clearing the cookie alone would leave a stolen copy of
// the token working until it expired.
app.post('/api/admin/auth/logout', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Deliberately NOT behind requireAdmin: logging out must be idempotent and
  // must never fail, including when the session has already expired — an admin
  // who cannot log out is worse than one who logs out twice. An anonymous call
  // therefore answers 200 having done nothing, which is the correct no-op.
  //
  // The Origin check is the one thing worth enforcing here. SameSite=Strict
  // already stops a cross-site page from sending the session cookie at all, so
  // a forged logout has nothing to revoke; this is a second, independent lock on
  // the same door, in case that cookie attribute is ever relaxed.
  if (!adminAuth.originOk(req)) return res.status(403).json({ ok: false, error: 'bad origin' });
  const cookies = adminAuth.parseCookies(req.headers?.cookie);
  const token = cookies[adminAuth.SESSION_COOKIE];
  if (token) {
    await adminAuth.revokeSession(getSupabaseAdmin(), token, 'logout');
    if (req.admin) auditAction(req, 'auth.logout', null, 'success');
  }
  adminAuth.clearSessionCookies(res);
  res.json({ ok: true });
});

// Revoke every session for this admin — the "my laptop was stolen" button.
app.post('/api/admin/auth/logout-all', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!requireAdminCsrf(req, res)) return;
  const n = await adminAuth.revokeAllSessions(getSupabaseAdmin(), req.admin.username, 'logout_all');
  auditAction(req, 'auth.logout_all', null, 'success', { revoked: n });
  adminAuth.clearSessionCookies(res);
  res.json({ ok: true, revoked: n });
});

// Who am I? Used by the dashboard to decide whether to render or redirect.
app.get('/api/admin/me', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    ok: true,
    username: req.admin.username,
    via: req.admin.via,
    session: req.admin.session
      ? { createdAt: req.admin.session.createdAt, expiresAt: req.admin.session.expiresAt }
      : null,
  });
});

// ── GET /api/admin/dashboard ───────────────────────────────────────────────
// One round trip for the overview. Everything here is operational state the
// admin already has the right to see; no secret value is included, and the
// tests assert that.
app.get('/api/admin/dashboard', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const supa = getSupabaseAdmin();
  const out = {
    ok: true,
    catalog: {
      served: CATALOG.games.length,
      source: CATALOG.source,
      categories: byCategory.size,
    },
    server: {
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      env: process.env.NODE_ENV || 'development',
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      cronDisabled: process.env.CRON_DISABLED === '1',
    },
    ai: { mode: 'client-side', serverInference: false },
    proxy: proxyStatus,
  };
  try { out.supabase = await cachedSupabaseHealth(); }
  catch { out.supabase = { configured: isSupabaseConfigured(), connected: false }; }

  if (supa) {
    const count = async (table, build) => {
      try {
        let q = supa.from(table).select('*', { count: 'exact', head: true });
        if (build) q = build(q);
        const { count: n, error } = await q;
        return error ? null : n;
      } catch { return null; }
    };
    const [games, working, broken, scores, flagged, recs, hidden] = await Promise.all([
      count('games'),
      count('games', q => q.eq('is_working', true)),
      count('games', q => q.eq('is_working', false)),
      count('scores'),
      count('scores', q => q.neq('status', 'ok')),
      count('recommendations'),
      count('recommendations', q => q.eq('is_visible', false)),
    ]);
    out.database = { games, working, broken, scores, flagged, recommendations: recs, hiddenRecommendations: hidden };
  }
  res.json(out);
});

// ── GET /api/admin/security ────────────────────────────────────────────────
// The Security Centre: recent logins, security events, and the audit trail.
app.get('/api/admin/security', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const supa = getSupabaseAdmin();
  if (!supa) return res.status(503).json({ ok: false, error: 'no database' });
  const take = async (table, cols, order) => {
    try {
      const { data, error } = await supa.from(table).select(cols).order(order, { ascending: false }).limit(50);
      return error ? [] : (data || []);
    } catch { return []; }
  };
  const [logins, events, actions, sessions] = await Promise.all([
    take('admin_login_attempts', 'at, username, ok, ip_hash, reason, user_agent', 'at'),
    take('admin_security_events', 'at, kind, severity, username, ip_hash, detail', 'at'),
    take('admin_audit_logs', 'at, username, action, target, outcome, ip_hash', 'at'),
    adminAuth.listSessions(supa, req.admin.username, 20),
  ]);
  res.json({
    ok: true, logins, events, actions, sessions,
    lockout: { threshold: adminAuth.LOCK_THRESHOLD, windowMs: adminAuth.LOCK_WINDOW_MS, lockMs: adminAuth.LOCK_DURATION_MS },
  });
});

// ── GET /api/admin/games ───────────────────────────────────────────────────
// Search the live catalog. Reads the in-memory catalog rather than the database
// so a mistyped filter cannot become an expensive scan.
app.get('/api/admin/games', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  let rows = CATALOG.games;
  if (q) rows = rows.filter(g => g.title.toLowerCase().includes(q) || g.slug.includes(q));
  res.json({
    ok: true, total: rows.length,
    games: rows.slice(0, limit).map(g => ({
      slug: g.slug, title: g.title, category: g.category,
      embed_url: g.embed_url, is_working: g.is_working !== false,
      provider: (() => { try { return new URL(g.embed_url).hostname; } catch { return null; } })(),
    })),
  });
});

// ── POST /api/admin/games/:slug/visibility ─────────────────────────────────
// Show or hide one game. Writes is_working in Supabase — the same field the
// link checker maintains and the same one the public RLS policy filters on —
// rather than inventing a parallel visibility mechanism.
app.post('/api/admin/games/:slug/visibility', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!requireAdminCsrf(req, res)) return;
  const slug = String(req.params.slug || '').slice(0, 120);
  const visible = req.body?.visible === true;
  if (!/^[a-z0-9][a-z0-9-]{0,118}$/i.test(slug)) {
    return res.status(400).json({ ok: false, error: 'bad slug' });
  }
  const supa = getSupabaseAdmin();
  if (!supa) return res.status(503).json({ ok: false, error: 'no database' });
  try {
    const { data, error } = await supa.from('games')
      .update({ is_working: visible }).eq('slug', slug).select('slug');
    if (error) throw error;
    if (!data?.length) {
      auditAction(req, 'game.visibility', slug, 'failure', { reason: 'not_found' });
      return res.status(404).json({ ok: false, error: 'no such game' });
    }
    auditAction(req, 'game.visibility', slug, 'success', { visible });
    res.json({ ok: true, slug, visible });
  } catch (e) {
    auditAction(req, 'game.visibility', slug, 'failure', { error: e.message });
    res.status(500).json({ ok: false, error: 'update failed' });
  }
});

// Pull the catalog from Supabase again, without waiting for the 30-minute timer.
app.post('/api/admin/catalog/refresh', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!requireAdminCsrf(req, res)) return;
  try {
    const ok = await refreshCatalogFromSupabase();
    auditAction(req, 'catalog.refresh', null, ok ? 'success' : 'failure');
    res.json({ ok: !!ok, games: CATALOG.games.length, source: CATALOG.source });
  } catch (e) {
    auditAction(req, 'catalog.refresh', null, 'failure', { error: e.message });
    res.status(500).json({ ok: false, error: 'refresh failed' });
  }
});

// Normalize an embed URL so the same game submitted with http/https, a www
// prefix, a trailing slash or tracking params still matches the catalog copy.
function normEmbed(u) {
  try {
    const x = new URL(String(u));
    return (x.host.replace(/^www\./i, '') + x.pathname.replace(/\/+$/, '')).toLowerCase();
  } catch { return String(u || '').trim().toLowerCase(); }
}
const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Is this submitted game already in the live catalog? Keys are prefixed with
// `matched…` so spreading this over the recommendation row can never clobber the
// submission's own `title`/`slug`.
function catalogMatch(rec) {
  const url = normEmbed(rec.embed_url);
  const title = normTitle(rec.title);
  for (const g of CATALOG.games) {
    if (url && normEmbed(g.embed_url) === url) return { inCatalog: true, matchedBy: 'url', matchedSlug: g.slug, matchedTitle: g.title };
  }
  for (const g of CATALOG.games) {
    if (title && normTitle(g.title) === title) return { inCatalog: true, matchedBy: 'title', matchedSlug: g.slug, matchedTitle: g.title };
  }
  return { inCatalog: false, matchedBy: null, matchedSlug: null, matchedTitle: null };
}

// --- GET /api/admin/recommendations -----------------------------------------
app.get('/api/admin/recommendations', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  const supa = getSupabase();
  if (!supa) return res.json({ ok: true, recommendations: [], note: 'Supabase not configured.' });
  try {
    const { data, error } = await supa.from('recommendations')
      .select('id, title, embed_url, note, author, category, views, is_visible, created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    const recommendations = (data || []).map(r => ({ ...r, ...catalogMatch(r) }));
    return res.json({
      ok: true,
      counts: {
        total: recommendations.length,
        alreadyInCatalog: recommendations.filter(r => r.inCatalog).length,
        newToAdd: recommendations.filter(r => !r.inCatalog).length,
      },
      recommendations,
    });
  } catch (e) {
    if (needsSetup(e)) return res.status(503).json({ ok: false, error: 'Run db/community.sql first.' });
    return res.status(500).json({ ok: false, error: 'Could not load recommendations.' });
  }
});

// --- POST /api/admin/recommendations/:id/hide  (and /show) -------------------
app.post('/api/admin/recommendations/:id/:action', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!requireAdminCsrf(req, res)) return;
  auditAction(req, 'recommendation.' + req.params.action, req.params.id);
  res.setHeader('Cache-Control', 'no-store');
  if (req.params.action !== 'hide' && req.params.action !== 'show') {
    return res.status(400).json({ ok: false, error: 'action must be hide or show' });
  }
  const id = adminAuth.parseRowId(req.params.id);
  if (id === null) return res.status(400).json({ ok: false, error: 'bad id' });
  const supa = getSupabaseAdmin();   // show/hide a recommendation
  // Precise wording: Supabase may well be configured — it is the ADMIN key that
  // is missing, and only that distinction tells the operator what to fix.
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase admin key not configured — writes are disabled.' });
  try {
    const { error } = await supa.from('recommendations')
      .update({ is_visible: req.params.action === 'show' }).eq('id', id);
    if (error) throw error;
    return res.json({ ok: true, id, is_visible: req.params.action === 'show' });
  } catch { return res.status(500).json({ ok: false, error: 'Update failed.' }); }
});

// ── Leaderboard review helpers ─────────────────────────────────────────────

// Which score columns this database can actually serve. Both extra groups came
// from later migrations, so a deployment that has not run them yet still gets a
// working screen instead of a PostgREST error about an unknown column.
async function reviewColumns(supa) {
  const hasStatus = await ensureStatusCap(supa);
  const hasEvidence = hasStatus && await ensureEvidenceCols(supa);
  return {
    hasStatus,
    hasEvidence,
    cols: 'id, slug, player_name, score, created_at'
      + (hasStatus ? ', status, flag_reason' : '')
      + (hasEvidence ? ', flag_evidence' : ''),
  };
}

/**
 * Add the two things a reviewer needs that are not on the row itself: the score
 * to compare against, and the quarantine explained in words.
 *
 * The board best used to be fetched one query per row. At the 200-row limit that
 * was 200 sequential round trips to render one table, and it got slower the more
 * there was to review — exactly backwards. One `in` query covers every slug on
 * the page instead.
 */
async function attachReviewContext(supa, rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  const slugs = [...new Set(list.map((r) => r.slug).filter(Boolean))];
  const best = new Map();
  if (slugs.length) {
    try {
      const { data } = await supa.from('scores')
        .select('slug, score').in('slug', slugs).eq('status', 'ok')
        .order('score', { ascending: false });
      for (const r of (data || [])) {
        if (!best.has(r.slug)) best.set(r.slug, r.score);   // ordered desc, so first wins
      }
    } catch { /* context is a nicety; the queue must still render without it */ }
  }
  return list.map((s) => ({
    ...s,
    currentBest: best.get(s.slug) ?? 0,
    verdict: s.status === 'ok' ? null : explainEvidence(s.flag_evidence, s.flag_reason),
  }));
}

// --- GET /api/admin/scores --------------------------------------------------
// The full leaderboard, not just the queue. Search by player or game, filter by
// status, sort, paginate. Defaults to status=flagged so the URL with no query
// string is still the review queue.
app.get('/api/admin/scores', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  const supa = getSupabase();
  if (!supa) return res.json({ ok: true, scores: [], total: 0, note: 'Supabase not configured.' });
  const qy = parseScoreQuery(req.query);
  try {
    const { hasStatus, hasEvidence, cols } = await reviewColumns(supa);
    let sel = supa.from('scores').select(cols, { count: 'exact' });
    // Without the status column every row is implicitly public, so a status
    // filter would silently return nothing rather than everything.
    if (hasStatus && qy.status !== 'all') sel = sel.eq('status', qy.status);
    const filter = searchFilter(qy.q);
    if (filter) sel = sel.or(filter);
    const { data, error, count } = await sel
      .order(qy.column, { ascending: qy.ascending })
      .range(qy.offset, qy.offset + qy.limit - 1);
    if (error) throw error;
    const scores = await attachReviewContext(supa, data || []);
    return res.json({
      ok: true, scores, total: count ?? scores.length,
      query: { q: qy.q, status: qy.status, sort: qy.sort, limit: qy.limit, offset: qy.offset },
      capabilities: { status: hasStatus, evidence: hasEvidence },
    });
  } catch (e) {
    if (needsSetup(e)) return res.status(503).json({ ok: false, error: 'Run db/community.sql first.' });
    return res.status(500).json({ ok: false, error: 'Could not load scores.' });
  }
});

// --- GET /api/admin/players/:name -------------------------------------------
// Everything one name has ever submitted. A single flagged row cannot tell you
// whether someone is cheating or had one odd game; their history can.
app.get('/api/admin/players/:name', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  const supa = getSupabase();
  if (!supa) return res.json({ ok: true, player: null, scores: [], note: 'Supabase not configured.' });
  const name = String(req.params.name || '').slice(0, 80);
  if (!name) return res.status(400).json({ ok: false, error: 'no player name' });
  try {
    const { cols } = await reviewColumns(supa);
    // eq(), not ilike() — this is an exact identity, and a pattern match here
    // would fold distinct players together in a way a moderator would not see.
    const { data, error } = await supa.from('scores')
      .select(cols).eq('player_name', name)
      .order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    const rows = data || [];
    return res.json({
      ok: true,
      player: { name, ...summarizePlayer(rows) },
      scores: await attachReviewContext(supa, rows),
    });
  } catch (e) {
    if (needsSetup(e)) return res.status(503).json({ ok: false, error: 'Run db/community.sql first.' });
    return res.status(500).json({ ok: false, error: 'Could not load player history.' });
  }
});

// --- GET /api/admin/scores/flagged ------------------------------------------
app.get('/api/admin/scores/flagged', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  const supa = getSupabase();
  if (!supa) return res.json({ ok: true, scores: [], note: 'Supabase not configured.' });
  try {
    if (!(await ensureStatusCap(supa))) {
      return res.json({ ok: true, scores: [], note: 'The `status` column is missing — run db/community-scores-integrity.sql.' });
    }
    // flag_evidence is what makes this queue reviewable rather than a guess:
    // the board best at the time, the ratio, measured play time and implied
    // points-per-second. Selected optionally so this endpoint still works on a
    // database that has not had db/community-scores-evidence.sql applied.
    const withEvidence = await ensureEvidenceCols(supa);
    const cols = 'id, slug, player_name, score, status, flag_reason, created_at'
      + (withEvidence ? ', flag_evidence' : '');
    const { data, error } = await supa.from('scores')
      .select(cols)
      .eq('status', 'flagged')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    const out = await attachReviewContext(supa, data || []);
    return res.json({ ok: true, scores: out, count: out.length });
  } catch (e) {
    if (needsSetup(e)) return res.status(503).json({ ok: false, error: 'Run db/community.sql first.' });
    return res.status(500).json({ ok: false, error: 'Could not load flagged scores.' });
  }
});

// --- POST /api/admin/scores/:id/approve | /reject ---------------------------
app.post('/api/admin/scores/:id/:action', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!requireAdminCsrf(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  // Validate BEFORE auditing. This used to write 'score.' + the raw path segment
  // into the audit log's action column, so any authenticated request could put
  // an arbitrary string into an append-only table that nobody can clean up.
  const ACTIONS = ['approve', 'reject', 'delete'];
  if (!ACTIONS.includes(req.params.action)) {
    return res.status(400).json({ ok: false, error: `action must be one of: ${ACTIONS.join(', ')}` });
  }
  const id = adminAuth.parseRowId(req.params.id);
  if (id === null) return res.status(400).json({ ok: false, error: 'bad id' });
  auditAction(req, 'score.' + req.params.action, String(id));
  const supa = getSupabaseAdmin();   // approve/reject/delete a score
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase admin key not configured — writes are disabled.' });
  const approve = req.params.action === 'approve';
  try {
    // Deletion is the one irreversible action here, so what was removed goes
    // into the audit trail first. Otherwise the delete destroys the only record
    // that it ever existed, and an append-only log that cannot answer "what was
    // in that row" is not much of a log.
    if (req.params.action === 'delete') {
      const { data: row } = await supa.from('scores')
        .select('slug, player_name, score, status').eq('id', id).maybeSingle();
      if (!row) return res.status(404).json({ ok: false, error: 'not found' });
      const { error } = await supa.from('scores').delete().eq('id', id);
      if (error) throw error;
      auditAction(req, 'score.delete.detail', String(id), 'success',
        `${row.player_name} · ${row.slug} · ${row.score} · was ${row.status}`);
      return res.json({ ok: true, id, action: 'delete', deleted: row });
    }
    // Approving makes the score public. The UNIQUE (slug, player_name) WHERE
    // status='ok' index (db/community-scores-unique.sql) means a player who
    // already has a visible row would collide — so fold it into their best.
    if (approve) {
      const { data: row, error: rowErr } = await supa.from('scores')
        .select('id, slug, player_name, score').eq('id', id).maybeSingle();
      if (rowErr) throw rowErr;
      if (!row) return res.status(404).json({ ok: false, error: 'not found' });
      const { data: existing } = await supa.from('scores')
        .select('id, score').eq('slug', row.slug).eq('player_name', row.player_name)
        .eq('status', 'ok').maybeSingle();
      if (existing) {
        if (row.score > existing.score) {
          const { error } = await supa.from('scores')
            .update({ score: row.score, created_at: new Date().toISOString() }).eq('id', existing.id);
          if (error) throw error;
        }
        await supa.from('scores').delete().eq('id', id);   // fold the flagged row away
        return res.json({ ok: true, id, action: 'approve', merged: true });
      }
    }
    const { error } = await supa.from('scores')
      .update(approve ? { status: 'ok', flag_reason: null } : { status: 'rejected', flag_reason: 'rejected by admin' })
      .eq('id', id);
    if (error) throw error;
    return res.json({ ok: true, id, action: req.params.action });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Update failed.' });
  }
});

// A tiny self-contained console. The secret is typed in, kept only in
// sessionStorage, and sent as a header — it is never part of a URL or the page.
const ADMIN_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>ZoFHub · Admin</title>
<style>
 :root{--bg:#171034;--surface:#241a55;--surface2:#2c2065;--line:rgba(170,140,255,.28);
   --text:#f7f4ff;--dim:#c3b6ee;--brand:#ffd426;--ok:#22e06a;--bad:#ff4d5e;--cyan:#22d3ee}
 *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);
   font:15px/1.5 "Segoe UI",system-ui,sans-serif;padding:24px}
 h1{font-size:22px;margin:0 0 4px}p.sub{color:var(--dim);margin:0 0 20px;font-size:13.5px}
 .wrap{max-width:1000px;margin:0 auto}
 .bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:18px}
 input,button{font:inherit}
 input{background:var(--surface2);border:1px solid var(--line);color:var(--text);
   border-radius:9px;padding:9px 12px;min-width:240px}
 button{background:var(--surface2);border:1px solid var(--line);color:var(--text);
   border-radius:9px;padding:9px 14px;cursor:pointer;font-weight:600}
 button:hover{border-color:var(--brand)}
 button.p{background:var(--brand);color:#241a00;border-color:var(--brand);font-weight:800}
 .tabs{display:flex;gap:8px;margin-bottom:14px}
 .tab{padding:8px 14px;border-radius:9px;cursor:pointer;font-weight:700;color:var(--dim);
   background:var(--surface);border:1px solid var(--line)}
 .tab.on{background:var(--brand);color:#241a00;border-color:var(--brand)}
 .row{background:var(--surface);border:1px solid var(--line);border-radius:11px;
   padding:12px 14px;margin-bottom:9px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
 .row .main{flex:1;min-width:220px}
 .t{font-weight:700}.m{color:var(--dim);font-size:12.5px;word-break:break-all}
 .pill{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;
   padding:3px 8px;border-radius:6px;white-space:nowrap}
 .dup{background:var(--bad);color:#fff}.new{background:var(--ok);color:#0b2c16}
 .num{font-variant-numeric:tabular-nums;font-weight:800}
 .msg{padding:12px 14px;border-radius:10px;background:var(--surface);border:1px solid var(--line);color:var(--dim)}
 .counts{color:var(--dim);font-size:13px;margin-bottom:12px}
</style></head><body><div class="wrap">
<h1>ZoFHub · private admin</h1>
<p class="sub">Only you can see this. Nothing here is public or indexed.</p>
<div class="bar">
  <input id="k" type="password" placeholder="ADMIN_SECRET" autocomplete="current-password">
  <button class="p" id="go">Unlock</button>
  <button id="out">Forget</button>
</div>
<div class="tabs">
  <div class="tab on" data-t="recs">Game requests</div>
  <div class="tab" data-t="scores">Flagged scores</div>
</div>
<div id="counts" class="counts"></div>
<div id="list"><div class="msg">Enter your ADMIN_SECRET to load.</div></div>
</div><script>
const $=s=>document.querySelector(s);let tab="recs";
const key=()=>sessionStorage.getItem("zh_admin")||"";
const H=()=>({"x-admin-secret":key()});
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));}
async function api(u,o){const r=await fetch(u,Object.assign({headers:H()},o||{}));return r.json().catch(()=>({ok:false,error:"bad response"}));}
async function load(){
  const L=$("#list"),C=$("#counts");
  if(!key()){L.innerHTML='<div class="msg">Enter your ADMIN_SECRET to load.</div>';C.textContent="";return;}
  L.innerHTML='<div class="msg">Loading…</div>';C.textContent="";
  if(tab==="recs"){
    const d=await api("/api/admin/recommendations");
    if(!d.ok){L.innerHTML='<div class="msg">'+esc(d.error||"Failed")+'</div>';return;}
    const r=d.recommendations||[];
    C.textContent=r.length+" submitted · "+d.counts.alreadyInCatalog+" already in catalog · "+d.counts.newToAdd+" new";
    L.innerHTML=r.length?r.map(x=>'<div class="row">'
      +'<span class="pill '+(x.inCatalog?"dup":"new")+'">'+(x.inCatalog?"Already in catalog":"New")+'</span>'
      +'<div class="main"><div class="t">'+esc(x.title)+'</div>'
      +'<div class="m">'+esc(x.embed_url)+'</div>'
      +'<div class="m">by '+esc(x.author)+' · '+esc(x.category)+' · '+x.views+' views'
      +(x.inCatalog?' · matches <b>'+esc(x.matchedTitle||x.matchedSlug||"")+'</b> (by '+esc(x.matchedBy)+')':'')
      +(x.is_visible?'':' · <b>hidden</b>')+'</div></div>'
      +'<button data-rec="'+x.id+'" data-act="'+(x.is_visible?"hide":"show")+'">'+(x.is_visible?"Hide":"Show")+'</button>'
      +'</div>').join(""):'<div class="msg">No submissions yet.</div>';
  }else{
    const d=await api("/api/admin/scores/flagged");
    if(!d.ok){L.innerHTML='<div class="msg">'+esc(d.error||"Failed")+'</div>';return;}
    const s=d.scores||[];
    C.textContent=(d.note?d.note+" · ":"")+s.length+" awaiting review";
    L.innerHTML=s.length?s.map(x=>'<div class="row">'
      +'<div class="main"><div class="t">'+esc(x.player_name)+' — <span class="num">'+Number(x.score).toLocaleString()+'</span></div>'
      +'<div class="m">'+esc(x.slug)+' · current public best <span class="num">'+Number(x.currentBest).toLocaleString()+'</span> · '+esc(x.flag_reason||"")+'</div></div>'
      +'<button class="p" data-sc="'+x.id+'" data-act="approve">Approve</button>'
      +'<button data-sc="'+x.id+'" data-act="reject">Reject</button>'
      +'</div>').join(""):'<div class="msg">Nothing flagged. 🎉</div>';
  }
}
document.addEventListener("click",async e=>{
  const t=e.target.closest(".tab"); if(t){document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("on",x===t));tab=t.dataset.t;load();return;}
  const sc=e.target.closest("[data-sc]");
  if(sc){sc.disabled=true;await api("/api/admin/scores/"+sc.dataset.sc+"/"+sc.dataset.act,{method:"POST"});load();return;}
  const rc=e.target.closest("[data-rec]");
  if(rc){rc.disabled=true;await api("/api/admin/recommendations/"+rc.dataset.rec+"/"+rc.dataset.act,{method:"POST"});load();return;}
});
$("#go").onclick=()=>{sessionStorage.setItem("zh_admin",$("#k").value.trim());$("#k").value="";load();};
$("#k").addEventListener("keydown",e=>{if(e.key==="Enter")$("#go").click();});
$("#out").onclick=()=>{sessionStorage.removeItem("zh_admin");load();};
if(key())load();
</script></body></html>`;

// ── The admin console ──────────────────────────────────────────────────────
// /admin/login  — always reachable; it is the only way in.
// /admin        — the dashboard. An unauthenticated caller is REDIRECTED to the
//                 login page and never receives the dashboard document at all.
//
// That last point is the difference between real access control and hiding the
// UI: the previous console shipped its markup to anyone who asked and merely
// failed the API calls afterwards, which leaks the console's structure and
// invites people to poke at the endpoints behind it.
//
// The old inline ADMIN_HTML is retained below as the LOCAL-DEV fallback for a
// deployment that has not configured the new credentials yet, so upgrading does
// not lock an operator out of a running site before they run `npm run admin-hash`.
// The console lives in admin-ui/, which is OUTSIDE PUBLIC_DIR — deliberately.
//
// The first version of this put it in public/admin/, and express.static served
// public/admin/admin-dashboard.html to anonymous callers with a 200, bypassing
// every check below. Reordering middleware would have "fixed" that, but only
// until someone moved the static mount again. Keeping these documents out of the
// web root means there is no ordering to get wrong: the static handler cannot
// serve a file it cannot see.
const ADMIN_DIR = join(__dirname, 'admin-ui');

// Assets are served by an explicit, hard-coded allowlist — never a directory
// mount — so no path traversal or new file can widen what is reachable.
// Only the two the LOGIN page needs are public; the dashboard's script requires
// a session, because there is no reason to hand its shape to an anonymous caller.
const ADMIN_ASSETS = {
  'admin.css':       { file: 'admin.css',       type: 'text/css; charset=utf-8',        public: true },
  'admin-login.js':  { file: 'admin-login.js',  type: 'text/javascript; charset=utf-8', public: true },
  'admin.js':        { file: 'admin.js',        type: 'text/javascript; charset=utf-8', public: false },
};

app.get('/admin/login', (req, res) => {
  // Already signed in? Don't show a login form; go where they were going.
  if (req.admin) return res.redirect(302, '/admin');
  res.sendFile(join(ADMIN_DIR, 'admin-login.html'));
});

app.get('/admin/assets/:name', (req, res) => {
  const entry = ADMIN_ASSETS[Object.prototype.hasOwnProperty.call(ADMIN_ASSETS, req.params.name)
    ? req.params.name : ''];
  if (!entry) return res.status(404).type('text').send('not found');
  if (!entry.public && !req.admin) return res.status(401).type('text').send('unauthorized');
  res.type(entry.type).sendFile(join(ADMIN_DIR, 'assets', entry.file));
});

app.get('/admin', (req, res) => {
  if (!req.admin) {
    // No configured credentials AND no session: fall back to the legacy console
    // so a live site is not stranded mid-upgrade. It still authenticates every
    // API call with ADMIN_SECRET; it simply has no login page of its own.
    if (!adminAuth.adminConfigStatus().ok) return res.type('html').send(ADMIN_HTML);
    return res.redirect(302, '/admin/login');
  }
  res.sendFile(join(ADMIN_DIR, 'admin-dashboard.html'));
});

// Anything else under /admin is not a thing. Explicit 404 rather than falling
// through to the catch-all, so no future static mount can pick it up.
app.use('/admin', (req, res) => {
  res.status(404).type('text').send('not found');
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

// sessionId -> { slug, lastSeen }. Deliberately NO ip: the comment used to claim
// one was stored, but nothing ever set it. Abuse is handled by the writeAllow()
// gate on the beat/leave handlers instead, so there's no reason to hold visitor
// IPs in memory on a site whose privacy policy promises minimal collection.
const presence = new Map();
const sseClients = new Set();        // res objects subscribed to the stream

function presenceSnapshot() {
  // Object.create(null), NOT {}. This object is keyed by a slug the CLIENT
  // supplies, and a plain object literal inherits from Object.prototype — so
  // `games['constructor']` reads back the Object constructor rather than
  // undefined, and `(fn || 0) + 1` concatenates instead of adding:
  //
  //   {"games":{"constructor":"function Object() { [native code] }1"}}
  //
  // That was broadcast verbatim to every SSE subscriber. It is not only an
  // adversarial case — the catalog contains a real game slugged `constructor`
  // (id 6974, "Constructor"), so playing it triggered this in normal use and
  // its live-player badge could never light up. `toString`, `valueOf` and the
  // rest of the prototype behave the same way.
  //
  // A null-prototype object has nothing to inherit, which removes the whole
  // class rather than blocklisting the names. JSON.stringify treats it exactly
  // like any other object, so the wire format is unchanged.
  const games = Object.create(null);
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
  // Rate-limited like every other mutating endpoint. Without this, anyone could
  // POST a flood of fresh random sessionIds at a real slug to inflate its
  // "N playing" badge, or push the map toward PRESENCE_MAX_SESSIONS to evict
  // genuine sessions via the oldest-first sweep. Sized well above the client's
  // real cadence (BEAT_MS = 2s in public/js/presence.js): 10 per 5s.
  if (!writeAllow(req.ip || 'unknown', 10, 5000)) {
    return res.status(429).json({ ok: false, error: 'Too many requests — slow down.' });
  }
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
  // Same gate as /beat. 204 (not 429) on trip: this is a fire-and-forget beacon
  // the client never reads, and the session still expires via the 8s TTL.
  if (!writeAllow(req.ip || 'unknown', 10, 5000)) return res.status(204).end();
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

// NOTE: a single-flight Supabase loader (loadCatalogPage / pageInFlight) lived
// here and was removed when Mode 1 stopped querying the database per request.
// It is unreachable now, and leaving it would suggest this endpoint still hits
// Supabase, which it does not. Recoverable from git history if ever needed.

app.get('/api/games', async (req, res) => {
  // -------- Mode 1: page-based --------
  //
  // THIS USED TO QUERY SUPABASE DIRECTLY, AND IT WAS BROKEN. Recording why, so
  // nobody "restores" it:
  //
  //   The query was `ORDER BY id DESC LIMIT n OFFSET m`, and the in-repo
  //   override rules (data/catalog-overrides.json — dead hosts, unlicensed
  //   copies, duplicates; ~2.3k games) were applied to the rows AFTER they came
  //   back. Filtering after pagination means a page of 24 can return anything
  //   from 24 games down to none, and `total` reported the UNFILTERED count.
  //
  //   That is not a theoretical problem. `id DESC` walks newest-first, and the
  //   newest ~2,000 rows are where the removed games are concentrated — 97-99%
  //   of positions 200-2000 are removed. Measured against the live database:
  //   page 1 returned 22 of 24, page 2 returned 19, and pages 6 through ~83
  //   returned ZERO, while `total` cheerfully advertised 16,820 games. Any
  //   client paging through this hit a wall of empty pages almost immediately.
  //
  //   It also ordered by INSERTION ORDER, which is not a feed. Whatever was
  //   imported last led the page regardless of quality or popularity.
  //
  // The fix is to serve from the in-memory catalog, because that is where the
  // override rules can actually be applied — they are JS matchers (slug /
  // titleAllOf / hostIncludes), so no SQL ORDER BY can express them. Filtering
  // has to happen where the rules live. That gives exact pagination, an honest
  // total, and the same popularity ranking Mode 2 uses.
  //
  // Trade-off, stated plainly: the catalog refreshes from Supabase every 30
  // minutes, so this is eventually-consistent rather than live. For a game
  // catalog that is fine, and Mode 2 has always worked this way.
  if (req.query.page !== undefined) {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 24));
    const offset = (page - 1) * limit;
    const cat = req.query.category
      ? canonCategory(String(req.query.category).toLowerCase())
      : null;
    const seed = (req.query.seed || '').toString().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || null;

    const list = orderedList(cat && cat !== 'all' ? cat : null, seed);
    const slice = list.slice(offset, offset + limit);

    // Both field names are populated on purpose. The in-memory catalog
    // normalises to `thumbnail`, but this endpoint has always returned
    // `thumbnail_url` as well, and an external consumer may read either.
    const games = slice.map(g => ({
      ...g,
      thumbnail_url: g.thumbnail_url || g.thumbnail || '',
      game_url: g.game_url || g.embed_url || '',
    }));

    res.setHeader('Cache-Control', seed ? 'private, max-age=60' : PAGE_CACHE_CONTROL);
    res.setHeader('X-Cache', 'MEMORY');
    return res.json({
      games,
      page,
      limit,
      // The real, post-filter count — so `Math.ceil(total/limit)` is the true
      // number of pages and the last one is where the games actually end.
      total: list.length,
      pages: Math.max(1, Math.ceil(list.length / limit)),
      source: CATALOG.source || 'memory',
    });
  }

  // -------- Mode 2: in-memory, popularity-ranked + per-visit shuffle --------
  const limit  = Math.min(parseInt(req.query.limit) || 200, 1000);
  const offset = parseInt(req.query.offset) || 0;
  // Canonicalized for the same reason as /category/:catSlug — an alias spelling
  // would otherwise compare against already-canonical stored values and return [].
  const cat    = req.query.category ? canonCategory(String(req.query.category).toLowerCase()) : req.query.category;
  const q      = (req.query.q || '').toLowerCase();
  // `seed` makes the order popularity-WEIGHTED-RANDOM and stable for this visit;
  // sanitized to a short token. Absent → deterministic popularity order.
  const seed   = (req.query.seed || '').toString().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || null;

  if (q) {
    // Search: deterministic, most-played matches first; edge-cacheable.
    let list = (cat && cat !== 'all') ? (byCategory.get(cat) || []) : CATALOG.games;
    list = rankByPopularity(list.filter(g => g.title.toLowerCase().includes(q)));
    // Collapse repeated titles. Ranking alone cannot fix this: searching
    // "color road" matched exactly two rows and BOTH were returned, so the
    // results read "Color Road / Color Road". Sorting only decides which of the
    // two comes first. Search is where duplicates are most visible, because the
    // result set is small and the copies end up adjacent.
    //
    // rankByPopularity has already put the best copy of each title first (it
    // includes the feed-ranking score, which demotes non-canonical duplicates),
    // so keeping the FIRST occurrence keeps the right one. The others are not
    // deleted — they remain reachable by direct URL and on category pages.
    const seenTitle = new Set();
    list = list.filter(g => {
      const key = String(g.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!key) return true;
      if (seenTitle.has(key)) return false;
      seenTitle.add(key);
      return true;
    });
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
// /api/for-you — personalised recommendations from THIS device's history.
// ------------------------------------------------------------------------
// The client posts the slugs it has in localStorage (store.history /
// store.favorites) and gets back a ranked, de-duplicated, genre-diversified
// row. Nothing about the user is stored here — see the header comment in
// lib/recommender.mjs for why that is deliberate rather than lazy.
//
// POST, not GET, for two reasons: a history of 60 slugs does not belong in a
// URL, and a GET would invite a CDN or proxy to cache one person's personalised
// row and serve it to everyone. The response is explicitly no-store for the
// same reason.
//
// This handler always answers 200 with a games array (429 when rate-limited;
// a malformed JSON body is rejected as 400 by express.json() before it gets
// here). A recommendation row is decoration — if anything inside it fails, the
// page should quietly show fewer tiles, never an error.
// ========================================================================
const FOR_YOU_MAX_SEEDS = 60;   // history is capped at 80 client-side; decay makes
                                // anything past ~40 mathematically irrelevant anyway
const FOR_YOU_MAX_LIMIT = 36;

app.post('/api/for-you', (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
      .split(',')[0].trim();
    // Cheap endpoint, but it reads the whole catalog on the fallback path, so
    // it still gets a bucket. Generous limit: a normal page load makes one call.
    if (!writeAllow(ip, 30, 2000)) {
      return res.status(429).json({ games: [], error: 'rate-limited' });
    }

    const clean = (arr) => (Array.isArray(arr) ? arr : [])
      .map(s => String(s || '').toLowerCase().slice(0, 80))
      .filter(Boolean)
      .slice(0, FOR_YOU_MAX_SEEDS);

    const history   = clean(req.body?.history);
    const favorites = clean(req.body?.favorites);
    const limit = Math.min(FOR_YOU_MAX_LIMIT,
      Math.max(1, parseInt(req.body?.limit, 10) || 18));

    const games = recommendGames({
      history,
      favorites,
      limit,
      // bySlug is the LIVE catalog, which has already had catalog-overrides
      // applied — so a game the offline index still knows about but that has
      // since been removed simply resolves to undefined and is skipped. This is
      // exactly why the Python builder does not re-implement the override rules.
      getGame: (slug) => bySlug.get(slug),
      pool: () => CATALOG.games,
      playsOf: (slug) => playCounts.get(slug) || 0,
    });

    return res.json({
      games,
      count: games.length,
      personalized: history.length > 0 || favorites.length > 0,
      indexed: simIndexSize(),
    });
  } catch (e) {
    console.warn('[for-you] failed:', e.message);
    return res.json({ games: [], count: 0, error: 'unavailable' });
  }
});

// ========================================================================
// GET /api/weather — live conditions + 3-day forecast from Open-Meteo.
// ------------------------------------------------------------------------
// Location, most explicit first: ?lat&lon -> ?city -> ?tz (IANA timezone).
// The widget sends `tz` because the browser already knows it and it needs no
// permission prompt and no third-party IP lookup — see lib/weather.mjs.
//
// Publicly cacheable: the response depends only on the coordinates, contains
// nothing about the requester, and weather is identical for everyone in a city.
// That lets a CDN absorb the traffic from a widget that renders on every page.
// ========================================================================
app.get('/api/weather', async (req, res) => {
  try {
    if (!writeAllow(req.ip || 'unknown', 30, 2000)) {
      res.set('Cache-Control', 'no-store');
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }
    const place = await weather.resolveLocation({
      lat: req.query.lat, lon: req.query.lon,
      city: req.query.city ? String(req.query.city).slice(0, 80) : null,
      tz: req.query.tz ? String(req.query.tz).slice(0, 64) : null,
    });
    if (!place) {
      res.set('Cache-Control', 'public, max-age=60');
      return res.status(400).json({ ok: false, error: 'location_unresolved' });
    }
    const wx = await weather.forecast(place.latitude, place.longitude);
    res.set('Cache-Control', 'public, max-age=600, s-maxage=600, stale-while-revalidate=1800');
    return res.json({
      ok: true,
      place: { name: place.name, country: place.country },
      ...wx,
    });
  } catch (e) {
    // Never invent a temperature. A weather widget that guesses is worse than
    // one that admits it is unavailable.
    console.warn('[weather] failed:', e.message);
    res.set('Cache-Control', 'no-store');
    return res.status(503).json({ ok: false, error: 'weather_unavailable' });
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
    // Anchor BOTH ends. A leading \b only meant "starts a word", so "car" fired on
    // cartoon/career/cardboard and "cry" fired on crystal — pulling whole moods
    // into the wrong bucket.
    if (b.t.some(tr => new RegExp('\\b' + tr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(t))) {
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
    thumbnail: thumbUrl(g.thumbnail || g.thumbnail_url || ''),
    category: g.category || 'arcade',
  }));
}

// `ip` is used for the same rate/concurrency gates every other AI call goes
// through — this was the one outbound AI path with NO throttling at all.
async function vibeKeywordsFromAI(text, req) {
  // PRODUCTION GUARD FIRST — this was the AI path that escaped the audit.
  //
  // /api/ai/* is refused in production, but this route is not under /api/ai, so
  // it was never gated: a Vibe Finder search whose mood missed the curated map
  // sent the visitor's TYPED TEXT to Pollinations FROM THIS SERVER, on the
  // server's IP. Measured under NODE_ENV=production before this guard existed:
  // "relaxing puzzle" — an entirely ordinary query — took 3.02s because it was
  // waiting on that outbound call. It was not an edge case.
  //
  // The Vibe Finder does not degrade: vibeKeywords() is the curated source of
  // truth and the AI was only ever an optional refinement, so the caller's
  // catch already falls back to it. In production the fallback is now the ONLY
  // path, which also makes every mood search instant instead of costing up to
  // 2.5s of dead wait.
  if (!aiServerAllowed(req)) throw new Error('client-side-only');
  const ip = req?.ip || 'unknown';
  // Gate next: unthrottled, this fired an outbound Pollinations request on every
  // mood search that missed the local bucket map.
  if (!ipAllow(ip)) throw new Error('rate-limited');
  if (!aiGateEnter()) throw new Error('ai-busy');
  try {
    const messages = [
      { role: 'system', content: 'You translate a player\'s mood into video-game genres. Reply with ONLY comma-separated keywords chosen from the allowed list — no sentences, no extra words.' },
      { role: 'user', content: `Allowed keywords: ${VIBE_ALLOWED.join(', ')}\nMood: "${String(text).slice(0, 200)}"\nPick the 4-8 best-matching keywords from the allowed list:` },
    ];
    // Tight budget — the curated mood map is the source of truth, so the AI is a
    // quick optional refinement, never something the user waits on. The abort
    // controller makes the 2.5s budget REAL: the old Promise.race just stopped
    // waiting and left the upstream call running (up to ~90s) with no throttle.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const { text: model } = await resolveModels().catch(() => ({ text: undefined }));
    let reply;
    try {
      reply = await pollinationsChat(messages, 2500, { model, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    const allow = new Set(VIBE_ALLOWED);
    return (reply || '').toLowerCase().replace(/[^a-z, ]/g, ' ').split(/[,\s]+/).map(s => s.trim()).filter(w => allow.has(w));
  } finally {
    aiGateLeave();
  }
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
      const ai = await vibeKeywordsFromAI(q, req);
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
        thumbnail: thumbUrl(g.thumbnail || g.thumbnail_url || ''),
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

// Shared implementation for BOTH embed routes (catalog games and community
// recommendations) so community picks get identical treatment: same-origin
// delivery, the injected <base href>, the fit-to-frame CSS and the EMBED_GUARD.
// `cacheKeyBase` just namespaces the rewritten-HTML cache.
async function serveEmbed(req, res, upstreamUrl, cacheKeyBase) {
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
  const cacheKey = `${cacheKeyBase}|${uaPick}`;
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
}

// Community-recommended game, proxied exactly like a catalog game.
// Registered BEFORE /embed/:slug for clarity (the extra path segment already
// keeps them from colliding). Without this route the Community "Play" modal
// iframed the publisher URL directly, which (a) skipped the per-publisher render
// fixes catalog games rely on and (b) exposed the game's real CDN to network
// filters — breaking the same-origin "unblock at school" guarantee for exactly
// the games a visitor contributed.
app.get('/embed/rec/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).type('html').send('Bad recommendation id');
  const supa = getSupabase();
  if (!supa) return res.status(503).type('html').send('Community backend unavailable');
  let rec;
  try {
    const { data, error } = await supa.from('recommendations')
      .select('id, embed_url, is_visible').eq('id', id).maybeSingle();
    if (error) throw error;
    rec = data;
  } catch { return res.status(503).type('html').send('Community backend unavailable'); }
  if (!rec || !rec.is_visible) return res.status(404).type('html').send('Recommendation not found');
  // Re-validate at SERVE time, not just at submit time: the trusted-host list
  // changes (onlinegames.io / htmlgames.com were removed after being proven to
  // black-screen), and rows submitted under the old list must not still render.
  if (!recHostOk(rec.embed_url)) {
    return res.status(403).type('html').send('This game is no longer from a supported embeddable source.');
  }
  return serveEmbed(req, res, rec.embed_url, `rec:${id}`);
});

app.get('/embed/:slug', async (req, res) => {
  const game = bySlug.get(req.params.slug);
  if (!game) return res.status(404).type('html').send('Game not found');
  return serveEmbed(req, res, game.embed_url, req.params.slug);
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

// 100 MB. Unity WebGL .data/.wasm files (decompressed) are routinely far larger
// than a normal image/audio asset. We STREAM the body (below) instead of buffering,
// so raising this ceiling costs no extra memory. (Was 25 MB — which 413'd every
// large Unity game, so their data file never downloaded and the game surfaced an
// "unfixable" JavaScript loading error. Smaller HTML5 games stayed under 25 MB,
// which is exactly why ONLY Unity games were affected.)
// ---- Same-origin thumbnail proxy (see THUMB_PROXY_HOSTS near the top) ------
// Fetches a publisher-CDN thumbnail server-side and re-serves it from our own
// origin, so ad-blockers can't block it. Results are cached on disk so we hit
// each upstream image once, not once per visitor.
const THUMB_CACHE_DIR = join(__dirname, '.cache', 'thumbs');
const THUMB_MAX_BYTES = 5 * 1024 * 1024;
const thumbInFlight = new Map();   // url -> Promise<{buf, type}>

async function fetchThumb(target) {
  const key = createHash('sha1').update(target).digest('hex');
  const ext = (target.match(/\.(webp|png|jpe?g|gif|avif)(?:$|[?#])/i) || [])[1] || 'img';
  const file = join(THUMB_CACHE_DIR, `${key}.${ext.toLowerCase()}`);
  if (existsSync(file)) {
    try { return { buf: readFileSync(file), type: mimeForExt(ext) }; } catch {}
  }
  if (thumbInFlight.has(target)) return thumbInFlight.get(target);
  const work = (async () => {
    const r = await fetchAsBrowser(target, { ua: UA_POOL[0], timeoutMs: 12_000, accept: 'image/avif,image/webp,image/*,*/*' });
    if (!r.ok) throw new Error('upstream ' + r.status);
    const type = r.headers.get('content-type') || '';
    if (!/^image\//i.test(type)) throw new Error('not an image');
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > THUMB_MAX_BYTES) throw new Error('bad size');
    try { mkdirSync(THUMB_CACHE_DIR, { recursive: true }); writeFileSync(file, buf); } catch {}
    return { buf, type };
  })();
  thumbInFlight.set(target, work);
  try { return await work; } finally { thumbInFlight.delete(target); }
}
function mimeForExt(e) {
  e = String(e).toLowerCase();
  return e === 'png' ? 'image/png' : e === 'gif' ? 'image/gif' : e === 'webp' ? 'image/webp'
       : e === 'avif' ? 'image/avif' : e === 'img' ? 'application/octet-stream' : 'image/jpeg';
}

app.get('/thumb', async (req, res) => {
  const raw = req.query.u;
  if (!raw || typeof raw !== 'string') return res.status(400).type('text').send('missing ?u=');
  let target;
  try { target = new URL(raw); } catch { return res.status(400).type('text').send('bad url'); }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return res.status(400).type('text').send('http(s) only');
  if (isInternalHost(target.hostname)) return res.status(403).type('text').send('blocked host');
  // Never a general-purpose image proxy: only the known game CDNs.
  if (!THUMB_PROXY_HOSTS.test(target.hostname)) return res.redirect(302, target.toString());
  try {
    const { buf, type } = await fetchThumb(target.toString());
    res.setHeader('content-type', type);
    res.setHeader('cache-control', 'public, max-age=604800, immutable');   // 7 days
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
    return res.end(buf);
  } catch {
    // Upstream dead/blocked us — fall back to the original URL so the browser
    // still gets its chance (and the tile's own fallback handles a real miss).
    return res.redirect(302, target.toString());
  }
});

const ASSET_MAX_BYTES = 100 * 1024 * 1024;

app.get('/asset', async (req, res) => {
  const raw = req.query.u;
  if (!raw || typeof raw !== 'string') return res.status(400).type('text').send('missing ?u=');

  let target;
  try { target = new URL(raw); } catch { return res.status(400).type('text').send('bad url'); }
  if (target.protocol !== 'https:') return res.status(400).type('text').send('https only');
  if (isInternalHost(target.hostname)) return res.status(403).type('text').send('blocked host');
  // This server never fetches an inference endpoint for a caller. See
  // AI_PROVIDER_HOSTS — without this, /asset was a working AI proxy.
  if (AI_PROVIDER_HOSTS.test(target.hostname)) {
    return res.status(403).type('text').send('AI providers are not proxied — ZoFHub runs AI in your browser');
  }

  try {
    const r = await fetchAsBrowser(target.toString(), {
      ua: UA_POOL[0],
      timeoutMs: 15_000,          // TTFB only; the body streams below with no time cap
      accept: req.headers['accept'] || '*/*'
    });

    // Keep upstream's content-type, but force application/wasm for Unity's WebAssembly
    // so WebAssembly.instantiateStreaming() accepts it (otherwise Unity errors out or
    // falls back to a slower path). fetch() already decompressed the body, so we send
    // NO content-encoding — the bytes are the final decoded content.
    let ct = r.headers.get('content-type') || 'application/octet-stream';
    if (/\.wasm(\.[a-z0-9]+)?$/i.test(target.pathname)) ct = 'application/wasm';
    res.status(r.status);
    res.setHeader('content-type', ct);
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-expose-headers', '*');
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
    res.setHeader('cache-control', 'public, max-age=300');

    if (!r.body) return res.end();

    // STREAM the body straight to the client — never buffer a whole multi-MB/GB
    // asset in memory. Enforce the size cap incrementally and respect backpressure.
    const reader = r.body.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) { try { await reader.cancel(); } catch {} break; }   // client left
      total += value.length;
      if (total > ASSET_MAX_BYTES) { try { await reader.cancel(); } catch {} break; }
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => {
          const cleanup = () => { res.off('drain', cleanup); res.off('close', cleanup); resolve(); };
          res.once('drain', cleanup);
          res.once('close', cleanup);   // client disconnected mid-write — don't hang
        });
      }
    }
    return res.end();
  } catch (e) {
    if (!res.headersSent) return res.status(502).type('text').send('asset proxy failed: ' + (e.message || 'unknown'));
    try { return res.end(); } catch {}
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
  // Same rule as /asset. This endpoint diagnoses GAME embeds, but the probe
  // below is fetchAsBrowser(), which issues a full GET with redirects followed —
  // not the HEAD its own comment implies. Aimed at an inference endpoint it
  // would make this server generate and download AI output.
  if (AI_PROVIDER_HOSTS.test(target.hostname)) {
    return res.status(403).json({ ok: false, error: 'AI providers are not fetched by this server' });
  }

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
  // ZoFHub is always a proxy site (PROXY_ENABLED is always true), so games load
  // SAME-ORIGIN through /embed by default — a network filter only ever sees THIS
  // domain, never the game CDN. Routing is per-HOST because a few publishers need
  // special handling:
  //
  //  • GameDistribution + GameMonetize → always DIRECT. Their SDK does
  //    origin/referrer checks that FAIL when re-served through our proxy (black
  //    screen), and their assets come from generic HTML5 game CDNs that content
  //    filters almost never block, so a direct embed still loads behind a school
  //    filter. (isSdkDirectOnly below.)
  //  • Y8 / HTMLGames / Famobi → always PROXIED, even though they could embed
  //    direct: Y8 needs the injected fit-to-frame CSS (Y8_FIT_CSS); HTMLGames
  //    ship relative assets that need a corrected <base href>; Famobi's Play
  //    button uses window.open and needs the EMBED_GUARD to stay in-frame.
  //  • Everything else safe to proxy → SAME-ORIGIN /embed.
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
    'Disallow: /wisp/',
    // /licenses, /licenses/* and /licenses.json are DELIBERATELY crawlable.
    // They carry the AGPL-3.0 §13 source offer and the §5 modification notice.
    // The proxy engine PATHS above are disallowed (they are machine assets that
    // can get a domain classified as an anonymizer), but the license and source
    // offer for that same code must stay openly reachable. Do not add a
    // Disallow for /licenses.
    'Allow: /licenses',
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
  // The copyleft source offer. Listed so it is independently discoverable even
  // if the footer link is ever lost in a redesign — AGPL §13 compliance should
  // not depend on one nav element surviving.
  add('/licenses', '0.4', 'monthly');
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
  // Raw banner tags for the three fixed display slots. Each is refused outright
  // if it contains Google ad code (AdSense on a proxy domain is an ACCOUNT-level
  // ban, so this can never be allowed to slip through — same rule as the
  // page-level scripts above).
  //   PROXY_BANNER_TAG  → footer banner   (footer-ad.js)
  //   PROXY_HEADER_TAG  → header 728×90   (ad-slots.js)
  //   PROXY_SIDEBAR_TAG → sidebar 300×250 (ad-slots.js)
  // Unset = that slot simply never renders. No empty boxes, ever.
  const GOOGLE_AD_RE = /googlesyndication|googleadservices|adsbygoogle|doubleclick/i;
  const safeTag = (v) => { const s = (v || '').trim(); return GOOGLE_AD_RE.test(s) ? '' : s; };
  const proxyBannerTag  = safeTag(process.env.PROXY_BANNER_TAG);
  const proxyHeaderTag  = safeTag(process.env.PROXY_HEADER_TAG);
  const proxySidebarTag = safeTag(process.env.PROXY_SIDEBAR_TAG);
  res.json({ proxy: true, proxyAdScripts, proxyBannerTag, proxyHeaderTag, proxySidebarTag });
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
const contactEmail = (process.env.CONTACT_EMAIL || '').trim();
// The fallback used to link this repo's GitHub Issues page. That link is dead by
// DESIGN — the repo is intentionally private — so a rights-holder trying to file
// a DMCA notice, or any user with a privacy/terms question, hit a 404 on every
// deploy that didn't set CONTACT_EMAIL (which render.yaml never did). Saying
// plainly that no address is published yet is worse-looking but honest, and it
// doesn't send someone chasing a link that can never work.
// → Set CONTACT_EMAIL in the host dashboard to replace this everywhere.
const CONTACT_HTML = contactEmail
  ? `<a href="mailto:${htmlEscape(contactEmail)}">${htmlEscape(contactEmail)}</a>`
  : `<strong>a contact address has not been published yet</strong>`;
const SITE_URL_SET = !!(process.env.SITE_URL || '').trim();
const SITE_URL_HTML = SITE_URL_SET ? htmlEscape(process.env.SITE_URL.trim()) : 'this website';
function renderLegal(file, siteUrlHtml = SITE_URL_HTML) {
  const raw = readFileSync(join(LEGAL_DIR, file), 'utf8');
  return raw.replace(/\{\{CONTACT\}\}/g, CONTACT_HTML)
            .replace(/\{\{SITE_URL\}\}/g, siteUrlHtml);
}

// ── Naming the site when SITE_URL is unset ─────────────────────────────────
// SITE_URL is `sync: false` in render.yaml, so it is easy to deploy without it,
// and then a DMCA policy reads "…governs your use of this website", which is
// exactly where a real domain name matters most. Rather than leave that to a
// dashboard field nobody revisits, derive the origin from the request the
// visitor actually made.
//
// THE HOST HEADER IS ATTACKER-CONTROLLED, so this is deliberately narrow:
//   * strict hostname grammar + length cap — no spaces, no scheme, no path
//   * the result is htmlEscape()d like any other interpolated value
//   * a bad host falls back to "this website" rather than rendering anything
//   * the per-host render cache is bounded, so junk Host headers cannot grow it
//   * responses Vary on the headers templated from, so a shared cache can never
//     serve one host's page to a visitor on another
//
// It affects PAGE TEXT ONLY. SITE_URL_ORIGIN, which gates CORS, stays purely
// env-derived above — deriving a trust boundary from a header the caller
// controls would defeat the entire check. A spoofed Host here changes nothing
// but the wording of the attacker's own response.
const LEGAL_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;
function originFromRequest(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0].trim();
  if (!host || host.length > 253 || !LEGAL_HOST_RE.test(host)) return '';
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
             || req.protocol || 'https';
  if (proto !== 'http' && proto !== 'https') return '';
  return `${proto}://${host}`;
}
const LEGAL_PAGES = {
  '/privacy': 'privacy.html',
  '/terms':   'terms.html',
  '/dmca':    'dmca.html',
  '/cookies': 'cookies.html',
  '/credits': 'credits.html',
};
// Attribution table for /credits, built from the packages actually installed.
// Generated once at boot for the same reason the licence manifest is: a
// hand-written list is wrong the moment a dependency changes, and nothing
// breaks to tell you.
function renderDependencyTable() {
  const rows = getCredits().map(c => {
    const link = c.repository || c.homepage || '';
    const nameCell = link
      ? `<a href="${htmlEscape(link)}" target="_blank" rel="noopener">${htmlEscape(c.name)}</a>`
      : htmlEscape(c.name);
    const ver = c.version ? ` <span class="lic-ver">v${htmlEscape(c.version)}</span>` : '';
    const dev = c.dev ? ' <span class="lic-ver">(build tool only)</span>' : '';
    const copyleft = c.copyleft ? ' lic-copyleft' : '';
    // Where package.json and the LICENCE FILE disagree, show both. An
    // unexplained "MIT -> AGPL-3.0" on a credits page reads as an error; the
    // discrepancy is itself the useful information, and it is the reason this
    // table trusts the file over the metadata.
    const conflict = c.licenceConflict
      ? `<div class="lic-role">package.json declares &ldquo;${htmlEscape(c.declaredLicence)}&rdquo;, but the bundled LICENSE file is ${htmlEscape(c.licence)} &mdash; the file governs.</div>`
      : '';
    return `            <tr>
              <td>${nameCell}${ver}${dev}${conflict}</td>
              <td><span class="lic-spdx${copyleft}">${htmlEscape(c.licence)}</span></td>
              <td>${htmlEscape(c.author || '—')}</td>
            </tr>`;
  }).join('\n');

  const s = creditsSummary();
  return `<p class="legal-updated">${s.total} direct dependencies &middot; ${s.copyleft} copyleft &middot; ${s.dev} build-only`
    + (s.conflicts ? ` &middot; ${s.conflicts} with a licence discrepancy` : '')
    + `</p>
      <div class="lic-wrap">
        <table class="lic-table">
          <thead><tr><th>Package</th><th>Licence</th><th>Author</th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>`;
}

for (const [route, file] of Object.entries(LEGAL_PAGES)) {
  if (!existsSync(join(LEGAL_DIR, file))) continue;
  const build = (siteUrlHtml) => {
    let out = renderLegal(file, siteUrlHtml);
    if (route === '/credits') {
      out = out.replace(/\{\{DEPENDENCY_TABLE\}\}/g, renderDependencyTable());
    }
    return out;
  };
  // A placeholder that survives substitution renders as literal {{TOKEN}} to
  // visitors. That shipped once; a boot-time warning makes it impossible to
  // miss again. Checked on the boot-time render, so it still fires even when
  // the page is later re-templated per host.
  let html = build(SITE_URL_HTML);
  const leftover = html.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) console.warn(`[legal] ${file} still contains ${leftover[0]} after templating`);

  if (SITE_URL_SET) {
    // Fast path, unchanged: one render at boot, served to everyone.
    app.get(route, (req, res) => res.set('Cache-Control', 'public, max-age=3600').send(html));
  } else {
    // Name the origin the visitor actually reached. Bounded cache — a flood of
    // junk Host headers costs at most MAX_HOSTS renders, then resets.
    const byHost = new Map();
    const MAX_HOSTS = 8;
    app.get(route, (req, res) => {
      res.set('Vary', 'Host, X-Forwarded-Host, X-Forwarded-Proto');
      res.set('Cache-Control', 'public, max-age=3600');
      const origin = originFromRequest(req);
      if (!origin) return res.send(html);          // falls back to "this website"
      let page = byHost.get(origin);
      if (!page) {
        if (byHost.size >= MAX_HOSTS) byHost.clear();
        page = build(htmlEscape(origin));
        byHost.set(origin, page);
      }
      res.send(page);
    });
  }
}

// ========================================================================
// COPYLEFT COMPLIANCE — /licenses, /licenses/:id, /licenses.json
// ------------------------------------------------------------------------
// ZoFHub serves six AGPL-3.0 proxy engines and one LGPL-3.0 library to every
// visitor who opens /browser or /gust. Naming them on /credits is attribution,
// not compliance. These routes discharge the actual obligations:
//
//   AGPL §4  — the license text must accompany the work. Before this, every
//              /uv/LICENSE, /scram/LICENSE, … returned 404: the site served the
//              code and withheld the license.
//   AGPL §13 — a user interacting over a network must be offered the
//              Corresponding Source of the version they are running. That is
//              what /licenses.json is: a machine-readable written offer,
//              pinned to the versions actually installed.
//   AGPL §5  — a MODIFIED work must carry prominent notices of the change and
//              its date. GUST is modified (its Wisp target was repointed at our
//              own /wisp/, and the ZoFHub cloak system was added), so its entry
//              states that, dates it, and links the running modified file
//              rather than only upstream.
//   LGPL §4  — same notice/text requirement for libcurl.js.
//
// Deliberately NOT behind the legal-page templating: these are verbatim license
// texts and must be served byte-for-byte, with no {{token}} substitution.
// ========================================================================
const { getComponents, getLicenseText, getManifest } = await import('./lib/licenses.mjs');

// Machine-readable written offer. JSON so a compliance checker (or a human with
// curl) can enumerate every served component, its exact version, and where to
// get its source — without scraping HTML.
app.get('/licenses.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(getManifest(requestOrigin(req), contactEmail));
});

// Verbatim license text, e.g. /licenses/ultraviolet.
// text/plain so browsers display it rather than download it, and so no markup
// can alter a legal document.
app.get('/licenses/:id', (req, res) => {
  const text = getLicenseText(String(req.params.id).toLowerCase());
  if (!text) return send404(req, res);
  res.type('text/plain; charset=utf-8')
     .set('Cache-Control', 'public, max-age=86400')
     .send(text);
});

// Human-readable index.
//
// The PAGE SHELL is legal/licenses.html — a real file carrying the exact same
// head, header, footer and script tags as every other legal page, so /licenses
// is identical to /privacy, /terms and /credits BY CONSTRUCTION rather than by
// someone remembering to keep a template string in sync.
//
// That drift already happened once: this page previously lived as an inline
// template here and was missing the Google Fonts <link>s, so it rendered in a
// fallback system font while every other page used Inter/Lilita One. Moving the
// shell into legal/ makes that class of bug impossible — the page is now built
// from the same file pattern, loaded through the same renderLegal() templating,
// as its four siblings.
//
// Only the COMPONENT TABLE is generated, from the same getComponents() the JSON
// manifest uses, so the human page and the machine-readable offer can never
// disagree about versions or modification status.
const LICENSES_PAGE = (() => {
  const rows = getComponents().map(c => {
    // Vendored components (GUST) have no npm version — label them as such
    // rather than printing an empty or bogus "v".
    const ver = c.version
      ? ` <span class="lic-ver">v${htmlEscape(c.version)}</span>`
      : ' <span class="lic-ver">vendored in-repo</span>';
    const modBadge = c.modified ? ' <span class="lic-mod">MODIFIED</span>' : '';
    // Copyleft gets the same amber emphasis credits.html uses, so the two pages
    // read as one system instead of two different designs.
    const copyleft = /AGPL|LGPL|GPL/i.test(c.spdx) ? ' lic-copyleft' : '';
    const licCell = c.licenseAvailable
      ? `<a class="lic-spdx${copyleft}" href="/licenses/${htmlEscape(c.id)}">${htmlEscape(c.spdx)}</a>`
      : `<span class="lic-spdx${copyleft}">${htmlEscape(c.spdx)}</span>`;
    const modDetail = c.modified ? `
              <div class="lic-changes">
                <strong>Changed by ZoFHub on ${htmlEscape(c.modifiedOn)}:</strong>
                <ul>${c.modifications.map(m => `<li>${htmlEscape(m)}</li>`).join('')}</ul>
                <p>Corresponding Source of the running, modified version:
                  <a href="${htmlEscape(c.modifiedSourceAt)}">${htmlEscape(c.modifiedSourceAt)}</a></p>
              </div>` : '';
    return `            <tr>
              <td><a href="${htmlEscape(c.repo)}" target="_blank" rel="noopener">${htmlEscape(c.name)}</a>${ver}${modBadge}
                <div class="lic-role">${htmlEscape(c.role)}</div>${modDetail}</td>
              <td>${licCell}</td>
              <td><a href="${htmlEscape(c.repo)}" target="_blank" rel="noopener">source</a></td>
            </tr>`;
  }).join('\n');

  const table = `<div class="lic-wrap">
        <table class="lic-table">
          <thead><tr><th>Component</th><th>License</th><th>Source</th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>`;

  // renderLegal() applies the same {{CONTACT}} / {{SITE_URL}} substitution every
  // other legal page receives; the generated table is injected on top of it.
  //
  // GLOBAL regex, not a plain string. A string .replace() substitutes only the
  // FIRST match, so any earlier mention of the placeholder — even inside an HTML
  // comment — would swallow the table and leave the real placeholder rendered
  // raw on the page. That happened; this makes it structurally impossible.
  const html = renderLegal('licenses.html').replace(/\{\{COMPONENT_TABLE\}\}/g, table);
  // Fail loudly at BOOT rather than silently serving a broken page to visitors.
  if (html.includes('{{')) {
    console.warn('[licenses] unsubstituted {{token}} left in the rendered page — check legal/licenses.html');
  }
  return html;
})();

app.get('/licenses', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600').type('html').send(LICENSES_PAGE);
});

// ========================================================================
// /category/:catSlug — server-templates a per-category page
// (each is its own URL — DOM only ever holds one page of <=60 tiles)
// ========================================================================
const CATEGORY_TEMPLATE = readFileSync(join(PUBLIC_DIR, 'category.html'), 'utf8');
app.get('/category/:catSlug', (req, res) => {
  // Canonicalize the INCOMING slug too. Stored categories are already run through
  // canonCategory(), so a bookmarked/hand-typed alias spelling (/category/puzzles,
  // /category/car, /category/sandbox) would string-compare against canonical data
  // and 404 despite the category existing.
  const slug = canonCategory(String(req.params.catSlug).toLowerCase());
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

// Client faults and server faults are different events and must not be logged
// or answered the same way.
//
// WHAT THIS FIXES. Every malformed JSON body used to print a seven-line stack
// trace at error level — body-parser → raw-body → async_hooks, with absolute
// filesystem paths. Two consequences, both real:
//   * Real 500s drown. `POST /api/ai/text -d '{oops'` in a loop is a cheap way
//     to bury genuine errors, and on a host with a log quota, to exhaust it.
//   * The CLIENT was told "Something went wrong. Please try again." for its own
//     malformed request — which is untrue and, worse, advises a retry that is
//     guaranteed to fail identically forever.
//
// So: 4xx logs one line and gets an accurate message; 5xx keeps the full stack
// and the deliberately generic response.
const CLIENT_ERROR_MESSAGES = {
  'entity.parse.failed':   'Malformed JSON in request body.',
  'entity.too.large':      'Request body is too large.',
  'encoding.unsupported':  'Unsupported content encoding.',
  'request.aborted':       'Request aborted.',
};
app.use((err, req, res, _next) => {
  const status = Number(err.status || err.statusCode) || 500;

  if (status >= 400 && status < 500) {
    // One line, no stack. Enough to spot a pattern; not enough to bury anything.
    console.warn(`[zofhub] ${status} ${req.method} ${req.path} — ${err.type || err.code || 'client error'}`);
    // Only ever a fixed string from the table above, never err.message, so a
    // parser's internals can't be reflected back to the caller.
    const msg = CLIENT_ERROR_MESSAGES[err.type] || 'Bad request.';
    if (!res.headersSent) res.status(status).json({ error: msg });
    return;
  }

  // Genuine server fault: keep the full object, stack included.
  console.error('[zofhub] error:', err);
  // Headers may already be sent (e.g. a stream that failed mid-flight); writing
  // again would throw ERR_HTTP_HEADERS_SENT inside the error handler itself.
  if (res.headersSent) { try { res.end(); } catch {} return; }
  res.status(status).json({ error: 'Something went wrong. Please try again.' });
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
// On boot, immediately fetch any MISSING Y8 thumbnails from the web — best-effort,
// in the BACKGROUND so it never delays the server. Because it's tied to server
// boot, it runs on EVERY start command (npm start / dev / restart / production).
// The tool only touches games whose thumbnail is missing, so after the first pass
// it's a fast no-op. Skips when Supabase isn't configured or SKIP_THUMB_FETCH=1.
function kickThumbnailFetch() {
  if (process.env.SKIP_THUMB_FETCH === '1') return;
  // Either admin key name is fine (normalizeSupabaseKeys mirrors them, but stay
  // explicit so this guard can't silently disable itself if that order changes).
  if (!process.env.SUPABASE_URL) return;
  if (!process.env.SUPABASE_SECRET_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    // Pass through only CA flags (not --watch etc.) so the child's TLS matches ours.
    const caArgs = process.execArgv.filter(a => /^--use-(system|bundled|openssl)-ca/.test(a));
    const child = spawn(process.execPath, [...caArgs, join(__dirname, 'tools', 'fetch-y8-thumbs.mjs'), '--missing-only'],
      { cwd: __dirname, stdio: 'inherit' });
    child.on('error', (e) => console.warn('[zofhub] thumbnail fetch could not start:', e.message));
  } catch (e) { console.warn('[zofhub] thumbnail fetch skipped:', e.message); }
}

// Some environments disable IPv6; fall back to IPv4 if a dual-stack bind fails.
// Each attempt registers its OWN one-time 'error' handler BEFORE calling listen(),
// so the IPv4 fallback is covered too. (A single top-level .once() would fire on
// the IPv6 failure and be consumed — leaving the fallback attempt's 'error' with
// no listener, which Node routes to uncaughtException. Because our uncaughtException
// handler deliberately does NOT exit, that used to leave a zombie process running
// but listening on nothing. `isFallback` guarantees we retry at most once.)
function startListening(host, isFallback = false) {
  httpServer.once('error', (e) => {
    if (!isFallback && HOST === '::' && (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL')) {
      console.warn('[zofhub] IPv6 bind failed — falling back to 0.0.0.0 (IPv4).');
      startListening('0.0.0.0', true);
    } else {
      console.error(`[zofhub] listen error on ${host}:${PORT} — ${e.code ? e.code + ' ' : ''}${e.message}. Exiting.`);
      process.exit(1);
    }
  });
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
startListening(HOST);
kickThumbnailFetch();   // grab any missing Y8 thumbnails from the web on every boot
