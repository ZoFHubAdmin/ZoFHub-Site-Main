// tools/generate-sql-from-json.mjs
// Generates Supabase INSERT scripts from the JSON game sources.
//
// IMPORTANT: output is CHUNKED into `load-<source>-partNN.sql` files, each a
// single self-contained idempotent upsert kept well under the Supabase SQL
// editor's ~1000-line "save snippet" limit. (The old version emitted one giant
// file per source with 1000-ROW batches = ~1012-line statements that the editor
// refused to save.) Keep tools/split-sql-for-supabase.mjs in sync with the
// MAX_ROWS / MAX_BYTES / header / footer below.
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DB = join(ROOT, 'db');

// Per-part budget (both inside the known-good size: the y8-games-*.sql files are
// ~566 lines / ~108 KB and save fine).
const MAX_ROWS = 700;
const MAX_BYTES = 130 * 1024;

const INSERT_HEADER = 'insert into public.games (slug, title, game_url, thumbnail_url, category, is_working, last_checked)';
const CONFLICT_FOOTER = [
  'on conflict (slug) do update set',
  '  title = excluded.title,',
  '  game_url = excluded.game_url,',
  '  thumbnail_url = excluded.thumbnail_url,',
  '  category = excluded.category,',
  '  is_working = excluded.is_working,',
  '  last_checked = excluded.last_checked,',
  '  updated_at = now();',
].join('\n');

function escapeSql(str) {
  if (!str) return '';
  return String(str).replace(/'/g, "''");
}

function generateSlug(title) {
  if (!title) return '';
  return String(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizeGame(game) {
  const title = game.title || game.name || '';
  if (!title) return null;
  const game_url = game.embed_url || game.embedUrl || game.embed || game.link || game.game_url || game.url || '';
  if (!game_url) return null;
  const thumbnail_url = game.thumbnail || game.thumbnail_url || game.thumbnailUrl || game.image || game.imageUrl || '';
  const category = (game.category || game.type || game.genre || 'arcade').toString().toLowerCase();
  const slug = game.slug || generateSlug(title);
  if (!slug) return null;
  return { slug, title, game_url, thumbnail_url, category };
}

function normalizeAll(jsonPath) {
  const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
  let games = [];
  if (Array.isArray(data)) games = data;
  else if (data.games && Array.isArray(data.games)) games = data.games;
  else if (data.gamesFlat && Array.isArray(data.gamesFlat)) games = data.gamesFlat;
  return games.map(normalizeGame).filter(Boolean);
}

function rowSql(g) {
  return `  ('${escapeSql(g.slug)}', '${escapeSql(g.title)}', '${escapeSql(g.game_url)}', '${escapeSql(g.thumbnail_url)}', '${escapeSql(g.category)}', true, now())`;
}

function chunkRows(rows) {
  const parts = [];
  let cur = [], bytes = 0;
  for (const r of rows) {
    const rb = Buffer.byteLength(r, 'utf8') + 2;
    if (cur.length && (cur.length >= MAX_ROWS || bytes + rb > MAX_BYTES)) { parts.push(cur); cur = []; bytes = 0; }
    cur.push(r); bytes += rb;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

function renderPart(base, idx, total, rows) {
  return `-- ${base}  (part ${idx} of ${total})
-- Auto-generated; kept well under the Supabase SQL-editor ~1000-line save limit.
-- Idempotent upsert on slug - safe to run in any order and to re-run.
${INSERT_HEADER}
values
${rows.join(',\n')}
${CONFLICT_FOOTER}
`;
}

// Delete any stale outputs for this base, then write the fresh chunked set.
function writeChunked(baseName, games) {
  for (const f of readdirSync(DB)) {
    if (f === `${baseName}.sql` || new RegExp(`^${baseName}-part\\d+\\.sql$`).test(f)) {
      try { unlinkSync(join(DB, f)); } catch {}
    }
  }
  const parts = chunkRows(games.map(rowSql));
  parts.forEach((rows, i) => {
    const name = parts.length === 1 ? `${baseName}.sql` : `${baseName}-part${String(i + 1).padStart(2, '0')}.sql`;
    writeFileSync(join(DB, name), renderPart(baseName, i + 1, parts.length, rows));
  });
  return parts.length;
}

function generateFor(jsonPath, baseName) {
  const games = normalizeAll(jsonPath);
  const parts = writeChunked(baseName, games);
  console.log(`✓ ${baseName}: ${games.length} games -> ${parts} file(s)`);
}

// api/games.json
generateFor(join(ROOT, 'api', 'games.json'), 'load-api-games');

// ai_gaming_hub_final.json (may not be a game list)
try { generateFor(join(ROOT, 'ai_gaming_hub_final.json'), 'load-ai-games'); }
catch (e) { console.log(`⚠ ai_gaming_hub_final.json skipped: ${e.message}`); }

// root-level game JSON sources
for (const file of ['somethingrandom.json', 'master_games.json', 'everygame.json', 'y8-games.json']) {
  try { generateFor(join(ROOT, file), `load-${file.replace('.json', '')}`); }
  catch (e) { console.log(`⚠ ${file} skipped: ${e.message}`); }
}

// any other JSON lists under data/
try {
  for (const file of readdirSync(join(ROOT, 'data')).filter(f => f.endsWith('.json') && f !== 'catalog-overrides.json')) {
    try { generateFor(join(ROOT, 'data', file), `load-${file.replace('.json', '')}`); }
    catch (e) { console.log(`⚠ data/${file} skipped: ${e.message}`); }
  }
} catch { console.log('⚠ no data/ directory'); }

console.log('\n=== HOW TO LOAD ===');
console.log('Fastest (recommended): `npm run restore-games` loads every source into Supabase in one command.');
console.log('Manual (Supabase SQL editor): run db/schema.sql, then each db/load-*.sql (part files in numeric order),');
console.log('then db/community.sql and db/stats.sql. Every file now stays under the editor save limit.');
