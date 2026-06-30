// lib/y8-ingest.mjs
//
// Ingests Y8's official embed-directory games (from y8-games.json, produced by
// scrape-y8.js or the deeper y8-harvest.js) into the Supabase `games` table so
// they paginate naturally with the rest of the catalog. Driven by:
//   - the weekly cron job  (lib/cron-jobs.mjs → jobY8Sync)
//   - the CLI              (`npm run y8-sync` / `node lib/y8-ingest.mjs`)
//
// Why a dedicated path (not the generic `grow` job): the grow job's
// validateEmbeddable() requires a *trusted host* and y8.com is deliberately
// excluded there (its embed URLs 301-redirect, which the generic probe can't
// reason about). Y8's "Games for your website" directory is its OWN sanctioned
// embed feature, so these are safe to insert as a group — we still apply the
// trademark filter for copyright safety, skip anything that isn't a real y8
// /embed/ URL, and (by default) reachability-validate every candidate so dead /
// pulled games never become broken tiles.
//
// Safety properties:
//   * UPSERT by slug — never inserts a duplicate; re-running is idempotent.
//   * NO-CLOBBER guard — if a slug already exists as a NON-y8 game, skip it so a
//     normalized y8 slug can't overwrite an unrelated catalog entry.
//   * Trademark filter (shared with the cron) drops IP-violating titles.
//   * Self-hosted thumbnail preferred (/public/thumbs/<slug>.webp), else the
//     scraped y8 CDN thumbnail (verified to hotlink).
//   * Previously-hidden y8 rows are folded back in, re-validated, and revived
//     (is_working=false → true) — but only if they actually still load.
//   * Reachability validation (HEAD/GET, follows the y8 301) before upsert.
//   * Never deletes anything.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSupabase } from './supabase.mjs';
import { isTrademarkTitle } from './cron-jobs.mjs';
import { guessCategory } from './categorize.mjs';
import { probe } from './link-checker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const THUMBS_DIR = join(ROOT, 'public', 'thumbs');
const DEFAULT_JSON = join(ROOT, 'y8-games.json');

// Y8's broad directory buckets → our free-form category slugs.
const Y8_CATEGORY = {
  'action & racing':  'racing',
  'cooking & kids':   'casual',
  'girls & dress-up': 'girls',
  'other / casual':   'casual',
  'puzzle & brain':   'puzzle',
  'shooting & arcade':'arcade',
};

// Slugs handled elsewhere: slope-unblocked is a featured catalog-overrides `add`
// (kept out of Supabase so it isn't duplicated on page 1); the bare "slope"
// Famobi dup is removed by catalog-overrides.json.
const SKIP_SLUGS = new Set(['slope', 'slope-unblocked']);

function toSlug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function mapCategory(c) {
  const key = String(c || '').toLowerCase().trim();
  return Y8_CATEGORY[key] || (key && /^[a-z]/.test(key) ? key.split(/[ &/]/)[0] : 'arcade');
}

// Prefer a self-hosted thumbnail (same-origin, fast, reliable); otherwise use
// the scraped y8 CDN URL (verified to hotlink). Null → frontend placeholder.
function resolveThumb(slug, scraped) {
  if (existsSync(join(THUMBS_DIR, `${slug}.webp`))) return `/thumbs/${slug}.webp`;
  if (existsSync(join(THUMBS_DIR, `${slug}.png`)))  return `/thumbs/${slug}.png`;
  const s = (scraped || '').toString().trim();
  return s && /^https:\/\//i.test(s) ? s : null;
}

const wwwize = (u) => String(u || '').replace(/^https?:\/\/y8\.com/i, 'https://www.y8.com');

function readGamesFlat(jsonPath) {
  try {
    const d = JSON.parse(readFileSync(jsonPath, 'utf8'));
    return Array.isArray(d) ? d : (d.gamesFlat || d.games || d.data || []);
  } catch (e) {
    console.warn('[y8-ingest] read failed:', e.message);
    return [];
  }
}

// Curated y8 favorites explicitly listed in catalog-overrides.json `add`. These
// are guaranteed-included (the user picked them) even if they've rotated off the
// directory's first scraped pages or were previously hard-deleted.
function readOverridesY8() {
  try {
    const d = JSON.parse(readFileSync(join(ROOT, 'data', 'catalog-overrides.json'), 'utf8'));
    return (Array.isArray(d.add) ? d.add : [])
      .filter(a => a && a.game_url && /y8\.com\/embed\//i.test(a.game_url))
      .map(a => ({
        name: a.title || a.slug,
        slug: a.slug || (a.game_url.match(/\/embed\/([a-z0-9_]+)/i) || [])[1] || '',
        embedUrl: a.game_url,
        thumbnail: a.thumbnail_url || null,
        category: a.category || 'arcade',
      }));
  } catch { return []; }
}

// Small concurrency pool for reachability validation.
async function validatePool(items, n, keepFn) {
  const queue = items.slice();
  const kept = [];
  const runners = new Array(n).fill(0).map(async () => {
    while (queue.length) {
      const it = queue.shift();
      if (it === undefined) break;
      if (await keepFn(it)) kept.push(it);
    }
  });
  await Promise.all(runners);
  return kept;
}

/**
 * Ingest y8-games.json into Supabase.
 * @returns {Promise<object>} stats
 */
export async function ingestY8({
  jsonPath = DEFAULT_JSON, dryRun = false, reviveExisting = true,
  validate = true, concurrency = 10,
} = {}) {
  const stats = { read: 0, candidates: 0, droppedShape: 0, droppedTrademark: 0, skippedSlope: 0,
                  foldedHidden: 0, collisionSkipped: 0, validatedOut: 0, upserted: 0 };

  const supa = getSupabase();
  if (!supa && !dryRun) { console.warn('[y8-ingest] Supabase unconfigured — skipping.'); return stats; }

  // 1. Read + normalize + filter + dedupe. Source = fresh scraped/harvested set
  //    PLUS the curated favorites from catalog-overrides.json (guaranteed-in).
  const arr = readGamesFlat(jsonPath);
  const curated = readOverridesY8();
  stats.read = arr.length;

  const bySlug = new Map();
  for (const g of [...arr, ...curated]) {
    const embedSlug = (g.slug || '').toString().trim();
    const title = (g.name || g.title || '').toString().trim();
    const embedUrl = wwwize(g.embedUrl || g.embed_url || (embedSlug ? `https://www.y8.com/embed/${embedSlug}` : ''));
    if (!embedSlug || !title || !/y8\.com\/embed\//i.test(embedUrl)) { stats.droppedShape++; continue; }

    const slug = toSlug(embedSlug);
    if (!slug) { stats.droppedShape++; continue; }
    if (SKIP_SLUGS.has(slug) || SKIP_SLUGS.has(embedSlug)) { stats.skippedSlope++; continue; }
    if (isTrademarkTitle(title)) { stats.droppedTrademark++; continue; }

    const cand = {
      slug,
      title: title.slice(0, 255),
      game_url: embedUrl,
      thumbnail_url: resolveThumb(slug, g.thumbnail || g.thumbnail_url || null),
      // Source feed has no category → infer from title/slug (shared with the
      // SQL generator via lib/categorize.mjs); use source category if present.
      category: g.category ? mapCategory(g.category) : guessCategory(title, slug),
      is_working: true,
      last_checked: new Date().toISOString(),
    };
    const prev = bySlug.get(slug);
    // Dedupe keeping the BEST: prefer the entry that has a thumbnail.
    if (!prev || (!prev.thumbnail_url && cand.thumbnail_url)) bySlug.set(slug, cand);
  }

  // 2. Fold in previously-hidden y8 rows so an older, over-aggressive link-check
  //    can't permanently bury them — they get re-validated and revived below.
  if (supa && reviveExisting) {
    try {
      const { data, error } = await supa.from('games')
        .select('slug, title, game_url, thumbnail_url, category')
        .eq('is_working', false).ilike('game_url', '%y8.com/embed/%');
      if (error) throw error;
      for (const r of (data || [])) {
        const slug = toSlug(r.slug);
        if (!slug || SKIP_SLUGS.has(slug) || bySlug.has(slug)) continue;
        if (isTrademarkTitle(r.title || '')) continue;
        bySlug.set(slug, {
          slug,
          title: String(r.title || slug).slice(0, 255),
          game_url: wwwize(r.game_url),
          thumbnail_url: resolveThumb(slug, r.thumbnail_url),
          category: r.category || 'arcade',
          is_working: true,
          last_checked: new Date().toISOString(),
        });
        stats.foldedHidden++;
      }
    } catch (e) {
      console.warn('[y8-ingest] hidden-row fold-in failed:', e.message);
    }
  }

  let candidates = [...bySlug.values()];
  stats.candidates = candidates.length;

  // 3. NO-CLOBBER guard: drop candidates whose slug already exists as a
  //    DIFFERENT (non-y8) game, so we never overwrite an unrelated entry.
  if (supa && candidates.length) {
    const existing = new Map(); // slug -> game_url
    const slugs = candidates.map(c => c.slug);
    try {
      for (let i = 0; i < slugs.length; i += 80) {
        const chunk = slugs.slice(i, i + 80);
        const { data, error } = await supa.from('games').select('slug, game_url').in('slug', chunk);
        if (error) throw error;
        for (const r of (data || [])) existing.set(r.slug, r.game_url || '');
      }
      candidates = candidates.filter(c => {
        const url = existing.get(c.slug);
        if (url === undefined) return true;             // brand new slug → ok
        if (/y8\.com\/embed\//i.test(url)) return true; // existing y8 row → update/revive
        stats.collisionSkipped++;                       // existing non-y8 game → don't clobber
        return false;
      });
    } catch (e) {
      console.warn('[y8-ingest] collision check failed (continuing without it):', e.message);
    }
  }

  // 4. Reachability validation — keep only games that actually load (follows the
  //    y8 301 → www). Drops pulled/404 games so we never insert a broken tile.
  if (validate && candidates.length && !dryRun) {
    const before = candidates.length;
    candidates = await validatePool(candidates, concurrency, async (c) => {
      try { const r = await probe(c.game_url); return !!r.ok; } catch { return false; }
    });
    stats.validatedOut = before - candidates.length;
  }

  if (dryRun) {
    console.log('[y8-ingest] DRY RUN:', JSON.stringify({ ...stats, finalCandidates: candidates.length }));
    return stats;
  }

  // 5. Upsert (onConflict slug → updates the existing 27 + revives folded rows + adds new).
  for (let i = 0; i < candidates.length; i += 200) {
    const chunk = candidates.slice(i, i + 200);
    const { error } = await supa.from('games').upsert(chunk, { onConflict: 'slug', ignoreDuplicates: false });
    if (error) console.warn('[y8-ingest] upsert chunk failed:', error.message);
    else stats.upserted += chunk.length;
  }

  // 6. Invalidate the paged catalog cache so the new games appear immediately.
  try {
    const { delPattern } = await import('./cache.mjs');
    const n = await delPattern('games:page:*');
    console.log(`[y8-ingest] cache invalidated: ${n} keys`);
  } catch { /* cache optional */ }

  console.log('[y8-ingest] done:', JSON.stringify(stats));
  return stats;
}

// ---- CLI: `node lib/y8-ingest.mjs [--dry-run] [--no-validate]` ----
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  for (const f of ['.env', '.env.local']) {
    const p = join(ROOT, f);
    if (existsSync(p) && typeof process.loadEnvFile === 'function') { try { process.loadEnvFile(p); break; } catch {} }
  }
  ingestY8({ dryRun: process.argv.includes('--dry-run'), validate: !process.argv.includes('--no-validate') })
    .then(() => process.exit(0))
    .catch(e => { console.error('[y8-ingest] fatal:', e?.message || e); process.exit(1); });
}
