// tools/clean-fake-gd-hashes.mjs
//
// Removes GameDistribution game entries whose URL hash follows an obvious
// sequential/synthetic pattern (e.g. 3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f).
// These were almost certainly AI-generated placeholder hashes — they return
// HTTP 200 from GD but never render a real game, showing only a black screen.
//
// IMPORTANT: this cleans EVERY file the Supabase migrator reads, not just
// api/games.json.  The migrator (tools/migrate-to-supabase.mjs) consolidates
// six source files and picks the highest-priority entry per slug.  Cleaning
// only api/games.json (priority 4) is useless because data/top_games.json
// (priority 5) outranks it — the fakes would come straight back in on migrate.
//
// Detection: every byte in a real GD hash is random-looking hex.  Fake hashes
// have each nibble following a simple arithmetic sequence (even nibbles step
// through 0-9, odd nibbles step through a-f), making the full 32-char string
// look like counting in two interleaved sequences.
//
// Run: node tools/clean-fake-gd-hashes.mjs [--dry-run]
// Modifies (in-place): data/top_games.json, api/games.json, everygame.json,
//                      somethingrandom.json, master_games.json,
//                      ai_gaming_hub_final.json

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync }          from 'node:fs';
import { join, dirname }       from 'node:path';
import { fileURLToPath }       from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const DRY_RUN   = process.argv.includes('--dry-run');

// Every file the migrator reads (see SOURCES in migrate-to-supabase.mjs).
const FILES = [
  'data/top_games.json',
  'api/games.json',
  'somethingrandom.json',
  'master_games.json',
  'everygame.json',
  'ai_gaming_hub_final.json',
];

const GD_RE = /html5\.gamedistribution\.com\/([0-9a-f]{32})\//i;

// Returns true if the 32-char hex hash is synthetic/sequential.
// Pattern: even-position nibbles (0,2,4,...) form one AP mod 10 (digits 0-9),
// odd-position nibbles (1,3,5,...) form one AP mod 6 (digits a-f only).
function isFakeHash(hash) {
  const h = String(hash).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) return false;

  const evenNibs = [], oddNibs = [];
  for (let i = 0; i < 32; i++) {
    const v = parseInt(h[i], 16);
    (i % 2 === 0 ? evenNibs : oddNibs).push(v);
  }

  // Odd nibbles must ALL be a-f (10-15); if any are 0-9 it's not this pattern
  if (oddNibs.some(n => n < 10)) return false;
  const oddMapped = oddNibs.map(n => n - 10); // 0-5 for a-f

  const evenDiffs = new Set();
  for (let i = 1; i < evenNibs.length; i++)
    evenDiffs.add(((evenNibs[i] - evenNibs[i-1]) + 10) % 10);

  const oddDiffs = new Set();
  for (let i = 1; i < oddMapped.length; i++)
    oddDiffs.add(((oddMapped[i] - oddMapped[i-1]) + 6) % 6);

  // Sequential = single unique diff in each track
  return evenDiffs.size === 1 && oddDiffs.size === 1;
}

function urlOf(g) {
  return g.embed_url || g.embedUrl || g.embed || g.url || g.link
      || g.game_url || g.iframe || g.iframeUrl || g.gameUrl || '';
}

// Locate the games array inside any supported shape and return both the array
// and a rebuild() that splices a cleaned array back into the original shape.
function locate(data) {
  if (Array.isArray(data)) return { list: data, rebuild: (clean) => clean };
  for (const key of ['games', 'data', 'results', 'items']) {
    if (Array.isArray(data[key]))
      return { list: data[key], rebuild: (clean) => ({ ...data, [key]: clean }) };
  }
  return null;
}

let grandRemoved = 0;

for (const rel of FILES) {
  const full = join(ROOT, rel);
  if (!existsSync(full)) { console.log(`[skip] ${rel} (missing)`); continue; }

  const raw  = await readFile(full, 'utf8');
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { console.log(`[skip] ${rel} (parse error: ${e.message})`); continue; }

  const loc = locate(data);
  if (!loc) { console.log(`[skip] ${rel} (no games array found)`); continue; }

  let removed = 0;
  const clean = loc.list.filter(g => {
    const m = urlOf(g).match(GD_RE);
    if (!m) return true;
    if (isFakeHash(m[1])) {
      console.log(`  [REMOVE] ${rel} :: ${g.slug || g.title || g.name} — fake hash ${m[1]}`);
      removed++;
      return false;
    }
    return true;
  });

  grandRemoved += removed;
  console.log(`[${rel}] ${loc.list.length} → ${clean.length} (removed ${removed})`);

  if (removed > 0 && !DRY_RUN) {
    const out = loc.rebuild(clean);
    await writeFile(full, JSON.stringify(out, null, 2) + '\n');
    console.log(`  written: ${rel}`);
  }
}

console.log(`\nTotal fake-hash entries ${DRY_RUN ? 'found' : 'removed'}: ${grandRemoved}`);
if (DRY_RUN) console.log('Dry run — no files written. Remove --dry-run to apply.');
