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
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { totalmem } from 'node:os';
import { getHeapStatistics, getHeapSpaceStatistics } from 'node:v8';
import { monitorEventLoopDelay } from 'node:perf_hooks';

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
// An uncaught EXCEPTION is different in kind from a stray rejection: Node's own
// documentation is explicit that the process is in an undefined state
// afterwards. Staying up is still the right call for a public site — but not
// silently. The fault is recorded and /healthz, /readyz and /livez report it,
// so the platform replaces this instance on its own schedule (a controlled
// recycle) instead of it serving indefinitely in an unknown state, and without
// a crash-exit loop if the fault recurs on every boot.
let PROCESS_FAULT = null;
process.on('uncaughtException', (err) => {
  console.error('[zofhub] uncaughtException (continuing, instance marked unhealthy):', err);
  if (!PROCESS_FAULT) PROCESS_FAULT = { at: new Date().toISOString(), kind: 'uncaughtException' };
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
//   1. .env is gitignored and untracked (commit 1dd45a7e). But an .env file that
//      reaches a host by any route — baked into an image, copied by a deploy
//      script, restored from a backup — still acts as a silent fallback for
//      anything the dashboard did not set, and a secret sourced that way is one
//      nobody can rotate from the dashboard. So in production we log exactly
//      which keys came from a file rather than from the host.
//   2. .env.example is a LAST RESORT (e.g. Docker, where .dockerignore excludes
//      .env). It ships placeholders like "change-me-to-a-long-random-string".
//      Letting those through would mean ADMIN_SECRET is literally the string
//      "change-me-…" — a documented password, i.e. no password at all. So
//      placeholder values are stripped rather than used, which makes each
//      feature take its own safe path: admin auth fails CLOSED, Supabase reports
//      unconfigured, and session secrets fall back to a random per-boot value.
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
const HTML_VALUED_KEYS = new Set(['PROXY_BANNER_TAG', 'PROXY_HEADER_TAG', 'PROXY_SIDEBAR_TAG', 'PROXY_INCONTENT_TAG']);
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
const { startCronJobs, isTrademarkTitle, cronStatus } = await import('./lib/cron-jobs.mjs');
const { getCache }                         = await import('./lib/cache.mjs');
const { publicProviderList, MODEL_FALLBACKS }               = await import('./lib/ai-providers.mjs');
const { applyCatalogOverrides }            = await import('./lib/catalog-overrides.mjs');
const { getDonateConfig }                  = await import('./lib/donate.mjs');
const { createInvoice, swapConfig, swapStatusLine, SwapError, DEPOSIT_COINS } = await import('./lib/swap.mjs');
const { healthyModels, candidateModels, markFailure, markSuccess, withRetry,
        healthSnapshot, modelPriority } = await import('./lib/ai-pipeline.mjs');
const { checkUrlSafety, findDuplicates } = await import('./lib/game-discovery.mjs');
// Per-game SEO content (unique description + title/meta/canonical/JSON-LD),
// generated deterministically from verified catalog metadata — see lib/game-seo.mjs.
const { seoPayload } = await import('./lib/game-seo.mjs');
// Aggregate, identity-free quality telemetry: which games fail to render on
// which browsers, and bucketed Core Web Vitals. Counters only — there is no
// visitor in lib/telemetry.mjs and deliberately nowhere to put one.
const { buildFailure: buildFailureReport, buildVital: buildVitalReport,
        parseFailureKey, parseVitalKey,
        summarizeFailures, summarizeVitals } = await import('./lib/telemetry.mjs');
// The one shared AI prompt + retrieval grounding, imported by the browser as a
// static module and by the server from disk. There is deliberately no copy.
const { buildSystemPrompt, groundingBlock, findMentionedGames, looksLikeProvenanceQuestion }
  = await import('./public/js/ai-prompt.js');
// Structural catalog health — the offline half of tools/audit-catalog.mjs.
const { auditGames, ISSUE_LABELS } = await import('./lib/catalog-quality.mjs');
// Ops telemetry for the admin console: a bounded, redacted error buffer and the
// catalog rollups the analytics panel needs.
const { createErrorLog, summarizeCatalog } = await import('./lib/ops-metrics.mjs');
const errorLog = createErrorLog();
// Imported EARLY on purpose: renderDependencyTable() runs while routes are
// being registered, which is before the late import block. A `const` from a
// later `await import` is still in the temporal dead zone at that point, and
// the server crashed at boot with "Cannot access 'getCredits' before
// initialization" until this moved up here.
const { getCredits, creditsSummary } = await import('./lib/credits.mjs');
// Admin authentication: scrypt password verification, database-backed sessions,
// lockout, CSRF and the append-only audit trail. See lib/admin-auth.mjs.
const adminAuth = await import('./lib/admin-auth.mjs');
const usage     = await import('./lib/usage-stats.mjs');
const scoreRules = await import('./lib/scores.mjs');
const { normalizeEmail, isPlausibleEmail } = await import('./lib/subscribe.mjs');
// Feedback routing + redaction. Pure module: no DB, no network, so the rules
// that decide what may ever become training data are unit-testable.
const { prepareFeedbackRecord } = await import('./lib/ai-feedback.mjs');
// The model catalogue is shared with the browser (served at /js/hf-models.js),
// so the allow-list the server validates against and the menu the UI shows can
// never drift apart.
const { hfCatalogue } = await import('./public/js/hf-models.js');
const { loadSimilarityIndex, recommend: recommendGames, indexSize: simIndexSize, neighbours: simNeighbours } =
  await import('./lib/recommender.mjs');
// Loads data/game-similarity.json once, at boot. Missing file is fine — the
// recommender degrades to category affinity and logs how to build it.
loadSimilarityIndex(join(__dirname, 'data'));
// The Vibe Finder's two halves: a pure text->intent parser and the ranker that
// scores the catalog against it. Both are synchronous and dependency-free, so
// /api/vibe answers from local computation instead of waiting on a model.
const { parseVibe, describeIntent } = await import('./lib/vibe-intent.mjs');
const { rankByVibe, targetsFromGame, vibeResponse } = await import('./lib/vibe-engine.mjs');
// Advertising: the six supported networks, the one role each of them owns, the
// surfaces that may carry them, and the proxy boundary that must not. See
// lib/ad-providers.mjs.
const { resolveAdConfig, adOrigins, publicAdConfig, emptyPublicAdConfig, adminAdConfig, isAdSurface,
        INTERSTITIAL_COOLDOWN_MS, PROVIDERS: AD_NETWORKS } =
  await import('./lib/ad-providers.mjs');
// Regions: which country a visitor is in, which region that is, and which
// domain serves it. Parsed once here; every request is two Map lookups. See
// lib/geo.mjs. Resolved before AD_CONFIG, which localises tags per region.
const { geoConfig, countryOf, regionOf, routeDecision, geoStatusLine } = await import('./lib/geo.mjs');
const GEO = geoConfig(process.env);
for (const w of GEO.warnings) console.warn(`[geo] ${w}`);
// GameFlare: a supplied, self-contained catalog kept OUT of the main CATALOG.
// It is a separate source of truth with its own eligibility rule, and the main
// catalog blocks gameflare.com host-wide at the serve layer, so merging the two
// would put each one's rules in the other's way. See lib/gameflare-catalog.mjs.
const { parseCatalog: parseGameflare, filterGames: filterGameflare,
        findBySlug: findGameflareBySlug, categoriesOf: gameflareCategories,
        parseCandidates: parseGameflareCandidates } =
  await import('./lib/gameflare-catalog.mjs');
// Hardening modules. Each owns one decision that used to be made inline here:
// which forwarded hops to believe, how requests are budgeted, how presence
// sessions are held, and which outbound destinations are reachable at all.
const { trustProxySetting, resolveClientIp } = await import('./lib/trust-proxy.mjs');
const { createLimiterSet, envNumber, clientKey: clientKeyOf } = await import('./lib/rate-limit.mjs');
const { createPresenceStore } = await import('./lib/presence-store.mjs');
const { safeFetch, BlockedDestinationError } = await import('./lib/safe-fetch.mjs');
// The inference endpoints this server never fetches, and the rule that keeps
// the server-side AI routes a local-development aid. See each module's header.
const { isAiProviderHost, mentionsAiProvider } = await import('./lib/ai-hosts.mjs');
const { aiServerAllowed: aiRouteAllowed, isAiFallbackPath } = await import('./lib/ai-guard.mjs');
const { sanitizeCatalogEntry } = await import('./lib/catalog-sanitize.mjs');

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

// ── Aggregate quality telemetry ────────────────────────────────────────────
// Two counter maps, same shape and lifecycle as playCounts above: aggregate in
// memory, flush once a minute, degrade to in-memory-only when the tables are
// absent. The KEY is the whole row (see lib/telemetry.mjs) and contains nothing
// but a slug and closed-vocabulary buckets — no ip, no session, no user agent,
// no per-event timestamp. Two visitors hitting the same bug bump the same key,
// which is the privacy property stated as a data structure rather than a promise.
//
// TELEMETRY_ENABLED=0 turns collection off entirely: the endpoints still answer
// 204 so the client never sees an error, and nothing is recorded anywhere.
const TELEMETRY_ENABLED = String(process.env.TELEMETRY_ENABLED ?? '1') !== '0';
const failureCounts  = new Map();  // `slug|browser|platform|kind` -> count
const failuresDirty  = new Map();  // same key -> count NOT yet flushed (a delta)
const vitalCounts    = new Map();  // `metric|bucket|route|platform` -> count
const vitalsDirty    = new Map();  // same key -> unflushed delta
let   telemetryTables = true;      // flips false if the tables don't exist yet
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
// The list and the matching rules live in lib/ai-hosts.mjs: isAiProviderHost()
// for a bare hostname (applied on every redirect hop through fetchAsBrowser),
// mentionsAiProvider() for a caller-supplied URL, which also looks inside the
// path and query for an AI URL smuggled through an intermediary. /asset, /thumb
// and /api/proxy/diag all refuse with 403 before any connection is opened.

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

// The publisher host a game is served from, e.g. "html5.gamemonetize.co".
//
// Provider is a first-class attribute here, not a curiosity: every licensing
// decision in this repo is made per-provider (Famobi and Gamezop removed,
// HTMLGames excluded for frame-busting), and /play routes per-host. It was being
// derived ad hoc at one call site and assumed pre-set at another — see the note
// in setCatalog().
function providerOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
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
// Structured game attributes, from tools/build-game-attributes.py.
//
// mood-tags gives every game a flat SET of words, which answers "something
// chill" by overlap. These are the same catalog expressed as six CONTINUOUS
// axes (calm / pace / brainy / challenge / social / cozy) plus an estimated
// session length — which is what makes "I only have 10 minutes" and
// "challenging but not frustrating" answerable at all. Overlap scoring cannot
// express a duration or a band.
//
// Optional, like every other artifact here: without the file the Vibe Finder
// falls back to keyword matching and behaves exactly as it did before, with no
// error. That matters because this file is built by a Python step that a fresh
// clone will not have run.
let GAME_ATTRS = new Map();
try {
  const gaFile = join(__dirname, 'data', 'game-attributes.json');
  if (existsSync(gaFile)) {
    GAME_ATTRS = new Map(Object.entries(JSON.parse(readFileSync(gaFile, 'utf8'))));
    console.log(`[zofhub] game-attributes loaded: ${GAME_ATTRS.size} games`);
  } else {
    console.log('[zofhub] no data/game-attributes.json — Vibe Finder uses keyword '
      + 'matching only. Build it with: npm run game-attributes');
  }
} catch (e) { console.warn('[zofhub] game-attributes load failed:', e.message); }

// ------------------------------------------------------------------------
// GameFlare — supplied dataset, parsed and validated ONCE at boot.
//
// Parsed here rather than per request because the file is 1.4 MB and never
// changes while the process runs. The parse cannot throw (see the module), so a
// malformed or missing file leaves GAMEFLARE.ok false and every route below
// renders a first-party unavailable state instead of failing.
//
// As supplied this yields ZERO public games — 298 traceability records, none of
// them verified_working. That is the dataset's own verdict
// (integration_readiness.ready_for_public_catalog = false), and the empty
// catalog is the correct output, not a defect.
let GAMEFLARE = { ok: false, error: 'not loaded', dataset: null, games: [], counts: null, rejected: [] };
try {
  const gfFile = join(__dirname, 'data', 'gameflare_verified_games.json');
  if (existsSync(gfFile)) {
    GAMEFLARE = parseGameflare(readFileSync(gfFile, 'utf8'));
    if (!GAMEFLARE.ok) {
      console.warn(`[gameflare] dataset rejected: ${GAMEFLARE.error} — catalog will show as unavailable`);
    } else {
      const c = GAMEFLARE.counts;
      console.log(`[gameflare] ${c.records} record(s), ${c.eligible} playable`
        + `${c.eligible === 0 ? ' — public catalog is empty by design' : ''}`
        + ` (excluded ${c.excludedByStatus}, invalid ${c.rejectedInvalid}, duplicate ${c.duplicates})`);
    }
  } else {
    GAMEFLARE = { ...GAMEFLARE, error: 'data/gameflare_verified_games.json not present' };
    console.log('[gameflare] no data/gameflare_verified_games.json — /gameflare shows an empty catalog.');
  }
} catch (e) {
  GAMEFLARE = { ok: false, error: e.message, dataset: null, games: [], counts: null, rejected: [] };
  console.warn('[gameflare] load failed:', e.message);
}

// The candidate pool the verification pipeline draws from — structurally valid
// records regardless of verification status. These are NEVER served publicly.
// The only way to reach one is the player route's verification preview, which
// requires GAMEFLARE_VERIFY_TOKEN; with that variable unset the preview does not
// exist at all and this pool is inert.
let GAMEFLARE_CANDIDATES = [];
try {
  const gfFile = join(__dirname, 'data', 'gameflare_verified_games.json');
  if (existsSync(gfFile)) {
    // Embed URLs recovered from GameFlare's own published embed code, as an
    // overlay. It only fills records the dataset left null, and it grants no
    // eligibility whatsoever: a recovered URL makes a record TESTABLE, and the
    // public catalog still requires iframe_compatibility.status to be exactly
    // "verified_working", which only a browser run can produce.
    const embedOverlay = new Map();
    const discFile = join(__dirname, 'data', 'gameflare-embed-discovery.json');
    if (existsSync(discFile)) {
      const disc = JSON.parse(readFileSync(discFile, 'utf8'));
      for (const r of disc.results || []) {
        if (r.status === 'embed_url_found' && r.embedUrl) embedOverlay.set(r.slug, r.embedUrl);
      }
    }
    const { candidates, counts } = parseGameflareCandidates(readFileSync(gfFile, 'utf8'), { embedOverlay });
    GAMEFLARE_CANDIDATES = candidates;
    console.log(`[gameflare] candidate pool: ${counts.usable} verifiable of ${counts.considered}`
      + ` (${counts.unusable} have no usable embed URL, ${counts.fromOverlay} recovered)`);
  }
} catch (e) { console.warn('[gameflare] candidate pool failed:', e.message); }

// Verification preview token. Unset (the default, including production) means
// the preview path is disabled outright rather than merely unlikely to be
// guessed — an operator turns it on for a verification run and off afterwards.
const GAMEFLARE_VERIFY_TOKEN = (process.env.GAMEFLARE_VERIFY_TOKEN || '').trim();

/** Constant-time token check. Returns false when the feature is disabled. */
function gameflareVerifyAllowed(req) {
  if (!GAMEFLARE_VERIFY_TOKEN) return false;
  const supplied = String(req.get('x-gameflare-verify') || req.query.verify || '');
  if (supplied.length !== GAMEFLARE_VERIFY_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(GAMEFLARE_VERIFY_TOKEN));
}

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
  // Untrusted-input choke point: every source converges here, so fields that
  // reach innerHTML are normalised once (see lib/catalog-sanitize.mjs). An
  // entry with an unusable slug or a non-web embed URL is dropped, and the
  // count is logged so a bad feed is visible rather than silently shrinking.
  {
    const before = games.length;
    games = games.filter((g) => sanitizeCatalogEntry(g) !== null);
    if (games.length !== before) {
      console.warn(`[catalog] ${before - games.length} entr${before - games.length === 1 ? 'y' : 'ies'} dropped by sanitisation (bad slug or non-web embed URL)`);
    }
  }
  // Provider governance: a SUSPENDED or REVOKED provider's games are withheld
  // from every public surface at once (lib/provider-registry.mjs). A game whose
  // host is not a registered provider origin is a legacy row and is kept.
  {
    const idx = CONTROL.providers;
    const before = games.length;
    games = games.filter((g) => {
      const p = idx.forEmbedUrl(g.embed_url || g.game_url || '');
      return !p || idx.serves(p.id);
    });
    if (games.length !== before) {
      console.log(`[catalog] ${before - games.length} game(s) withheld: their provider is suspended or revoked`);
    }
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
    // Derive the publisher host ONCE, here, for the same reason category and
    // thumbnail are derived here: every source path ends up in this loop.
    //
    // Nothing set this before. summarizeCatalog() in lib/ops-metrics.mjs reads
    // g.provider to build the admin Analytics provider breakdown, so that panel
    // reported a single row — "unknown: 12,329" — on every deployment. Its unit
    // test passed throughout, because the fixtures set `provider` by hand and
    // production never did.
    if (!g.provider) g.provider = providerOf(g.embed_url || g.game_url || g.url);
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
  //
  // KEYSET, NOT OFFSET. The page is bounded by "id < the last id I saw" rather
  // than by .range(from, from + 999). Two reasons, both live here:
  //
  //   • Stability. The set being paged is `is_working = true` — that is what the
  //     games_public view selects — and the hourly link-check flips that column
  //     on up to 200 rows WHILE this runs, while the admin refresh button can
  //     start a second pass concurrently. Under OFFSET, a row leaving the set
  //     between two pages shifts every later row one place forward and a game is
  //     dropped from the catalog with no error anywhere; a row joining it serves
  //     one game twice. Under keyset the cursor is a value, not a position, so
  //     neither can happen.
  //   • Cost. OFFSET makes Postgres walk and discard every row before the window,
  //     so 17 pages read ~144k index entries instead of ~17k — quadratic in the
  //     catalog size, on a job that runs every 30 minutes.
  //
  // A retry is also now genuinely idempotent: the same cursor asks for the same
  // page, where the same OFFSET after a concurrent change asked for a different one.
  // games_working_id_desc_idx — (is_working, id desc) — serves this directly.
  const fetchPage = async (afterId) => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let q = supa
          .from('games_public')
          .select('id, slug, title, game_url, thumbnail_url, category')
          .order('id', { ascending: false })
          .limit(1000);
        if (afterId !== null) q = q.lt('id', afterId);
        const { data, error } = await q;
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
    // Terminates because id is the primary key: every page strictly lowers the
    // cursor, and there are finitely many rows below it.
    let rows = [], cursor = null;
    while (true) {
      const data = await fetchPage(cursor);
      if (!data.length) break;
      rows = rows.concat(data);
      if (data.length < 1000) break;
      cursor = data[data.length - 1].id;
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
    // Keyset on slug, which is game_stats' PRIMARY KEY — so the order is total,
    // the cursor is unique, and the walk uses the PK index.
    //
    // The previous form was `.range(from, from + 999)` with NO .order() at all.
    // A LIMIT/OFFSET with no ORDER BY has no defined row order in Postgres: the
    // planner may return rows in any sequence, and an UPDATE that moves a row
    // within the heap can push it into a page already read or past one still to
    // come. flushPlayStats() upserts this exact table every 60 seconds, so that
    // is not a theoretical concurrency window — a boot slow enough to overlap one
    // flush could silently load the wrong lifetime counts, and the only symptom
    // would be a few games quietly ranking lower than they earned.
    let cursor = null;
    while (true) {
      let q = supa.from('game_stats').select('slug, plays')
        .order('slug', { ascending: true }).limit(1000);
      if (cursor !== null) q = q.gt('slug', cursor);
      const { data, error } = await q;
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
      cursor = data[data.length - 1].slug;
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

// ── Telemetry persistence ──────────────────────────────────────────────────
// Same three-part lifecycle as play counts: load at boot, aggregate in memory,
// flush the DELTA once a minute.
//
// Why a delta rather than an upsert of the total (which is what game_stats
// does): these counters are shared across instances. Two servers that each
// upserted their own running total would clobber each other and the smaller
// number would win. The delta goes through bump_game_failure() /
// bump_web_vital(), which do `count + n` inside the database, so the increment
// is atomic and correct with any number of instances.
async function loadTelemetry() {
  if (!telemetryTables) return;
  const supa = getSupabaseAdmin();
  if (!supa) return;
  try {
    const miss = (e) => /relation|does not exist|could not find|schema cache/i.test(e?.message || '');
    const f = await supa.from('game_failures').select('slug, browser, platform, kind, count').limit(5000);
    if (f.error) {
      if (miss(f.error)) {
        telemetryTables = false;
        console.warn('[telemetry] tables not found — quality telemetry is in-memory only '
          + '(run db/16_game_telemetry.sql to make it persist).');
        return;
      }
      throw f.error;
    }
    for (const r of (f.data || [])) {
      failureCounts.set(`${r.slug}|${r.browser}|${r.platform}|${r.kind}`, Number(r.count) || 0);
    }
    const v = await supa.from('web_vitals').select('metric, bucket, route, platform, count').limit(500);
    if (v.error) { if (miss(v.error)) { telemetryTables = false; return; } throw v.error; }
    for (const r of (v.data || [])) {
      vitalCounts.set(`${r.metric}|${r.bucket}|${r.route}|${r.platform}`, Number(r.count) || 0);
    }
    console.log(`[telemetry] loaded ${failureCounts.size} failure combinations, `
      + `${vitalCounts.size} vitals buckets`);
  } catch (e) {
    console.warn('[telemetry] load failed (in-memory only):', e.message);
  }
}

async function flushTelemetry() {
  if (!telemetryTables) return;
  if (!failuresDirty.size && !vitalsDirty.size) return;
  const supa = getSupabaseAdmin();
  if (!supa) return;

  // Take the pending deltas and clear, so reports arriving DURING the flush
  // accumulate into the next one instead of being lost or double-counted.
  const fPending = [...failuresDirty]; failuresDirty.clear();
  const vPending = [...vitalsDirty];   vitalsDirty.clear();

  const requeue = (map, pending) => {
    for (const [k, n] of pending) map.set(k, (map.get(k) || 0) + n);
  };

  try {
    for (const [key, n] of fPending) {
      const p = parseFailureKey(key);
      if (!p) continue;
      const { error } = await supa.rpc('bump_game_failure', {
        p_slug: p.slug, p_browser: p.browser, p_platform: p.platform, p_kind: p.kind, p_n: n,
      });
      if (error) throw error;
    }
  } catch (e) {
    requeue(failuresDirty, fPending);
    if (/function|does not exist|schema cache/i.test(e?.message || '')) {
      telemetryTables = false;
      console.warn('[telemetry] bump_game_failure() missing — run db/16_game_telemetry.sql. '
        + 'Telemetry stays in memory.');
      return;
    }
    console.warn('[telemetry] failure flush failed (will retry next tick):', e.message);
  }

  try {
    for (const [key, n] of vPending) {
      const p = parseVitalKey(key);
      if (!p) continue;
      const { error } = await supa.rpc('bump_web_vital', {
        p_metric: p.metric, p_bucket: p.bucket, p_route: p.route, p_platform: p.platform, p_n: n,
      });
      if (error) throw error;
    }
  } catch (e) {
    requeue(vitalsDirty, vPending);
    console.warn('[telemetry] vitals flush failed (will retry next tick):', e.message);
  }
}

// ========================================================================
// Express + middleware
// ========================================================================
const app = express();
const httpServer = createServer();

// Which X-Forwarded-For hops to believe. This is a SECURITY setting: every
// per-client control below keys on req.ip, and an over-trusting value lets a
// client choose its own address. It used to be a hard-coded `1`, which is only
// right behind exactly one proxy — with none in front, `X-Forwarded-For:
// 127.0.0.1` made any caller "local". See lib/trust-proxy.mjs for the defaults.
const TRUST_PROXY = trustProxySetting(process.env);
app.set('trust proxy', TRUST_PROXY.value);
if (TRUST_PROXY.warning) console.warn(`[zofhub] ${TRUST_PROXY.warning}`);
// Express compiles the setting into a function; the raw WebSocket upgrade path
// uses the same one, so req.ip and the upgrade's client key can never disagree.
const TRUST_PROXY_FN = app.get('trust proxy fn');
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
//
// EVERY URL HERE IS PUBLISHED, UNAUTHENTICATED, BY /api/proxies. So basic-auth
// credentials pasted into one of these variables — a natural thing to do for a
// private instance — would be handed verbatim to every visitor of the site.
// publicEngineUrl() removes the userinfo before the value is ever stored, and
// says so at boot, because auth the operator believes is configured is now not
// being sent. An unparseable URL is left exactly as typed: it cannot leak a
// credential we could not find, and rewriting a string we failed to understand
// would only make the operator's typo harder to recognise.
function publicEngineUrl(raw, varName) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { return s; }
  if (!u.username && !u.password) return s;
  u.username = '';
  u.password = '';
  console.warn(`[engines] removed credentials from ${varName}: that URL is published `
    + 'publicly by /api/proxies. Sign in at the service itself instead.');
  return u.href;
}

const COMPANION_ENGINES = [
  { id: 'nautilus',     label: 'NautilusOS',   url: publicEngineUrl(process.env.PROXY_NAUTILUS_URL,     'PROXY_NAUTILUS_URL') },
  { id: 'interstellar', label: 'Interstellar', url: publicEngineUrl(process.env.PROXY_INTERSTELLAR_URL, 'PROXY_INTERSTELLAR_URL') },
  { id: 'daydream',     label: 'DayDream',     url: publicEngineUrl(process.env.PROXY_DAYDREAM_URL,     'PROXY_DAYDREAM_URL') },
  { id: 'nebula',       label: 'Nebula',       url: publicEngineUrl(process.env.PROXY_NEBULA_URL,       'PROXY_NEBULA_URL') },
  // InvisiProxy LTS (AGPL-3.0, formerly Holy Unblocker LTS). It belongs in this
  // list and NOT in the tree: it is a complete proxy application built on the
  // same primitives ZoFHub already integrates directly (Ultraviolet, Scramjet,
  // Wisp, bare-mux, epoxy), on Fastify under pnpm, and vendoring it would
  // duplicate working architecture while pulling AGPL source into a proprietary
  // work that is served over a network — engaging §13 for the combination.
  // Deployed separately it stays a peer, and its obligations stay with its
  // deployer. Provenance: data/invisiproxy-upstream.json · docs/proxy/INVISIPROXY.md
  {
    id: 'invisi',
    label: 'InvisiProxy',
    url: publicEngineUrl(process.env.PROXY_INVISI_URL, 'PROXY_INVISI_URL'),
    // `npm run proxies` starts the four bundled companions and cannot start
    // this one, so it carries its own instruction to the offline panel.
    setup: 'pnpm install && pnpm start   (in your own InvisiProxy checkout)',
  },
].filter(e => e.url);

// ── AnuraOS ────────────────────────────────────────────────────────────────
// Handled apart from the list above because, unlike the other four, THIS
// process can serve it: `npm run fetch-anura` puts the pinned AGPL-3.0 release
// in vendor/anura, and lib/anura-host.mjs serves it on an origin of its own
// (a second port by default, or a hostname pointed here via ANURA_HOST).
//
// It needs a real origin rather than a subpath, and that is a measured fact
// about the bundle, not a preference — see the header of lib/anura-host.mjs.
// Its URL is resolved PER REQUEST so a mirror deployment offers its own
// AnuraOS rather than sending visitors back to a blocked domain.
const { anuraHandler, anuraExposure, anuraUrlFor, anuraBundlePresent } =
  await import('./lib/anura-host.mjs');
const ANURA = anuraExposure(process.env, { present: anuraBundlePresent() });

/** AnuraOS obeys the same engine switch and access mode as the other engines. */
async function anuraAllowed(headers, ip) {
  if (CONTROL.proxy && !CONTROL.proxy.engineEnabled('anura')) return false;
  if (PROXY_POLICY.accessMode === 'disabled') return false;
  if (PROXY_POLICY.accessMode === 'staff') return staffProxyAllowed(headers, ip);
  return true;
}

// Host-based origin: a subdomain pointed at this service. Registered FIRST so
// it wins before any ZoFHub route can answer for that hostname — /browser and
// /assets exist in both apps, and on the AnuraOS origin they must be AnuraOS's.
if (ANURA.mode === 'host') {
  // No port in the authority here: the hostname IS the origin, on the main
  // listener, whose upgrade handler already routes /wisp/ into the tunnel.
  const serveAnura = anuraHandler();
  app.use(async (req, res, next) => {
    const h = String(req.headers['x-forwarded-host'] || req.headers.host || '')
      .split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
    if (h === ANURA.host) {
      if (!(await anuraAllowed(req.headers, req.ip))) return res.status(503).type('text').send('AnuraOS is turned off.');
      return serveAnura(req, res);
    }
    return next();
  });
}

// ── Kasm Workspaces ────────────────────────────────────────────────────────
// A third kind of engine: not a rewriter (Scramjet/Ultraviolet) and not an
// emulator (AnuraOS) but a REAL remote desktop, streamed by KasmVNC from a
// container built out of github.com/kasmtech/workspaces-images.
//
// Unlike AnuraOS this process cannot host it — upstream ships Dockerfiles, not
// a bundle, and there is no Docker daemon inside a Render web service. So it is
// operator-hosted and pointed at by PROXY_KASM_URL, and the module's job is to
// detect, BEFORE the frame is created, the two things that make a Kasm origin
// silently unembeddable. See the header of lib/kasm-host.mjs.
const { kasmExposure, kasmProbe, kasmEntry, kasmStatusLine } =
  await import('./lib/kasm-host.mjs');
const KASM = kasmExposure(process.env);
if (KASM.mode === 'disabled') {
  console.warn(`[kasm] ${KASM.reason}. Not offering it in /browser.`);
}

// Origins we must allow in frame-src so the stage iframe can embed a companion.
const companionFrameOrigins = (() => {
  const set = new Set();
  for (const e of COMPANION_ENGINES) {
    try { set.add(new URL(e.url).origin); } catch {}
  }
  // Kasm's origin, for the same reason. frame-src already carries a blanket
  // `https:`, so this matters specifically for an operator running it over
  // plain http on their own network — where CSP would otherwise be a second,
  // invisible blocker stacked on top of the mixed-content rule.
  if (KASM.mode === 'external') set.add(KASM.origin);
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
// browser then refused every one. Verified against real network loader
// domains — all four blocked, while an allowlisted CDN loaded fine. The only symptom is a console message, so the
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
// Resolved ONCE at boot from lib/ad-providers.mjs — the single source of truth
// for which of the six supported networks (Ad-Maven, ExoClick, HilltopAds,
// Clickadu, Mondiad, PopAds) are live, the one role each owns, and where —
// including every region's localised tags, so the CSP covers all of them.
//
// Everything downstream reads AD_CONFIG rather than process.env, so the CSP,
// /api/site-config and the admin panel can never disagree about what is enabled.
// `let`, not `const`: the admin console can switch networks OFF at runtime
// (settings ads.enabled / ads.disabled_networks — see applyAdSettings()). It can
// never switch one ON: a network with no <PREFIX>_ENABLED in the environment has
// nothing to render. AD_ORIGINS below stays the boot-time superset — disabling a
// network narrows what renders; the CSP only needs to be no WIDER than the env.
let AD_CONFIG = resolveAdConfig(process.env, { regions: GEO.regionIds });
const AD_ORIGINS = adOrigins(
  AD_CONFIG,
  (process.env.PROXY_AD_ORIGINS || '').split(','),
);

if (AD_CONFIG.activeIds.length) {
  console.log(`[ads] active network(s): ${AD_CONFIG.activeIds.join(', ')}`);
} else {
  console.log('[ads] no network enabled — the site runs ad-free.');
}
// Role ownership, stated at boot. Every role has one owner and never falls
// through to another network, so "ExoClick is enabled but the header is empty"
// has exactly one explanation — ExoClick supplies no header tag — and it is
// printed here rather than left to be inferred from the admin panel.
{
  const owners = adminAdConfig(AD_CONFIG).roleOwner;
  console.log('[ads] roles → ' + Object.entries(owners).map(([role, id]) => `${role}: ${id || 'none'}`).join(' · ')
    + ` · interstitial capped at 1 per ${Math.round(INTERSTITIAL_COOLDOWN_MS / 60000)} min`);
  if (GEO.regionIds.length) {
    const localised = Object.keys(AD_CONFIG.regional);
    console.log(`[ads] regional tags: ${localised.length ? localised.join(', ') : 'none — every region uses the global tags'}`);
  }
}
if (AD_CONFIG.ignored.length) {
  // Names only, never values. Each of these is set in the environment and read
  // by nothing: a retired network, a pre-provider slot variable, or a field
  // outside the network's one role (e.g. HILLTOPADS_SCRIPT for a push-only
  // network, whose loader is HILLTOPADS_PUSH_SCRIPT).
  console.warn(`[ads] set but NOT used: ${AD_CONFIG.ignored.join(', ')} — see docs/features/ADVERTISING.md.`);
}
if (AD_ORIGINS.length) console.log(`[ads] CSP allows ${AD_ORIGINS.length} ad origin(s): ${AD_ORIGINS.join(' ')}`);

const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: [
    // 'wasm-unsafe-eval' lets GUST's libcurl.js compile its embedded WebAssembly
    // even on browsers that no longer accept plain 'unsafe-eval' for wasm.
    "'self'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'",
    'https://cdn.jsdelivr.net', 'https://esm.sh', 'https://unpkg.com',
    // Puter.js — an OPT-IN, user-chosen AI provider on /ai (public/js/puter-ai.js).
    // Loaded browser-direct and billed to the visitor's own Puter account; it
    // never touches a ZoFHub endpoint, so the server AI guard is unaffected.
    // connect-src already permits https: for its API calls; this lets the SDK load.
    'https://js.puter.com',
    // ── NO GOOGLE AD STACK HERE. THIS IS THE LAST LAYER. ────────────────────
    // googlesyndication / googletagmanager / googleadservices / doubleclick are
    // deliberately ABSENT. Every other layer already refuses to emit Google ad
    // code (lib/ad-providers.mjs strips it from every configured tag, script and
    // origin; public/js/ad-slots.js, proxy-ads.js and preroll.js each refuse it
    // again at injection time; tools/check-ads.mjs fails the build on it). A CSP
    // that still NAMED those origins meant the one layer that could have stopped
    // an accidental or injected tag from executing was the one layer holding the
    // door open — on every page of the site, including /browser and /gust.
    //
    // This does NOT cost the in-game revenue share. Games are not served under
    // this policy: /embed/:slug sets its own deliberately permissive CSP for the
    // game sandbox (`default-src *`, with frame-ancestors 'self'), so a
    // GameMonetize or GameDistribution title still runs its publisher's own ad
    // stack inside its own frame. What changed is that ZoFHub's OWN pages can no
    // longer initialise Google ad code by any route — which is the thing that
    // gets a proxy domain banned at the account level.
    //
    // Do not add them back here. If a game genuinely needs one, it belongs in
    // the /embed route's policy, not in the policy the whole site runs under.
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

// ── Server-side AI fallback routes: refused before anything else runs ──────
// /api/ai/text, /api/ai/image and /api/ai/echo answer 403 in production, and
// outside production to anything but a genuine loopback client (lib/ai-guard.mjs).
// This runs ahead of CORS, the body parser, rate limiting, maintenance mode and
// MASQR, so a refused request costs nothing: no preflight is answered, no body
// is read, and no error path can turn the refusal into a 400, 413 or 429. It
// covers every method and every spelling that normalises to one of the three
// paths. The route handlers keep their own identical check behind this one.
app.use((req, res, next) => {
  if (!isAiFallbackPath(req.path)) return next();
  if (aiServerAllowed(req)) return next();
  return refuseServerAi(res);
});

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

// Request bodies. Was 2mb for every route, while the largest legitimate body
// here — an AI-feedback submission, three fields capped at 4,000 characters —
// is a few tens of kilobytes. Parsing is synchronous and holds the event loop,
// so a 2mb ceiling let any client buy ~2mb of blocking JSON.parse per request.
// JSON_BODY_LIMIT overrides it (any value body-parser accepts, e.g. "256kb").
const JSON_PARSER = express.json({ limit: String(process.env.JSON_BODY_LIMIT || '100kb').trim() || '100kb' });
// The admin FILE-IMPORT routes parse their own, larger body — but only after
// authentication, authorisation and CSRF have passed (lib/admin-api.mjs).
// Skipping them here is what stops an anonymous caller from making this process
// parse a 2 MB body: at this point nobody has been authenticated yet.
app.use((req, res, next) => (req.path.startsWith('/api/admin/cms/import/') ? next() : JSON_PARSER(req, res, next)));

// ========================================================================
// Control plane state (db/control-plane.sql, lib/cms-*.mjs, lib/*-service.mjs)
// ------------------------------------------------------------------------
// Filled in by initControlPlane() after boot. Until then — and permanently on a
// database the control-plane migration has not reached — the services are null
// and the admin API answers 503 with the reason, while the PUBLIC site runs
// exactly as before. Nothing public depends on the control plane being up
// except the three things that must fail closed: provider withdrawal (applied
// when known), proxy destinations (none approved until loaded), and settings
// (defaults until loaded).
// ========================================================================
const { createProviderIndex } = await import('./lib/provider-registry.mjs');
const CONTROL = {
  store: null, schema: 'initialising', reason: 'The control plane is starting.',
  cms: null, settings: null, staff: null, proxy: null,
  providers: createProviderIndex(),
};

// Feature flags gate the SERVER, not just the navigation: a switched-off feature
// answers 404 on its API and its page, so turning it off in the console actually
// stops it rather than hiding a link to something still running.
const FEATURE_ROUTES = [
  ['features.ai',          ['/api/ai/'],           ['/ai', '/ai.html']],
  ['features.community',   ['/api/recommendations'], ['/community', '/community.html']],
  ['features.leaderboard', ['/api/scores'],        ['/leaderboard', '/leaderboard.html']],
  ['features.donate',      ['/api/donate'],        ['/donate', '/donate.html']],
  ['features.subscribe',   ['/api/subscribe'],     []],
  ['features.feedback',    ['/api/feedback'],      []],
];
const routeMatches = (path, p) => (p.endsWith('/') ? path.startsWith(p) : path === p || path.startsWith(p + '/'));
// Maintenance mode never takes down the console, the health probes, the AGPL
// source offer, or the assets the maintenance page itself needs.
const MAINTENANCE_EXEMPT = /^\/(admin(\/|$)|api\/admin\/|healthz$|readyz$|livez$|ping$|api\/health$|api\/site-config$|licenses|robots\.txt$|favicon|assets\/)/;
const plainPage = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${htmlEscapeText(title)}</title></head><body><main><h1>${htmlEscapeText(title)}</h1><p>${htmlEscapeText(body)}</p></main></body></html>`;
function htmlEscapeText(v) { return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

app.use((req, res, next) => {
  const settings = CONTROL.settings;
  if (!settings) return next();
  const m = settings.get('site.maintenance');
  if (m?.enabled && !MAINTENANCE_EXEMPT.test(req.path)) {
    res.setHeader('Retry-After', '600');
    res.setHeader('Cache-Control', 'no-store');
    const message = m.message || 'ZoFHub is down for maintenance. Please check back soon.';
    if (req.path.startsWith('/api/')) return res.status(503).json({ ok: false, error: 'maintenance', message });
    return res.status(503).type('html').send(plainPage('Down for maintenance', message));
  }
  for (const [key, apis, pages] of FEATURE_ROUTES) {
    if (settings.get(key) !== false) continue;
    if (apis.some((p) => routeMatches(req.path, p))) {
      return res.status(404).json({ ok: false, error: 'This feature is turned off.' });
    }
    if (pages.includes(req.path)) {
      return res.status(404).type('html').send(plainPage('Not available', 'This part of the site is turned off right now.'));
    }
  }
  next();
});

// What a visitor's page may know before it renders: the public settings only
// (lib/settings-registry.mjs marks which), the proxy's approved destinations,
// the advertising this page may carry, and whether the ad-block gate applies.
//
// ONE HANDLER. There used to be two routes at this path. This one answered and
// never called next(), so the second — the surface-gated ad payload — was dead
// code: no page ever received a script URL or a slot tag, and configuring an ad
// network changed nothing on the live site while every check still passed.
//
// THE AD PAYLOAD IS SURFACE-GATED. The caller says which page it is on (an
// explicit ?surface=, else the Referer path), and anything that is not a native
// ad surface — the proxy pages above all — gets every ad field present and
// EMPTY, so a client that forgets to check `adsAllowed` still has nothing to
// render. layout.js holds the client half of the same boundary; either alone
// is one edit away from failing open.
//
// The payload varies by page and by the visitor's region, so it is cached
// privately and briefly: an announcement or a switched-off feature still
// reaches pages within a minute, and no shared cache can hand one page's or one
// region's answer to another.
app.get('/api/site-config', (req, res) => {
  const pub = CONTROL.settings ? CONTROL.settings.public() : {};
  const features = {};
  for (const [k, v] of Object.entries(pub)) if (k.startsWith('features.')) features[k.slice(9)] = v;
  const ann = pub['site.announcement'];

  // Deny-by-default all the way down: no surface and no Referer is NO surface.
  // (Resolving an empty Referer against a base URL yields "/", which used to
  // classify every anonymous request as the homepage and hand it the ads.) A
  // Referer from another site says nothing about which of OUR pages is asking.
  let surface = String(req.query.surface || '');
  if (!surface) {
    const ref = req.get('referer');
    if (ref) {
      try {
        const u = new URL(ref);
        if (u.hostname.toLowerCase() === String(req.hostname || '').toLowerCase()) surface = u.pathname;
      } catch { surface = ''; }
    }
  }
  const adsAllowed = isAdSurface(surface);
  const region = regionOf(countryOf(req.headers, GEO), GEO)?.id || null;

  res.setHeader('Cache-Control', 'private, max-age=30');
  res.json({
    ok: true,
    announcement: ann && ann.active ? { text: ann.text, level: ann.level } : null,
    features,
    proxy: CONTROL.proxy ? publicProxyView() : null,
    adsAllowed,
    ...(adsAllowed ? publicAdConfig(AD_CONFIG, { surface, region }) : emptyPublicAdConfig()),
    // Sent on EVERY surface, including /browser: that is where the premium
    // engines are, and the page must know whether they may be locked without
    // being handed anything ad-related. See public/js/support-gate.js.
    supportGate: adblockGateOn(),
  });
});

/**
 * Does the ad-block premium gate apply right now? Only while at least one
 * network is actually serving — locking engines "to support the ads" on a
 * deployment that runs none would be a lock with no reason — and only while
 * the console switch is on.
 */
function adblockGateOn() {
  if (!AD_CONFIG.anyActive) return false;
  return !CONTROL.settings || CONTROL.settings.get('ads.adblock_gate') !== false;
}

/** Is a video pre-roll configured for game pages in any region? */
function prerollConfigured() {
  return Boolean(AD_CONFIG.global?.preroll || Object.values(AD_CONFIG.regional || {}).some((p) => p.preroll));
}

// Engines the page may offer: switched on in the console AND actually installed.
function publicProxyView() {
  const v = CONTROL.proxy.publicView();
  const installed = { ultraviolet: !!proxyStatus.ultraviolet, scramjet: !!proxyStatus.scramjet, gust: !!proxyStatus.gust, anura: !!ANURA.serves };
  return { ...v, engines: v.engines.filter((e) => installed[e]) };
}

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
    // Reading the clipboard is withheld from embedded frames: a game never
    // needs it, and a third-party ad frame that obtained it could read
    // whatever the visitor last copied. Writing (a "copy code" button) stays.
    'clipboard-read=(self)',
    'clipboard-write=*',
    'web-share=*',
    'encrypted-media=*',
    // No game or ad on this site takes a payment through the Payment Request
    // API, and donations are wallet addresses, not a checkout. Denied.
    'payment=()',
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
// ── Always-on proxy + proxy-friendly ads ────────────────────────────────────
// ZoFHub is ALWAYS a proxy site. There is NO hub / Google-AdSense mode: Google
// bans proxy / anonymizer domains at the ACCOUNT level, so the site earns solely
// via the six proxy-friendly networks in lib/ad-providers.mjs, each on its own
// role. The web proxy stack (GUST /
// Ultraviolet / Scramjet / Wisp) is always enabled. PROXY_ENABLED is kept as a
// named constant (always true) so the code that reads it stays readable.
const PROXY_ENABLED = true;

// ── The AGPL engines, behind one call ───────────────────────────────────────
// GUST, Ultraviolet, Scramjet, their service workers and the Wisp tunnel now
// live entirely in proxy-engine/. This file keeps the proprietary half: the
// Supabase models, the catalog, identity, ads, feedback, donations and the
// admin console. The only things crossing the boundary are an Express app in
// and a { proxyStatus, wisp } out — no shared state, no shared imports.
//
// This is a structural boundary, not a legal one. proxy-engine/mount.mjs says
// plainly what that does and does not change about the AGPL position; the short
// version is that a folder is not a licence boundary, the engines here are
// unmodified upstream builds, and docs/CREDITS.md still carries the §13 source offer
// that actually keeps this compliant.
// ── Proxy discovery gate (MASQR) ───────────────────────────────────────────
// Registered BEFORE the engines and before express.static, because the whole
// point is to answer for /browser, /uv/, /gust/ … before anything can serve
// them. OFF unless MASQR_ENABLED is set, in which case this is a pass-through.
//
// What it buys: a mirror domain usually dies because somebody shares the link,
// a filter vendor's crawler fetches it, sees a web proxy, and burns the domain.
// With the gate on, an unauthenticated client sees the games hub — which is
// what this site actually is — and the proxy surfaces answer 404.
//
// It is NOT access control and must never be described as such. See lib/masqr.mjs.
const { masqrConfig, masqrMiddleware, masqrStatusLine, mintKey: mintMasqrKey, grantKeyFor } =
  await import('./lib/masqr.mjs');
const MASQR = masqrConfig(process.env);
for (const w of MASQR.warnings) console.warn(`[masqr] ${w}`);

// ── Regional routing (lib/geo.mjs) ─────────────────────────────────────────
// Keeps each region's visitors on that region's domain(s), so one market's
// block lists stop reaching another market's domain. A pass-through unless
// REGION_ROUTES assigns hosts. Top-level page loads only — never an API call,
// an asset, a frame, a health probe or ads.txt.
//
// Registered BEFORE the MASQR gate on purpose: a keyed visitor about to be
// moved to their region's domain has to take the key with them (the grant is a
// host-only cookie), and the gate here would otherwise 404 the proxy page first.
// The key is computed only when a redirect is actually issued.
app.use((req, res, next) => {
  if (!GEO.routing) return next();
  const d = routeDecision(
    { method: req.method, host: req.hostname, url: req.originalUrl || req.url, headers: req.headers },
    GEO,
    { grant: () => grantKeyFor(MASQR, req.headers.cookie) },
  );
  if (d.action === 'stay') {
    res.append('Set-Cookie', d.cookie + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
    return next();
  }
  if (d.action !== 'redirect') return next();
  res.setHeader('Cache-Control', 'private, no-store');
  return res.redirect(302, d.location);
});
// send404 is a hoisted function declaration further down this file, so passing
// it here is safe: the gate only calls it per request, long after boot.
app.use(masqrMiddleware(MASQR, { deny404: (req, res) => send404(req, res) }));

// ========================================================================
// Proxy governance (lib/proxy-control.mjs, lib/proxy-service.mjs)
// ------------------------------------------------------------------------
// The engines are kept and served; what changes is that the platform decides
// WHERE they may connect. Every tunnel stream is checked against the approved
// destinations an administrator manages in the console, and anything not on
// that list is refused. Until the list has loaded, only PROXY_APPROVED_TARGETS
// (if set) is approved — the tunnel fails closed, never open.
// ========================================================================
const {
  createProxyGovernor, createSessionTracker, resolveGuarded, DestinationRefused,
  DEFAULT_POLICY: PROXY_DEFAULT_POLICY, targetsFromEnv,
} = await import('./lib/proxy-control.mjs');
const PROXY_GOVERNOR = createProxyGovernor();
const PROXY_SESSIONS = createSessionTracker();
PROXY_GOVERNOR.setTargets(targetsFromEnv(process.env.PROXY_APPROVED_TARGETS).rows);
// PROXY_ACCESS_MODE applies from the first request, not after the async load —
// otherwise `disabled` would be `public` for the first seconds of every boot.
let PROXY_POLICY = {
  ...PROXY_DEFAULT_POLICY,
  ...(['public', 'staff', 'disabled'].includes(String(process.env.PROXY_ACCESS_MODE || '').trim().toLowerCase())
    ? { accessMode: String(process.env.PROXY_ACCESS_MODE).trim().toLowerCase() } : {}),
};
PROXY_GOVERNOR.setPolicy(PROXY_POLICY);
// Refusals BEFORE a tunnel exists, by cause. Destination refusals are counted by
// the governor itself, by reason code.
const PROXY_REFUSALS = { maintenance: 0, disabled: 0, origin: 0, staffOnly: 0 };

const PROXY_ENGINE_PATHS = [['/uv/', 'ultraviolet'], ['/scram/', 'scramjet'], ['/gust', 'gust'], ['/proxy', 'gust']];
const PROXY_TRANSPORT_PATHS = ['/baremux/', '/epoxy/'];

// Staff-only access mode: the same session validation the console uses, cached
// for a minute per session token so a proxied page's hundreds of asset requests
// cost one database round trip, not hundreds.
const staffProxyCache = new Map();
async function staffProxyAllowed(headers, ip) {
  const token = adminAuth.parseCookies(headers?.cookie)[adminAuth.SESSION_COOKIE];
  if (!token) return false;
  const key = adminAuth.hashToken(token);
  const hit = staffProxyCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.ok;
  let ok = false;
  const supa = getSupabaseAdmin();
  if (supa) {
    const sess = await adminAuth.validateSession(supa, token, {
      ipHash: adminAuth.hashIp(ip), userAgent: headers?.['user-agent'],
    }).catch(() => null);
    ok = !!sess && rbac.can(principalFromSession(sess), 'proxy.use');
  }
  if (staffProxyCache.size > 2000) staffProxyCache.clear();
  staffProxyCache.set(key, { ok, exp: Date.now() + 60_000 });
  return ok;
}

function proxyEngineFor(path) {
  for (const [prefix, id] of PROXY_ENGINE_PATHS) {
    const base = prefix.replace(/\/$/, '');
    if (path === base || path.startsWith(base + '/')) return id;
  }
  return null;
}

app.use(async (req, res, next) => {
  const p = req.path;
  const engine = proxyEngineFor(p);
  const transport = PROXY_TRANSPORT_PATHS.some((t) => p.startsWith(t));
  const page = p === '/browser' || p === '/browser.html';
  if (!engine && !transport && !page) return next();
  if (engine && CONTROL.proxy && !CONTROL.proxy.engineEnabled(engine)) {
    return res.status(404).type('text').send('This proxy engine is turned off.');
  }
  if (PROXY_POLICY.accessMode === 'disabled') {
    return page
      ? res.status(503).type('html').send(plainPage('Proxy unavailable', 'The proxy browser is turned off by the site administrator.'))
      : res.status(503).type('text').send('The proxy is turned off.');
  }
  if (PROXY_POLICY.accessMode === 'staff' && !(await staffProxyAllowed(req.headers, req.ip))) {
    return page
      ? res.status(403).type('html').send(plainPage('Staff only', 'The proxy browser is currently limited to signed-in staff.'))
      : res.status(403).type('text').send('Staff only.');
  }
  next();
});

const { mountProxyEngines, routeProxyUpgrade } = await import('./proxy-engine/mount.mjs');
const { proxyStatus, wisp } = mountProxyEngines(app, express, { repoRoot: __dirname });

// ── Egress policy ──────────────────────────────────────────────────────────
// /wisp/ is the only endpoint here that opens a TCP connection to an address a
// stranger picked, so its rules ARE the security boundary of the proxy. They
// used to be wisp-js's defaults, which is not the same as being ZoFHub's
// policy: an inherited default is a promise nobody made, and it changes when a
// dependency changes. Applied immediately after the server object exists and
// BEFORE any upgrade can be routed into it. See lib/wisp-policy.mjs.
const { wispPolicy, applyWispPolicy, wispPolicyLine } = await import('./lib/wisp-policy.mjs');
const WISP_POLICY = wispPolicy(process.env);
const WISP_POLICY_APPLIED = wisp ? applyWispPolicy(wisp, WISP_POLICY) : { applied: false, reason: 'no wisp server' };
for (const e of WISP_POLICY.errors) console.warn(`[egress] ${e}`);
for (const w of WISP_POLICY.warnings) console.warn(`[egress] WARNING: ${w}`);
if (wisp && !WISP_POLICY_APPLIED.applied) {
  console.warn(`[egress] policy NOT applied (${WISP_POLICY_APPLIED.reason}). `
    + 'The tunnel is running on wisp-js defaults: no port restriction and no stream cap.');
}

// ── Approved destinations: the allowlist wisp-js consults ────────────────────
// wisp-js checks `hostname_whitelist` entries with entry.test(hostname) before
// it allocates a stream (server/filter.mjs). One entry, backed by the governor,
// turns that into the console's approved-destination list. WISP_BLOCKED_HOSTS
// still applies on top: wisp-js ignores its blacklist once a whitelist is set,
// so the patterns are honoured inside the same test. Raw IP literals are
// refused outright — an approval names a site, never an address.
if (wisp?.options) {
  const blocked = WISP_POLICY.blockedHosts || [];
  wisp.options.hostname_whitelist = [{
    test: (h) => !blocked.some((re) => re.test(String(h).toLowerCase()))
      && PROXY_GOVERNOR.evaluate({ host: h, port: null, staff: true }).decision === 'ALLOW',
  }];
  wisp.options.allow_direct_ip = false;
}

// WISP_MAX_STREAMS / WISP_ALLOWED_PORTS / WISP_MAX_PER_IP remain the operator's
// CEILINGS: the console can set a policy inside them, never outside.
const WISP_ENV_STREAM_CAP = String(process.env.WISP_MAX_STREAMS || '').trim() && WISP_POLICY.streamLimitPerTunnel !== -1
  ? WISP_POLICY.streamLimitPerTunnel : null;

/** Push a validated policy (lib/proxy-control.mjs validatePolicy) into the live tunnel. */
function applyProxyPolicy(policy) {
  const envPorts = WISP_POLICY.allowedPorts;               // null = no env restriction
  const ports = policy.allowedPorts.filter((port) => envPorts === null
    || envPorts.some((e) => (Array.isArray(e) ? port >= e[0] && port <= e[1] : e === port)));
  PROXY_POLICY = { ...policy, allowedPorts: ports };
  PROXY_GOVERNOR.setPolicy(PROXY_POLICY);
  WISP_MAX_TUNNELS = policy.maxTunnels;
  WISP_MAX_PER_IP = WISP_ENV_MAX_PER_IP ? Math.min(WISP_ENV_MAX_PER_IP, policy.maxPerClient) : policy.maxPerClient;
  WISP_IDLE_MS = policy.idleMinutes * 60_000;
  if (wisp?.options) {
    // An EMPTY list blocks every port in wisp-js (nothing matches) — the right
    // failure when the console and the environment share no port at all.
    wisp.options.port_whitelist = ports;
    wisp.options.stream_limit_total = WISP_ENV_STREAM_CAP ? Math.min(WISP_ENV_STREAM_CAP, policy.streamsPerTunnel) : policy.streamsPerTunnel;
  }
  staffProxyCache.clear();
}

// A connect-time refusal of an APPROVED name that resolved to a private
// address is either a misconfiguration or a DNS-rebinding attempt. Recorded as a
// security event, at most once a minute per host so a loop cannot flood it.
const _privateRefusalSeen = new Map();
function noteProxyPrivateRefusal(host) {
  const now = Date.now();
  if ((_privateRefusalSeen.get(host) || 0) > now - 60_000) return;
  if (_privateRefusalSeen.size > 500) _privateRefusalSeen.clear();
  _privateRefusalSeen.set(host, now);
  adminAuth.securityEvent(getSupabaseAdmin(), {
    kind: 'proxy_private_address', severity: 'warn',
    detail: { host: String(host).slice(0, 253), reason: 'an approved destination resolved to a private or reserved address' },
  });
}

/**
 * The per-tunnel socket class. wisp-js constructs one per stream with
 * (hostname, port); this subclass re-checks the destination WITH its port,
 * resolves DNS itself, refuses any private answer, and dials the address it
 * validated — which is what closes the rebinding window between wisp-js's own
 * lookup and the connection. It also feeds the session record its counts.
 */
function guardedSocketClass(sessionId) {
  return class GuardedTCPSocket extends SingboxTCPSocket {
    async connect() {
      const d = PROXY_GOVERNOR.evaluate({ host: this.hostname, port: this.port, staff: true });
      if (d.decision !== 'ALLOW') { PROXY_SESSIONS.denied(sessionId); throw new DestinationRefused(d.reason); }
      let address;
      try { address = await resolveGuarded(this.hostname); }
      catch (e) {
        PROXY_SESSIONS.denied(sessionId);
        if (e?.reason === 'private_address') noteProxyPrivateRefusal(this.hostname);
        throw e;
      }
      this.hostname = address;
      await super.connect();
      this._zhCounted = true;
      PROXY_SESSIONS.streamOpened(sessionId);
    }
    async send(data) { PROXY_SESSIONS.touch(sessionId); return super.send(data); }
    async close() {
      if (this._zhCounted) { this._zhCounted = false; PROXY_SESSIONS.streamClosed(sessionId); }
      return super.close();
    }
  };
}

// What /api/admin/proxy reports. Built from the values READ BACK off the live
// wisp-js options object rather than recomputed from the environment: an
// operator asking "can this proxy reach my database?" needs the effective
// answer, and a policy that failed to apply is exactly the case where the
// intended one would lie. `warnings` lists every deliberate widening.
function egressReport() {
  return {
    ...WISP_POLICY_APPLIED,
    // RegExp objects do not survive JSON; the count is the useful part.
    hostnameBlacklistPatterns: WISP_POLICY_APPLIED.hostname_blacklist ?? 0,
    warnings: WISP_POLICY.warnings,
    errors: WISP_POLICY.errors,
  };
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

// Alternate spellings people and crawlers actually type. Each 301s to the one
// canonical URL rather than serving a second copy of the page: two URLs with the
// same legal text is a duplicate-content problem, and a legal document that
// exists at two addresses is a legal document that can drift.
const LEGAL_ALIASES = {
  '/privacy-policy': '/privacy',
  '/privacy-policy.html': '/privacy',
  '/terms-of-service': '/terms',
  '/tos': '/terms',
  '/copyright': '/dmca',
};
for (const [alias, target] of Object.entries(LEGAL_ALIASES)) {
  app.get(alias, (req, res) => res.redirect(301, target));
}

// ── /hf/ — the Hugging Face inference client, served from OUR origin ───────
// public/js/ai.js used to reach @huggingface/transformers over cdn.jsdelivr.net.
// For this audience that is the wrong dependency to have: ZoFHub exists because
// school networks block things, and a filtered CDN turns the AI fallback into a
// blank screen at exactly the moment the primary provider is also unreachable.
// Serving the module from the same origin the page came from means it is
// reachable whenever the site itself is.
//
// This is the ESM build, which was checked to reference no Node builtins, so it
// runs unmodified in a browser. It is a static file mount: no request from a
// visitor is proxied to Hugging Face by this server, and no token passes
// through here — see lib/hf-models.mjs for why the token stays client-side.
app.use('/hf/', express.static(join(__dirname, 'node_modules', '@huggingface', 'inference', 'dist', 'esm'), {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  index: false,
  setHeaders: (res, p) => {
    if (p.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  },
}));

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
    // .mjs is not mapped by every Express/send build, and a wrong MIME makes the
    // browser refuse a module import. (GUST was the original reason; it now
    // carries its own copy of this in proxy-engine/mount.mjs. Kept here for any
    // ES module served out of public/.)
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

// ── Memory pressure ────────────────────────────────────────────────────────
// /healthz has to answer a question an orchestrator can act on: "is this
// container still fit to serve?" Uptime alone cannot answer it — a process
// three seconds from an OOM kill has excellent uptime right up until it dies,
// and the kill lands mid-request on whoever is playing.
//
// So the probe reports memory headroom and fails the check at HEALTH_MEM_MAX_PCT
// (default 85%). A platform that sees 503 pulls the instance out of rotation and
// starts a replacement BEFORE the kernel's OOM killer takes it out mid-request,
// which is the difference between a rolling restart and dropped connections.
//
// WHICH NUMBER. Two ceilings can kill this process and they are not the same:
//
//   • the V8 heap limit — Node aborts with a heap OOM when used_heap_size
//     approaches heap_size_limit, regardless of how much RAM the box has;
//   • the container/host memory limit — the kernel SIGKILLs on RSS, and V8 is
//     unaware of it, so a container capped below the default heap limit dies
//     with the heap looking perfectly healthy.
//
// Reporting either one alone hides a real failure mode, so the reported figure
// is the WORSE of the two.
const HEALTH_MEM_MAX_PCT = (() => {
  const raw = Number(process.env.HEALTH_MEM_MAX_PCT);
  // Out-of-range values are a config typo, not an instruction to disable the
  // check — fall back to the documented default rather than to 0 (always
  // unhealthy) or 100 (never unhealthy).
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 85;
})();

// The cgroup limit, when there is a real one. Both cgroup versions report
// "unlimited" with a sentinel rather than an absent file: v2 writes the literal
// "max", v1 writes a number near 2^63. Either one, read naively, becomes a
// ceiling so large that RSS is permanently 0% of it and the check never fires.
const CONTAINER_MEM_LIMIT = (() => {
  for (const f of ['/sys/fs/cgroup/memory.max',
                   '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = readFileSync(f, 'utf8').trim();
      if (raw === 'max') continue;
      const n = Number(raw);
      // Anything above physical RAM is that sentinel, not a limit.
      if (Number.isFinite(n) && n > 0 && n <= totalmem()) return n;
    } catch { /* not containerised, or not readable — fall through */ }
  }
  return 0;
})();
const MEM_CEILING = CONTAINER_MEM_LIMIT || totalmem();

function memoryReport() {
  const mem = process.memoryUsage();
  const heap = getHeapStatistics();
  const rssPct = MEM_CEILING ? (mem.rss / MEM_CEILING) * 100 : 0;
  const heapPct = heap.heap_size_limit
    ? (heap.used_heap_size / heap.heap_size_limit) * 100 : 0;
  const mb = (b) => Math.round(b / 1048576);
  return {
    pct: Math.round(Math.max(rssPct, heapPct) * 10) / 10,
    limitPct: HEALTH_MEM_MAX_PCT,
    rssMb: mb(mem.rss),
    heapUsedMb: mb(heap.used_heap_size),
    heapLimitMb: mb(heap.heap_size_limit),
    ceilingMb: mb(MEM_CEILING),
    ceilingFrom: CONTAINER_MEM_LIMIT ? 'cgroup' : 'os',
  };
}

// Two separate questions, and they used to share one answer:
//
//   keepAliveAuthorized — may this request poke Supabase awake? Fails OPEN when
//     CRON_SECRET is unset, deliberately, so a fresh deployment's uptime
//     monitor keeps the free-tier database from pausing before anyone has
//     configured anything. The poke is throttled to twice a day, so an open
//     path cannot be turned into database load.
//
//   healthDetailAuthorized — may this request see memory, heap, event-loop and
//     job figures? Fails CLOSED. It used to reuse the check above, so with
//     CRON_SECRET unset every anonymous caller received the full operator
//     detail — the exact fingerprinting data the verdict-only body exists to
//     withhold.
function presentedCronSecret(req) {
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  // `?key=` is still accepted because uptime monitors that cannot send a header
  // exist, but a header is preferred: a query string lands in access logs.
  return bearer || req.get('x-cron-secret') || (typeof req.query.key === 'string' ? req.query.key : '') || '';
}
function cronSecretMatches(req) {
  if (!CRON_SECRET) return false;
  const a = Buffer.from(String(presentedCronSecret(req)));
  const b = Buffer.from(CRON_SECRET);
  return a.length === b.length && timingSafeEqual(a, b); // constant-time compare
}
function keepAliveAuthorized(req) {
  if (!CRON_SECRET) {
    if (!warnedNoCronSecret) {
      warnedNoCronSecret = true;
      console.warn('[keepalive] CRON_SECRET is not set — /healthz keep-alive pokes are open (detail stays private). Set CRON_SECRET in your env.');
    }
    return true;
  }
  return cronSecretMatches(req);
}
const healthDetailAuthorized = (req) => cronSecretMatches(req);

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

// ── Readiness, liveness, and the thresholds behind them ────────────────────
//
//   /livez   "is the process able to respond at all?" 503 only after an
//            uncaught exception. For a liveness probe: failing it means
//            restart.
//   /readyz  "should this instance receive traffic right now?" 503 on a
//            recorded fault, SUSTAINED memory pressure, or a SUSTAINED stalled
//            event loop. For a readiness probe: failing it means stop routing.
//   /healthz the same verdict as /readyz. It is what render.yaml points at,
//            because Render has one health check that does both jobs.
//
// SUSTAINED, NOT INSTANTANEOUS. A single sample over the line — a GC pause,
// one large JSON parse — used to be enough to fail the check, and a check that
// fails on a transient spike recycles a healthy instance: every visitor on it
// loses their game for nothing. A breach must now persist for
// HEALTH_SUSTAIN_MS (default 10s) before the verdict flips; it flips back the
// moment a sample is under the line.
//
// WHAT THIS DOES NOT DO: stop a restart loop caused by a baseline that is
// itself over the threshold (a container too small for the catalog). No
// in-process logic can fix that; it is a sizing problem, so the boot log warns
// when resident memory at startup is already near the ceiling.
const HEALTH_SUSTAIN_MS = (() => {
  const raw = Number(process.env.HEALTH_SUSTAIN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10_000;
})();
const HEALTH_EVENT_LOOP_P99_MS = envNumber('HEALTH_EVENT_LOOP_P99_MS', 1_000);

// Event-loop delay, sampled by the runtime's own histogram (a timer at 20ms
// resolution — negligible cost) and read every 5s. p99 over a window, not a
// single sample: one slow tick is not a stalled process.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let loopP99Ms = 0;
setInterval(() => {
  loopP99Ms = Math.round(loopDelay.percentile(99) / 1e6);
  loopDelay.reset();
}, 5_000).unref();

const healthBreach = { memory: 0, loop: 0 };
function sustained(key, breached, now = Date.now()) {
  if (!breached) { healthBreach[key] = 0; return false; }
  if (!healthBreach[key]) healthBreach[key] = now;
  return now - healthBreach[key] >= HEALTH_SUSTAIN_MS;
}

/** The verdict every health route shares. No I/O. */
function readinessVerdict() {
  const memory = memoryReport();
  const reasons = [];
  if (PROCESS_FAULT) reasons.push(`uncaught exception at ${PROCESS_FAULT.at}`);
  if (sustained('memory', memory.pct >= HEALTH_MEM_MAX_PCT)) {
    reasons.push(`memory ${memory.pct}% >= ${HEALTH_MEM_MAX_PCT}%`);
  }
  if (sustained('loop', loopP99Ms >= HEALTH_EVENT_LOOP_P99_MS)) {
    reasons.push(`event-loop p99 ${loopP99Ms}ms >= ${HEALTH_EVENT_LOOP_P99_MS}ms`);
  }
  const status = PROCESS_FAULT ? 'unhealthy' : reasons.length ? 'degraded' : 'ok';
  return { ok: reasons.length === 0, status, reasons, memory };
}

// TWO AUDIENCES, ONE ROUTE — and they are deliberately told different things.
//
//   An ORCHESTRATOR (Render health check, Kubernetes probe, uptime monitor)
//   cannot present a bearer token, and a probe that always 401s is a probe that
//   can never trigger the restart it exists to trigger. So the VERDICT — the
//   status code, plus ok/status — is unauthenticated.
//
//   An OPERATOR holding CRON_SECRET additionally gets the numbers behind the
//   verdict and the cron-job history.
//
// The unauthenticated body carries no uptime, no memory figures and no job
// names, so opening the probe up leaks nothing an attacker can fingerprint.
function healthPayload(req, res) {
  if (keepAliveAuthorized(req)) pokeSupabaseThrottled();
  const v = readinessVerdict();
  res.set('Cache-Control', 'no-store');
  res.status(v.ok ? 200 : 503);
  if (!healthDetailAuthorized(req)) return { ok: v.ok, status: v.status };

  const mb = (b) => Math.round(b / 1048576);
  return {
    ok: v.ok,
    status: v.status,
    reason: v.reasons.length ? v.reasons.join('; ') : undefined,
    uptime: Math.round(process.uptime()),
    memory: {
      ...v.memory,
      externalMb: mb(process.memoryUsage().external),
      heapSpaces: getHeapSpaceStatistics().map((sp) => ({
        space: sp.space_name, usedMb: mb(sp.space_used_size), sizeMb: mb(sp.space_size),
      })),
    },
    eventLoop: { p99Ms: loopP99Ms, thresholdMs: HEALTH_EVENT_LOOP_P99_MS },
    sustainMs: HEALTH_SUSTAIN_MS,
    fault: PROCESS_FAULT,
    catalogGames: CATALOG.games.length,
    cron: cronStatus(),
    ts: new Date().toISOString(),
  };
}

app.get(['/healthz', '/ping', '/readyz'], (req, res) => {
  res.json(healthPayload(req, res));
});
app.head(['/healthz', '/ping', '/readyz'], (req, res) => {
  healthPayload(req, res);   // sets the status code; HEAD carries no body
  res.end();
});

// Liveness only: the one condition a restart genuinely fixes.
app.get('/livez', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(PROCESS_FAULT ? 503 : 200).json({ ok: !PROCESS_FAULT, status: PROCESS_FAULT ? 'unhealthy' : 'alive' });
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
  // `setup` is carried through when an engine defines one: the offline panel
  // prefers it over the bundled-launcher hint, which only applies to the four
  // companions `npm run proxies` actually starts.
  const base = { id: e.id, label: e.label, url: e.url, kind: 'companion', setup: e.setup };
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

  // AnuraOS is resolved per request, so it is NOT cacheable with the others:
  // its URL carries the hostname the visitor is actually on, and a mirror must
  // offer its own instance rather than one on a domain that may be blocked.
  const anuraUrl = anuraUrlFor(req, ANURA);
  const anuraEntry = anuraUrl ? {
    id: 'anura', label: 'AnuraOS', url: anuraUrl, kind: 'companion',
    // When WE serve it there is nothing to probe — the answer would be this
    // same process asking itself. An external deployment is still probed.
    up: ANURA.serves ? true : undefined,
    selfHosted: ANURA.serves || undefined,
  } : null;

  const now = Date.now();
  let engines = companionCache.data;
  if (!engines || now - companionCache.at >= 5000) {
    engines = await Promise.all(COMPANION_ENGINES.map(probeCompanion));
    companionCache.at = now;
    companionCache.data = engines;
  }

  const extra = [];
  if (anuraEntry) {
    extra.push(anuraEntry.up === undefined
      ? await probeCompanion({ id: 'anura', label: 'AnuraOS', url: anuraUrl })
      : anuraEntry);
  }

  const kasm = await kasmStatus();
  if (kasm) extra.push(kasmEntry(req, KASM, kasm));

  // Governance. The access mode applies to every engine; companions that are
  // SEPARATE servers (everything here except a self-hosted AnuraOS) bypass this
  // server's approved-destination policy entirely, so they are offered only
  // when an administrator has switched `external` on, knowingly.
  let list = extra.length ? [...engines, ...extra] : engines;
  const mode = PROXY_POLICY.accessMode;
  if (mode === 'disabled' || (mode === 'staff' && !(await staffProxyAllowed(req.headers, req.ip)))) list = [];
  const externalOn = !!CONTROL.proxy && CONTROL.proxy.engineEnabled('external');
  list = list.filter((e) => (e.id === 'anura' && e.selfHosted
    ? (!CONTROL.proxy || CONTROL.proxy.engineEnabled('anura'))
    : externalOn));
  res.json({ engines: list });
});

// Kasm reachability, cached AND de-duplicated.
//
// /api/proxies is unauthenticated, and this probe opens a real TLS connection
// to somebody else's machine. Without both guards a page refresh loop turns
// ZoFHub into a small traffic amplifier pointed at the operator's own server.
// The cache alone is not enough: N requests arriving inside one cold window
// each start their own probe, so concurrent callers share a single in-flight
// promise as well.
const kasmCache = { at: 0, data: null, inflight: null };
const KASM_PROBE_TTL_MS = 10_000;
function kasmStatus() {
  if (KASM.mode !== 'external') return Promise.resolve(null);
  const now = Date.now();
  if (kasmCache.data && now - kasmCache.at < KASM_PROBE_TTL_MS) return Promise.resolve(kasmCache.data);
  if (kasmCache.inflight) return kasmCache.inflight;
  kasmCache.inflight = kasmProbe(KASM.url)
    .then((r) => { kasmCache.data = r; kasmCache.at = Date.now(); return r; })
    // A probe that throws must not poison the cache into permanent "offline";
    // report it down for this window and try again on the next one.
    .catch(() => ({ up: false, reason: 'probe-failed' }))
    .finally(() => { kasmCache.inflight = null; });
  return kasmCache.inflight;
}

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
  // The Hugging Face catalogue is published on BOTH paths, unlike the
  // server-side provider list. It describes models the USER'S BROWSER may call
  // with the USER'S OWN token — there is no server inference behind it and no
  // credential in it, so withholding it in production would hide a menu while
  // protecting nothing. It is how the AI page discovers models instead of
  // hard-coding one (see lib/hf-models.mjs).
  const huggingface = hfCatalogue();
  if (!aiServerAllowed(req) && !adminAuthorized(req)) {
    return res.json({
      mode: 'client-side', serverInference: false,
      text: [], image: [], web_search: [],
      huggingface,
    });
  }
  res.json({ ...publicProviderList(), huggingface });
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
// Per-IP rate limits, with defaults chosen from what each endpoint actually
// costs rather than one number for everything. The AI budget — ~15 req/min
// (burst 5, one token per 4s), configurable via AI_RATE_CAPACITY /
// AI_RATE_REFILL_MS — is the tightest, because an AI call fans out to a
// third-party model and can occupy an upstream slot for seconds. Every budget
// answers with a JSON 429, never an HTML error page a fetch() cannot parse.
const AI_IP_BUCKET = {
  capacity: Number(process.env.AI_RATE_CAPACITY) || 5,
  refillMs: Number(process.env.AI_RATE_REFILL_MS) || 4000,
};

// ── Presence traffic model ─────────────────────────────────────────────────
// Declared here, beside the other budgets, because the limiter set below is
// built from it. Full reasoning in lib/presence-store.mjs; the short version:
//
//   per SESSION  a tab beats every 2s (0.5/s). Budget: 1/s, burst 10.
//   per ADDRESS  a school NAT is hundreds of tabs on ONE address. Budget:
//                200/s, burst 600 — about 400 tabs at the real cadence.
//   SESSIONS per address  a separate cap (500) on how many distinct tabs one
//                address can have COUNTED, so the generous address budget
//                cannot be spent fabricating players.
//
// The address figures are configurable because the right number is a fact
// about the deployment's audience, not about this code.
const PRESENCE_TTL_MS       = 8_000;
const PRESENCE_SESSION_BURST = 10;
const PRESENCE_SESSION_MS_PER_TOKEN = 1_000;        // → 1 beat/s per tab
const PRESENCE_IP_BURST = envNumber('PRESENCE_IP_BURST', 600);
const PRESENCE_IP_MS_PER_TOKEN = envNumber('PRESENCE_IP_MS_PER_TOKEN', 5);   // → 200 beats/s per address
const PRESENCE_MAX_SESSIONS_PER_IP = envNumber('PRESENCE_MAX_SESSIONS_PER_IP', 500);
const PRESENCE_MAX_SESSIONS = 20_000;

// ── Every request budget, each in its OWN bucket ───────────────────────────
// These used to share ONE bucket per IP (see lib/rate-limit.mjs for what that
// broke). Each scope below is independent: spending one never spends another.
// `burst` requests back-to-back, then one per `refillMs` — so (3, 10_000) is
// three at once, then one every ten seconds.
//
// Rare, human-paced writes stay per-address and tight: a false positive costs
// one visitor a retry with a clear 429 message. The two endpoints a whole
// classroom hits at once — opening a game (scoreSession) and presence — are
// sized for a shared NAT instead.
const LIMITS = createLimiterSet({
  ai:              { capacity: AI_IP_BUCKET.capacity, refillMs: AI_IP_BUCKET.refillMs },
  donateInvoice:   { capacity: 3,   refillMs: 20_000 },
  // One global budget for the only public route that makes a third-party
  // account do work (a swap provider creates a real shift per call). Per-IP
  // limits cannot bound a distributed caller; this does.
  donateGlobal:    { capacity: 20,  refillMs: 6_000 },
  scoreSession:    { capacity: 60,  refillMs: 500 },
  scoreSubmit:     { capacity: 6,   refillMs: 5_000 },
  subscribe:       { capacity: 3,   refillMs: 30_000 },
  aiFeedback:      { capacity: 8,   refillMs: 5_000 },
  feedback:        { capacity: 4,   refillMs: 15_000 },
  recommend:       { capacity: 6,   refillMs: 10_000 },
  recSeen:         { capacity: 40,  refillMs: 1_000 },
  forYou:          { capacity: 30,  refillMs: 2_000 },
  proxyDiag:       { capacity: 10,  refillMs: 3_000 },
  // Telemetry is fire-and-forget and bursty by nature: one page load can emit
  // several vitals at once (LCP, CLS, INP, FCP, TTFB). Generous burst, slow
  // refill — enough for honest reporting, not enough to spin a counter.
  telemetry:       { capacity: 20,  refillMs: 3_000 },
  frameCheck:      { capacity: 30,  refillMs: 1_000 },
  presenceIp:      { capacity: PRESENCE_IP_BURST, refillMs: PRESENCE_IP_MS_PER_TOKEN },
  presenceSession: { capacity: PRESENCE_SESSION_BURST, refillMs: PRESENCE_SESSION_MS_PER_TOKEN },
  // Admin budgets. Keyed per ADMIN PRINCIPAL (`admin:<username>`), not per IP:
  // an admin behind a school NAT must not share a budget with its visitors,
  // and a stolen session must not get a fresh budget by changing networks.
  adminRead:       { capacity: 240, refillMs: 250 },
  adminWrite:      { capacity: 60,  refillMs: 1_000 },
  adminExpensive:  { capacity: 4,   refillMs: 15_000 },
  adminReauth:     { capacity: 5,   refillMs: 60_000 },
});

/** The AI budget, kept under its old name for the AI routes. */
function ipAllow(ip) { return LIMITS.allow('ai', ip); }

/**
 * Spend one token from `scope` for this client address. `scope` must be one
 * of the names above — an unknown scope throws, so a typo fails loudly in
 * testing instead of silently sharing, or skipping, a budget.
 */
function writeAllow(scope, ip) { return LIMITS.allow(scope, ip); }

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
//   * NODE_ENV=production  → always refused, no exceptions (render.yaml sets it).
//                            Checked first; nothing else is consulted.
//   * otherwise            → only for a LOOPBACK client, i.e. a dev on the same
//                            machine, and only when no forwarding header names
//                            somebody else (a tunnel connecting from loopback on
//                            an internet visitor's behalf). `trust proxy` decides
//                            req.ip, so a remote client cannot claim 127.0.0.1.
//
// There is no escape hatch. AI_SERVER_FALLBACK=1 used to be read BEFORE
// NODE_ENV, which re-opened these routes on a live deployment; it is no longer
// honoured anywhere (lib/ai-guard.mjs).
//
// Enforcing it here rather than only in the client matters: the client gate is a
// convention that a future edit could quietly drop, and these endpoints are
// reachable by anyone who knows the URL. This makes "no AI on my server" a
// property of the deployment instead of a promise in a comment.
function aiServerAllowed(req) {
  return aiRouteAllowed({
    nodeEnv: process.env.NODE_ENV,
    ip: req.ip || req.socket?.remoteAddress || '',
    headers: req.headers || {},
  });
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
  usage.noteAiRequest('text');
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
  // RETRIEVAL BEFORE GENERATION.
  // Asked who made a game, an ungrounded model invents authors, dates and a
  // ZoFHub-flavoured backstory — it was told it IS ZoFHub, so it credited ZoFHub
  // with third-party games. When the question names a game we hold, the real
  // catalog fields go in the prompt and the model is told those are the only
  // facts it has, including that authorship is genuinely not among them.
  //
  // The grounding text is part of the cache key (aiCacheKey hashes `system`), so
  // a grounded answer and an ungrounded one never share a cache entry.
  let grounding = '';
  try {
    if (looksLikeProvenanceQuestion(latest)) {
      grounding = groundingBlock(findMentionedGames(latest, CATALOG.games));
    }
  } catch (e) {
    // Grounding is an improvement, not a dependency. The accuracy rules in the
    // base prompt still apply without it.
    console.warn('[ai] grounding unavailable:', e.message);
  }
  let system = buildSystemPrompt(grounding);

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
  usage.noteAiRequest('image');
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
  usage.noteAiRequest('audio');
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
  usage.noteAiRequest('video');
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
  usage.noteAiRequest('text');
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
// Community: recommendations (Supabase: recommendations)
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
// ── Donations ──────────────────────────────────────────────────────────────────
// Read-only, and everything it returns is public by definition — a donation
// address is meant to be handed out. There is deliberately NO write route and no
// payment processing: this server never touches a card, never holds a balance,
// and never learns who donated. It hands over an address and gets out of the way,
// which is also why there is nothing here worth attacking.
//
// Methods whose address fails its checksum are dropped in lib/donate.mjs and
// never reach this response, so a typo shows up as a missing button rather than
// as donations going to nobody.
// POST /api/donate/invoice — one-time deposit address for a public coin,
// auto-converted to Monero by a non-custodial swap provider.
//
// NOTHING IS PERSISTED. There is no invoice table, no session, no cookie and no
// row anywhere joining this request to a visitor, an IP, or a gameplay history.
// The response is built, sent, and forgotten. That is a stronger guarantee than
// a retention policy, because there is no store to leak, subpoena or misconfigure.
//
// The rate limiter DOES see the IP — it has to, to work — but it is the same
// in-memory bucket every other write route uses: a counter keyed by address that
// decays, never written to disk and never associated with what was requested.
//
// If a donor needs support later, the provider's own reference (returned to
// them, not stored by us) is the handle. We deliberately cannot look it up.
app.post('/api/donate/invoice', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // A swap creates a real third-party API call, so this is tighter than
  // feedback: burst 3, then one every 20s.
  if (!writeAllow('donateInvoice', req.ip)) {
    return res.status(429).json({ ok: false, error: 'Too many requests — wait a moment.' });
  }
  // Process-wide ceiling as well: per-IP limits cannot bound a caller spread
  // across many addresses, and each call here makes the provider create a real
  // shift against the operator's affiliate account. Only checked when the
  // feature is actually configured, so an unconfigured deployment's 503 does
  // not spend it.
  if (swapConfig().enabled && !LIMITS.allow('donateGlobal', 'global', { rawKey: true })) {
    res.setHeader('Retry-After', String(LIMITS.retryAfterSec('donateGlobal', 'global', { rawKey: true })));
    return res.status(429).json({ ok: false, error: 'Donations are busy right now — try again in a minute.' });
  }
  try {
    const invoice = await createInvoice({ from: req.body?.coin });
    return res.json({ ok: true, invoice });
  } catch (e) {
    const status = e instanceof SwapError ? e.status : 502;
    // e.message from SwapError is already sanitised in lib/swap.mjs; anything
    // else is replaced rather than echoed.
    const msg = e instanceof SwapError ? e.message : 'could not create a deposit address';
    // The provider's own wording is kept for the operator, in the log only.
    if (e?.detail) console.warn(`[swap] ${e.detail}`);
    return res.status(status).json({ ok: false, error: msg });
  }
});

app.get('/api/donate', (req, res) => {
  const cfg = getDonateConfig();
  // Short cache: the config hot-reloads, and an operator fixing a wrong address
  // should not have to wait out a long TTL for the bad one to disappear.
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
  const swap = swapConfig();
  res.json({
    enabled: cfg.enabled || swap.enabled,
    heading: cfg.heading,
    blurb: cfg.blurb,
    methods: cfg.methods,
    // Which public coins can be swapped to XMR. Names only — the collection
    // address and the provider key never appear in a client response.
    swap: swap.enabled
      ? { enabled: true, coins: swap.coins.map(c => ({ id: c, label: DEPOSIT_COINS[c].label })) }
      : { enabled: false, coins: [] },
  });
});

// ── Feedback ────────────────────────────────────────────────────────────────
// Private by design. There is no GET: feedback is not a public wall, and the
// RLS policy grants anon INSERT only — the publishable key cannot read back even
// the row it just wrote. Review happens in the admin console via the secret key.
// ========================================================================
// LEADERBOARD — player-reported scores, per game and overall.
// ------------------------------------------------------------------------
// WHY THIS LOOKS THE WAY IT DOES. Every game on ZoFHub is a third-party
// cross-origin iframe. There is no way to read a real score out of one, so a
// leaderboard here is necessarily self-reported — which is precisely why
// db/community-scores-integrity.sql specifies "single-use proof-of-play
// sessions + per-game score ceilings" and a `flagged` quarantine. The rules
// live in lib/scores.mjs; this is the transport around them.
//
// FAILS SOFT, NOT LOUD. The `scores` table was dropped from this project once
// already (db/feedback.sql), so the code must treat "table not there" as a
// normal state: reads return an empty board with available:false, and writes
// say so plainly instead of throwing a 500 at a player who just finished a run.
// ========================================================================
const scoresState = { available: null, checkedAt: 0 };
const SCORES_PROBE_MS = 60_000;

async function scoresAvailable() {
  const supa = getSupabaseAdmin();
  if (!supa) return false;
  const now = Date.now();
  if (scoresState.available !== null && now - scoresState.checkedAt < SCORES_PROBE_MS) {
    return scoresState.available;
  }
  try {
    // A real SELECT, not a HEAD+count: a head request against a table that does
    // not exist came back without an error, so the probe reported the
    // leaderboard as available and every write then failed with a 502 instead
    // of the honest "not installed" answer.
    const { error } = await supa.from('scores').select('id').limit(1);
    scoresState.available = !error;
    if (error) console.warn('[scores] table unavailable:', error.message);
  } catch { scoresState.available = false; }
  scoresState.checkedAt = now;
  return scoresState.available;
}

/** Visible scores for one game (or all games). The admin key bypasses RLS, so
 *  status is filtered HERE and never left to the policy alone. */
async function visibleScores(supa, slug, limit = 100) {
  let q = supa.from('scores')
    .select('slug, player_name, score, created_at')
    .eq('status', scoreRules.STATUS.OK)
    .order('score', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(Math.min(500, Math.max(1, limit)));
  if (slug) q = q.eq('slug', slug);
  const { data, error } = await q;
  return error ? [] : (data || []);
}

// Hand out a single-use proof-of-play token. Called when a game is opened, so a
// score submission can prove the game was at least started from this server.
app.post('/api/scores/session', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!writeAllow('scoreSession', req.ip)) {
    return res.status(429).json({ ok: false, error: 'Too many requests — slow down.' });
  }
  const slug = typeof req.body?.slug === 'string' ? req.body.slug.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug)) {
    return res.status(400).json({ ok: false, error: 'bad slug' });
  }
  if (!bySlug.has(slug)) return res.status(404).json({ ok: false, error: 'unknown game' });
  // The owner key (a keyed hash of the client address) gives each address its
  // own slice of the token store, so one address cannot evict everyone else's.
  const owner = adminAuth.hashIp(clientKeyOf(req.ip)) || `raw:${clientKeyOf(req.ip)}`;
  res.json({ ok: true, token: scoreRules.issueSession(slug, Date.now(), owner) });
});

// Public board. ?slug= for one game, omitted for the all-games board.
app.get('/api/scores', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const slugRaw = typeof req.query.slug === 'string' ? req.query.slug.trim().toLowerCase() : '';
  const slug = /^[a-z0-9][a-z0-9-]{0,119}$/.test(slugRaw) ? slugRaw : '';
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

  if (!(await scoresAvailable())) {
    return res.json({
      ok: true, available: false, slug: slug || null, scores: [],
      note: 'The leaderboard table is not installed. Run db/community.sql in the Supabase SQL editor.',
    });
  }
  const supa = getSupabaseAdmin();
  const rows = await visibleScores(supa, slug, limit);
  const ranked = scoreRules.rank(rows).slice(0, limit).map(scoreRules.publicRow);
  const out = { ok: true, available: true, slug: slug || null, scores: ranked };
  if (slug) {
    const g = bySlug.get(slug);
    if (g) out.game = { slug: g.slug, title: g.title };
  }
  res.json(out);
});

// Submit a score.
app.post('/api/scores', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // A finished run is a rare event. Burst 3, then one per 10s.
  if (!writeAllow('scoreSubmit', req.ip)) {
    return res.status(429).json({ ok: false, error: 'Too many submissions — please wait a moment.' });
  }
  if (!(await scoresAvailable())) {
    return res.status(503).json({ ok: false, error: 'The leaderboard is not available right now.' });
  }

  const v = scoreRules.validateSubmission(req.body, (s) => bySlug.has(s));
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
  const { slug, score, playerName } = v.value;

  // Proof of play. Single use, bound to this game, and it carries how long ago
  // the game was opened — which is what makes "submitted too fast" detectable.
  const play = scoreRules.consumeSession(req.body?.token, slug);
  if (!play.ok) return res.status(403).json({ ok: false, error: play.error });

  const supa = getSupabaseAdmin();
  const board = (await visibleScores(supa, slug, 200)).map((r) => Number(r.score) || 0);
  // Status is decided HERE. A client may send anything it likes; it is never read.
  const { status, reason } = scoreRules.classifyScore(score, board, { playedMs: play.playedMs });

  try {
    // Keep-best, exactly as db/community.sql describes: one row per player per
    // game, updated only when they actually beat themselves.
    const { data: prior } = await supa.from('scores')
      .select('id, score').eq('slug', slug).eq('player_name', playerName)
      .order('score', { ascending: false }).limit(1);
    const existing = prior && prior[0];

    if (existing && Number(existing.score) >= score) {
      return res.json({
        ok: true, recorded: false, best: Number(existing.score),
        message: 'Your previous score for this game is higher.',
      });
    }
    if (existing) {
      const { error } = await supa.from('scores')
        .update({ score, status, flag_reason: reason, created_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supa.from('scores')
        .insert({ slug, player_name: playerName, score, status, flag_reason: reason });
      if (error) throw new Error(error.message);
    }
  } catch (e) {
    console.warn('[scores] write failed:', e.message);
    return res.status(502).json({ ok: false, error: 'Could not save that score. Try again shortly.' });
  }

  // A quarantined score is reported honestly as held for review — never as a
  // silent success, and never as a place on a board it is not actually on.
  res.json({
    ok: true, recorded: true, status,
    pending: status !== scoreRules.STATUS.OK,
    message: status === scoreRules.STATUS.OK
      ? 'Score saved.'
      : 'Score saved but held for review — it is unusually high for this game.',
  });
});


// ========================================================================
// POST /api/subscribe — the mirror-update list.
// ------------------------------------------------------------------------
// Censorship insurance: if this domain is blocked, an address collected today
// is the only channel left to say where the mirror is.
//
// THE RESPONSE IS DELIBERATELY UNIFORM. It never reveals whether an address was
// already on the list. db/14_subscriber_emails.sql makes the table write-only to
// the public key precisely so nobody can enumerate it; an endpoint that answered
// "already subscribed" would hand that capability straight back, one address per
// request. Duplicate, fresh insert and provider-unavailable all answer the same.
//
// WHAT IS STORED: the address, and nothing else. No IP, no timestamp, no user
// agent — see the schema comment. The rate limiter does see an IP, because it
// has to, but it holds it in memory and writes it nowhere.
// ========================================================================
app.post('/api/subscribe', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  // Subscribing is a once-ever act. Burst 3, then roughly one per 30s: invisible
  // to a person, useless to a script trying to probe membership or flood rows.
  if (!writeAllow('subscribe', req.ip)) {
    return res.status(429).json({ ok: false, error: 'Too many attempts — please wait a moment.' });
  }

  const body = req.body || {};

  // Honeypot, same contract as /api/feedback: answer 200 so the bot records
  // success and does not retry with a different strategy.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return res.json({ ok: true });
  }

  const email = normalizeEmail(body.email);
  if (!isPlausibleEmail(email)) {
    return res.status(400).json({ ok: false, error: 'That does not look like an email address.' });
  }

  const supa = getSupabaseAdmin();
  if (!supa) {
    return res.status(503).json({ ok: false, error: 'The mirror list is not available right now.' });
  }

  let stored = false;
  try {
    const { error } = await supa.from('subscriber_emails').insert({ email });
    if (error) {
      // 23505 = unique violation: already on the list. That is a SUCCESS for the
      // subscriber and must be indistinguishable from a fresh insert.
      const dup = error.code === '23505' || /duplicate key|already exists/i.test(error.message || '');
      if (!dup) {
        if (/does not exist|could not find the table|42P01|PGRST205/i.test(error.message || '')) {
          console.warn('[subscribe] table missing — run db/14_subscriber_emails.sql');
          return res.status(503).json({ ok: false, error: 'The mirror list is not available right now.' });
        }
        throw new Error(error.message);
      }
    } else {
      stored = true;
    }
  } catch (e) {
    console.warn('[subscribe] insert failed:', e.message);
    return res.status(502).json({ ok: false, error: 'Could not save that right now. Try again shortly.' });
  }

  // Hand the address to the mail provider so there is a way to actually SEND the
  // mirror notice. Best-effort and never fatal: the row is the durable record,
  // and a provider outage must not lose a subscriber or leak a failure to them.
  // The key lives only here, on the server, and is never echoed to a client.
  if (stored) forwardToMailProvider(email).catch(() => {});

  res.json({ ok: true });
});

/**
 * Add an address to the mail provider's audience.
 *
 * Resend is the configured provider (RESEND_API_KEY + RESEND_AUDIENCE_ID). With
 * neither set this is a no-op, which is the normal state until the owner opens
 * an account — the subscription still succeeds and the row is still stored, so
 * nothing is lost by turning this on later.
 */
async function forwardToMailProvider(email) {
  const key = (process.env.RESEND_API_KEY || '').trim();
  const audience = (process.env.RESEND_AUDIENCE_ID || '').trim();
  if (!key || !audience) return;
  try {
    const r = await fetch(`https://api.resend.com/audiences/${encodeURIComponent(audience)}/contacts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, unsubscribed: false }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok && r.status !== 409) {          // 409 = already in the audience
      console.warn('[subscribe] mail provider returned', r.status);
    }
  } catch (e) {
    console.warn('[subscribe] mail provider unreachable:', e.message);
  }
}


// ========================================================================
// POST /api/ai/feedback — feedback on ONE AI answer.
// ------------------------------------------------------------------------
// The AI itself never touches this server: public/js/ai.js talks to providers
// from the visitor's own browser. This endpoint exists so a person can tell us
// an answer was wrong — and it is deliberately the ONLY path by which anything
// a visitor typed at the AI reaches our database.
//
// WHAT PROTECTS THE PERSON:
//   * lib/ai-feedback.mjs redacts emails, phones, card-shaped digits, API
//     tokens, addresses and IPs BEFORE the insert. No raw copy is stored.
//   * consent is per submission and defaults to false. Without it a row can be
//     counted and evaluated but can never enter a training set.
//   * `training_eligible` is computed HERE and pinned to false by the RLS
//     policy on the anon key, so a forged direct insert cannot self-promote.
//   * no conversation id, no user id, no IP is stored. The rate limiter sees an
//     IP because it must; it writes it nowhere.
//
// WHAT PROTECTS THE SYSTEM: routeSignal() decides which mechanism a signal is
// allowed to influence. A complaint about an answer that never arrived is
// routing evidence and is refused entry to every training lane — otherwise the
// most common failure on this site (an empty stream) would become the most
// common "bad output" in the corpus.
// ========================================================================
app.post('/api/ai/feedback', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Rating an answer is more frequent than sending site feedback, but still a
  // human act. Burst 8, then roughly one every 5s.
  if (!writeAllow('aiFeedback', req.ip)) {
    return res.status(429).json({ ok: false, error: 'Too many submissions — please wait a moment.' });
  }

  const b = req.body || {};
  if (typeof b.website === 'string' && b.website.trim() !== '') return res.json({ ok: true });

  const prepared = prepareFeedbackRecord({
    type: b.type,
    input: b.input,
    output: b.output,
    correction: b.correction,
    rating: b.rating,
    provider: b.provider,
    model: b.model,
    promptVersion: b.promptVersion,
    consentTraining: b.consentTraining === true,
  });

  if (!prepared.ok) {
    // A discarded signal is not an error the user should see as a failure —
    // they did nothing wrong, the signal simply carries no information.
    if (prepared.discarded) return res.json({ ok: true, stored: false, reason: prepared.error });
    return res.status(400).json({ ok: false, error: prepared.error });
  }

  const supa = getSupabaseAdmin();
  if (!supa) return res.status(503).json({ ok: false, error: 'Feedback is not available right now.' });

  try {
    const { error } = await supa.from('ai_feedback').insert(prepared.record);
    if (error) {
      if (/does not exist|could not find the table|42P01|PGRST205/i.test(error.message || '')) {
        console.warn('[ai-feedback] table missing — run db/15_ai_feedback.sql');
        return res.status(503).json({ ok: false, error: 'Feedback is not available right now.' });
      }
      throw new Error(error.message);
    }
  } catch (e) {
    console.warn('[ai-feedback] insert failed:', e.message);
    return res.status(502).json({ ok: false, error: 'Could not save that right now.' });
  }

  // Tell the client what we did with it. Being explicit that a rating is NOT
  // training data is the honest answer to "where does this go?".
  res.json({
    ok: true,
    stored: true,
    lanes: prepared.record.lanes,
    trainingEligible: prepared.record.training_eligible,
  });
});

app.post('/api/feedback', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Sending feedback is a once-in-a-while act. Burst 4, then roughly one every
  // 15s: invisible to a real person, useless to a script.
  if (!writeAllow('feedback', req.ip)) {
    return res.status(429).json({ ok: false, error: 'Too many submissions — please wait a moment.' });
  }

  const b = req.body || {};

  // Honeypot. A field hidden from people but present in the DOM; bots fill every
  // input they find. Answers 200 so the bot records success and does not retry
  // with a different strategy — telling it that it failed only teaches it.
  if (typeof b.website === 'string' && b.website.trim() !== '') {
    return res.json({ ok: true, id: null });
  }

  const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (message.length < 4)    return res.status(400).json({ ok: false, error: 'Please write a little more.' });
  if (message.length > 2000) return res.status(400).json({ ok: false, error: 'Feedback is limited to 2000 characters.' });

  const kind = ['bug', 'idea', 'other'].includes(b.kind) ? b.kind : 'other';

  // Empty string and absent must not become two different stored states.
  let email = typeof b.email === 'string' ? b.email.trim().slice(0, 200) : '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'That email address does not look right. Leave it blank if you prefer.' });
  }
  const page = typeof b.page === 'string' ? b.page.trim().slice(0, 300) : '';

  const supa = getSupabaseAdmin();
  if (!supa) return res.status(503).json({ ok: false, error: 'Feedback is unavailable right now.' });

  try {
    const { data, error } = await supa.from('feedback').insert({
      message, kind,
      email: email || null,
      page:  page  || null,
      // Hashed, never raw — enough to spot one source filing forty, useless for
      // identifying anybody. Same helper the admin security tables use.
      ip_hash: adminAuth.hashIp(req.ip),
      user_agent: (req.get('user-agent') || '').slice(0, 300) || null,
    }).select('id').single();
    if (error) throw error;
    return res.json({ ok: true, id: data.id });
  } catch (e) {
    if (needsSetup(e)) return res.status(503).json({ ok: false, error: 'Feedback storage is not set up yet.' });
    console.warn('[feedback] insert failed:', e.message);
    return res.status(500).json({ ok: false, error: 'Could not save that — please try again.' });
  }
});

app.post('/api/recommendations', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Posting a game is rare per user — a tight limit blocks spam without ever
  // bothering a real contributor (burst 6, then ~1 every 10s).
  if (!writeAllow('recommend', req.ip)) {
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
  if (!writeAllow('recSeen', req.ip)) return res.json({ ok: false });
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
  return principalFromSession(sess);
}

/**
 * The principal a validated session represents. A staff session carries its
 * account's role (public.admin_users); the owner's carries none and resolves to
 * `owner` in lib/admin-rbac.mjs. Used by resolveAdmin() and by the proxy's
 * staff-only access mode, so both reach the same answer for the same cookie.
 */
function principalFromSession(sess) {
  if (sess.user) {
    return {
      username: sess.username, via: 'session', session: sess,
      userId: sess.user.id, role: sess.user.role, mustChangePassword: sess.user.mustChangePassword,
    };
  }
  return { username: sess.username, via: 'session', session: sess };
}

/**
 * Gate for admin API routes. Sync, so the many existing call sites keep their
 * shape; it accepts a caller the async middleware below already resolved.
 */
const rbac = await import('./lib/admin-rbac.mjs');
// Read-only adapter for an OPTIONAL, externally-run sing-box instance. Unset by
// default (SINGBOX_API_URL absent) → reports { reachable:false } rather than
// zeroes, so the panel shows "not connected", never a fake idle dashboard.
const { singboxTelemetry } = await import('./lib/singbox.mjs');
// Process supervision for a MANAGED sing-box (SINGBOX_MANAGED=1). Opt-in and
// fails soft: with it unset every call below no-ops and the site is unchanged.
const { startSingbox, stopSingbox, singboxProcessStatus, singboxManaged } =
  await import('./lib/singbox-supervisor.mjs');
// The proxy's EGRESS path. This is the piece that puts sing-box in the site's
// real traffic flow: every TCP stream the Wisp tunnel opens is dialled through
// sing-box's loopback SOCKS inbound, falling back to a direct connection (and
// saying so) when the daemon is not answering.
const { createSingboxTCPSocket, egressStats, singboxEgressEnabled } =
  await import('./lib/singbox-socket.mjs');
// One class for the whole process — it reads the environment per connect(), so
// building it once costs nothing and changes nothing about liveness.
const SingboxTCPSocket = createSingboxTCPSocket();

/**
 * Authorise an already-authenticated admin for one permission.
 *
 * Same shape as requireAdmin/requireAdminCsrf — returns true to continue, or
 * writes the response and returns false — so a route reads as three lines of
 * guard and then its own logic.
 *
 * Authentication runs first so an anonymous caller still gets 401, not 403:
 * they are answers to different questions, and returning 403 to a stranger
 * confirms that a valid credential exists.
 */
function requirePerm(req, res, permission) {
  if (!requireAdmin(req, res)) return false;
  // A staff account on a temporary password may do nothing but replace it.
  if (req.admin.mustChangePassword) {
    res.status(403).json({ ok: false, error: 'Set a new password first.', passwordChangeRequired: true });
    return false;
  }
  if (rbac.can(req.admin, permission)) return true;
  const who = rbac.principalSummary(req.admin);
  // Recorded, always. A permission system whose refusals are invisible cannot
  // distinguish "correctly configured" from "being probed".
  auditAction(req, 'rbac.denied', permission, 'denied', { role: who.role, via: who.via });
  res.setHeader('Cache-Control', 'no-store');
  res.status(403).json({ ok: false, error: 'forbidden', needed: permission, role: who.role });
  return false;
}

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
/**
 * Did this caller actually PRESENT a credential? A request with none is an
 * ordinary anonymous 401 and must never count toward the throttle — otherwise
 * any passer-by hitting /admin could lock the real operator out.
 */
function adminCredentialPresented(req) {
  if (req.get('authorization') || req.get('x-admin-secret')) return true;
  const cookies = adminAuth.parseCookies(req.headers?.cookie);
  return !!cookies[adminAuth.SESSION_COOKIE];
}

/** Throttle key: the HMAC of the IP, or the raw IP if no secret is configured. */
const adminThrottleKey = (req) => adminAuth.hashIp(req.ip) || `raw:${req.ip || 'unknown'}`;

async function adminGate(req, res, next) {
  const key = adminThrottleKey(req);

  // Logging out stays idempotent even while throttled: it destroys a session,
  // it cannot be used to guess one.
  const isLogout = req.path === '/auth/logout' || req.path === '/api/admin/auth/logout';

  const gate = adminAuth.credentialThrottle(key);
  if (gate.locked && !isLogout) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(gate.retryAfterSec || 60));
    return req.path.startsWith('/api') || req.originalUrl.startsWith('/api/admin')
      ? res.status(429).json({ ok: false, error: 'Too many failed credentials. Try again later.' })
      : res.status(429).type('text').send('Too many failed credentials. Try again later.');
  }

  try { req.admin = await resolveAdmin(req); } catch { req.admin = null; }

  if (req.admin) {
    adminAuth.clearCredentialFailures(key);
  } else if (adminCredentialPresented(req)) {
    const after = adminAuth.noteCredentialFailure(key);
    if (after.locked) {
      adminAuth.securityEvent(getSupabaseAdmin(), {
        kind: 'credential_throttle_lock', severity: 'critical',
        ipHash: adminAuth.hashIp(req.ip),
        detail: { path: req.path, failures: after.failures },
      });
    }
  }
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
    ipHash: adminAuth.hashIp(req.ip), userAgent: req.get('user-agent'),
    // Every detail object passes the redactor: the audit trail is append-only,
    // so a secret written there could never be removed (lib/audit-redact.mjs).
    detail: redactAudit(detail ?? null),
    actorId: req.admin?.userId, actorRole: req.admin ? rbac.roleForPrincipal(req.admin) : null,
    requestId: req.requestId,
  });
}

const { redact: redactAudit } = await import('./lib/audit-redact.mjs');

/** The actor a service call acts as — identity plus the request context the audit record needs. */
function actorOf(req) {
  const a = req.admin || {};
  return {
    username: a.username, via: a.via,
    ...(a.role !== undefined ? { role: a.role } : {}),
    ...(a.userId ? { userId: a.userId } : {}),
    requestId: req.requestId, ipHash: adminAuth.hashIp(req.ip), userAgent: req.get('user-agent'),
  };
}

// Step-up authentication: destructive actions need a password re-entered in the
// last five minutes on THIS session. A bearer token can never satisfy it — a
// token in a cron file is not a person who can be asked to confirm.
const REAUTH_WINDOW_MS = 5 * 60 * 1000;
function isRecentAuth(req) {
  const t = req.admin?.via === 'session' ? req.admin?.session?.reauthAt : null;
  return !!t && Date.now() - Date.parse(t) < REAUTH_WINDOW_MS;
}

// Resolve a session before any admin route runs. Mounted on both prefixes; it
// only ever READS the request, so a non-admin caller is unaffected.
app.use(['/admin', '/api/admin'], adminGate);

// Nothing under /admin may be cached or indexed, ever.
app.use(['/admin', '/api/admin'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  // A correlation id for every admin request: it is written into each audit
  // record the request produces and returned to the console, so "what did that
  // click do" is one lookup.
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  // The console may never be framed — not even by this origin. Proxied game
  // documents (/embed) run third-party code on this origin; were /admin
  // frameable same-origin, such a script could load the console in a hidden
  // frame and read it. Appended as a SECOND policy, so helmet's site-wide CSP
  // still applies in full and this only narrows it.
  res.setHeader('X-Frame-Options', 'DENY');
  res.append('Content-Security-Policy', "frame-ancestors 'none'");
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
  // username measurably faster to reject than a bad password. Both the owner
  // check AND the staff lookup run on every attempt (the staff path verifies
  // against a dummy hash when the name is unknown), so timing does not reveal
  // which kind of account a name belongs to — or whether it exists at all.
  const expectedUser = String(process.env.ADMIN_USERNAME || '');
  const passOk = await adminAuth.verifyPassword(password, process.env.ADMIN_PASSWORD_HASH);
  const userBuf = Buffer.from(username);
  const wantBuf = Buffer.from(expectedUser);
  const userOk = userBuf.length === wantBuf.length && timingSafeEqual(userBuf, wantBuf);
  const staffResult = CONTROL.staff
    ? await CONTROL.staff.authenticate(username, password).catch(() => ({ user: null, reason: 'unknown_user' }))
    : { user: null, reason: 'unknown_user' };
  const ownerOk = userOk && passOk;
  const staffUser = ownerOk ? null : staffResult.user;

  if (!ownerOk && !staffUser) {
    await adminAuth.recordLoginAttempt(supa, {
      username, ok: false, ipHash, userAgent: ua,
      // Recorded, never returned. A suspended account gets the same generic
      // answer as a wrong password, so a probe cannot learn an account exists.
      reason: userOk ? 'bad_password' : (staffResult.reason || 'unknown_user'),
    });
    const after = await adminAuth.isLockedOut(supa, ipHash);
    if (after.locked) {
      await adminAuth.securityEvent(supa, { kind: 'lockout_started', severity: 'warn', username, ipHash });
    }
    // Progressive delay: cheap for a human who mistyped, expensive for a script.
    await new Promise(r => setTimeout(r, Math.min(2000, 250 * (after.failures || 1))));
    return res.status(401).json(generic);
  }

  const who = staffUser ? staffUser.username : expectedUser;
  const created = await adminAuth.createSession(supa, {
    username: who, ipHash, userAgent: ua, userId: staffUser ? staffUser.id : null,
  });
  if (!created) return res.status(503).json({ ok: false, error: 'Could not start a session.' });

  await adminAuth.recordLoginAttempt(supa, { username, ok: true, ipHash, userAgent: ua, reason: 'ok' });
  await adminAuth.audit(supa, {
    username: who, action: 'auth.login', outcome: 'success', ipHash, userAgent: ua,
    actorId: staffUser ? staffUser.id : null, actorRole: staffUser ? staffUser.role : 'owner',
    resourceType: staffUser ? 'user' : null, resourceId: staffUser ? staffUser.id : null,
  });
  if (staffUser) CONTROL.staff.noteLogin(staffUser.id);
  adminAuth.setSessionCookies(res, created);
  // The CSRF token is returned so the page can use it immediately; it is also in
  // a readable cookie, which is what makes the double-submit check work.
  res.json({
    ok: true, username: who, csrfToken: created.csrf,
    mustChangePassword: !!staffUser?.must_change_password,
  });
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
  if (!requirePerm(req, res, 'security.write')) return;
  if (!requireAdminCsrf(req, res)) return;
  const n = await adminAuth.revokeAllSessions(getSupabaseAdmin(), req.admin.username, 'logout_all');
  auditAction(req, 'auth.logout_all', null, 'success', { revoked: n });
  adminAuth.clearSessionCookies(res);
  res.json({ ok: true, revoked: n });
});

// ── POST /api/admin/auth/reauth ────────────────────────────────────────────
// Step-up authentication. Re-entering the password stamps THIS session for
// REAUTH_WINDOW_MS; the destructive routes (permanent deletion, role changes,
// approving proxy destinations, widening a provider) check that stamp. Throttled
// separately from the login lockout, and every failure is a security event:
// somebody holding a live session but not its password is exactly the case
// step-up exists for.
app.post('/api/admin/auth/reauth', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!requireAdminCsrf(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.admin.via !== 'session' || !req.admin.session) {
    return res.status(403).json({ ok: false, error: 'A service token cannot re-authenticate. Sign in as a person.' });
  }
  if (!LIMITS.allow('adminReauth', `admin:${req.admin.username}`, { rawKey: true })) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Wait a minute and try again.' });
  }
  const supa = getSupabaseAdmin();
  const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
  let ok = false;
  if (req.admin.userId) {
    const row = CONTROL.store ? await CONTROL.store.getStaff(req.admin.userId).catch(() => null) : null;
    ok = !!row && row.status === 'active' && await adminAuth.verifyPassword(password, row.password_hash);
  } else {
    ok = await adminAuth.verifyPassword(password, process.env.ADMIN_PASSWORD_HASH);
  }
  if (!ok) {
    auditAction(req, 'auth.reauth', null, 'failure');
    adminAuth.securityEvent(supa, { kind: 'reauth_failed', severity: 'warn', username: req.admin.username, ipHash: adminAuth.hashIp(req.ip) });
    await new Promise((r) => setTimeout(r, 400));
    return res.status(401).json({ ok: false, error: 'That password is not correct.' });
  }
  if (!(await adminAuth.markReauth(supa, req.admin.session.id))) {
    return res.status(503).json({ ok: false, error: 'Could not record the confirmation — is the control-plane migration applied?' });
  }
  auditAction(req, 'auth.reauth', null, 'success');
  res.json({ ok: true, validForSec: REAUTH_WINDOW_MS / 1000 });
});

// ── POST /api/admin/auth/password ──────────────────────────────────────────
// A staff member replacing their own password — the one self-service path, and
// the only thing a temporary password is allowed to do. The owner's password
// lives in the environment (npm run admin-hash) and is not changeable here.
app.post('/api/admin/auth/password', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!requireAdminCsrf(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  if (!CONTROL.staff) return res.status(503).json({ ok: false, error: CONTROL.reason });
  if (!LIMITS.allow('adminReauth', `admin:${req.admin.username}`, { rawKey: true })) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Wait a minute and try again.' });
  }
  try {
    const current = typeof req.body?.current === 'string' ? req.body.current.slice(0, 200) : '';
    const next = typeof req.body?.next === 'string' ? req.body.next.slice(0, 200) : '';
    await CONTROL.staff.changeOwnPassword(actorOf(req), current, next);
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) return res.status(e.status).json({ ok: false, error: e.message });
    console.warn('[admin] password change failed:', e?.message || e);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// Who am I? Used by the dashboard to decide whether to render or redirect.
app.get('/api/admin/me', (req, res) => {
  if (!requireAdmin(req, res)) return;
  // The role and its permissions travel with the identity so the console can
  // grey out what this principal cannot do. Presentation only — every one of
  // these is enforced again server-side, because a hidden button is not an
  // access control.
  const who = rbac.principalSummary(req.admin);
  res.json({
    ok: true,
    username: req.admin.username,
    via: req.admin.via,
    role: who.role,
    roleLabel: who.roleLabel,
    permissions: who.permissions,
    session: req.admin.session
      ? { createdAt: req.admin.session.createdAt, expiresAt: req.admin.session.expiresAt }
      : null,
    // Staff-account facts. userId is null for the owner and for service tokens.
    userId: req.admin.userId || null,
    mustChangePassword: !!req.admin.mustChangePassword,
    reauthFresh: isRecentAuth(req),
    controlPlane: { schema: CONTROL.schema, storage: CONTROL.store?.kind || null, reason: CONTROL.schema === 'ready' ? null : CONTROL.reason },
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
    // `mode` describes where inference RUNS (the visitor's browser, talking to
    // Pollinations directly). `requests` counts only what actually reached this
    // process — the server-side fallback. The two are different questions and
    // the console must not let them read as one.
    ai: { mode: 'client-side', serverInference: false, ...usage.usageSnapshot().ai },
    audience: usage.usageSnapshot().visitors,
    liveNow: presenceSnapshot().total,
    peakConcurrent: usage.usageSnapshot().peakConcurrent,
    plays: { lifetime: _liveTotalPlays, tracked: playCounts.size },
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
    const [games, working, broken, recs, hidden] = await Promise.all([
      count('games'),
      count('games', q => q.eq('is_working', true)),
      count('games', q => q.eq('is_working', false)),
      count('recommendations'),
      count('recommendations', q => q.eq('is_visible', false)),
    ]);
    out.database = { games, working, broken, recommendations: recs, hiddenRecommendations: hidden };

    // Security summary over the last 24 hours. Counts only — the Security view
    // carries the rows.
    const since = new Date(Date.now() - 864e5).toISOString();
    const since24 = async (table, build) => {
      try {
        const { count: n, error } = await build(supa.from(table).select('*', { count: 'exact', head: true }).gte('at', since));
        return error ? null : n;
      } catch { return null; }
    };
    const [failedLogins, denied, events] = await Promise.all([
      since24('admin_login_attempts', q => q.eq('ok', false)),
      since24('admin_audit_logs', q => q.eq('outcome', 'denied')),
      since24('admin_security_events', q => q.neq('severity', 'info')),
    ]);
    out.security = { failedLogins24h: failedLogins, deniedActions24h: denied, securityEvents24h: events };
  }
  out.controlPlane = { schema: CONTROL.schema, storage: CONTROL.store?.kind || null, reason: CONTROL.schema === 'ready' ? null : CONTROL.reason };
  if (CONTROL.store) {
    try { out.content = await CONTROL.store.statusCounts(); } catch { out.content = null; }
    try {
      const staff = await CONTROL.store.listStaff();
      out.staff = {
        total: staff.filter(s => s.status !== 'deleted').length,
        active: staff.filter(s => s.status === 'active').length,
        suspended: staff.filter(s => s.status === 'suspended').length,
      };
    } catch { out.staff = null; }
  }
  out.proxyControl = {
    accessMode: PROXY_POLICY.accessMode,
    approvedTargets: CONTROL.proxy ? CONTROL.proxy.snapshot().targets.approved : 0,
    liveSessions: PROXY_SESSIONS.size,
    refusals: { ...PROXY_REFUSALS },
  };
  out.rateLimited = { admin: ADMIN_429, wispGlobal: wispStats.rejected, wispPerClient: wispStats.rejectedPerIp };
  out.build = { version: PKG_VERSION, commit: String(process.env.RENDER_GIT_COMMIT || '').slice(0, 12) || null };
  res.json(out);
});

// ── GET /api/admin/security ────────────────────────────────────────────────
// The Security Centre: recent logins, security events, and the audit trail.
app.get('/api/admin/security', async (req, res) => {
  if (!requirePerm(req, res, 'security.read')) return;
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


// ── GET /api/admin/audit ───────────────────────────────────────────────────
// The searchable audit trail.
//
// /api/admin/security already returns the newest 50 rows, which answers "what
// just happened" and nothing else. An audit log earns its name when it can
// answer a QUESTION — "every denied action from this account last Tuesday" —
// and that needs filters and paging.
//
// PAGING IS CURSOR-BASED, on the primary key, deliberately. admin_audit_logs is
// append-only and written while it is being read, so OFFSET paging shifts
// underneath the reader: rows inserted during paging push earlier rows down a
// page, so page 2 re-shows what page 1 already showed and something in between
// is never seen at all. An id cursor is stable regardless of what arrives.
app.get('/api/admin/audit', async (req, res) => {
  if (!requirePerm(req, res, 'security.read')) return;
  res.setHeader('Cache-Control', 'no-store');
  const supa = getSupabaseAdmin();
  if (!supa) return res.status(503).json({ ok: false, error: 'no database' });

  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const action = str(req.query.action, 60);
  const outcome = str(req.query.outcome, 20).toLowerCase();
  const username = str(req.query.username, 80);
  const q = str(req.query.q, 80);
  const since = str(req.query.since, 40);
  const until = str(req.query.until, 40);
  const cursor = parseInt(req.query.cursor, 10);

  // A date that does not parse is a typo, not "the beginning of time" — a
  // silently ignored filter shows MORE than the operator asked for, which in an
  // audit tool is the dangerous direction to fail in.
  const isoOk = (v) => !v || !Number.isNaN(Date.parse(v));
  if (!isoOk(since) || !isoOk(until)) {
    return res.status(400).json({ ok: false, error: 'since/until must be ISO timestamps' });
  }
  const OUTCOMES = ['success', 'failure', 'denied'];
  if (outcome && !OUTCOMES.includes(outcome)) {
    return res.status(400).json({ ok: false, error: `outcome must be one of ${OUTCOMES.join(', ')}` });
  }

  try {
    let sel = supa.from('admin_audit_logs')
      .select('id, at, username, action, target, outcome, ip_hash, user_agent, detail')
      .order('id', { ascending: false })
      .limit(limit + 1);                       // +1 probes for a further page

    // Prefix match, so 'auth.' finds auth.login and auth.logout_all alike.
    // escapeLike keeps a '%' typed by the operator from widening the search to
    // everything — the one input here that could silently match all rows.
    const escapeLike = (v) => v.replace(/[\\%_]/g, (c) => '\\' + c);
    if (action) sel = sel.like('action', `${escapeLike(action)}%`);
    if (outcome) sel = sel.eq('outcome', outcome);
    if (username) sel = sel.eq('username', username);
    if (q) sel = sel.ilike('target', `%${escapeLike(q)}%`);
    if (since) sel = sel.gte('at', new Date(since).toISOString());
    if (until) sel = sel.lte('at', new Date(until).toISOString());
    if (Number.isFinite(cursor)) sel = sel.lt('id', cursor);

    const { data, error } = await sel;
    if (error) return res.status(502).json({ ok: false, error: 'audit query failed' });

    const rows = data || [];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    res.json({
      ok: true,
      rows: page,
      count: page.length,
      hasMore,
      // Null rather than absent, so a client can assign it unconditionally.
      nextCursor: hasMore ? page[page.length - 1].id : null,
      filters: { action, outcome, username, q, since, until, limit },
      outcomes: OUTCOMES,
    });
  } catch {
    res.status(502).json({ ok: false, error: 'audit query failed' });
  }
});

// ── GET /api/admin/audit/export ────────────────────────────────────────────
// The audit trail as a file, with the same filters as the searchable view.
// Separate permission (audit.export) from reading it: taking a copy OUT of the
// system is a different act from looking, and the export is itself audited.
// Keyset over the primary key, bounded at 20,000 rows per file.
app.get('/api/admin/audit/export', async (req, res) => {
  if (!requirePerm(req, res, 'audit.export')) return;
  res.setHeader('Cache-Control', 'no-store');
  if (!LIMITS.allow('adminExpensive', `admin:${req.admin.username}`, { rawKey: true })) {
    return res.status(429).json({ ok: false, error: 'Exports are limited — try again shortly.' });
  }
  const supa = getSupabaseAdmin();
  if (!supa) return res.status(503).json({ ok: false, error: 'no database' });
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const action = str(req.query.action, 60);
  const outcome = str(req.query.outcome, 20).toLowerCase();
  const username = str(req.query.username, 80);
  const q = str(req.query.q, 80);
  if (outcome && !['success', 'failure', 'denied'].includes(outcome)) return res.status(400).json({ ok: false, error: 'bad outcome' });
  const escapeLike = (v) => v.replace(/[\\%_]/g, (c) => '\\' + c);
  const rows = [];
  let cursor = null;
  try {
    while (rows.length < 20_000) {
      let sel = supa.from('admin_audit_logs')
        .select('id, at, username, action, target, outcome, detail')
        .order('id', { ascending: false }).limit(1000);
      if (action) sel = sel.like('action', `${escapeLike(action)}%`);
      if (outcome) sel = sel.eq('outcome', outcome);
      if (username) sel = sel.eq('username', username);
      if (q) sel = sel.ilike('target', `%${escapeLike(q)}%`);
      if (cursor !== null) sel = sel.lt('id', cursor);
      const { data, error } = await sel;
      if (error) return res.status(502).json({ ok: false, error: 'audit query failed' });
      if (!data?.length) break;
      rows.push(...data);
      if (data.length < 1000) break;
      cursor = data[data.length - 1].id;
    }
  } catch { return res.status(502).json({ ok: false, error: 'audit query failed' }); }
  auditAction(req, 'audit.export', null, 'success', { rows: rows.length, format: req.query.format === 'csv' ? 'csv' : 'json', filters: { action, outcome, username, q } });
  const stamp = new Date().toISOString().slice(0, 10);
  if (req.query.format === 'csv') {
    const { csvCell } = await import('./lib/admin-api.mjs');
    const cols = ['id', 'at', 'username', 'action', 'target', 'outcome', 'detail'];
    res.setHeader('Content-Disposition', `attachment; filename="zofhub-audit-${stamp}.csv"`);
    return res.type('text/csv; charset=utf-8')
      .send([cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n'));
  }
  res.setHeader('Content-Disposition', `attachment; filename="zofhub-audit-${stamp}.json"`);
  res.json({ ok: true, exportedAt: new Date().toISOString(), rows });
});

// ── GET /api/admin/audit/verify ────────────────────────────────────────────
// Re-derive the hash chain over recent audit records (db/control-plane.sql,
// admin_audit_verify). A mismatch means a record was altered, or inserted
// outside the application, after the chain was written — something the
// append-only trigger alone cannot show, because a superuser can disable it.
app.get('/api/admin/audit/verify', async (req, res) => {
  if (!requirePerm(req, res, 'security.read')) return;
  res.setHeader('Cache-Control', 'no-store');
  const supa = getSupabaseAdmin();
  if (!supa) return res.status(503).json({ ok: false, error: 'no database' });
  try {
    const { data, error } = await supa.rpc('admin_audit_verify', { p_limit: 5000 });
    if (error) return res.status(503).json({ ok: false, error: 'Integrity checking needs the control-plane migration.' });
    const row = Array.isArray(data) ? data[0] : data;
    auditAction(req, 'audit.verify', null, row?.first_bad_id ? 'failure' : 'success', { checked: row?.checked ?? 0, firstBadId: row?.first_bad_id ?? null });
    res.json({
      ok: true, checked: row?.checked ?? 0, firstBadId: row?.first_bad_id ?? null,
      note: 'Records written before the control-plane migration carry no hash and are not part of the chain.',
    });
  } catch { res.status(502).json({ ok: false, error: 'verification failed' }); }
});

// ── GET /api/admin/quality ─────────────────────────────────────────────────
// The aggregate quality picture: which games fail to render for which browsers,
// and how real visitors experience page speed.
//
// `worst` is the actionable list — a game with a high `blank` count on one
// browser family is a catalog problem the link-check cannot see, because the
// embed URL answers 200 and only the render fails.
//
// There is nothing per-visitor to expose here, so this needs no redaction pass:
// the underlying maps are counters keyed by closed-vocabulary buckets. An admin
// reading this learns about GAMES and BROWSERS, never about a person.
app.get('/api/admin/quality', (req, res) => {
  if (!requirePerm(req, res, 'telemetry.read')) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    enabled: TELEMETRY_ENABLED,
    persisted: telemetryTables,      // false => tables absent, memory only
    pending: { failures: failuresDirty.size, vitals: vitalsDirty.size },
    failures: summarizeFailures(failureCounts, { top: 50 }),
    vitals: summarizeVitals(vitalCounts),
  });
});

// ── GET /api/admin/proxy ───────────────────────────────────────────────────
// Telemetry for the proxy layer THIS SERVER ACTUALLY RUNS: the Wisp tunnel and
// the engines mounted by proxy-engine/mount.mjs (GUST, Ultraviolet, Scramjet,
// bare-mux, epoxy).
//
// Everything reported here is measured in-process. There is no external proxy
// daemon to scrape and no second service to be out of sync with, so the numbers
// cannot disagree with what the server is doing — they ARE what the server is
// doing.
app.get('/api/admin/proxy', async (req, res) => {
  if (!requirePerm(req, res, 'telemetry.read')) return;
  res.setHeader('Cache-Control', 'no-store');
  const mem = process.memoryUsage();
  // The external sing-box instance, if one is configured. Awaited here rather
  // than fetched by the client so its loopback API is never exposed to a
  // browser, and its own timeout (1.5s) bounds this handler. It always resolves.
  const singbox = await singboxTelemetry();
  res.json({
    ok: true,
    // Which engines mounted at boot. A `false` here is why a given proxy route
    // 404s, and it is otherwise only visible in the boot log.
    engines: proxyStatus,
    tunnels: wispSnapshot(),
    egress: egressReport(),
    // sing-box (GPL-3.0, its own process — see docs/proxy/SINGBOX.md).
    //   `singbox`        what the daemon's API reports. `reachable:false` is the
    //                    honest default; nothing fabricates traffic for a daemon
    //                    that is not answering.
    //   `singboxProcess` whether WE started it, and how that is going. Separate
    //                    because "we never launched it" and "we launched it and
    //                    it is crash-looping" are different problems with
    //                    different fixes, and one number cannot say both.
    singbox,
    singboxProcess: singboxProcessStatus(),
    //   `singboxEgress`  the answer to "is it actually carrying our traffic?",
    //                    which neither of the two above can give. A daemon can
    //                    be up and reachable while every stream quietly falls
    //                    back to direct, so the share is reported explicitly
    //                    rather than inferred from liveness.
    singboxEgress: egressStats(),
    // Governance: approved-destination decisions by reason, live sessions,
    // pre-tunnel refusals and the effective policy. Counts only.
    governance: {
      policy: { ...PROXY_POLICY },
      decisions: PROXY_GOVERNOR.stats().decisions,
      sessions: PROXY_SESSIONS.stats(),
      refusals: { ...PROXY_REFUSALS },
    },
    process: {
      uptimeSec: Math.round(process.uptime()),
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      handles: typeof process._getActiveHandles === 'function'
        ? process._getActiveHandles().length : null,
    },
    ts: new Date().toISOString(),
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
      // Set on every catalog object by setCatalog(); derived here only for the
      // rare row that reached this list without going through it.
      provider: g.provider || providerOf(g.embed_url),
    })),
  });
});

// ── POST /api/admin/games/:slug/visibility ─────────────────────────────────
// Show or hide one game. Writes is_working in Supabase — the same field the
// link checker maintains and the same one the public RLS policy filters on —
// rather than inventing a parallel visibility mechanism.
app.post('/api/admin/games/:slug/visibility', async (req, res) => {
  if (!requirePerm(req, res, 'catalog.write')) return;
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
  if (!requirePerm(req, res, 'catalog.write')) return;
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
  if (!requirePerm(req, res, 'moderation.write')) return;
  if (!requireAdminCsrf(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  // Validated BEFORE auditing, like the feedback route: the audit trail is
  // append-only, so recording first let any string from the URL into it.
  if (req.params.action !== 'hide' && req.params.action !== 'show') {
    return res.status(400).json({ ok: false, error: 'action must be hide or show' });
  }
  const id = adminAuth.parseRowId(req.params.id);
  if (id === null) return res.status(400).json({ ok: false, error: 'bad id' });
  auditAction(req, 'recommendation.' + req.params.action, String(id));
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

// --- GET /api/admin/feedback ------------------------------------------------
// The review queue. Defaults to unread, because that is the view with work in
// it. Never exposed publicly: there is no matching public route, and RLS denies
// the publishable key SELECT entirely.
// --- POST /api/admin/ai-feedback/forget --------------------------------------
// Right to erasure, exercised by an operator on somebody's behalf.
//
// There is deliberately no user id on ai_feedback (see db/15_ai_feedback.sql),
// so the only honest handle is the exact text the person submitted — which they
// are the one most likely to still have. The SQL function refuses anything
// shorter than 12 characters so this cannot become a mass-delete by "a".
//
// Admin-gated: it is a delete, and the matching text is somebody's content.
// --- POST /api/admin/masqr/key -----------------------------------------------
// Mint a proxy access key. Without this the gate would be a feature with no way
// to use it: keys are HMAC-signed rather than stored, so there is nothing to
// insert into a table by hand and no way to produce one except by signing.
//
// Permission + CSRF like every other admin write: a key is a capability, and a
// cross-site POST from a logged-in admin's browser must not be able to mint one.
// The key is returned ONCE, in the response body, and is never logged or stored
// — there is nowhere to look it up again, by design.
app.post('/api/admin/masqr/key', async (req, res) => {
  if (!requirePerm(req, res, 'security.write')) return;
  if (!requireAdminCsrf(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  if (!MASQR.enabled) {
    return res.status(503).json({
      ok: false,
      error: MASQR.mode === 'misconfigured'
        ? 'The proxy gate is misconfigured — see the [masqr] warning in the server log.'
        : 'The proxy gate is off. Set MASQR_ENABLED=1 and MASQR_SECRET to use it.',
    });
  }

  // An operator may want a short-lived key for one class period. Bounded on
  // both ends: zero would mint something already expired, and "forever" defeats
  // the point of keys that age out after a leak.
  const days = Number(req.body?.days);
  const ttlDays = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : MASQR.ttlDays;
  const key = mintMasqrKey(MASQR.secret, { ttlMs: ttlDays * 24 * 60 * 60 * 1000 });
  const expires = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

  res.json({
    ok: true,
    key,
    expires,
    ttlDays,
    // The shape the key is meant to travel in. Built from the request so it is
    // correct on whichever mirror the admin happens to be signed in to.
    link: `${req.protocol}://${req.get('host')}/browser?k=${encodeURIComponent(key)}`,
    note: 'Shown once. It is signed, not stored — there is no way to look it up again. '
      + 'Rotating MASQR_SECRET invalidates every key at once.',
  });
});

app.post('/api/admin/ai-feedback/forget', async (req, res) => {
  // Deleting somebody's content is a state change with a permission AND a CSRF
  // requirement, like every other admin write here. adminGate alone would have
  // left it open to a cross-site POST from an authenticated admin's browser.
  if (!requirePerm(req, res, 'security.write')) return;
  if (!requireAdminCsrf(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (text.trim().length < 12) {
    return res.status(400).json({ ok: false, error: 'Provide the exact submitted text (12+ characters).' });
  }
  const supa = getSupabaseAdmin();
  if (!supa) return res.status(503).json({ ok: false, error: 'Not available.' });
  try {
    const { data, error } = await supa.rpc('forget_ai_feedback', { p_text: text });
    if (error) {
      if (/does not exist|could not find|PGRST202|42883|42P01/i.test(error.message || '')) {
        return res.status(503).json({ ok: false, error: 'AI feedback is not installed.' });
      }
      throw error;
    }
    // The count is the useful answer; the text itself is never echoed back.
    return res.json({ ok: true, removed: Number(data) || 0 });
  } catch (e) {
    console.warn('[ai-feedback] forget failed:', e.message);
    return res.status(502).json({ ok: false, error: 'Could not complete that right now.' });
  }
});
app.get('/api/admin/feedback', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  const supa = getSupabaseAdmin();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase admin key not configured.' });
  const status = ['new', 'read', 'archived'].includes(req.query.status) ? req.query.status
    : req.query.status === 'all' ? 'all' : 'new';
  try {
    let q = supa.from('feedback')
      .select('id, created_at, message, email, page, kind, status, ip_hash', { count: 'exact' });
    if (status !== 'all') q = q.eq('status', status);
    const { data, error, count } = await q.order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    // Per-status counts drive the filter labels, so a moderator can see there is
    // work waiting without switching tabs to find out.
    const counts = {};
    for (const s of ['new', 'read', 'archived']) {
      const { count: n } = await supa.from('feedback')
        .select('id', { count: 'exact', head: true }).eq('status', s);
      counts[s] = n ?? 0;
    }
    return res.json({ ok: true, feedback: data || [], total: count ?? 0, status, counts });
  } catch (e) {
    if (needsSetup(e)) return res.status(503).json({ ok: false, error: 'Run db/feedback.sql first.' });
    return res.status(500).json({ ok: false, error: 'Could not load feedback.' });
  }
});

// --- POST /api/admin/feedback/:id/:action -----------------------------------
// read | archive | delete. Validated BEFORE auditing, so the audit table cannot
// be filled with arbitrary strings from the URL.
app.post('/api/admin/feedback/:id/:action', async (req, res) => {
  if (!requirePerm(req, res, 'moderation.write')) return;
  if (!requireAdminCsrf(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  const ACTIONS = ['read', 'archive', 'delete'];
  if (!ACTIONS.includes(req.params.action)) {
    return res.status(400).json({ ok: false, error: `action must be one of: ${ACTIONS.join(', ')}` });
  }
  const id = adminAuth.parseRowId(req.params.id);
  if (id === null) return res.status(400).json({ ok: false, error: 'bad id' });
  auditAction(req, 'feedback.' + req.params.action, String(id));
  const supa = getSupabaseAdmin();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase admin key not configured.' });
  try {
    if (req.params.action === 'delete') {
      // Irreversible, so what it contained goes into the append-only trail
      // first — otherwise the delete destroys the only record it existed.
      const { data: row } = await supa.from('feedback')
        .select('kind, status, message').eq('id', id).maybeSingle();
      if (!row) return res.status(404).json({ ok: false, error: 'not found' });
      const { error } = await supa.from('feedback').delete().eq('id', id);
      if (error) throw error;
      auditAction(req, 'feedback.delete.detail', String(id), 'success',
        `${row.kind} · was ${row.status} · ${String(row.message).slice(0, 120)}`);
      return res.json({ ok: true, id, action: 'delete' });
    }
    const status = req.params.action === 'read' ? 'read' : 'archived';
    const { error } = await supa.from('feedback').update({ status }).eq('id', id);
    if (error) throw error;
    return res.json({ ok: true, id, status });
  } catch {
    return res.status(500).json({ ok: false, error: 'Update failed.' });
  }
});

// --- GET /api/admin/analytics -----------------------------------------------
// Play distribution across the catalog. Reads the in-memory playCounts map the
// server already maintains, so opening this panel costs no database work.
app.get('/api/admin/analytics', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    return res.json({ ok: true, ...summarizeCatalog(CATALOG.games, playCounts, { top: 20 }) });
  } catch {
    return res.status(500).json({ ok: false, error: 'Could not build analytics.' });
  }
});

// --- GET /api/admin/system --------------------------------------------------
// Runtime, background jobs, caches, feature state and recent errors: the things
// you want when the site is misbehaving and you do not yet know why.
//
// Feature state is reported from the environment the process actually booted
// with, not from a settings table. There is no toggle here that nothing reads —
// a switch in a dashboard that changes no behaviour is worse than no switch,
// because it looks like it worked.
// ── GET /api/admin/ads ─────────────────────────────────────────────────────
// Which of the five networks are enabled, which are configured, and which slot
// each one owns.
//
// RETURNS NO TAGS, ZONES OR CREDENTIALS — only booleans and counts. An ad tag is
// a bearer credential for that account's revenue: anyone holding it can serve
// ads billed to this publisher. Admin sessions are legitimate, but there is no
// reason for a tag to travel to a browser, sit in a response cache, or land in a
// screenshot, so it never leaves the server. adminAdConfig() enforces that shape.
// GameFlare audit view — the ONLY place the excluded candidates are visible.
//
// The public API returns eligible games and nothing else, so failure evidence,
// legal notes and the test-harness origin never reach a visitor. An operator
// still needs to see why 298 records produced 0 playable games, and this is the
// authenticated surface for that. It reports COUNTS and reasons, not the raw
// records, so the evidence blobs stay out of any response.
app.get('/api/admin/gameflare-audit', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.set('Cache-Control', 'private, no-store');
  if (!GAMEFLARE.ok) {
    return res.json({ ok: false, error: GAMEFLARE.error, counts: null });
  }
  res.json({
    ok: true,
    dataset: GAMEFLARE.dataset,
    counts: GAMEFLARE.counts,
    publicCatalogEmpty: GAMEFLARE.counts.eligible === 0,
    // Why each rejected record failed, without the record itself.
    rejected: GAMEFLARE.rejected.slice(0, 200),
    note: 'Only iframe_compatibility.status === "verified_working" inside the top-level '
        + '`games` array is publicly exposable. Commercial use is NOT verified in this '
        + 'dataset; external advertising around these embeds stays disabled.',
  });
});

// Donation CONFIGURATION health — not revenue, because no revenue data exists.
//
// Nothing in this codebase records a donation. There is no donations table, no
// invoice log, no webhook and no balance: the site publishes addresses and a
// donor's wallet talks to a blockchain directly, with this server never in the
// path. That is the design (see data/donate.json), and it means an "income"
// panel could only ever be invented. What an operator CAN be shown, and what
// actually goes wrong in practice, is whether each method is live and why any
// of them are not.
//
// Addresses are returned in full and that is deliberate: a receiving address is
// already shown to every visitor in the donate dialog, so there is nothing here
// the public does not have. Seeing it is how an operator confirms the deployed
// address is the one they meant.
app.get('/api/admin/donations', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.set('Cache-Control', 'private, no-store');

  const cfg = getDonateConfig();
  const swap = swapConfig();

  res.json({
    ok: true,
    enabled: cfg.enabled,
    heading: cfg.heading,
    live: cfg.methods.map(m => ({
      id: m.id, label: m.label, kind: m.kind,
      ticker: m.ticker || null,
      address: m.address || null,
      url: m.url || null,
      // "checksum" means a typo cannot reach the dialog. "shape-only" means it
      // can — the operator has to have sent a test transaction instead.
      verified: m.verified || null,
      note: m.note || '',
    })),
    // The dropped ones are the whole point of this panel: a method missing from
    // the site is otherwise silent, and this says exactly which and exactly why.
    problems: cfg.problems || [],
    swap: {
      configured: !!swap.provider && !swap.missing.length && !!swap.collect,
      // Why a set-but-invalid DONATE_XMR_ADDRESS turned the swap path off.
      collectProblem: swap.collectProblem || null,
      provider: swap.provider ? swap.provider.label : null,
      missingEnv: swap.missing || [],
      collectsTo: swap.collect ? 'XMR' : null,
      depositCoins: Object.keys(DEPOSIT_COINS),
    },
    tracking: {
      recorded: false,
      why: 'No donation is ever recorded. There is no donations table, invoice log, webhook or balance in this '
         + 'codebase — a donor wallet talks to a blockchain and this server is never in the path. Revenue '
         + 'figures would have to be read from your own wallets.',
    },
    mutable: false,
    howToChange: 'Set DONATE_<TICKER>_ADDRESS in the host environment and restart. Addresses are never editable '
      + 'from this panel: one that can be changed through a web login is one an attacker redirects by stealing it.',
  });
});

app.get('/api/admin/ads', (req, res) => {
  // adminGate only RESOLVES an identity; it does not enforce. Every admin route
  // has to call requireAdmin itself, and omitting it does not fail loudly — the
  // route simply answers 200 to the whole internet. This one did exactly that
  // until it was checked against /api/admin/dashboard's 401.
  if (!requireAdmin(req, res)) return;
  res.set('Cache-Control', 'private, no-store');
  res.json({
    ...adminAdConfig(AD_CONFIG),
    // Surfaces are part of the compliance story an admin needs to see: it is
    // the answer to "are we running ads on the proxy?" (no, structurally).
    surfaces: { adsAllowedOn: 'native pages only', proxyExcluded: true },
    cspOrigins: AD_ORIGINS.length,
    // Changing providers means changing environment variables and restarting —
    // deliberately NOT a runtime write. A mutable ad config endpoint is a
    // remote script-injection primitive: whoever can POST a tag can run
    // arbitrary JavaScript on every page of the site.
    mutable: false,
    howToChange: 'Set <NETWORK>_ENABLED and the variable for that network\'s one role (e.g. EXOCLICK_HEADER_TAG, '
      + 'CLICKADU_PREROLL_VAST) in the host environment and redeploy. Regional variants add __<REGION>. '
      + 'See docs/features/ADVERTISING.md.',
    regions: GEO.regionIds,
    adblockGate: adblockGateOn(),
  });
});

app.get('/api/admin/system', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  const mem = process.memoryUsage();
  const flag = (name, on, note) => ({ name, on: !!on, note: note || null });

  // ASYNC fs, not the *Sync twins. This walks the whole thumbnail cache — which
  // is unbounded and reaches thousands of files — and a readdirSync plus one
  // statSync per file stops the event loop for the entire walk. Every other
  // request in flight, from every other visitor, waits behind an admin opening a
  // dashboard. Chunked so the promises do not all queue against the fs
  // threadpool at once on a large cache.
  let thumbCache = { files: null, bytes: null };
  try {
    const { readdir, stat } = await import('node:fs/promises');
    const files = await readdir(THUMB_CACHE_DIR);
    let bytes = 0;
    for (let i = 0; i < files.length; i += 256) {
      const sizes = await Promise.all(files.slice(i, i + 256).map(
        f => stat(join(THUMB_CACHE_DIR, f)).then(s => s.size).catch(() => 0)));  // raced deletes → 0
      for (const n of sizes) bytes += n;
    }
    thumbCache = { files: files.length, bytes };
  } catch { /* the directory is created lazily; absent is normal */ }

  return res.json({
    ok: true,
    runtime: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      env: process.env.NODE_ENV || 'development',
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      rssMB: Math.round(mem.rss / 1048576),
      heapUsedMB: Math.round(mem.heapUsed / 1048576),
      heapTotalMB: Math.round(mem.heapTotal / 1048576),
    },
    // Render sets these; absent locally, which is not a fault.
    deployment: {
      service: process.env.RENDER_SERVICE_NAME || null,
      region: process.env.RENDER_REGION || null,
      commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 8) || null,
      branch: process.env.RENDER_GIT_BRANCH || null,
      instance: process.env.RENDER_INSTANCE_ID ? 'render' : 'self-hosted',
    },
    jobs: {
      cron: process.env.CRON_DISABLED === '1' ? 'disabled' : 'running',
      catalogSource: CATALOG.source,
      catalogGeneratedAt: CATALOG.generatedAt,
      catalogGames: CATALOG.games.length,
      playCountsTracked: playCounts.size,
      playCountsPending: playsDirty.size,
    },
    caches: {
      thumbnails: { ...thumbCache, dir: '.cache/thumbs' },
      catalogInMemory: CATALOG.games.length,
    },
    features: [
      flag('Supabase writes', !!getSupabaseAdmin(), 'admin key present'),
      flag('Cron jobs', process.env.CRON_DISABLED !== '1'),
      flag('Server-side AI routes', process.env.NODE_ENV !== 'production',
        process.env.NODE_ENV === 'production'
          ? 'refused (403) — production never runs inference on this server'
          : 'loopback clients only — a local-development aid'),
      flag('Proxy engines', Object.values(proxyStatus || {}).some(Boolean),
        Object.entries(proxyStatus || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'),
    ],
    // Same list the boot log prints. A warning that lives only in a log nobody
    // tails is a warning that does not exist, so it also lands in the console.
    warnings: devFallbackWarnings(),
    errors: { recent: errorLog.list({ limit: 40 }), ...errorLog.stats() },
  });
});

// --- POST /api/admin/cache/clear --------------------------------------------
// Drops the on-disk thumbnail cache. Safe by construction: every entry is a
// copy of a remote image that is re-fetched on the next request, so the worst
// case is one slow page load.
app.post('/api/admin/cache/clear', async (req, res) => {
  if (!requirePerm(req, res, 'config.write')) return;
  if (!requireAdminCsrf(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  auditAction(req, 'cache.clear', 'thumbnails');
  try {
    // Async, and chunked, for the same reason as /api/admin/system above: this
    // deletes every file in an unbounded directory, and the synchronous form
    // holds the event loop for the whole sweep.
    const { readdir, rm } = await import('node:fs/promises');
    const files = await readdir(THUMB_CACHE_DIR);
    let removed = 0;
    for (let i = 0; i < files.length; i += 256) {
      // Only ever files directly inside the cache directory. Never recursive,
      // never a path built from anything the caller sent.
      const done = await Promise.all(files.slice(i, i + 256).map(
        f => rm(join(THUMB_CACHE_DIR, f), { force: true }).then(() => 1).catch(() => 0)));
      for (const n of done) removed += n;
    }
    return res.json({ ok: true, removed });
  } catch (e) {
    if (e?.code === 'ENOENT') return res.json({ ok: true, removed: 0, note: 'Cache directory does not exist yet.' });
    return res.status(500).json({ ok: false, error: 'Could not clear the cache.' });
  }
});

// --- GET /api/admin/catalog/quality -----------------------------------------
// Structural health of the catalog the site actually serves. CATALOG.games is
// already override-applied (see loadCatalog), so this reports what a player
// sees rather than what the database holds — auditing the raw table re-reports
// the ~4,200 entries the override layer already handles and buries anything new.
//
// Read-only. Hiding a game is a separate, reviewable step: `npm run quality --
// --write` appends rules to data/catalog-overrides.json, which lands in a diff
// rather than mutating the live site from a dashboard button.
app.get('/api/admin/catalog/quality', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    const report = auditGames(CATALOG.games);
    return res.json({
      ok: true,
      ...report,
      source: CATALOG.source,
      generatedAt: CATALOG.generatedAt,
      labels: ISSUE_LABELS,
      applyWith: 'npm run quality -- --write',
    });
  } catch {
    return res.status(500).json({ ok: false, error: 'Could not audit the catalog.' });
  }
});

// A tiny self-contained console, kept ONLY as the fallback for a deployment
// that has not yet run `npm run admin-hash` (see the /admin route below). The
// secret is typed in, kept only in sessionStorage, and sent as a header — it is
// never part of a URL or the page.
//
// It had a second tab, "Flagged scores", backed by /api/admin/scores/flagged.
// That route went with the leaderboard, so the tab could only ever render its
// own error. Reviewing game requests is all this fallback does now.

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
// There is no second, weaker console. A deployment whose credentials are not
// configured gets a setup notice and nothing else — being locked out of your
// own console is recoverable in one command; a console anyone can reach is not.
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
// Shown at /admin when ADMIN_USERNAME / ADMIN_PASSWORD_HASH / ADMIN_SESSION_SECRET
// are missing or malformed. Deliberately inert: no form, no fetch, no endpoint
// names, no version. It cannot be authenticated against because there is
// nothing here to authenticate against.
//
// The exact list of problems is withheld from remote callers — "which of my
// three variables is unset" is free reconnaissance — and printed to the server
// log at boot instead, where the operator can already see it.
const ADMIN_SETUP_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Setup required</title>
<style>
:root{color-scheme:light dark;--bg:#0d1117;--card:#161b22;--line:#30363d;--tx:#e6edf3;--dim:#8b949e;--amber:#d29922}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--tx);
 font:15px/1.6 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
.card{max-width:520px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{margin:0 0 6px;font-size:19px;letter-spacing:-.01em}
p{margin:0 0 16px;color:var(--dim);font-size:14px}
code{display:block;background:#0d1117;border:1px solid var(--line);border-radius:8px;padding:11px 13px;
 margin:8px 0;font:13px/1.5 ui-monospace,"Cascadia Code",monospace;color:var(--tx);overflow-x:auto}
.tag{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;
 color:var(--amber);border:1px solid var(--amber);border-radius:999px;padding:3px 9px;margin-bottom:14px}
</style></head><body><div class="card">
<span class="tag">Setup required</span>
<h1>Admin access is not configured</h1>
<p>The console stays closed until credentials are set. Run this, then put the three
printed values in your environment and restart:</p>
<code>npm run admin-hash</code>
<p>The specific problems are printed in the server log at startup.</p>
</div></body></html>`;


/**
 * Print the admin security posture at boot — the one place an operator
 * reliably looks. The /admin setup page deliberately withholds this detail
 * from remote callers, so this log is how the owner learns what is wrong.
 *
 * ADMIN_SECRET is a bearer token typed by nobody: there is no reason for it to
 * be short or memorable, and a short one is guessable now that it is the only
 * credential on that path. Length is a proxy for entropy, but a blunt one is
 * better than staying silent.
 */
function printAdminSecurityStatus() {
  const cfg = adminAuth.adminConfigStatus();
  if (cfg.ok) {
    console.log('  → admin:   password login active (sessions, CSRF, lockout)');
  } else {
    console.warn('  → admin:   NOT CONFIGURED — /admin is closed. Run: npm run admin-hash');
    for (const p of cfg.problems) console.warn(`             · ${p}`);
  }
  if (ADMIN_SECRET && ADMIN_SECRET.length < 32) {
    console.warn(`  → WARNING: ADMIN_SECRET is only ${ADMIN_SECRET.length} characters. It is a bearer`);
    console.warn('             token with full admin access — use 32+ random characters');
    console.warn("             (node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\").");
  }
  for (const line of devFallbackWarnings()) console.warn('  → ' + line);
}

/**
 * Development-only settings that are dangerous once a real domain is pointed at
 * this process. Returned as strings so the same list can be printed at boot AND
 * surfaced in the admin console — a warning that exists only in a log nobody
 * tails is a warning that does not exist.
 */
function devFallbackWarnings() {
  const out = [];
  const isProd = process.env.NODE_ENV === 'production';
  const siteUrl = String(process.env.SITE_URL || '').trim();
  // A real https host that is not localhost is "a production URL" regardless of
  // what NODE_ENV happens to say — NODE_ENV is the thing people forget to set.
  let publicDomain = false;
  try {
    const u = new URL(siteUrl);
    publicDomain = u.protocol === 'https:' && !/^(localhost|127\.|\[::1\])/.test(u.hostname);
  } catch { /* unset or unparseable → not a public domain */ }
  const liveish = isProd || publicDomain;

  if (liveish && !isProd) {
    out.push('WARNING: this looks like a live deployment but NODE_ENV is not "production".');
    out.push('         The server-side AI routes stay loopback-only either way, but set');
    out.push('         NODE_ENV=production so they answer 403 unconditionally.');
  }
  const pk = String(process.env.POLLINATIONS_PUBLIC_KEY || '').trim();
  if (pk && !pk.startsWith('pk_')) {
    out.push('WARNING: POLLINATIONS_PUBLIC_KEY is not a pk_ key. It is being withheld from');
    out.push('         the browser (correctly — only publishable pk_ keys are served), so it');
    out.push('         is doing nothing. If you pasted a secret key here, rotate it.');
  }
  if (!isProd && publicDomain) {
    out.push(`WARNING: NODE_ENV is "${process.env.NODE_ENV || 'unset'}" but SITE_URL is a public https`);
    out.push('         domain. Production hardening keys off NODE_ENV — set it to "production".');
  }
  return out;
}

// ========================================================================
// Control plane API + boot (lib/admin-api.mjs)
// ========================================================================
const { createCmsService, ServiceError } = await import('./lib/cms-service.mjs');
const { createMemoryStore } = await import('./lib/cms-store-memory.mjs');
const { createSupabaseStore } = await import('./lib/cms-store-supabase.mjs');
const { createSettingsService } = await import('./lib/settings-service.mjs');
const { createStaffService } = await import('./lib/staff-service.mjs');
const { createProxyService } = await import('./lib/proxy-service.mjs');
const { mountAdminApi } = await import('./lib/admin-api.mjs');
const { runGdImport, IMPORT_ACTOR: GD_IMPORT_ACTOR } = await import('./lib/gamedistribution-import.mjs');
const PKG_VERSION = (() => { try { return JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version; } catch { return null; } })();

let ADMIN_429 = 0;

/** The audit sink every service writes through. Structured and redacted upstream. */
function controlAudit(e) {
  const a = e.actor || {};
  const role = rbac.roleForPrincipal(a);
  adminAuth.audit(getSupabaseAdmin(), {
    username: a.username, action: e.action, target: e.target, outcome: e.outcome,
    ipHash: a.ipHash, userAgent: a.userAgent, detail: e.detail,
    actorId: a.userId, actorRole: role, resourceType: e.resourceType, resourceId: e.resourceId,
    requestId: a.requestId,
  });
  // In memory mode there is no database to hold the trail, so the store keeps a
  // bounded copy — which is what makes history views and tests work without one.
  if (CONTROL.store?.kind === 'memory') {
    const log = CONTROL.store._audit;
    log.push({ id: log.length + 1, at: new Date().toISOString(), username: a.username || null, actor_role: role,
      action: e.action, outcome: e.outcome, resource_type: e.resourceType, resource_id: e.resourceId, detail: e.detail });
    if (log.length > 5000) log.splice(0, log.length - 5000);
  }
}

// Catalog refreshes after console edits are debounced: fifty edits in a minute
// should cost one refresh, not fifty.
let _catalogRefreshTimer = null;
function scheduleCatalogRefresh() {
  if (_catalogRefreshTimer) return;
  _catalogRefreshTimer = setTimeout(() => {
    _catalogRefreshTimer = null;
    refreshCatalogFromSupabase().catch(() => {});
  }, 15_000);
  _catalogRefreshTimer.unref?.();
}

function applyAdSettings() {
  const st = CONTROL.settings;
  if (!st) return;
  const off = new Set(st.get('ads.disabled_networks') || []);
  const allOff = st.get('ads.enabled') === false;
  const env = { ...process.env };
  for (const n of AD_NETWORKS) if (allOff || off.has(n.id)) env[`${n.env}_ENABLED`] = '0';
  AD_CONFIG = resolveAdConfig(env, { regions: GEO.regionIds });
}

function onSettingChanged(key) {
  if (key.startsWith('ads.')) applyAdSettings();
}

// ── The GameDistribution import job ─────────────────────────────────────────
// One at a time, in the background, started by the weekly cron or an admin
// holding games.import. Never by a visitor: the route is behind requirePerm
// and the expensive-operation budget.
const GD_JOB = { running: false, startedAt: null, finishedAt: null, by: null, dryRun: false, onlyIds: null, report: null, error: null };
function gdImportStatus() {
  const r = GD_JOB.report;
  return { ...GD_JOB, report: r ? { ...r, planned: (r.planned || []).slice(0, 60), flagged: (r.flagged || []).slice(0, 200), failures: (r.failures || []).slice(0, 50) } : null };
}
function startGdImport(actor, { dryRun = false, onlyIds = null } = {}) {
  if (GD_JOB.running) throw new ServiceError(409, 'an import is already running');
  if (!CONTROL.cms || CONTROL.store?.kind !== 'supabase') {
    throw new ServiceError(503, CONTROL.schema === 'ready' ? 'the import needs the database' : CONTROL.reason);
  }
  Object.assign(GD_JOB, { running: true, startedAt: new Date().toISOString(), finishedAt: null, by: actor.username, dryRun, onlyIds, report: null, error: null });
  const autoPublish = CONTROL.settings?.get('catalog.gd_auto_publish_clean') !== false;
  runGdImport({ cms: CONTROL.cms, store: CONTROL.store, autoPublish, dryRun, onlyIds, log: (m) => console.log('[gd-import]', m) })
    .then((report) => {
      GD_JOB.report = report;
      controlAudit({ actor, action: 'import.gamedistribution', resourceType: 'import', resourceId: 'gamedistribution',
        target: 'import:gamedistribution', outcome: 'success',
        detail: { dryRun, onlyIds, counts: report.counts, rejectReasons: report.rejectReasons, flagCounts: report.flagCounts, feed: report.feed } });
      console.log(`[gd-import] ${dryRun ? 'DRY RUN ' : ''}done: ${JSON.stringify(report.counts)}`);
      if (!dryRun && report.counts.inserted) scheduleCatalogRefresh();
    })
    .catch((e) => {
      GD_JOB.error = String(e?.message || e).slice(0, 300);
      controlAudit({ actor, action: 'import.gamedistribution', resourceType: 'import', resourceId: 'gamedistribution',
        target: 'import:gamedistribution', outcome: 'failure', detail: { dryRun, error: GD_JOB.error } });
      console.warn('[gd-import] failed:', GD_JOB.error);
    })
    .finally(() => { GD_JOB.running = false; GD_JOB.finishedAt = new Date().toISOString(); });
  return gdImportStatus();
}
async function jobGdImport() {
  if (CONTROL.settings?.get('catalog.gd_auto_import') === false) { console.log('[cron:gd-import] switched off in settings'); return; }
  if (CONTROL.store?.kind !== 'supabase') { console.log(`[cron:gd-import] skipped: ${CONTROL.reason}`); return; }
  try { startGdImport({ ...GD_IMPORT_ACTOR, requestId: `cron-${Date.now()}` }); }
  catch (e) { console.warn('[cron:gd-import]', e.message); }
}

function controlStatus() {
  return {
    schema: CONTROL.schema, storage: CONTROL.store?.kind || null,
    reason: CONTROL.schema === 'ready' ? null : CONTROL.reason,
    settings: CONTROL.settings?.status() || null,
    proxy: CONTROL.proxy?.status() || null,
    providers: CONTROL.providers.list().map((p) => ({ id: p.id, status: p.status })),
  };
}

let _controlRetry = null;
async function initControlPlane() {
  const supa = getSupabaseAdmin();
  let store = null;
  if (supa) {
    try {
      const { error } = await supa.from('game_providers').select('id').limit(1);
      if (error) {
        CONTROL.schema = 'missing';
        CONTROL.reason = 'The control-plane migration (supabase/migrations/20260101001080_control_plane.sql) has not been applied to this database yet. The public site is unaffected; content, staff, settings and proxy-destination management need it.';
      } else {
        store = createSupabaseStore(supa);
        CONTROL.schema = 'ready';
        CONTROL.reason = null;
      }
    } catch {
      CONTROL.schema = 'unreachable';
      CONTROL.reason = 'The database could not be reached; the control plane will retry.';
    }
  } else if (!isSupabaseConfigured()) {
    const cats = [...new Set(['arcade', ...byCategory.keys()])].filter((c) => c && c.length <= 40 && c === c.toLowerCase());
    store = createMemoryStore({ categories: cats });
    CONTROL.schema = 'memory';
    CONTROL.reason = 'No database is configured: the control plane is running in memory and nothing is saved.';
    // CONTROL_MEMORY_SEED: a JSON file of settings, proxy destinations and games
    // to start the in-memory control plane with. Honoured ONLY here — with no
    // database configured, where nothing persists — so it can never write to or
    // shadow a real deployment's data. It exists for local development and for
    // the test suite, which must exercise maintenance mode, feature flags and a
    // review queue without a database.
    if (process.env.CONTROL_MEMORY_SEED) {
      try {
        const seed = JSON.parse(readFileSync(String(process.env.CONTROL_MEMORY_SEED), 'utf8'));
        for (const [k, v] of Object.entries(seed.settings || {})) await store.putSetting(k, v, 'seed');
        for (const t of seed.targets || []) await store.insertTarget({ ...t, created_by: 'seed' });
        for (const g of seed.games || []) await store.insertGame({ ...g, created_by: 'seed', updated_by: 'seed' });
        console.log(`[control] memory seed loaded from ${process.env.CONTROL_MEMORY_SEED}`);
      } catch (e) { console.warn('[control] CONTROL_MEMORY_SEED ignored:', e.message); }
    }
  } else {
    CONTROL.schema = 'no-admin-key';
    CONTROL.reason = 'Only the publishable Supabase key is configured; the control plane needs the secret key.';
  }
  CONTROL.store = store;
  CONTROL.settings = createSettingsService({ store, audit: controlAudit, onChange: onSettingChanged });
  await CONTROL.settings.load();
  applyAdSettings();
  if (store) {
    CONTROL.cms = createCmsService({
      store, audit: controlAudit,
      countsByCategory: () => Object.fromEntries([...byCategory].map(([k, v]) => [k, v.length])),
      onChange: (kind) => {
        if (kind === 'provider') CONTROL.providers = CONTROL.cms.providers;
        scheduleCatalogRefresh();
      },
    });
    try { CONTROL.providers = await CONTROL.cms.refreshProviders(); }
    catch (e) { console.warn('[control] providers could not be read — using the built-in registry:', e.message); }
    CONTROL.staff = createStaffService({ store, hashPassword: adminAuth.hashPassword, verifyPassword: adminAuth.verifyPassword, audit: controlAudit });
  }
  CONTROL.proxy = createProxyService({ store, governor: PROXY_GOVERNOR, sessions: PROXY_SESSIONS, audit: controlAudit, onPolicy: applyProxyPolicy });
  await CONTROL.proxy.load();
  for (const p of [...(CONTROL.settings.status().problems || []), ...(CONTROL.proxy.status().problems || [])]) console.warn(`[control] ${p}`);
  console.log(`[control] ${CONTROL.schema}${CONTROL.reason ? ` — ${CONTROL.reason}` : ''}`);
  // A migration applied later is picked up without a restart.
  if (['missing', 'unreachable'].includes(CONTROL.schema) && !_controlRetry) {
    _controlRetry = setTimeout(() => { _controlRetry = null; initControlPlane().catch(() => {}); }, 5 * 60_000);
    _controlRetry.unref?.();
  }
}

const ADMIN_API = mountAdminApi(app, {
  requirePerm, requireAdminCsrf, actorOf, isRecentAuth,
  limiter: {
    allow: (scope, key) => { const ok = LIMITS.allow(scope, key, { rawKey: true }); if (!ok) ADMIN_429++; return ok; },
    retryAfterSec: (scope, key) => LIMITS.retryAfterSec(scope, key, { rawKey: true }),
  },
  services: { cms: () => CONTROL.cms, staff: () => CONTROL.staff, settings: () => CONTROL.settings, proxy: () => CONTROL.proxy },
  unavailableReason: () => CONTROL.reason || 'The control plane is not ready.',
  auditDenied: (req, perm, reason) => auditAction(req, 'rbac.denied', perm, 'denied', { role: rbac.roleForPrincipal(req.admin), via: req.admin?.via, reason }),
  status: controlStatus,
  gdImport: { start: startGdImport, status: gdImportStatus },
  proxyOverview: () => proxyControlOverview(),
  log: (...a) => console.warn(...a),
});

const ADMIN_ASSETS = {
  'admin.css':         { file: 'admin.css',         type: 'text/css; charset=utf-8',        public: true },
  'admin-login.js':    { file: 'admin-login.js',    type: 'text/javascript; charset=utf-8', public: true },
  'admin.js':          { file: 'admin.js',          type: 'text/javascript; charset=utf-8', public: false },
  'admin-control.js':  { file: 'admin-control.js',  type: 'text/javascript; charset=utf-8', public: false },
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
  if (req.admin) return res.sendFile(join(ADMIN_DIR, 'admin-dashboard.html'));

  // Misconfigured credentials used to fall back to a legacy console that was
  // served, fully working, to ANY anonymous visitor — its markup named the
  // `x-admin-secret` header and the endpoints behind it, and the only thing
  // between a stranger and the data was one shared static token with no
  // throttle. A probe walked 25 wrong guesses through it without a single 429.
  //
  // There is no fallback console now. Bad configuration means a setup notice
  // with no form, no endpoint names and no session — never a weaker way in.
  if (!adminAuth.adminConfigStatus().ok) {
    return res.status(503).type('html').send(ADMIN_SETUP_HTML);
  }
  return res.redirect(302, '/admin/login');
});

// Anything else under /admin is not a thing. Explicit 404 rather than falling
// through to the catch-all, so no future static mount can pick it up.
app.use('/admin', (req, res) => {
  res.status(404).type('text').send('not found');
});

// ========================================================================
// Live presence — total visitors + per-game player counts
// ------------------------------------------------------------------------
// Honest, ZoFHub-only counts. No simulation. A session is any tab that has
// beaten in the last PRESENCE_TTL_MS; the client beats every ~2s and the beat
// RESPONSE carries a fresh snapshot, which is the whole live-update path (see
// public/js/presence.js). A normal tab-close drops out at once via the leave
// beacon; the TTL is the backstop for a crash or a dropped network.
//
// The traffic model — per-session, per-address and sessions-per-address — is
// declared with the other budgets near the top of this file and explained in
// lib/presence-store.mjs. It is sized so a school or library NAT, hundreds of
// real devices on one address, is served rather than throttled.
//
// REMOVED: GET /api/presence/stream (Server-Sent Events). The bundled client
// stopped using it long ago — per-tab SSE starved the browser's connection
// pool — and it had no limit of its own, so any client could hold an unbounded
// number of connections open against this process. Nothing called it.
// ========================================================================
const PRESENCE_SWEEP_MS = 1_500;

const presenceStore = createPresenceStore({
  ttlMs: PRESENCE_TTL_MS,
  maxSessions: PRESENCE_MAX_SESSIONS,
  maxSessionsPerKey: PRESENCE_MAX_SESSIONS_PER_IP,
  // Only real catalog slugs are counted: the snapshot is sent to every
  // visitor, so an arbitrary client-supplied key must not be able to appear in it.
  isKnownSlug: (slug) => bySlug.has(slug),
});

/** The public snapshot { total, games, t }; also records the peak for the console. */
function presenceSnapshot() {
  const snap = presenceStore.snapshot();
  usage.notePeakConcurrent(snap.total);
  return snap;
}

setInterval(() => presenceStore.sweep(), PRESENCE_SWEEP_MS).unref();

/**
 * The key an address is counted under for the sessions-per-address cap: a
 * keyed HMAC when a secret is configured, so no raw address sits in the map.
 */
const presenceOwner = (ip) => adminAuth.hashIp(clientKeyOf(ip)) || `raw:${clientKeyOf(ip)}`;

app.post('/api/presence/beat', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Coarse per-address flood limit first — sized for a whole NAT.
  if (!writeAllow('presenceIp', req.ip)) {
    res.setHeader('Retry-After', String(LIMITS.retryAfterSec('presenceIp', req.ip)));
    return res.status(429).json({ ok: false, error: 'Too many requests — slow down.' });
  }
  const { sessionId, slug, action } = req.body || {};
  // Then the precise per-tab limit, keyed on the tab's own random id.
  if (typeof sessionId === 'string' && sessionId && !LIMITS.allow('presenceSession', sessionId, { rawKey: true })) {
    return res.status(429).json({ ok: false, error: 'Too many requests — slow down.' });
  }
  // Count the visitor behind this beat, as a hashed membership test only.
  usage.noteVisitor(adminAuth.hashIp(req.ip));

  if (action === 'leave') presenceStore.leave(sessionId);
  else presenceStore.beat(sessionId, slug, presenceOwner(req.ip));
  usage.notePeakConcurrent(presenceStore.snapshot().total);
  // Pre-serialised: the snapshot is shared by every caller within its window,
  // so it is stringified once rather than once per beat.
  res.type('application/json').send(presenceStore.snapshotJson());
});

// sendBeacon on page-hide hits this. The beacon's Blob type is application/json,
// so the GLOBAL express.json() has usually ALREADY parsed req.body into an object
// by the time we get here — the express.text() below then no-ops. So accept BOTH:
// an already-parsed object OR a raw string.
app.post('/api/presence/leave', express.text({ type: '*/*', limit: '4kb' }), (req, res) => {
  // Same per-address budget as /beat. 204 (not 429) on trip: this is a
  // fire-and-forget beacon the client never reads, and the session still
  // expires via the TTL.
  if (!writeAllow('presenceIp', req.ip)) return res.status(204).end();
  let sessionId;
  const b = req.body;
  if (b && typeof b === 'object') sessionId = b.sessionId;
  else { try { sessionId = JSON.parse(b || '{}').sessionId; } catch {} }
  presenceStore.leave(sessionId);
  res.status(204).end();
});

app.get('/api/presence', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  presenceSnapshot();
  res.type('application/json').send(presenceStore.snapshotJson());
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
    const cat = typeof req.query.category === 'string' && req.query.category
      ? canonCategory(req.query.category.toLowerCase())
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
  // Bounded and non-negative: a negative offset made slice() count from the END
  // of the list, and a negative limit was passed straight through.
  const limit  = Math.min(Math.max(1, parseInt(req.query.limit) || 200), 1000);
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  // Canonicalized for the same reason as /category/:catSlug — an alias spelling
  // would otherwise compare against already-canonical stored values and return [].
  // STRINGS ONLY. The query parser turns `?q[]=a` or `?q[x]=a` into an array or
  // object, and `.toLowerCase()` on either threw — a 500 on demand from any
  // URL. A non-string parameter is treated as absent.
  const cat    = typeof req.query.category === 'string' && req.query.category
    ? canonCategory(req.query.category.toLowerCase()) : null;
  const q      = (typeof req.query.q === 'string' ? req.query.q : '').toLowerCase().slice(0, 100);
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
    // req.ip, NOT the leftmost X-Forwarded-For entry. `trust proxy` is on, so
    // req.ip is the address the trusted hop vouched for; the leftmost XFF entry
    // is whatever the CLIENT wrote. Reading the header directly let a bot defeat
    // this limit entirely by varying one header per request, while the other 17
    // call sites already used req.ip. Same value, minus the bypass.
    const ip = String(req.ip || req.socket?.remoteAddress || '');
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
// POST /api/telemetry/failure — "this game did not render for me".
// ------------------------------------------------------------------------
// The quality signal the server cannot produce by itself. A game that paints a
// black screen only on iOS Safari passes the link-check (the URL returns 200)
// AND passes render-verification (it framed fine in headless Chromium). Only a
// real browser failing to render it knows, so the browser has to say so.
//
// WHAT IS RECORDED: one increment on `slug|browser|platform|kind`. That is all.
// The browser family and platform are derived HERE from the User-Agent header
// we already received, then the raw UA is dropped — the client does not get to
// send them, so it cannot invent values, and no UA string is ever stored. The
// failure kind must be one of five known values or the report is dropped: that
// is what keeps free text structurally unable to become a row.
//
// NOT recorded: ip, any hash of an ip, a session, a visitor id, a timestamp per
// event, or the order reports arrived in. Two people hitting the same bug are
// indistinguishable because they bump the same counter.
//
// Always 204. This is a beacon the client never reads, and a telemetry blip must
// never turn into a visible error on a page that is already failing.
// ========================================================================
app.post('/api/telemetry/failure', express.json({ limit: '1kb' }), (req, res) => {
  try {
    if (!TELEMETRY_ENABLED) return res.status(204).end();
    if (!writeAllow('telemetry', req.ip)) return res.status(204).end();
    const r = buildFailureReport(
      { slug: req.body?.slug, kind: req.body?.kind, ua: req.headers['user-agent'] },
      (s) => bySlug.has(s),           // an unknown slug is refused, so this
    );                                // endpoint cannot be used to grow the table
    if (!r) return res.status(204).end();
    failureCounts.set(r.key, (failureCounts.get(r.key) || 0) + 1);
    failuresDirty.set(r.key, (failuresDirty.get(r.key) || 0) + 1);
  } catch { /* a counter must never fail a request */ }
  return res.status(204).end();
});

// ========================================================================
// POST /api/telemetry/vitals — bucketed Core Web Vitals.
// ------------------------------------------------------------------------
// Sampled in the browser (see public/js/telemetry.js), and reduced to a bucket
// BEFORE it is stored: an exact LCP of 2473.84ms is a far stronger identifier
// than the good/needs-improvement/poor verdict anybody acts on. The path becomes
// a page CLASS, so no URL and no query string (which here can carry a search
// term) reaches storage.
//
// The whole table is capped at 180 rows by construction — 5 metrics x 3 buckets
// x 6 routes x 2 platforms — for the entire site, forever.
//
// Accepts a small BATCH, because one page load legitimately produces several
// metrics and five separate beacons would be five rate-limit tokens.
// ========================================================================
app.post('/api/telemetry/vitals', express.json({ limit: '2kb' }), (req, res) => {
  try {
    if (!TELEMETRY_ENABLED) return res.status(204).end();
    if (!writeAllow('telemetry', req.ip)) return res.status(204).end();
    const path = req.body?.path;
    const ua = req.headers['user-agent'];
    const list = Array.isArray(req.body?.metrics) ? req.body.metrics.slice(0, 8) : [];
    for (const m of list) {
      const r = buildVitalReport({ metric: m?.name, value: m?.value, path, ua });
      if (!r) continue;               // one bad entry never discards the batch
      vitalCounts.set(r.key, (vitalCounts.get(r.key) || 0) + 1);
      vitalsDirty.set(r.key, (vitalsDirty.get(r.key) || 0) + 1);
    }
  } catch { /* never fail a request over a metric */ }
  return res.status(204).end();
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
    // req.ip, NOT the leftmost X-Forwarded-For entry. `trust proxy` is on, so
    // req.ip is the address the trusted hop vouched for; the leftmost XFF entry
    // is whatever the CLIENT wrote. Reading the header directly let a bot defeat
    // this limit entirely by varying one header per request, while the other 17
    // call sites already used req.ip. Same value, minus the bypass.
    const ip = String(req.ip || req.socket?.remoteAddress || '');
    // Cheap endpoint, but it reads the whole catalog on the fallback path, so
    // it still gets a bucket. Generous limit: a normal page load makes one call.
    if (!writeAllow('forYou', ip)) {
      return res.status(429).json({ games: [], error: 'rate-limited' });
    }

    const clean = (arr) => (Array.isArray(arr) ? arr : [])
      .map(s => String(s || '').toLowerCase().slice(0, 80))
      .filter(Boolean)
      .slice(0, FOR_YOU_MAX_SEEDS);

    const history   = clean(req.body?.history);
    const favorites = clean(req.body?.favorites);
    // Games the visitor scrolled past without opening. Purely a ranking signal
    // and never stored — see the privacy note in public/js/signals.js.
    const skips     = clean(req.body?.skips);
    const limit = Math.min(FOR_YOU_MAX_LIMIT,
      Math.max(1, parseInt(req.body?.limit, 10) || 18));

    // The last mood they searched, carried over as a soft preference. Sent as
    // TEXT and re-parsed here rather than trusting a client-supplied target
    // vector: a hand-crafted body could otherwise set arbitrary axis weights,
    // and re-parsing costs microseconds.
    let vibe = null;
    const vibeText = String(req.body?.vibe || '').slice(0, 200);
    if (vibeText && GAME_ATTRS.size) {
      const parsed = parseVibe(vibeText);
      if (Object.keys(parsed.targets).length) vibe = parsed;
    }

    const games = recommendGames({
      history,
      favorites,
      skips,
      vibe,
      attrsOf: GAME_ATTRS.size ? (slug) => GAME_ATTRS.get(slug) : null,
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
      vibeApplied: Boolean(vibe),
    });
  } catch (e) {
    console.warn('[for-you] failed:', e.message);
    return res.json({ games: [], count: 0, error: 'unavailable' });
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

// Result cache for the ATTRIBUTE path. Scoring is a full pass over ~16.8k games
// (~80ms), which is fine for one interactive search and not fine when a class of
// thirty taps the same mood chip at once. Keyed on the normalized query, so the
// quick-mood buttons — by far the most repeated queries — are answered from
// memory. PERSONALIZED responses are never cached: they differ per visitor, and
// caching them would leak one visitor's results to another.
const vibeCache = new Map();               // key -> { at, payload }
const VIBE_CACHE_TTL = 5 * 60 * 1000;
const VIBE_CACHE_MAX = 200;

function vibeCacheGet(key) {
  const hit = vibeCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > VIBE_CACHE_TTL) { vibeCache.delete(key); return null; }
  return hit.payload;
}
function vibeCacheSet(key, payload) {
  if (vibeCache.size >= VIBE_CACHE_MAX) {
    // Oldest-first eviction. Map preserves insertion order, so the first key is
    // the least recently added.
    vibeCache.delete(vibeCache.keys().next().value);
  }
  vibeCache.set(key, { at: Date.now(), payload });
}

const vibeShape = (g) => ({
  slug: g.slug,
  title: g.title,
  thumbnail: thumbUrl(g.thumbnail || g.thumbnail_url || ''),
  category: g.category || 'arcade',
  because: g.because || null,
});

// GET  /api/vibe?q=...        — anonymous, cacheable
// POST /api/vibe {q, history, favorites}
//                             — same ranking, personalized tie-breaks
//
// Both go through the same engine. The POST body is used ONLY to break ties
// among games that already match the vibe (lib/vibe-engine.mjs, blendTaste) and
// to resolve "something like the game I just played". It is never stored.
async function handleVibe(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  const body = req.method === 'POST' ? (req.body || {}) : {};
  const q = String(req.query.q ?? body.q ?? '').trim().slice(0, 200);
  if (!q) return res.json(vibeResponse({ source: 'empty' }));

  const cleanSlugs = (arr) => (Array.isArray(arr) ? arr : [])
    .map(s => String(s || '').toLowerCase().slice(0, 80)).filter(Boolean).slice(0, 40);
  const history = cleanSlugs(body.history);
  const favorites = cleanSlugs(body.favorites);
  const personalized = history.length > 0 || favorites.length > 0;

  const cacheKey = q.toLowerCase().replace(/\s+/g, ' ');
  if (!personalized) {
    const hit = vibeCacheGet(cacheKey);
    // Re-normalised rather than spread: a payload cached by an older build of
    // this file predates the contract and would otherwise be served as-is.
    if (hit) return res.json(vibeResponse({ ...hit, cached: true }));
  }

  const intent = parseVibe(q);

  // The attribute path needs the Python artifact. Without it, fall through to
  // the keyword map exactly as before — this is the only reason the old code
  // below still exists, and it is a real path on a fresh clone.
  if (GAME_ATTRS.size === 0) {
    const { keywords: local, matched } = vibeKeywords(q);
    let keywords = local, source = 'local-keywords';
    if (!matched) {
      try {
        const ai = await vibeKeywordsFromAI(q, req);
        if (ai.length) { keywords = [...new Set([...ai, ...local])]; source = 'ai'; }
      } catch { /* AI slow/down → built-in mood map carries it */ }
    }
    let games = rankCatalogByKeywords(keywords, 18);
    if (!games.length) games = rankCatalogByKeywords(['arcade', 'puzzle', 'run', 'race', 'ball', 'jump'], 18);
    const payload = vibeResponse({ games, keywords, source });
    if (!personalized) vibeCacheSet(cacheKey, payload);
    return res.json(payload);
  }

  // Ask the AI only when the parser genuinely could not read the request. This
  // used to fire whenever no mood BUCKET matched, which was often; the parser
  // now understands duration, negation and comparatives, so the low-confidence
  // case is rare. Everything else answers with zero network calls.
  let source = 'attributes';
  if (intent.confidence < 0.25 && !intent.wantsReference) {
    try {
      const ai = await vibeKeywordsFromAI(q, req);
      if (ai.length) {
        intent.keywords = [...new Set([...ai, ...intent.keywords])].slice(0, 12);
        source = 'attributes+ai';
      }
    } catch { /* parser result carries it */ }
  }

  // "Something like the game I just played" — seed from the most recent play.
  // Only meaningful with history, so it degrades to a plain vibe search when a
  // visitor asks for it on their first visit.
  const taste = new Map();
  if (intent.wantsReference && history.length) {
    taste.set(history[0], 1.0);
    // Adopt the reference game's own profile as the request, unless the
    // sentence already said what it wants ("like that but calmer" keeps the
    // explicit clause and only borrows the axes it did not mention).
    const refAttrs = GAME_ATTRS.get(history[0]);
    const refTargets = targetsFromGame(refAttrs);
    if (refTargets) {
      for (const [axis, t] of Object.entries(refTargets)) {
        if (!intent.targets[axis]) intent.targets[axis] = t;
      }
    }
  } else if (personalized) {
    // Recency-decayed, same curve as the feed so the two systems agree about
    // what "recent" means.
    history.forEach((slug, i) => {
      const w = Math.pow(0.85, i);
      if (w >= 0.05) taste.set(slug, (taste.get(slug) || 0) + w);
    });
    for (const slug of favorites) taste.set(slug, (taste.get(slug) || 0) + 1.25);
  }

  // Never re-offer something they just played — the whole point is discovery.
  const exclude = new Set([...history.slice(0, 12), ...favorites]);

  const { games: ranked, matched } = rankByVibe({
    intent,
    pool: () => CATALOG.games,
    attrsOf: (slug) => GAME_ATTRS.get(slug),
    getGame: (slug) => bySlug.get(slug),
    limit: 18,
    playsOf: (slug) => playCounts.get(slug) || 0,
    taste: taste.size ? taste : null,
    neighboursOf: simNeighbours,
    exclude,
  });

  let games = ranked.map(vibeShape);
  // Last-resort floor: never show an empty dialog. A query that matches nothing
  // (a typo, a language we do not parse) still gets a usable shelf.
  if (!games.length) {
    games = rankCatalogByKeywords(['arcade', 'puzzle', 'run', 'race', 'ball', 'jump'], 18);
    source = 'fallback';
  }

  const payload = vibeResponse({
    games,
    keywords: intent.keywords,
    understood: describeIntent(intent),
    source,
    personalized: taste.size > 0,
    candidates: matched,
  });
  if (!personalized) vibeCacheSet(cacheKey, payload);
  return res.json(payload);
}

app.get('/api/vibe', handleVibe);
app.post('/api/vibe', handleVibe);

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
// Every hop goes through lib/safe-fetch.mjs: the destination address is checked
// at connect time and every redirect is re-validated, so a URL from a query
// string, a catalog row or a community submission cannot be bounced to the
// cloud metadata service or to this host's own network. `allowHttp` is for the
// thumbnail path only, whose host is already allowlisted. `denyHost` refuses an
// AI inference endpoint on EVERY hop, so a public URL that redirects to one is
// stopped before the second connection opens (lib/ai-hosts.mjs).
async function fetchAsBrowser(targetUrl, { ua, timeoutMs = 20_000, accept, allowHttp = false, maxBytes } = {}) {
  const upstream = new URL(targetUrl);
  return safeFetch(targetUrl, {
    timeoutMs,
    allowHttp,
    denyHost: isAiProviderHost,
    ...(maxBytes ? { maxBytes } : {}),
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
      <p style="color:#b4abe0;margin:0 0 18px">${lastErr instanceof BlockedDestinationError ? 'This game points somewhere that cannot be loaded.' : 'The game’s server did not respond. Try again in a moment.'}</p>
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
    const r = await fetchAsBrowser(target, {
      ua: UA_POOL[0], timeoutMs: 12_000, accept: 'image/avif,image/webp,image/*,*/*',
      allowHttp: true, maxBytes: THUMB_MAX_BYTES,
    });
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
  // Checked ahead of the CDN allowlist, not instead of it: an image CDN that
  // fetches origins on request (cloudimage is one) would otherwise relay an AI
  // URL carried in its own path. See lib/ai-hosts.mjs.
  if (mentionsAiProvider(target)) {
    return res.status(403).type('text').send('AI providers are not proxied — ZoFHub runs AI in your browser');
  }
  // Never a general-purpose image proxy: only the known game CDNs.
  //
  // This used to 302 to the target for any other host. That made /thumb an
  // OPEN REDIRECT — /thumb?u=https://phishing.example bounced a visitor off
  // this domain to anywhere — and nothing needed it: thumbUrl() only ever
  // rewrites allowlisted hosts to /thumb, so a non-allowlisted ?u= can only
  // come from a hand-crafted link. It is refused instead.
  if (!THUMB_PROXY_HOSTS.test(target.hostname)) return res.status(400).type('text').send('host not allowed');
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
  // This server never fetches an inference endpoint for a caller — not by
  // name, not with a trailing dot, not smuggled inside another URL, and not at
  // the end of a redirect (fetchAsBrowser re-checks every hop). Without this,
  // /asset was a working AI proxy. See lib/ai-hosts.mjs.
  if (mentionsAiProvider(target)) {
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
    // A fixed message: e.message can carry resolver output, internal
    // hostnames or addresses, none of which belong in a response.
    if (!res.headersSent) {
      return e instanceof BlockedDestinationError
        ? res.status(403).type('text').send('blocked destination')
        : res.status(502).type('text').send('asset unavailable');
    }
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
// Server-side memo of verdicts. The CDN header below only helps when a CDN is
// in front; without one, every call was a fresh outbound request, so the route
// turned page views into traffic aimed at publishers. One probe per game per
// ten minutes, shared by every visitor, and a per-address budget on top.
const FRAME_CHECK_TTL_MS = 10 * 60 * 1000;
const FRAME_CHECK_MAX = 5_000;
const frameCheckCache = new Map();          // slug -> { at, body }

app.get('/api/frame-check', async (req, res) => {
  const slug = typeof req.query.slug === 'string' ? req.query.slug : '';
  if (!slug) return res.status(400).json({ embeddable: null, error: 'missing slug' });
  const game = bySlug.get(slug);
  if (!game) return res.status(404).json({ embeddable: null, error: 'not found' });

  const hit = frameCheckCache.get(slug);
  if (hit && Date.now() - hit.at < FRAME_CHECK_TTL_MS) {
    res.setHeader('Cache-Control', 'public, max-age=600');
    return res.json(hit.body);
  }
  if (!writeAllow('frameCheck', req.ip)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(429).json({ embeddable: null, error: 'rate-limited' });
  }

  const remember = (body) => {
    if (frameCheckCache.size >= FRAME_CHECK_MAX) frameCheckCache.clear();
    frameCheckCache.set(slug, { at: Date.now(), body });
    res.setHeader('Cache-Control', 'public, max-age=600');
    return res.json(body);
  };

  try {
    // Through safe-fetch: a catalog row is third-party data, and its URL — or a
    // redirect from it — must not be able to point this server inward.
    const r = await safeFetch(game.embed_url, {
      method: 'HEAD',
      timeoutMs: 4_000,
      headers: {
        'User-Agent': UA_POOL[0],
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Referer': (() => { try { return new URL(game.embed_url).origin + '/'; } catch { return ''; } })()
      }
    });

    if (r.status === 404 || r.status === 410) {
      return remember({ embeddable: false, dead: true, reason: 'not-found', status: r.status });
    }
    const xfo = r.headers.get('x-frame-options') || '';
    const csp = r.headers.get('content-security-policy') || '';
    if (/\b(deny|sameorigin)\b/i.test(xfo)) {
      return remember({ embeddable: false, reason: 'x-frame-options' });
    }
    if (/frame-ancestors\b/i.test(csp) && !/frame-ancestors\s+['"]?\*/i.test(csp)) {
      return remember({ embeddable: false, reason: 'csp-frame-ancestors' });
    }
    return remember({ embeddable: true, status: r.status });
  } catch (e) {
    // Not cached: a timeout is a fact about this moment, not about the game.
    res.setHeader('Cache-Control', 'no-store');
    const error = e instanceof BlockedDestinationError ? 'blocked-destination'
      : e?.name === 'AbortError' ? 'timeout' : 'unreachable';
    return res.json({ embeddable: null, error });
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
  // Every refusal below is decided from the URL alone and opens no connection,
  // so they run BEFORE the rate budget is spent: the budget exists to cap
  // outbound fetches, and a refused URL never makes one.
  const raw = req.query.u;
  if (!raw || typeof raw !== 'string') return res.json({ ok: false, error: 'missing ?u=' });
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
  if (mentionsAiProvider(target)) {
    return res.status(403).json({ ok: false, error: 'AI providers are not fetched by this server' });
  }
  // Rate-limit: this endpoint fetches a caller-supplied URL server-side, so cap
  // it to stop it being used as a fast internal port-scanner / traffic amplifier.
  if (!writeAllow('proxyDiag', req.ip)) {
    return res.status(429).json({ ok: false, error: 'Too many requests — slow down.' });
  }

  const report = { url: target.toString(), checks: {}, ts: new Date().toISOString() };

  // 1) Direct HEAD — does the publisher respond at all?
  try {
    const r = await fetchAsBrowser(target.toString(), { ua: UA_POOL[0], timeoutMs: 5_000 });
    report.checks.direct = { ok: r.ok, status: r.status, contentType: r.headers.get('content-type') || null };
  } catch (e) {
    report.checks.direct = { ok: false, error: e instanceof BlockedDestinationError ? 'blocked-destination' : (e?.name === 'AbortError' ? 'timeout' : 'unreachable') };
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
// Negative cache for the live lookup below. /play/<anything> is public, and
// every miss used to cost one database query — so requesting random slugs was
// a free way to turn page views into Supabase load. A malformed slug never
// reaches the database, and a well-formed miss is remembered for 5 minutes.
const SLUG_MISS_TTL_MS = 5 * 60 * 1000;
const SLUG_MISS_MAX = 5_000;
const slugMisses = new Map();            // slug -> expiresAt
function slugMissCached(slug) {
  const exp = slugMisses.get(slug);
  if (exp === undefined) return false;
  if (exp > Date.now()) return true;
  slugMisses.delete(slug);
  return false;
}
function rememberSlugMiss(slug) {
  if (slugMisses.size >= SLUG_MISS_MAX) slugMisses.clear();   // bounded; misses are cheap to relearn
  slugMisses.set(slug, Date.now() + SLUG_MISS_TTL_MS);
}

async function fetchGameBySlug(slug) {
  const supa = getSupabase();
  if (!supa || typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug)) return null;
  if (slugMissCached(slug)) return null;
  const found = await fetchGameBySlugUncached(supa, slug);
  // Only a CONFIRMED miss is cached. `undefined` means the lookup itself
  // failed (network, database) — caching that would hide a real game for five
  // minutes after a blip.
  if (found === null) rememberSlugMiss(slug);
  return found || null;
}

async function fetchGameBySlugUncached(supa, slug) {
  try {
    const { data, error } = await supa
      .from('games_public')
      .select('slug, title, game_url, thumbnail_url, category')
      .eq('slug', slug)
      .limit(1)
      .maybeSingle();
    if (error) return undefined;
    if (!data) return null;
    const game = normalizeRuntimeEntry(data);
    if (!game) return null;
    // Respect serve-layer overrides (licensing removals) on this direct-DB
    // fallback too — otherwise a bookmarked or search-indexed /play/<slug> for a
    // deliberately-hidden game (e.g. HTMLGames' license-blocked titles) would
    // still load it, bypassing the catalog filter.
    const [kept] = applyCatalogOverrides([game], { injectAdds: false });
    if (!kept) return null;
    // Same untrusted-input normalisation setCatalog applies; this path adds a
    // game to bySlug without going through it.
    if (sanitizeCatalogEntry(kept) === null) return null;
    if (kept.slug) bySlug.set(kept.slug, kept);    // warm the cache for next time
    return kept;
  } catch (e) {
    console.warn('[zofhub] fetchGameBySlug failed:', e.message);
    return undefined;
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
  // Hosts that MUST be framed directly rather than through /embed.
  //
  // gamedistribution / gamemonetize: their ad SDK black-screens behind a proxy.
  //
  // onlinegames.io: their Unity WebGL builds fetch .wasm/.data companions with
  // Brotli content-encoding and integrity-sensitive paths relative to the game
  // document. Routing them through /embed rewrites those URLs and the Unity
  // loader dies with "couldn't load the content" and a JavaScript error — the
  // black-screen that got the whole host blocked in July. They do not need the
  // proxy at all: probed 10/10 returning HTTP 200 with no X-Frame-Options and no
  // frame-ancestors, so a direct iframe is both simpler and the only one that
  // works.
  const isSdkDirectOnly = /(^|\.)(gamedistribution\.com|gamemonetize\.(com|co)|onlinegames\.io)$/.test(embedHost);
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
  // Per-game SEO payload (unique description, meta, canonical, JSON-LD). Built
  // from this game's own verified metadata and memoised per origin on the cached
  // game object, so a crawler or visitor hitting the page never recomputes it and
  // never triggers AI or database work — it is pure string generation.
  const seoOrigin = requestOrigin(req);
  const seoCache = (game._seo ||= new Map());
  let seo = seoCache.get(seoOrigin);
  if (!seo) { seo = seoPayload(game, { origin: seoOrigin, image: ogImage }); seoCache.set(seoOrigin, seo); }
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
    // SEO: pre-escaped by lib/game-seo.mjs, so JSON_LD and GAME_ABOUT are
    // injected via function replacements (no htmlEscape — that would double-encode
    // intended markup — and a function replacement so a `$` in a tag can't be read
    // as a replacement pattern).
    .replace(/\{\{SEO_TITLE\}\}/g,        () => htmlEscape(seo.seoTitle))
    .replace(/\{\{META_DESCRIPTION\}\}/g, () => htmlEscape(seo.metaDescription))
    .replace(/\{\{CANONICAL_URL\}\}/g,    () => htmlEscape(seo.canonical))
    .replace(/\{\{JSON_LD\}\}/g,          () => seo.jsonLd)
    .replace(/\{\{GAME_ABOUT\}\}/g,       () => seo.descriptionHtml)
    .replace(/\{\{DIRECT_ONLY\}\}/g,  isSdkDirectOnly ? 'true' : 'false')
    // Whether ANY region has a pre-roll configured — deliberately not this
    // visitor's region, so the page stays identical for every visitor. When it
    // is false, game-page.js binds the frame immediately and never waits on
    // /api/site-config; when true, that response says whether THIS visitor
    // actually gets one. Bare JS boolean, like DIRECT_ONLY.
    .replace(/\{\{HAS_PREROLL\}\}/g,  prerollConfigured() ? 'true' : 'false');
  res.set('Cache-Control', 'no-cache').send(html);
});

// ========================================================================
// /ads.txt — IAB authorized-digital-sellers declaration.
// ZoFHub is a proxy site and uses NO Google AdSense. It monetizes via the six
// proxy-friendly networks in lib/ad-providers.mjs. Most of those
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
  // NB: no /leaderboard. It was listed here after the leaderboard was retired,
  // so every sitemap this server generated advertised a URL that 404s — which
  // Search Console reports as a crawl error against the whole sitemap. Only add
  // a path here that has a route above.
  add('/community', '0.5', 'weekly');
  add('/donate', '0.3', 'monthly');
  add('/leaderboard', '0.4', 'daily');
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

app.get('/',         (req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));
app.get('/ai',       (req, res) => res.sendFile(join(PUBLIC_DIR, 'ai.html')));
app.get('/browser',  (req, res) => res.sendFile(join(PUBLIC_DIR, 'browser.html')));
// GUST's `/gust` and `/proxy` routes moved to proxy-engine/mount.mjs along with
// the bundle itself. They are registered there, at the same URLs, so no client
// changed — this file simply no longer serves any AGPL asset.
app.get('/community',(req, res) => res.sendFile(join(PUBLIC_DIR, 'community.html')));

// Donations. The dialog (donate.js) is the fast path from any page; this is the
// real, linkable, JS-optional page behind it. Both read the SAME /api/donate
// response, so there is exactly one source for a wallet address.
app.get('/donate',   (req, res) => res.sendFile(join(PUBLIC_DIR, 'donate.html')));

// Leaderboard. ?game=<slug> narrows it to one game; the page reads /api/scores
// and renders "not installed", "empty" and "failed" as three different things.
app.get('/leaderboard', (req, res) => res.sendFile(join(PUBLIC_DIR, 'leaderboard.html')));

// ========================================================================
// GameFlare — catalog + internal player.
//
// Deliberately NOT routed through /play/:slug. That route sends Y8, HTMLGames
// and Famobi through the embed proxy (see injectGdReferrer and the isY8 branch
// below it), and the supplied dataset's embedding policy forbids proxying,
// mirroring or modifying a GameFlare embed. Reusing it would break that rule
// silently the moment PROXY_ENABLED is on, so GameFlare gets its own player
// whose iframe src is the exact embed_url and nothing else.
//
// Both routes serve static HTML; the data arrives from /api/gameflare/games.
app.get('/gameflare', (req, res) => res.sendFile(join(PUBLIC_DIR, 'gameflare.html')));
app.get('/gameflare/play/:slug', (req, res) => res.sendFile(join(PUBLIC_DIR, 'gameflare-play.html')));

// The public payload. Only eligible games ever appear here, so the client
// cannot render an unverified candidate even if it tried — the data is simply
// not in the response.
app.get('/api/gameflare/games', (req, res) => {
  if (!GAMEFLARE.ok) {
    return res.status(503).json({
      ok: false,
      error: 'catalog_unavailable',
      // Public-facing text: no parser internals, no file paths, no evidence.
      message: 'The game catalog is temporarily unavailable.',
      games: [], categories: [],
    });
  }
  const games = filterGameflare(GAMEFLARE.games, {
    q: typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '',
    category: typeof req.query.category === 'string' ? req.query.category.slice(0, 60) : '',
    developer: typeof req.query.developer === 'string' ? req.query.developer.slice(0, 60) : '',
    sort: typeof req.query.sort === 'string' ? req.query.sort : 'rank',
  });
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    ok: true,
    dataset: GAMEFLARE.dataset,
    total: GAMEFLARE.games.length,
    count: games.length,
    categories: gameflareCategories(GAMEFLARE.games),
    games,
  });
});

// One game, for the internal player. 404 rather than a redirect: an ineligible
// or unknown slug must land on a first-party state, never on gameflare.com.
app.get('/api/gameflare/games/:slug', (req, res) => {
  if (!GAMEFLARE.ok) {
    return res.status(503).json({ ok: false, error: 'catalog_unavailable',
      message: 'The game catalog is temporarily unavailable.' });
  }
  const game = findGameflareBySlug(GAMEFLARE.games, req.params.slug);
  if (game) {
    res.set('Cache-Control', 'public, max-age=300');
    return res.json({ ok: true, game });
  }

  // Verification preview. The browser worker needs the REAL player route to load
  // a candidate that is not yet verified — testing a bespoke harness page would
  // verify the harness, not the product (spec §12). This is the narrowest way to
  // allow that: same route, same script, same iframe, same CSS, and a candidate
  // is reachable only with the operator's token. Never cached, and flagged in
  // the payload so the player can label itself.
  if (gameflareVerifyAllowed(req)) {
    const candidate = findGameflareBySlug(GAMEFLARE_CANDIDATES, req.params.slug);
    if (candidate) {
      res.set('Cache-Control', 'private, no-store');
      return res.json({ ok: true, game: candidate, preview: true });
    }
  }

  return res.status(404).json({ ok: false, error: 'not_found',
    message: 'This game is not available.' });
});

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

// Read ONCE at boot. The file cannot change while the process runs, and a
// synchronous read inside a handler stalls the event loop for every concurrent
// request, not only the one asking for the licence text.
const ANURA_MODIFICATION_SOURCE = (() => {
  try { return readFileSync(join(__dirname, 'lib', 'anura-host.mjs'), 'utf8'); }
  catch (e) { return `(could not read lib/anura-host.mjs: ${e.message})`; }
})();

// ── AGPL §5 + §13 for AnuraOS ──────────────────────────────────────────────
// GUST's change notice can point at /gust/index.html because the modification
// lives in a file ZoFHub serves. AnuraOS's does not: its one change is applied
// at serve time by lib/anura-host.mjs, to a file that lives on a DIFFERENT
// origin. So the Corresponding Source for that change is published here,
// literally — the function that makes it, not a description of it.
//
// Registered before /licenses/:id so the id route cannot swallow it.
app.get('/licenses/anura-modifications', (req, res) => {
  const source = ANURA_MODIFICATION_SOURCE;
  res.type('text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(
    'AnuraOS — AGPL-3.0 change notice (GNU AGPL v3 section 5)\n'
    + '=========================================================\n\n'
    + 'Upstream:  https://github.com/MercuryWorkshop/anuraOS\n'
    + 'Obtained:  the pinned release archive, by tools/fetch-anura.mjs.\n'
    + '           Its sha256 is recorded in data/anura-release.json.\n\n'
    + 'THE CHANGE\n'
    + '----------\n'
    + 'Exactly one file is not served as published: /config.json. A "wisp-url"\n'
    + 'key is added to its defaultsettings object, naming this deployment\'s own\n'
    + 'same-origin /wisp/ tunnel.\n\n'
    + 'Upstream ships no wisp-url, so lib/Anura.js builds its Networking with an\n'
    + 'undefined server and the browser has no working tunnel. Supplying it here\n'
    + 'also keeps proxy traffic on this deployment rather than a third-party\n'
    + 'relay, and it is derived from the incoming request so it stays correct if\n'
    + 'this site is redeployed on another domain.\n\n'
    + 'Every other file in the bundle is served byte-for-byte as published.\n\n'
    + 'THE SOURCE THAT MAKES THE CHANGE (lib/anura-host.mjs)\n'
    + '-----------------------------------------------------\n\n'
    + source,
  );
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
  // Also into the bounded in-memory buffer the admin console reads. The message
  // is redacted on the way in — an error message is the most common place a
  // credential leaks, and this one ends up as JSON in a browser.
  errorLog.record(err, { where: `${req.method} ${req.path}`, status });
  // Headers may already be sent (e.g. a stream that failed mid-flight); writing
  // again would throw ERR_HTTP_HEADERS_SENT inside the error handler itself.
  if (res.headersSent) { try { res.end(); } catch {} return; }
  res.status(status).json({ error: 'Something went wrong. Please try again.' });
});

// ========================================================================
// HTTP + WebSocket
// ========================================================================
httpServer.on('request', app);

// ── Wisp tunnel lifecycle ──────────────────────────────────────────────────
// An upgraded socket leaves Express entirely: no route, no res.end(), none of
// the timeouts that reclaim an ordinary request. It lives until somebody closes
// it — and the somebody is usually a browser tab that was closed on a laptop
// that went to sleep, which sends no FIN at all. Those sockets are invisible
// and permanent, and each one pins its Wisp stream buffers.
//
// Three mechanisms, each covering what the others cannot:
//
//   TCP KEEPALIVE reclaims sockets whose peer is GONE (sleeping laptop, dropped
//   Wi-Fi, killed tab). This is the one that matters, because it distinguishes
//   "dead" from "quiet" at the OS level — a long-lived tunnel with no traffic is
//   perfectly healthy and must not be killed for being idle.
//
//   AN IDLE TIMEOUT reclaims sockets that are merely silent for far longer than
//   any live session plausibly is. Ten minutes of literally zero bytes on a
//   proxy tunnel is an abandoned tab, not a patient user.
//
//   A CONCURRENCY CAP keeps a burst from becoming an OOM. Refusing the 513th
//   tunnel costs one visitor a retry; accepting it can cost every visitor the
//   process.
let WISP_IDLE_MS = 10 * 60 * 1000;     // no bytes either way for this long → reclaim (policy: idleMinutes)
const WISP_KEEPALIVE_MS = 30 * 1000;   // probe a silent peer this often
let WISP_MAX_TUNNELS = 512;            // hard ceiling on concurrent upgrades (policy: maxTunnels)
const wispSockets = new Set();

// ── Per-client fairness cap ──────────────────────────────────────────────
// The global cap above stops the process being OOM-killed, but it does nothing
// about FAIRNESS: one client — a runaway tab reconnecting in a loop, a script,
// a leak on the visitor's own end — can open hundreds of tunnels and consume
// the whole pool, so the 512th refusal lands on an innocent bystander while the
// offender holds 500 sockets. That is the "single-user stream leak crashes the
// core" case. This bounds any one client to a slice of the pool.
//
// The key is the client address, resolved exactly as req.ip is (see
// wispClientKey below). This proxy is anonymous — there is no per-user token
// to key on. It is a coarse key (a shared NAT counts as one client), which is
// why the per-IP cap is generous relative to the global one: it exists to stop
// a single runaway, not to ration normal use.
// WISP_MAX_PER_IP in the environment is a ceiling; the console's policy
// (maxPerClient) can only lower it (applyProxyPolicy).
const WISP_ENV_MAX_PER_IP = (() => {
  const raw = Number(process.env.WISP_MAX_PER_IP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
})();
let WISP_MAX_PER_IP = WISP_ENV_MAX_PER_IP || 32;
const wispPerIp = new Map();           // ipKey -> live tunnel count

// The raw upgrade `req` is not an Express req, so req.ip is unavailable here.
//
// This used to take the LEFT-MOST X-Forwarded-For entry, which is text the
// client writes: a runaway or hostile client could present a new "address"
// on every upgrade and never hit the per-client cap at all. It now resolves the
// address with Express's own compiled trust function (lib/trust-proxy.mjs), so
// the upgrade path believes exactly the hops req.ip believes — and IPv6 is
// keyed on its /64, like every other budget.
function wispClientKey(req, socket) {
  return clientKeyOf(resolveClientIp(req, socket, TRUST_PROXY_FN));
}

// Telemetry for the admin console. Cheap by construction: `opened`, `closed`
// and `rejected` are three integers, and the byte totals come from
// socket.bytesRead / bytesWritten, which Node already maintains for every
// socket — nothing here wraps a stream or copies a buffer, so measuring the
// tunnel costs the tunnel nothing.
//
// Totals are accumulated ON CLOSE, because a socket's counters are only final
// once it ends. Live traffic is summed across the open set at read time, so
// `bytesIn` in the API is (settled + in-flight) rather than a figure that jumps
// when a long download finally finishes.
// `rejected` = refused at the global cap; `rejectedPerIp` = refused at the
// per-client cap. Separated because they mean different things: the first says
// "raise capacity", the second says "one client is misbehaving" — and a
// dashboard that adds them together can never tell an operator which.
const wispStats = { opened: 0, closed: 0, rejected: 0, rejectedPerIp: 0, peak: 0, bytesIn: 0, bytesOut: 0 };

/** A point-in-time view of the tunnel layer, for /api/admin/proxy. */
function wispSnapshot() {
  let liveIn = 0, liveOut = 0;
  for (const sock of wispSockets) {
    liveIn += sock.bytesRead || 0;
    liveOut += sock.bytesWritten || 0;
  }
  // The busiest single client, so a leak shows up as a number an operator can
  // act on rather than being hidden inside the aggregate live count.
  let topClient = 0;
  for (const n of wispPerIp.values()) if (n > topClient) topClient = n;
  return {
    live: wispSockets.size,
    capacity: WISP_MAX_TUNNELS,
    // What an operator actually wants to know: how close to refusing are we?
    saturationPct: Math.round((wispSockets.size / WISP_MAX_TUNNELS) * 1000) / 10,
    peak: wispStats.peak,
    opened: wispStats.opened,
    closed: wispStats.closed,
    // Non-zero means the cap is being hit and visitors are being turned away.
    rejected: wispStats.rejected,
    rejectedPerIp: wispStats.rejectedPerIp,
    perIpCap: WISP_MAX_PER_IP,
    distinctClients: wispPerIp.size,
    topClientTunnels: topClient,
    bytesIn: wispStats.bytesIn + liveIn,
    bytesOut: wispStats.bytesOut + liveOut,
    idleTimeoutMs: WISP_IDLE_MS,
    keepAliveMs: WISP_KEEPALIVE_MS,
  };
}

// The Origin a browser sends on a WebSocket upgrade must be this site. Without
// the check any other website could open tunnels from its visitors' browsers
// through this server. A request with no Origin is not a browser (browsers
// always send one) and is left to the other checks.
const PROXY_EXTRA_ORIGINS = new Set(String(process.env.PROXY_ALLOWED_ORIGINS || '')
  .split(',').map((o) => o.trim().toLowerCase()).filter(Boolean));
function upgradeOriginOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  const own = String(req.headers.host || '').toLowerCase();
  // X-Forwarded-Host is believed only when a proxy in front is trusted at all
  // (TRUST_PROXY); with none, it is text the client wrote.
  const fwd = TRUST_PROXY.value && req.headers['x-forwarded-host']
    ? String(req.headers['x-forwarded-host']).split(',')[0].trim().toLowerCase() : '';
  return host === own || (!!fwd && host === fwd) || PROXY_EXTRA_ORIGINS.has(String(origin).toLowerCase());
}

function refuseUpgrade(socket, status, text) {
  // A real HTTP response, not a bare destroy: a client that gets a status can
  // back off, whereas a silent RST looks like a network fault and is retried
  // immediately and forever.
  try { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
  catch { /* peer already gone */ }
  socket.destroy();
}

/**
 * Every /wisp/ upgrade, from the main listener AND the AnuraOS listener, passes
 * through here. The AnuraOS listener used to route straight into the tunnel,
 * skipping the global cap, the per-client cap and the idle timeout; one handler
 * for both is what makes "the same caps" true.
 */
async function handleProxyUpgrade(req, socket, head) {
  try {
    if (CONTROL.settings?.get('site.maintenance')?.enabled) { PROXY_REFUSALS.maintenance++; return refuseUpgrade(socket, 503, 'Service Unavailable'); }
    if (PROXY_POLICY.accessMode === 'disabled') { PROXY_REFUSALS.disabled++; return refuseUpgrade(socket, 403, 'Forbidden'); }
    if (!upgradeOriginOk(req)) { PROXY_REFUSALS.origin++; return refuseUpgrade(socket, 403, 'Forbidden'); }
    if (wispSockets.size >= WISP_MAX_TUNNELS) { wispStats.rejected++; return refuseUpgrade(socket, 503, 'Service Unavailable'); }

    // Per-client cap. Checked BEFORE routing the upgrade so a runaway client is
    // refused without ever allocating a Wisp stream for it.
    const ipKey = wispClientKey(req, socket);
    if ((wispPerIp.get(ipKey) || 0) >= WISP_MAX_PER_IP) { wispStats.rejectedPerIp++; return refuseUpgrade(socket, 429, 'Too Many Requests'); }

    let staff = false;
    if (PROXY_POLICY.accessMode === 'staff') {
      staff = await staffProxyAllowed(req.headers, resolveClientIp(req, socket, TRUST_PROXY_FN));
      if (!staff) { PROXY_REFUSALS.staffOnly++; return refuseUpgrade(socket, 403, 'Forbidden'); }
      if (socket.destroyed) return;
    }

    // The session record: counts and timestamps only, never destinations. The
    // client tag is a short HMAC so the console can see "one client, many
    // tunnels" without holding an address.
    const clientTag = (adminAuth.hashIp(ipKey) || '').slice(0, 8) || null;
    const sid = PROXY_SESSIONS.open({ clientTag, staff, kill: (reason) => { socket._zhCloseReason = reason; try { socket.destroy(); } catch { /* gone */ } } });

    // Anything that is not exactly `/wisp/` is refused — including the
    // `/wisp/host:port` wsproxy shape, which wisp-js would otherwise serve with
    // a socket class of its own choosing, bypassing every check above.
    if (!routeProxyUpgrade(wisp, req, socket, head, { TCPSocket: guardedSocketClass(sid) })) {
      PROXY_SESSIONS.close(sid, 'bad_request');
      return refuseUpgrade(socket, 400, 'Bad Request');
    }

    wispSockets.add(socket);
    // Charge this tunnel to its client. The key is stored ON the socket so the
    // close handler decrements the SAME bucket even if the header is gone by then.
    socket._wispIpKey = ipKey;
    wispPerIp.set(ipKey, (wispPerIp.get(ipKey) || 0) + 1);
    wispStats.opened++;
    if (wispSockets.size > wispStats.peak) wispStats.peak = wispSockets.size;
    // Interactive proxy traffic is many small frames; Nagle batches them into
    // visible input lag.
    socket.setNoDelay(true);
    socket.setKeepAlive(true, WISP_KEEPALIVE_MS);
    socket.setTimeout(WISP_IDLE_MS);
    // 'timeout' does NOT close the socket on its own — Node only notifies. The
    // destroy has to be explicit, which is exactly the step that gets forgotten.
    socket.on('timeout', () => { socket._zhCloseReason = 'idle_timeout'; try { socket.destroy(); } catch { /* raced */ } });
    // One removal point for every ending: close covers error, timeout-destroy,
    // FIN and RST alike, so neither the Set nor the per-client map nor the
    // session table can outlive the sockets they track.
    socket.once('close', () => {
      wispSockets.delete(socket);
      wispStats.closed++;
      const key = socket._wispIpKey;
      if (key !== undefined) {
        const n = (wispPerIp.get(key) || 0) - 1;
        if (n > 0) wispPerIp.set(key, n);
        else wispPerIp.delete(key);
      }
      wispStats.bytesIn += socket.bytesRead || 0;
      wispStats.bytesOut += socket.bytesWritten || 0;
      PROXY_SESSIONS.close(sid, socket._zhCloseReason || 'closed');
    });
    socket.on('error', () => { /* handled by close; prevents an unhandled throw */ });
  } catch (err) {
    console.error('[zofhub] upgrade error:', err?.message || err);
    try { socket.destroy(); } catch { /* already gone */ }
  }
}

httpServer.on('upgrade', (req, socket, head) => { handleProxyUpgrade(req, socket, head); });

// Session lifetime cap (policy: maxSessionMinutes). Idle sockets are reclaimed
// by the socket timeout above; this catches the long-lived-but-busy tunnel.
// A cleanup sweep over live sockets, not a job scheduler.
setInterval(() => {
  for (const [id, reason] of PROXY_SESSIONS.expired({ maxSessionMs: PROXY_POLICY.maxSessionMinutes * 60_000 })) {
    PROXY_SESSIONS.terminate(id, reason);
  }
}, 30_000).unref();

/** Everything the Proxy Management view shows, in one response. */
function proxyControlOverview() {
  return {
    policy: { ...PROXY_POLICY },
    engines: CONTROL.proxy ? CONTROL.proxy.snapshot().engines : [],
    installed: { ...proxyStatus, anura: !!ANURA.serves },
    status: CONTROL.proxy ? CONTROL.proxy.status() : null,
    decisions: PROXY_GOVERNOR.stats(),
    sessions: PROXY_SESSIONS.stats(),
    refusals: { ...PROXY_REFUSALS },
    tunnels: wispSnapshot(),
    egress: egressReport(),
    ceilings: {
      maxPerClient: WISP_ENV_MAX_PER_IP, streamsPerTunnel: WISP_ENV_STREAM_CAP,
      ports: WISP_POLICY.allowedPorts,
    },
  };
}

// Reclaim the whole tunnel set on shutdown. Without this, an orchestrator's
// SIGTERM waits for the grace period and then SIGKILLs, because every open
// tunnel is a reason for the server not to close — which turns the memory-based
// 503 above into a hard kill instead of the clean restart it exists to enable.
function closeWispTunnels() {
  for (const sock of wispSockets) { try { sock.destroy(); } catch { /* ignore */ } }
  wispSockets.clear();
  wispPerIp.clear();
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    closeWispTunnels();
    // Stop the managed daemon explicitly. node is PID 1 in the container, so a
    // child left running would be orphaned into a zombie rather than reaped.
    // Not awaited — the 5s backstop below bounds the whole shutdown, and the
    // supervisor escalates SIGTERM to SIGKILL on its own timer.
    stopSingbox({ graceMs: 3000 }).catch(() => {});
    // The AnuraOS listener holds the event loop open on its own, so closing
    // only httpServer would leave the process alive until the 5s backstop —
    // turning every graceful stop into a five-second one.
    try { anuraServer?.close(); } catch { /* not listening */ }
    httpServer.close(() => process.exit(0));
    // Backstop: if something still holds the loop open, leave anyway rather
    // than hang until the platform's SIGKILL.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

// Ordinary (non-upgraded) request timeouts. Express sets none of these, so a
// client that opens a connection and sends headers slowly holds a socket
// indefinitely. keepAliveTimeout sits UNDER headersTimeout deliberately: the
// reverse ordering is the documented cause of sporadic 502s behind a load
// balancer, where the balancer reuses a connection the server is closing.
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 70_000;
httpServer.requestTimeout = 120_000;

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
initControlPlane().catch((e) => console.warn('[control] init failed:', e?.message || e));
// The weekly GameDistribution import is registered with the other cron jobs so
// it shares their run history, overlap protection and /healthz reporting.
startCronJobs({ extra: [{ label: 'gd-import', expr: '0 5 * * 0', fn: jobGdImport }] });

// Managed sing-box, if configured. Deliberately NOT awaited: a daemon that is
// slow to validate its config must not delay the web server, and every failure
// inside is already contained (see lib/singbox-supervisor.mjs).
if (singboxManaged()) {
  startSingbox()
    .then((r) => console.log(`[singbox] supervisor: ${r.started ? 'running' : 'not started'} (${r.reason})`))
    .catch((e) => console.warn('[singbox] supervisor failed to start:', e?.message || e));
}
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
// Same cadence for aggregate quality telemetry. Separate call, not folded into
// flushPlayStats, so a failure in one cannot stop the other from persisting.
setInterval(() => { flushTelemetry().catch(() => {}); }, 60 * 1000).unref();
loadTelemetry().catch(() => {});
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
    console.log('  ' + swapStatusLine());
    // The EFFECTIVE egress policy, read back off the live wisp-js options —
    // not the intended one. Those differ exactly when something is wrong.
    console.log('  ' + wispPolicyLine(WISP_POLICY));
    console.log('  ' + masqrStatusLine(MASQR));
    console.log('  ' + geoStatusLine(GEO));
    console.log('  ' + anuraStatusLine());
    // Printed even when unconfigured, so "where did Kasm go?" is answerable
    // from the boot banner instead of by reading source.
    console.log('  ' + kasmStatusLine(KASM));
    printAdminSecurityStatus();
    console.log(`  → client IPs: trust proxy = ${JSON.stringify(TRUST_PROXY.value)} (${TRUST_PROXY.source})`);
    // A baseline already near the health ceiling means the instance will be
    // recycled as soon as traffic arrives, and again after every restart — a
    // loop no in-process logic can break. Say so while it is still a warning.
    {
      const m = memoryReport();
      if (m.pct >= HEALTH_MEM_MAX_PCT * 0.8) {
        console.warn(`  → WARNING: memory is ${m.pct}% of the ${m.ceilingFrom} ceiling (${m.ceilingMb} MB) at startup,`
          + ` close to the ${HEALTH_MEM_MAX_PCT}% health limit. Give the instance more memory or raise HEALTH_MEM_MAX_PCT.`);
      }
    }
    console.log(`  → press Ctrl+C in this terminal to stop the server\n`);
    openInBrowser(url);
  });
}

// ── AnuraOS second listener ────────────────────────────────────────────────
// A different PORT is already a different ORIGIN, so this gives AnuraOS the
// site root it requires without DNS, a second deployment or any rewriting —
// and keeps its root-scoped service worker away from Ultraviolet's and
// Scramjet's. Started before the main listener so the engine is ready the
// moment /browser can ask for it.
//
// FAILING TO BIND IS NOT FATAL. ZoFHub does not need this port; losing it costs
// one optional engine, so it degrades to "no AnuraOS entry" and says why,
// rather than taking the whole site down over a port conflict.
let anuraServer = null;
function anuraStatusLine() {
  switch (ANURA.mode) {
    case 'external': return `→ anura:   external (${ANURA.externalUrl})`;
    case 'host':     return `→ anura:   served on host ${ANURA.host}`;
    case 'port':     return anuraServer
      ? `→ anura:   http://localhost:${ANURA.port} (own origin, same process)`
      : `→ anura:   not listening${ANURA.reason ? ' — ' + ANURA.reason : ''}`;
    case 'disabled': return '→ anura:   disabled';
    default:         return '→ anura:   not installed (npm run fetch-anura)';
  }
}

if (ANURA.mode === 'port') {
  const serveAnura = anuraHandler(undefined, { port: ANURA.port });
  anuraServer = createServer(async (req, res) => {
    if (!(await anuraAllowed(req.headers, req.socket?.remoteAddress))) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('AnuraOS is turned off.');
    }
    serveAnura(req, res);
  });

  // AnuraOS's browser needs a Wisp tunnel, and its config is rewritten to point
  // at /wisp/ on THIS origin (lib/anura-host.mjs). Route that upgrade into the
  // same tunnel the rest of the site uses, so AnuraOS's traffic gets the same
  // sing-box egress, the same SSRF filter and the same caps — rather than a
  // second, unaudited path out of the process.
  // The SAME handler as the main listener: caps, origin check, access mode,
  // approved destinations and session tracking all apply to AnuraOS traffic.
  anuraServer.on('upgrade', (req, socket, head) => { handleProxyUpgrade(req, socket, head); });
  anuraServer.on('error', (e) => {
    ANURA.reason = `${e.code || 'error'} on port ${ANURA.port}`;
    console.warn(`[anura] not listening: ${ANURA.reason}. `
      + 'AnuraOS will not appear in /browser. Set ANURA_PORT to a free port, '
      + 'or ANURA_PORT=0 to stop trying.');
    // Serving nothing must not leave an entry advertising this port.
    ANURA.mode = 'disabled';
    ANURA.serves = false;
    anuraServer = null;
  });
  anuraServer.listen(ANURA.port, HOST === '::' ? '::' : HOST, () => {
    // BINDING IS NOT THE SAME AS BEING REACHABLE. A wildcard bind succeeds even
    // when another process already holds the SPECIFIC address on that port, and
    // the more specific socket then wins — so we would advertise a URL that
    // hangs on somebody else's service. Confirm the thing answering is ours
    // before offering it to anyone.
    const probe = `http://127.0.0.1:${ANURA.port}/`;
    fetch(probe, { signal: AbortSignal.timeout(4000) })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (!/AnuraOS/i.test(await r.text())) throw new Error('another service holds this port');
        ANURA.verified = true;
      })
      .catch((e) => {
        ANURA.reason = `port ${ANURA.port} does not answer as AnuraOS (${e.message})`;
        console.warn(`[anura] ${ANURA.reason}. Not offering it in /browser. `
          + 'Set ANURA_PORT to a free port, or ANURA_PORT=0 to stop trying.');
        ANURA.mode = 'disabled';
        ANURA.serves = false;
        try { anuraServer?.close(); } catch { /* already closing */ }
        anuraServer = null;
      });
  });
}

startListening(HOST);
kickThumbnailFetch();   // grab any missing Y8 thumbnails from the web on every boot
