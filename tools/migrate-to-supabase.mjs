// tools/migrate-to-supabase.mjs
//
// Streaming migration: pumps every game from
//   - everygame.json
//   - master_games.json
//   - somethingrandom.json
//   - data/top_games.json   (curated — highest priority)
//   - api/games.json        (already-built — second highest)
// into the Supabase `games` table created by db/schema.sql.
//
// Design constraints from the spec:
//   - DO NOT use fs.readFileSync / JSON.parse on whole files.
//     Files can be 5-20 MB; on a 512 MB free-tier VM that's tight.
//     We stream with `stream-json` so peak memory stays ~30 MB regardless of file size.
//   - Batch 100 rows per upsert (Supabase free tier handles 100-row upserts
//     comfortably; larger batches risk POST body size limits).
//   - Exponential backoff (5 retries, 1s / 2s / 4s / 8s / 16s).
//   - On unrecoverable per-batch failure: log + skip the batch, keep going.
//   - Dedupe by `slug`. When a slug appears in 2+ sources, the higher-quality
//     entry wins (see qualityScore() below).
//   - IP filter: drop entries whose title matches a registered-trademark pattern.
//
// Run with:
//   $env:SUPABASE_URL = "https://xxx.supabase.co"
//   $env:SUPABASE_SERVICE_ROLE_KEY = "eyJ..."
//   node tools/migrate-to-supabase.mjs
//
// Add `--dry-run` to skip the actual writes (useful to validate counts).

import { createReadStream, existsSync, statSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// stream-json v1 is CommonJS — the named exports live on the default object.
import streamArrayMod from 'stream-json/streamers/StreamArray.js';
import pickMod        from 'stream-json/filters/Pick.js';
import parserMod      from 'stream-json/Parser.js';
import chainMod       from 'stream-chain';
import { createClient } from '@supabase/supabase-js';

const { streamArray } = streamArrayMod;
const { pick }        = pickMod;
const { parser }      = parserMod;
const { chain }       = chainMod;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');
// --curated: migrate ONLY the high-priority, mostly-tested sources
// (top_games.json + api/games.json + ai_gaming_hub_final.json) — ~800 games.
// The bulk-scraped sources (master_games / somethingrandom / everygame) are
// left to the 3-day auto-grow cron, which HEAD-probes each candidate for
// liveness before inserting — so untested games never reach the live site.
const CURATED = process.argv.includes('--curated');
// Spec section 2: multi-row bulk inserts of 1000 rows.
// Supabase JS client over PostgREST handles 1000-row upserts comfortably
// (under the 2 MB POST body limit at ~500 bytes per row average).
const BATCH_SIZE = 1000;
const MAX_RETRIES = 5;

// Errors go to a separate file so a tail -f works during the run.
const LOG_DIR = join(ROOT, 'logs');
const ERR_LOG = join(LOG_DIR, 'migration-errors.log');
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function logErr(label, detail) {
  const line = `${new Date().toISOString()} [${label}] ${detail}\n`;
  try { appendFileSync(ERR_LOG, line); } catch {}
}

// Memory snapshot helper — prints RSS + heap so a regression in
// streaming behavior shows up as RSS growth across batches.
function snapMemory(tag) {
  const m = process.memoryUsage();
  const mb = (n) => (n / 1_048_576).toFixed(1) + 'MB';
  console.log(`[migrate]   mem(${tag}): rss=${mb(m.rss)} heap=${mb(m.heapUsed)}/${mb(m.heapTotal)} ext=${mb(m.external)}`);
}

// ---------------------------------------------------------------------
// env — auto-load .env (or .env.example as a last-resort fallback) so
// `node tools/migrate-to-supabase.mjs` Just Works without requiring the
// user to remember `--env-file=.env`.
// ---------------------------------------------------------------------
for (const f of ['.env', '.env.example']) {
  const p = join(ROOT, f);
  if (existsSync(p) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(p);
      console.log(`[migrate] loaded env from ${f}`);
      if (f === '.env.example') console.warn('[migrate] WARNING: reading .env.example because no .env exists. Copy .env.example → .env for production.');
      break;
    } catch (e) {
      console.warn(`[migrate] failed to load ${f}:`, e.message);
    }
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL
                  || process.env.NEXT_PUBLIC_SUPABASE_URL;
// adminKey() reads SUPABASE_SECRET_KEY *and* the legacy SUPABASE_SERVICE_ROLE_KEY.
// This previously read only the legacy name, while the error message below claimed
// both were accepted — so pasting the new `sb_secret_…` key produced an error that
// pointed away from the actual cause.
const { adminKey } = await import('../lib/supabase-keys.mjs');
const SUPABASE_KEY = adminKey();

// Validate: the service-role key MUST look like a JWT.  A common mistake
// is pasting the project ID (e.g. "qemiyzaimvjrjmgdfsks") instead of the
// actual key.  Catch that here with a clear error.
function looksLikeJWT(s) {
  return typeof s === 'string' && s.startsWith('eyJ') && s.split('.').length === 3 && s.length > 100;
}

if (!DRY_RUN) {
  const errors = [];
  if (!SUPABASE_URL) errors.push('SUPABASE_URL is empty');
  if (!SUPABASE_KEY) errors.push('SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY is empty');
  // A new-style secret key (sb_secret_…) is equally valid and is what Supabase
  // is migrating everyone to — rejecting it as "not a service-role key" would
  // block the very migration we want.
  else if (!looksLikeJWT(SUPABASE_KEY) && !SUPABASE_KEY.startsWith('sb_secret_')) {
    errors.push(`That does not look like a Supabase admin key.\n` +
      `          You set: ${SUPABASE_KEY.slice(0, 30)}${SUPABASE_KEY.length > 30 ? '…' : ''}\n` +
      `          A valid admin key is either:\n` +
      `            - a new secret key starting with "sb_secret_"  (preferred), or\n` +
      `            - a legacy service-role JWT starting with "eyJ" with two dots\n` +
      `          You probably pasted the project ID instead. Get the real key here:\n` +
      `            https://supabase.com/dashboard/project/_/settings/api\n` +
      `          → scroll to "Project API keys" → click "Reveal" on the red "service_role" row.`);
  }

  if (errors.length) {
    console.error('\n[migrate] Cannot start migration:\n');
    for (const e of errors) console.error('  • ' + e);
    console.error('\n  Fix .env in the project root, then re-run:');
    console.error('      node tools/migrate-to-supabase.mjs\n');
    console.error('  Or skip writing and validate the streaming pipeline:');
    console.error('      node tools/migrate-to-supabase.mjs --dry-run\n');
    process.exit(1);
  }
}

const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

// ---------------------------------------------------------------------
// Sources (in priority order — higher = wins dedupe ties)
// ---------------------------------------------------------------------
const ALL_SOURCES = [
  { path: 'data/top_games.json',        priority: 5, shape: 'auto', curated: true  },
  { path: 'api/games.json',             priority: 4, shape: 'auto', curated: true  },
  // finalgames.json — the cleaned master catalog (licensing-blocked hosts already
  // stripped by scripts/strip-finalgames-blocked.mjs). It's the bulk of what the
  // live site serves, so it's a CURATED source: `migrate:curated` pushes the full
  // served catalog (curated + finalgames) into Supabase without the unvetted
  // scrape dumps below. Priority 3 keeps the hand-vetted top_games/api entries
  // winning on any slug collision (they carry richer, override-friendly metadata).
  { path: 'finalgames.json',            priority: 3, shape: 'auto', curated: true  },
  { path: 'somethingrandom.json',       priority: 3, shape: 'auto', curated: false },
  { path: 'master_games.json',          priority: 2, shape: 'auto', curated: false },
  { path: 'everygame.json',             priority: 1, shape: 'auto', curated: false },
  // AI Gaming Hub bundle — games nested under .games key (wrapperKey
  // detection handles this).  Note: most entries will be dropped by
  // the IP filter (Brawl Stars, Minecraft, Subway Surfers, Geometry
  // Dash, Block Blast — all named trademarks of paid IP).
  { path: 'ai_gaming_hub_final.json',   priority: 0, shape: 'auto', curated: true  },
];
// In --curated mode keep only the hand-vetted sources (~800 games).
const SOURCES = CURATED ? ALL_SOURCES.filter(s => s.curated) : ALL_SOURCES;

// ---------------------------------------------------------------------
// IP / trademark blocklist (compact — for the full list see
// tools/cleanup-ip.mjs and run that first on the raw files).
// ---------------------------------------------------------------------
const IP_PATTERNS = [
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
  // Film / streaming / kids-TV / toy / mobile-hit trademarks common in dumps:
  /\bkingdom[\s-]*rush\b/i, /\bplants[\s-]*(vs\.?|versus)[\s-]*zombies\b/i, /\bpvz\b/i,
  /\bflappy[\s-]*bird\b/i, /\bdoodle[\s-]*jump\b/i, /\bbad[\s-]*piggies\b/i,
  /\bhill[\s-]*climb[\s-]*racing\b/i, /\bsubway[\s-]*princess\b/i, /\bdisney\b/i,
  /\bspongebob\b/i, /\bbatman\b/i, /\bspider[\s-]*man\b/i, /\bfrozen\b.*\belsa\b/i, /\belsa\b.*\banna\b/i,
  /\bsquid[\s-]*game\b/i, /\bstranger[\s-]*things\b/i, /\bwednesday[\s-]*addams\b/i,
  /\bbarbie\b/i, /\bhello[\s-]*kitty\b/i, /\bpaw[\s-]*patrol\b/i, /\bpeppa[\s-]*pig\b/i,
  /\bbluey\b/i, /\bnaruto\b/i, /\bone[\s-]*piece\b/i, /\bmarvel\b/i, /\bavengers\b/i,
  /\bharry[\s-]*potter\b/i, /\bstar[\s-]*wars\b/i, /\blego\b/i, /\bhot[\s-]*wheels\b/i, /\bbendy\b/i,
];

// Hosts known to either (a) block iframe embedding via X-Frame-Options,
// (b) serve wrapper/portal HTML instead of the actual game, or (c) ship
// non-HTML proprietary file formats. Dropping these at ingest time
// prevents the "dark screen + spinning forever" UX failure.
const BAD_HOSTS = new Set([
  'duckmath.org',
  'smashkarts.io',
  'bloxd.io',
  // Poki — wrapper portal, blocks framing of game pages
  'poki.com', 'www.poki.com',
  // Total Jerkface — serves .tjf proprietary format, not HTML iframe
  'totaljerkface.com', 'www.totaljerkface.com',
  // CoolMath — does not license third-party iframe embedding
  'coolmathgames.com', 'www.coolmathgames.com',
  // CrazyGames — same; their games require their own portal
  'crazygames.com', 'www.crazygames.com',
  // Y8 — blocks framing
  'y8.com', 'www.y8.com',
  // Misc generic-domain unofficial mirrors that the IP filter doesn't catch
  'sites.google.com',
  'classic.minecraft.net',  // Mojang official but X-Frame-Options blocked
]);

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function looksLikeUrl(u) {
  if (!u || typeof u !== 'string') return false;
  if (!/^https?:\/\//i.test(u)) return false;
  if (/<\s*(script|iframe|div)\b/i.test(u)) return false; // some sources stuff HTML in here
  try { const x = new URL(u); return !!x.host; } catch { return false; }
}

function isIpBlocked(title, url) {
  for (const p of IP_PATTERNS) if (p.test(title)) return true;
  try { if (BAD_HOSTS.has(new URL(url).host.toLowerCase())) return true; } catch {}
  return false;
}

// Synthetic/sequential GameDistribution hashes (AI-generated placeholders).
// They return HTTP 200 from GD but never render a real game — a permanent
// black screen.  tools/clean-fake-gd-hashes.mjs scrubs the source files, but
// we ALSO drop them here so a future source addition can't reintroduce them.
// Pattern: even-position nibbles form one arithmetic progression mod 10
// (digits 0-9), odd-position nibbles form one AP mod 6 (letters a-f only).
const GD_HASH_RE = /html5\.gamedistribution\.com\/([0-9a-f]{32})\//i;
function isFakeGdHash(url) {
  const m = String(url).match(GD_HASH_RE);
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

// Higher = better. Used to resolve dedupe ties.
function qualityScore(entry, sourcePriority) {
  let s = sourcePriority * 10;
  if (entry.thumbnail_url) s += 3;
  if (entry.title && entry.title.length > 4) s += 1;
  if (/(onlinegames\.io|gamemonetize\.com|gamedistribution\.com|htmlgames\.com|crazygames\.com)/i.test(entry.game_url)) s += 2;
  return s;
}

// Normalize one raw entry from any of the source files into the table shape.
// Returns null if the entry is unusable.
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const title = raw.title || raw.name || raw.game_name || raw.Title;
  const game_url = raw.embed_url || raw.embedUrl || raw.embed || raw.url || raw.link
                  || raw.game_url || raw.iframe || raw.iframeUrl || raw.gameUrl;
  const thumbnail_url = raw.thumbnail || raw.thumb || raw.image
                       || raw.thumbnail_url || raw.thumbnailUrl || raw.imageUrl || null;
  const category = (raw.category || raw.genre || raw.cat || 'arcade').toString().toLowerCase().trim();

  if (!title || !looksLikeUrl(game_url)) return null;
  if (thumbnail_url && !/^https?:\/\//i.test(thumbnail_url)) {
    // Keep null instead of a junk value — the public view falls back to placeholder.
    return { title: String(title).trim(), game_url, thumbnail_url: null, category, slug: slugify(title) };
  }
  return { title: String(title).trim(), game_url, thumbnail_url, category, slug: slugify(title) };
}

// ---------------------------------------------------------------------
// Stream a JSON file as a sequence of entries.
// Detects shape: bare array (`[...]`) vs object-wrapping-array (`{"games":[...]}`).
// ---------------------------------------------------------------------
async function* streamEntries(filePath) {
  // Peek the first ~8 KB to figure out the shape — covers cases where the
  // games array is nested under other top-level keys (api/games.json has
  // ~100 lines of category metadata before "games":[...]).
  const head = await new Promise((resolve, reject) => {
    const chunks = [];
    const fh = createReadStream(filePath, { encoding: 'utf8', end: 8192 });
    fh.on('data', c => chunks.push(c));
    fh.on('end',  () => resolve(chunks.join('').trim()));
    fh.on('error', reject);
  });

  const isBareArray = head.startsWith('[');
  // Try common wrapper keys.
  const wrapperKey =
      /"games"\s*:\s*\[/.test(head)    ? 'games'    :
      /"data"\s*:\s*\[/.test(head)     ? 'data'     :
      /"results"\s*:\s*\[/.test(head)  ? 'results'  :
      /"items"\s*:\s*\[/.test(head)    ? 'items'    : null;

  const pipeline = isBareArray
    ? chain([ createReadStream(filePath), parser(), streamArray() ])
    : wrapperKey
        ? chain([ createReadStream(filePath), parser(), pick({ filter: wrapperKey }), streamArray() ])
        : null;

  if (!pipeline) {
    console.warn(`[migrate] ${filePath}: unknown shape, skipping`);
    return;
  }

  for await (const { value } of pipeline) {
    yield value;
  }
}

// ---------------------------------------------------------------------
// Exponential backoff wrapper
// ---------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withBackoff(label, fn) {
  let attempt = 0;
  let lastErr;
  while (attempt < MAX_RETRIES) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const wait = Math.min(16_000, 1000 * Math.pow(2, attempt));
      console.warn(`[migrate] ${label} attempt ${attempt + 1}/${MAX_RETRIES} failed: ${e.message}. Retry in ${wait}ms`);
      logErr(label, `attempt ${attempt + 1}/${MAX_RETRIES}: ${e.message}`);
      await sleep(wait);
      attempt++;
    }
  }
  console.error(`[migrate] ${label} permanently failed after ${MAX_RETRIES} attempts:`, lastErr?.message);
  logErr(label, `PERMANENT FAIL after ${MAX_RETRIES} attempts: ${lastErr?.message || lastErr}`);
  return { error: lastErr };
}

// ---------------------------------------------------------------------
// Upsert a batch with retry. ON CONFLICT (slug) DO UPDATE on the
// server side, plus we already deduped on the client side.
// ---------------------------------------------------------------------
async function flushBatch(rows) {
  if (!rows.length) return;
  if (DRY_RUN) return;
  await withBackoff(`upsert ${rows.length} rows`, async () => {
    const { error } = await supabase
      .from('games')
      .upsert(rows, { onConflict: 'slug', ignoreDuplicates: false });
    if (error) throw new Error(error.message || JSON.stringify(error));
  });
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
async function main() {
  console.log(`[migrate] ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${CURATED ? ' · CURATED (~800, vetted sources only)' : ' · FULL (all sources)'} — batch size ${BATCH_SIZE}, max retries ${MAX_RETRIES}`);

  const winners = new Map(); // slug -> { row, score }
  let totalRead = 0, droppedShape = 0, droppedIp = 0, droppedFake = 0, replaced = 0;

  for (const src of SOURCES) {
    const full = join(ROOT, src.path);
    if (!existsSync(full)) { console.log(`[migrate] skip (missing): ${src.path}`); continue; }
    const sizeMb = (statSync(full).size / 1_048_576).toFixed(2);
    console.log(`[migrate] reading ${src.path} (${sizeMb} MB, priority ${src.priority})`);

    let countThisFile = 0;
    try {
      for await (const raw of streamEntries(full)) {
        totalRead++;
        const norm = normalize(raw);
        if (!norm) { droppedShape++; continue; }
        if (isIpBlocked(norm.title, norm.game_url)) { droppedIp++; continue; }
        if (isFakeGdHash(norm.game_url)) { droppedFake++; continue; }

        const candScore = qualityScore(norm, src.priority);
        const existing = winners.get(norm.slug);
        if (!existing) {
          winners.set(norm.slug, { row: norm, score: candScore });
          countThisFile++;
        } else if (candScore > existing.score) {
          winners.set(norm.slug, { row: norm, score: candScore });
          replaced++;
        }
      }
    } catch (e) {
      console.error(`[migrate] ${src.path} stream error (continuing):`, e.message);
    }
    console.log(`[migrate]   ${src.path}: read OK, ${countThisFile} new winners so far`);
  }

  console.log(`[migrate] consolidated ${winners.size} unique slugs` +
              ` (read ${totalRead}, dropped shape=${droppedShape}, dropped IP=${droppedIp}, dropped fake-hash=${droppedFake}, replaced=${replaced})`);

  if (DRY_RUN) {
    console.log('[migrate] DRY RUN — not writing to Supabase. Done.');
    process.exit(0);
  }

  // Batched upserts
  let buf = [];
  let written = 0, failedBatches = 0, batchN = 0;
  snapMemory('pre-upsert');
  for (const { row } of winners.values()) {
    buf.push(row);
    if (buf.length >= BATCH_SIZE) {
      batchN++;
      const out = await flushBatch(buf);
      if (out?.error) failedBatches++;
      else written += buf.length;
      buf = [];
      // Log every batch + memory every 5 batches (every 5000 rows).
      console.log(`[migrate]   batch ${batchN}: ${written} rows written cumulative`);
      if (batchN % 5 === 0) snapMemory(`after batch ${batchN}`);
    }
  }
  if (buf.length) {
    batchN++;
    const out = await flushBatch(buf);
    if (out?.error) failedBatches++;
    else written += buf.length;
  }

  snapMemory('done');
  console.log(`[migrate] done. wrote=${written}, failed batches=${failedBatches}, total unique=${winners.size}`);
  if (failedBatches) console.log(`[migrate] error details: see ${ERR_LOG}`);
  process.exit(failedBatches > 0 ? 2 : 0);
}

main().catch(e => {
  console.error('[migrate] fatal:', e);
  process.exit(1);
});
