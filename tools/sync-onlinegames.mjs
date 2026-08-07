// tools/sync-onlinegames.mjs — reconcile the catalog against embedonlinegamesio.json.
//
//   npm run og-sync              report only
//   npm run og-sync -- --write   apply through data/catalog-overrides.json
//   npm run og-sync -- --live    read the catalog from Supabase (default: export)
//
// embedonlinegamesio.json is the single source of truth for which OnlineGames.io
// titles this site may embed. This tool makes the catalog agree with it.
//
// IT WRITES OVERRIDE RULES, NOT DATABASE ROWS.
// data/catalog-overrides.json is the repository's existing mechanism for hiding,
// patching and adding games at serve time. Using it means every change lands in
// a reviewable diff and reverts with an edit, instead of a script silently
// mutating 16,916 production rows. Same reasoning as tools/catalog-quality.mjs.
//
// THE 37-GAME TRAP
// Searching the catalog for "onlinegames.io" matches 348 rows; only 311 are
// OnlineGames.io games. The rest are GameDistribution games that name the site
// in a gd_sdk_referrer_url parameter and belong to a different provider under a
// different licence. lib/onlinegames-canon.mjs decides ownership by URL host,
// never by substring, and this tool reports how many it excluded so the
// exclusion is visible rather than implicit.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reconcile, indexCanonical } from '../lib/onlinegames-canon.mjs';
import { detectFormat } from './catalog-quality.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CANON = join(ROOT, 'embedonlinegamesio.json');
const OVERRIDES = join(ROOT, 'data', 'catalog-overrides.json');

export function loadCanonical(file = CANON) {
  if (!existsSync(file)) throw new Error(`${file} not found — it is the source of truth and must exist.`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : (raw.games || raw.items || []);
}

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
        .select('id, slug, title, game_url, thumbnail_url, category')
        .order('id', { ascending: true }).range(from, from + 999);
      if (error) throw new Error(error.message);
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return out;
  }
  const p = join(ROOT, 'data', 'games-export.json');
  if (!existsSync(p)) throw new Error('data/games-export.json not found. Run: npm run export-games (or pass --live)');
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * Turn a reconciliation into override rules.
 *
 * remove : OnlineGames.io games absent from the canonical file, plus duplicate
 *          copies of canonical ones.
 * patch  : canonical games whose stored title/thumbnail/category has drifted.
 * add    : canonical games the catalog does not carry at all.
 */
export function buildRules(result) {
  const remove = [];
  const patch = [];
  const add = [];

  for (const r of result.nonCanonical) {
    if (!r.slug) continue;                      // unaddressable as a rule
    remove.push({ _note: 'onlinegames.io: not in embedonlinegamesio.json', slug: String(r.slug).toLowerCase() });
  }
  for (const d of result.duplicates) {
    if (!d.row.slug) continue;
    remove.push({
      _note: `onlinegames.io: duplicate of ${d.keeping.slug}`,
      slug: String(d.row.slug).toLowerCase(),
    });
  }
  for (const m of result.matched) {
    if (m.inSync || !m.row.slug) continue;
    patch.push({
      _note: 'onlinegames.io: synced from embedonlinegamesio.json',
      match: { slug: String(m.row.slug).toLowerCase() },
      set: m.drift,
    });
  }
  for (const g of result.missing) {
    if (!g.slug) continue;
    add.push({
      _note: 'onlinegames.io: from embedonlinegamesio.json',
      slug: g.slug, title: g.title, game_url: g.game_url,
      thumbnail_url: g.thumbnail_url, category: g.category,
    });
  }
  return { remove, patch, add };
}

/** Merge rules into the override file, preserving its formatting. */
export function applyRules(rules, { file = OVERRIDES } = {}) {
  const text = readFileSync(file, 'utf8');
  const { indent, eol } = detectFormat(text);
  const raw = JSON.parse(text);
  for (const k of ['patch', 'remove', 'add']) if (!Array.isArray(raw[k])) raw[k] = [];

  const knownRemove = new Set(raw.remove.map(r => String(r?.slug || '').toLowerCase()).filter(Boolean));
  const knownAdd    = new Set(raw.add.map(a => String(a?.slug || '').toLowerCase()).filter(Boolean));
  // A patch is keyed by the slug it matches, so re-running replaces rather than
  // stacking a second rule for the same game.
  const patchIndex  = new Map(raw.patch.map((p, i) => [String(p?.match?.slug || '').toLowerCase(), i]));

  const applied = { remove: 0, patch: 0, add: 0, patchReplaced: 0 };

  for (const r of rules.remove) {
    if (knownRemove.has(r.slug)) continue;
    knownRemove.add(r.slug); raw.remove.push(r); applied.remove++;
  }
  for (const p of rules.patch) {
    const key = String(p.match.slug).toLowerCase();
    if (patchIndex.has(key)) {
      // Merge into the existing rule instead of adding a competing one: two
      // patches matching the same slug means the last loaded silently wins.
      const existing = raw.patch[patchIndex.get(key)];
      existing.set = { ...existing.set, ...p.set };
      existing._note = p._note;
      applied.patchReplaced++;
    } else {
      patchIndex.set(key, raw.patch.length); raw.patch.push(p); applied.patch++;
    }
  }
  for (const a of rules.add) {
    // Never add a game we are simultaneously removing, and never add twice.
    if (knownAdd.has(a.slug) || knownRemove.has(a.slug)) continue;
    knownAdd.add(a.slug); raw.add.push(a); applied.add++;
  }

  const total = applied.remove + applied.patch + applied.add + applied.patchReplaced;
  if (total) writeFileSync(file, JSON.stringify(raw, null, indent).replace(/\n/g, eol) + eol);
  return applied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Set(process.argv.slice(2));
  const write = args.has('--write'), live = args.has('--live');

  let canonical, catalog;
  try {
    canonical = loadCanonical();
    catalog = await loadCatalog({ live });
  } catch (e) { console.error('✗ ' + e.message); process.exit(1); }

  const idx = indexCanonical(canonical);
  const r = reconcile(canonical, catalog);

  console.log('──────── ONLINEGAMES.IO CANONICAL SYNC ────────');
  console.log(`source of truth........ embedonlinegamesio.json`);
  console.log(`  entries.............. ${idx.total}`);
  console.log(`  unique embeds........ ${idx.byEmbed.size}`);
  if (idx.duplicates.length) console.log(`  DUPLICATES IN FILE... ${idx.duplicates.length}: ${idx.duplicates.map(d => d.title).slice(0, 5).join(', ')}`);
  if (idx.invalid.length)    console.log(`  INVALID EMBEDS....... ${idx.invalid.length} (not an onlinegames.io URL)`);

  console.log(`\ncatalog (${live ? 'live Supabase' : 'games-export.json'}).. ${catalog.length} games`);
  console.log(`  served by onlinegames.io ${r.owned}`);
  console.log(`  merely NAME it in a URL parameter: ${r.ignoredMentions}  — other providers' games, NOT touched`);
  for (const s of r.ignoredSample) console.log(`      ${String(s.slug).slice(0, 34).padEnd(36)} ${String(s.url).slice(0, 60)}`);

  const drifted = r.matched.filter(m => !m.inSync);
  console.log(`\nreconciliation`);
  console.log(`  in canon, in catalog... ${r.matched.length}   (${drifted.length} with drifted metadata)`);
  console.log(`  duplicate copies....... ${r.duplicates.length}   -> hide`);
  console.log(`  NOT in canon........... ${r.nonCanonical.length}   -> hide`);
  console.log(`  in canon, missing...... ${r.missing.length}   -> add`);

  if (r.nonCanonical.length) {
    console.log(`\nnon-canonical (first 12):`);
    for (const g of r.nonCanonical.slice(0, 12)) console.log(`   ${String(g.slug).slice(0, 44).padEnd(46)} ${String(g.title || '').slice(0, 34)}`);
  }
  if (drifted.length) {
    console.log(`\nmetadata drift (first 8):`);
    for (const m of drifted.slice(0, 8)) console.log(`   ${String(m.row.slug).slice(0, 38).padEnd(40)} ${Object.keys(m.drift).join(', ')}`);
  }

  const rules = buildRules(r);
  console.log(`\nrules: ${rules.remove.length} remove, ${rules.patch.length} patch, ${rules.add.length} add`);

  if (write) {
    const applied = applyRules(rules);
    console.log(`written to data/catalog-overrides.json:`);
    console.log(`  +${applied.remove} remove, +${applied.patch} patch (${applied.patchReplaced} merged), +${applied.add} add`);
    console.log(`Review the diff, then restart the server to apply.`);
  } else if (rules.remove.length + rules.patch.length + rules.add.length) {
    console.log(`Re-run with --write to apply through data/catalog-overrides.json.`);
  } else {
    console.log(`Catalog already agrees with the canonical file.`);
  }
}
