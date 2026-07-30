// tools/add-slope.mjs
//
// One-shot, idempotent catalog fix for the OFFICIAL Slope game:
//
//   1. Ensure the GameDistribution Slope (hash 0022998ce3c54962be6ffe178229b168)
//      is present, working, named "Slope", and uses the self-hosted thumbnail
//      at /thumbs/slope.png. If a row already carries that GD hash (e.g. the old
//      "Slope Rolling"), it is RENAMED in place to "Slope" — no duplicate, and
//      the slug is left intact so /play links + recommendations don't break.
//   2. Remove the junk games the user flagged: "Spend Elon Musk Money" and
//      "Spend Bill Gates Money".
//   3. Remove any STRAY "Slope Rolling" row that does NOT carry the canonical
//      GD hash (a separate broken copy, if one exists).
//
// Removal tries a hard DELETE first; if a foreign-key constraint blocks it, it
// falls back to a soft remove (is_working=false) so the game vanishes from the
// site (games_public filters is_working=true) without erroring.
//
// The live gd_sdk_referrer_url is rewritten per-request by /play/:slug, so the
// static value stored here is only an analytics fallback.
//
// Usage:
//   node tools/add-slope.mjs            # apply
//   node tools/add-slope.mjs --dry-run  # preview, write nothing

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load .env BEFORE importing the Supabase client (it reads env lazily).
for (const f of ['.env', '.env.example']) {
  const p = join(ROOT, f);
  if (existsSync(p) && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(p); console.log(`[slope] loaded env from ${f}`); break; } catch {}
  }
}

const DRY_RUN = process.argv.includes('--dry-run');

const GD_HASH = '0022998ce3c54962be6ffe178229b168';
const SLOPE = {
  slug: 'slope-rolling', // canonical GD-classic slug (avoids colliding with the Famobi 'slope' we remove)
  title: 'Slope',
  game_url: `https://html5.gamedistribution.com/${GD_HASH}/?gd_sdk_referrer_url=https://yourgamingsite.com/`,
  thumbnail_url: '/thumbs/slope.png', // self-hosted (public/thumbs/slope.png)
  category: 'arcade',
};

// Junk to delete, matched case-insensitively (covers title variants like
// "Spend Elon Musk's Money", "...Money Simulator", etc.).
const REMOVE_PATTERNS = [
  { label: 'Spend Elon Musk Money', like: '%elon%musk%money%' },
  { label: 'Spend Bill Gates Money', like: '%bill%gates%money%' },
];

// Exact slugs to remove: the y8.com Slope and the duplicate Famobi 'Slope'.
// (Removed by slug, NOT title — the Famobi one is also titled "Slope" and we
// must not touch the canonical GD slope-rolling row.)
const REMOVE_SLUGS = ['slope-y8', 'slope'];

const { getSupabase } = await import('../lib/supabase.mjs');
const supa = getSupabase();
if (!supa) {
  console.error('[slope] Supabase is not configured. Set SUPABASE_URL + SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) in .env and retry.');
  process.exit(1);
}

const nowIso = new Date().toISOString();

// Hard-delete a set of ids; on FK failure, soft-remove (is_working=false).
async function removeRows(rows, why) {
  if (!rows.length) return;
  for (const g of rows) {
    console.log(`        • removing id=${g.id} slug="${g.slug}" title="${g.title}" (${why})`);
  }
  if (DRY_RUN) { console.log(`[slope] DRY RUN — would remove ${rows.length} row(s).`); return; }
  const ids = rows.map(r => r.id);
  const { error } = await supa.from('games').delete().in('id', ids);
  if (!error) { console.log(`[slope] ✓ hard-deleted ${ids.length} row(s).`); return; }
  console.warn(`[slope] hard delete blocked (${error.message}); soft-removing instead…`);
  const { error: e2 } = await supa.from('games').update({ is_working: false, last_checked: nowIso }).in('id', ids);
  if (e2) { console.error('[slope] soft-remove failed:', e2.message); process.exit(1); }
  console.log(`[slope] ✓ soft-removed ${ids.length} row(s) (is_working=false → hidden).`);
}

// ---- 1. Ensure the canonical Slope (match by GD hash) ----
let hashRows = [];
try {
  const { data, error } = await supa
    .from('games')
    .select('id, slug, title, game_url, thumbnail_url, is_working')
    .ilike('game_url', `%${GD_HASH}%`);
  if (error) throw error;
  hashRows = data || [];
} catch (e) { console.error('[slope] hash lookup failed:', e.message); process.exit(1); }

if (hashRows.length) {
  console.log(`[slope] found ${hashRows.length} existing row(s) for the official Slope:`);
  for (const g of hashRows) {
    console.log(`        • id=${g.id} slug="${g.slug}" title="${g.title}" working=${g.is_working} thumb=${g.thumbnail_url || 'none'}`);
    const patch = { title: SLOPE.title, thumbnail_url: SLOPE.thumbnail_url, is_working: true, last_checked: nowIso };
    if (DRY_RUN) { console.log(`[slope] DRY RUN id=${g.id} would set: ${JSON.stringify(patch)}`); continue; }
    const { error } = await supa.from('games').update(patch).eq('id', g.id);
    if (error) { console.error(`[slope] update id=${g.id} failed:`, error.message); process.exit(1); }
    console.log(`[slope] ✓ id=${g.id} is now "Slope" with the self-hosted thumbnail, working.`);
  }
} else {
  console.log('[slope] official Slope not in catalog — inserting a clean "Slope" entry.');
  const row = { ...SLOPE, is_working: true, last_checked: nowIso };
  if (DRY_RUN) { console.log(`[slope] DRY RUN would upsert: ${JSON.stringify(row)}`); }
  else {
    const { error } = await supa.from('games').upsert(row, { onConflict: 'slug', ignoreDuplicates: false });
    if (error) { console.error('[slope] insert failed:', error.message); process.exit(1); }
    console.log(`[slope] ✓ inserted slug="${row.slug}" title="${row.title}".`);
  }
}

// ---- 2. Remove the flagged junk games ----
for (const { label, like } of REMOVE_PATTERNS) {
  try {
    const { data, error } = await supa.from('games').select('id, slug, title').ilike('title', like);
    if (error) throw error;
    if (!data || !data.length) { console.log(`[slope] "${label}": none found.`); continue; }
    console.log(`[slope] "${label}": found ${data.length} match(es).`);
    await removeRows(data, label);
  } catch (e) { console.error(`[slope] remove "${label}" failed:`, e.message); }
}

// ---- 2b. Remove the y8 + Famobi duplicate slopes (by slug) ----
try {
  const { data, error } = await supa.from('games').select('id, slug, title, game_url').in('slug', REMOVE_SLUGS);
  if (error) throw error;
  // Safety: never remove the canonical GD slope, even if it somehow has one of
  // these slugs.
  const targets = (data || []).filter(g => !(g.game_url || '').includes(GD_HASH));
  if (targets.length) { console.log(`[slope] duplicate slopes by slug: ${targets.length}.`); await removeRows(targets, 'duplicate slope'); }
  else console.log(`[slope] no duplicate-slope slugs (${REMOVE_SLUGS.join(', ')}) found.`);
} catch (e) { console.error('[slope] slug removal failed:', e.message); }

// ---- 3. Remove any stray "Slope Rolling" that ISN'T the canonical hash ----
try {
  const { data, error } = await supa.from('games').select('id, slug, title, game_url').ilike('title', '%slope%rolling%');
  if (error) throw error;
  const strays = (data || []).filter(g => !(g.game_url || '').includes(GD_HASH));
  if (strays.length) { console.log(`[slope] stray "Slope Rolling" (non-canonical): ${strays.length}.`); await removeRows(strays, 'stray Slope Rolling'); }
  else console.log('[slope] no stray "Slope Rolling" rows.');
} catch (e) { console.error('[slope] stray-slope cleanup failed:', e.message); }

// ---- Heads-up: other slope-titled rows the user didn't explicitly name ----
try {
  const { data } = await supa.from('games').select('id, slug, title, thumbnail_url, is_working').ilike('title', '%slope%');
  const others = (data || []).filter(g => g.title !== 'Slope');
  if (others.length) {
    console.log('\n[slope] NOTE — other "slope" entries still in the catalog:');
    for (const g of others) console.log(`        • slug="${g.slug}" title="${g.title}" working=${g.is_working} thumb=${g.thumbnail_url || 'none'}`);
    console.log('[slope] (left untouched — tell me if you want any of these removed too.)');
  }
} catch { /* informational only */ }

// Best-effort cache flush so the change shows up fast (effective with Redis;
// the in-memory backend keeps its copy until restart/TTL).
try {
  const { getCache } = await import('../lib/cache.mjs');
  const cache = getCache?.();
  if (cache?.delPattern && !DRY_RUN) {
    await cache.delPattern('games:page:*');
    console.log(`\n[slope] cache flush attempted (backend=${cache.backend}).`);
  }
} catch { /* cache optional */ }

console.log('\n[slope] Done.' + (DRY_RUN ? ' (dry run — nothing written)' : ''));
console.log('[slope] If the homepage still shows the old data, run `npm run restart`.');
process.exit(0);
