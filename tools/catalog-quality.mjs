// tools/catalog-quality.mjs — structural catalog audit, no network required.
//
// Run:  npm run quality              report only
//       npm run quality -- --write   append remove rules for what it finds
//       npm run quality -- --raw     audit BEFORE the override layer runs
//       npm run quality -- --live    read the catalog from Supabase instead
//
// HOW THIS DIFFERS FROM `npm run audit`
// audit-catalog.mjs probes every game over the network to find dead embeds. It
// is slow, needs credentials, and its answers change with the weather. This is
// the structural half: duplicates, unplayable URLs and incomplete rows, all
// decidable from the data alone, so it runs offline and in CI.
//
// It audits what the site SERVES — after data/catalog-overrides.json is applied
// — because that is the only number that describes what a player sees. Auditing
// the raw export re-reports the 4,000-odd entries the override layer already
// handles, which buries the handful of new problems in old news.
//
// WHAT --write DOES
// Appends `{ "slug": "..." }` entries to the `remove` array of
// data/catalog-overrides.json. That is the mechanism the repository already uses
// to hide a game, so nothing new is invented and every removal stays in version
// control, reviewable in a diff and revertible with an edit. Cosmetic issues are
// never written — see lib/catalog-quality.mjs for why a missing thumbnail is not
// grounds for hiding a working game.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditGames, ISSUE_LABELS, SEVERITY } from '../lib/catalog-quality.mjs';
import { applyCatalogOverrides } from '../lib/catalog-overrides.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OVERRIDES = join(ROOT, 'data', 'catalog-overrides.json');

export async function loadGames({ live = false } = {}) {
  if (live) {
    const p = join(ROOT, '.env');
    if (existsSync(p) && typeof process.loadEnvFile === 'function') { try { process.loadEnvFile(p); } catch { /* optional */ } }
    const { adminKey } = await import(pathToFileURL(join(ROOT, 'lib', 'supabase-keys.mjs')).href);
    const url = process.env.SUPABASE_URL, key = adminKey();
    if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY are not set — drop --live to use the export.');
    const { createClient } = await import('@supabase/supabase-js');
    const supa = createClient(url, key, { auth: { persistSession: false } });
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supa.from('games')
        .select('id, slug, title, game_url, thumbnail_url, category, is_working').range(from, from + 999);
      if (error) throw new Error(error.message);
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return out;
  }
  const p = join(ROOT, 'data', 'games-export.json');
  if (!existsSync(p)) throw new Error('data/games-export.json not found. Run: npm run export-games');
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * Match the file's existing indentation and line endings.
 *
 * Re-serialising a 16,000-line JSON file with the wrong indent rewrites every
 * line: the first version of this wrote 16,294 insertions and 16,134 deletions
 * to add 40 entries, which destroys the reviewable diff that is the entire
 * justification for writing to this file rather than the database.
 */
export function detectFormat(text) {
  const indent = /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  return { indent, eol };
}

/** Append remove-by-slug rules, skipping any slug already covered. */
export function writeRemovals(removable, { file = OVERRIDES } = {}) {
  const text = readFileSync(file, 'utf8');
  const { indent, eol } = detectFormat(text);
  const raw = JSON.parse(text);
  if (!Array.isArray(raw.remove)) raw.remove = [];
  const known = new Set(raw.remove.map((r) => String(r?.slug || '').toLowerCase()).filter(Boolean));

  const added = [];
  for (const r of removable) {
    // Only slug-addressable removals. A row with no slug cannot be expressed as
    // a rule, and guessing at a title match risks taking working games with it.
    if (!r.slug || known.has(r.slug)) continue;
    known.add(r.slug);
    added.push({ _note: `auto: ${r.reason}`, slug: r.slug });
  }
  if (added.length) {
    raw.remove.push(...added);
    // Trailing newline: the file is in git and a missing one shows as a
    // "\ No newline at end of file" marker on every future diff.
    const out = JSON.stringify(raw, null, indent).replace(/\n/g, eol) + eol;
    writeFileSync(file, out);
  }
  return added;
}

function main(argv) {
  const args = new Set(argv);
  return { write: args.has('--write'), raw: args.has('--raw'), live: args.has('--live') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = main(process.argv.slice(2));
  let games;
  try { games = await loadGames({ live: opts.live }); }
  catch (e) { console.error('✗ ' + e.message); process.exit(1); }

  const scope = opts.raw ? 'raw catalog' : 'catalog as served';
  const list = opts.raw ? games : applyCatalogOverrides(games.map((g) => ({ ...g })), { injectAdds: true });
  if (!opts.raw) console.log(`overrides removed ${games.length - list.length} entr(ies) before this audit`);

  const r = auditGames(list);
  console.log(`\n──────── CATALOG QUALITY (${scope}) ────────`);
  console.log(`total.............. ${r.total}`);
  console.log(`healthy............ ${r.healthy}`);
  console.log(`with issues........ ${r.affected}`);
  console.log(`quality score...... ${r.score}%   (share not marked removable)`);
  console.log(`\nby severity:`);
  for (const [sev, n] of Object.entries(r.bySeverity)) {
    const tag = sev === SEVERITY.COSMETIC ? '  (reported only — never hidden)' : '';
    console.log(`  ${sev.padEnd(11)} ${String(n).padStart(6)}${tag}`);
  }
  if (Object.keys(r.byKind).length) {
    console.log(`\nby issue:`);
    for (const [k, n] of Object.entries(r.byKind).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(6)}  ${k.padEnd(19)} ${ISSUE_LABELS[k] || ''}`);
    }
    console.log(`\nexamples:`);
    for (const [k, ex] of Object.entries(r.examples)) {
      for (const e of ex.slice(0, 4)) {
        console.log(`  ${k.padEnd(19)} ${String(e.slug || e.title || e.id).slice(0, 44)}`);
      }
    }
  }

  console.log(`\nremovable.......... ${r.removable.length}`);
  if (opts.write && r.removable.length) {
    if (opts.raw) {
      console.error('\n✗ --write needs the served view. Drop --raw: the raw catalog re-reports');
      console.error('  everything the override layer already handles.');
      process.exit(1);
    }
    const added = writeRemovals(r.removable);
    console.log(`wrote ${added.length} new remove rule(s) to data/catalog-overrides.json`);
    console.log('Review the diff, then restart the server to apply.');
  } else if (r.removable.length) {
    console.log('Re-run with --write to hide these through data/catalog-overrides.json.');
  } else {
    console.log('Nothing to hide — the served catalog is structurally clean.');
  }
}
