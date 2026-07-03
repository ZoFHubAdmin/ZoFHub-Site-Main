// tools/split-sql-for-supabase.mjs
// ---------------------------------------------------------------------------
// The Supabase SQL editor refuses to SAVE a snippet past a size limit (~1000
// lines). Our bulk loaders (db/load-*.sql) are generated in 1000-ROW batches
// which — with the INSERT header + the 8-line `on conflict do update` footer —
// come out to ~1012 lines PER STATEMENT, already over the limit.
//
// This tool repackages every oversized db/load-*.sql into numbered part files
// (`<name>-partNN.sql`), each a single self-contained, idempotent INSERT that
// stays comfortably under the limit. It NEVER changes a single row of data — it
// only re-groups the existing rows — and it verifies that not one row is lost
// before deleting the oversized original.
//
//   node tools/split-sql-for-supabase.mjs            # split in place
//   node tools/split-sql-for-supabase.mjs --dry-run  # report only, write nothing
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB = join(__dirname, '..', 'db');
const DRY = process.argv.includes('--dry-run');

// Per-part budget — both well inside the known-good size (the hand-split
// y8-games-*.sql files are ~566 lines / ~108 KB and save fine).
const MAX_ROWS  = 700;
const MAX_BYTES = 130 * 1024;
// Only touch files bigger than this (everything else already saves).
const TRIGGER_LINES = 900;
const TRIGGER_BYTES = 150 * 1024;

// Every db/load-*.sql bulk loader shares these EXACT lines (verified). We only
// process files that match, so nothing unexpected gets rewritten.
const HEADER = 'insert into public.games (slug, title, game_url, thumbnail_url, category, is_working, last_checked)';
const FOOTER = [
  'on conflict (slug) do update set',
  '  title = excluded.title,',
  '  game_url = excluded.game_url,',
  '  thumbnail_url = excluded.thumbnail_url,',
  '  category = excluded.category,',
  '  is_working = excluded.is_working,',
  '  last_checked = excluded.last_checked,',
  '  updated_at = now();',
].join('\n');

// A data row is a line that (trimmed) starts with `('` — every value tuple the
// generator emits is exactly one line. Strip any trailing comma.
function extractRows(sql) {
  const rows = [];
  for (const raw of sql.split(/\r?\n/)) {
    const t = raw.trim();
    if (t.startsWith("('")) rows.push(t.replace(/,\s*$/, ''));
  }
  return rows;
}

const slugOf = (row) => { const m = row.match(/^\('((?:[^']|'')*)'/); return m ? m[1] : null; };
// Two rows with the same slug in ONE upsert make Postgres throw "ON CONFLICT DO
// UPDATE command cannot affect row a second time". Keep the first of each slug.
function dedupeBySlug(rows) {
  const seen = new Set(), out = [];
  for (const r of rows) { const s = slugOf(r); if (s !== null && seen.has(s)) continue; if (s !== null) seen.add(s); out.push(r); }
  return out;
}

function chunk(rows) {
  const parts = [];
  let cur = [], bytes = 0;
  for (const r of rows) {
    const rb = Buffer.byteLength(r, 'utf8') + 4; // + ",\n  "
    if (cur.length && (cur.length >= MAX_ROWS || bytes + rb > MAX_BYTES)) {
      parts.push(cur); cur = []; bytes = 0;
    }
    cur.push(r); bytes += rb;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

function render(base, idx, total, rows) {
  return `-- ${base}  (part ${idx} of ${total})
-- Auto-split so each file SAVES in the Supabase SQL editor (well under 1000 lines).
-- Idempotent upsert on slug - safe to run in any order and to re-run.
${HEADER}
values
  ${rows.join(',\n  ')}
${FOOTER}
`;
}

const files = readdirSync(DB)
  .filter(f => /^load-.*\.sql$/.test(f) && !/-part\d+\.sql$/.test(f));

const report = [];
let splitCount = 0, newFiles = 0;

for (const f of files) {
  const p = join(DB, f);
  const sql = readFileSync(p, 'utf8');
  const lineCount = sql.split(/\r?\n/).length;
  const byteCount = statSync(p).size;

  if (lineCount <= TRIGGER_LINES && byteCount <= TRIGGER_BYTES) {
    report.push(`  skip   ${f.padEnd(30)} ${lineCount} lines, ${Math.round(byteCount / 1024)}KB (already saves)`);
    continue;
  }
  // Safety: only split canonical bulk-INSERT loaders.
  if (!sql.includes(HEADER) || !sql.includes('on conflict (slug) do update set')) {
    report.push(`  SKIP   ${f.padEnd(30)} not a canonical games loader — left untouched`);
    continue;
  }

  const rawRows = extractRows(sql);
  if (!rawRows.length) { report.push(`  SKIP   ${f} — no rows found`); continue; }
  const rows = dedupeBySlug(rawRows);
  const dropped = rawRows.length - rows.length;

  const base = f.replace(/\.sql$/, '');
  const parts = chunk(rows);
  const written = parts.reduce((n, a) => n + a.length, 0);
  if (written !== rows.length) throw new Error(`ROW LOSS in ${f}: ${rows.length} -> ${written}`); // never silently drop data

  const maxLines = Math.max(...parts.map(pr => render(base, 1, 1, pr).split('\n').length));
  if (!DRY) {
    parts.forEach((rws, i) => {
      const name = `${base}-part${String(i + 1).padStart(2, '0')}.sql`;
      writeFileSync(join(DB, name), render(base, i + 1, parts.length, rws));
    });
    unlinkSync(p); // remove the oversized original
  }
  splitCount++; newFiles += parts.length;
  report.push(`  SPLIT  ${f.padEnd(30)} ${lineCount} lines → ${parts.length} parts, ${rows.length} rows${dropped ? ` (deduped ${dropped})` : ''}, biggest ${maxLines} lines`);
}

console.log(`\n${DRY ? '[DRY RUN] ' : ''}SQL split report (MAX_ROWS=${MAX_ROWS}, MAX_BYTES=${Math.round(MAX_BYTES / 1024)}KB):\n`);
console.log(report.join('\n'));
console.log(`\n${DRY ? 'Would split' : 'Split'} ${splitCount} file(s) into ${newFiles} part(s). Every part is a self-contained, idempotent upsert.`);
