// tools/y8-json-to-sql.mjs
// ---------------------------------------------------------------------------
// Turns y8-games.json (produced by scrape-y8.js) into SMALL, NUMBERED .sql
// files you paste into the Supabase SQL Editor one at a time. It does exactly
// what lib/y8-ingest.mjs does — same slug normalization, same www.y8.com embed
// URLs, same self-hosted-thumbnail preference, same trademark filter, same
// Slope skip, and the SAME no-clobber rule — but emits SQL instead of calling
// the DB.
//
// WHY MANY SMALL FILES INSTEAD OF ONE BIG ONE  (this is the bug we're fixing):
//   The Supabase SQL Editor struggles with a single ~500KB paste. Two things
//   go wrong and BOTH make it look like "it ran but nothing saved":
//     1. The editor can't reliably save such a large snippet, so when you
//        reopen the project the query TEXT is gone (you assume the data is too).
//     2. A giant paste can be truncated / hiccup at the very end. If the SQL is
//        wrapped in a transaction, the whole thing then ROLLS BACK — you saw
//        "Success" but the rows were never committed.
//   The fix:
//     • NO `begin/commit`. Every INSERT auto-commits the moment it succeeds, so
//       it is durable immediately and can NEVER be rolled back afterwards.
//     • Split into small numbered files (~GAMES_PER_FILE games each) that paste
//       cleanly, save as snippets, and never truncate.
//     • End each file with `select count(*)` so you SEE the total climb — that
//       is the real proof the data saved (INSERTs themselves say "no rows",
//       which is normal and does not mean nothing happened).
//
// SAFETY (matches the Node ingest):
//   * INSERT ... ON CONFLICT (slug) DO UPDATE  → idempotent; re-running is safe.
//   * The DO UPDATE has `WHERE games.game_url LIKE '%y8.com/embed/%'`, so a y8
//     slug can NEVER overwrite an existing non-y8 game (no-clobber). Brand-new
//     slugs insert; existing y8 rows update/revive (is_working=true).
//   * Trademark titles + the Slope duplicates are skipped.
//
// USAGE:  node tools/y8-json-to-sql.mjs
//   → writes db/y8-games-01.sql, db/y8-games-02.sql, … plus db/y8-games-check.sql.
//     Apply the schema FIRST with db/SCHEMA-ONLY.sql — see
//     docs/database/RUN-IN-ORDER.md for the run order.
//
// IT NO LONGER WRITES A RUN-ORDER FILE. It used to overwrite db/RUN-IN-ORDER.md
// with its own table naming schema.sql + community.sql as "the structure". That
// is the exact omission the real guide warns about: no grants.sql, so every
// table answers 42501. Running this tool silently replaced the maintained guide
// with those instructions. The order is now printed, and the guide is left alone.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTrademarkTitle } from '../lib/cron-jobs.mjs';
import { guessCategory } from '../lib/categorize.mjs';
import { isMain } from './_is-main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const THUMBS    = join(ROOT, 'public', 'thumbs');
const IN_JSON   = join(ROOT, 'y8-games.json');
const DB_DIR    = join(ROOT, 'db');

// Same category buckets as lib/y8-ingest.mjs.
const Y8_CATEGORY = {
  'action & racing': 'racing', 'cooking & kids': 'casual', 'girls & dress-up': 'girls',
  'other / casual': 'casual', 'puzzle & brain': 'puzzle', 'shooting & arcade': 'arcade',
};
const SKIP_SLUGS = new Set(['slope', 'slope-unblocked']);

// How many games go in EACH numbered file. ~500 games ≈ ~110KB of SQL — small
// enough that the editor pastes it instantly and saves the snippet, big enough
// that you only run a handful of files. Lower this if your editor still lags.
const GAMES_PER_FILE = 500;
// Within a file, rows are grouped into multi-row INSERTs of this size. Each one
// auto-commits on its own, so a finished INSERT is permanent even if a later
// one fails — you never lose what already went in.
const ROWS_PER_INSERT = 100;

const toSlug = (s) => String(s || '').toLowerCase().replace(/_/g, '-')
  .replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const mapCategory = (c) => {
  const k = String(c || '').toLowerCase().trim();
  return Y8_CATEGORY[k] || (k && /^[a-z]/.test(k) ? k.split(/[ &/]/)[0] : 'arcade');
};
const wwwize = (u) => String(u || '').replace(/^https?:\/\/y8\.com/i, 'https://www.y8.com');
const resolveThumb = (slug, scraped) => {
  if (existsSync(join(THUMBS, `${slug}.webp`))) return `/thumbs/${slug}.webp`;
  if (existsSync(join(THUMBS, `${slug}.png`)))  return `/thumbs/${slug}.png`;
  const s = (scraped || '').toString().trim();
  return s && /^https:\/\//i.test(s) ? s : null;
};
const q = (v) => v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
const pad2 = (n) => String(n).padStart(2, '0');

// One multi-row INSERT … ON CONFLICT block (no transaction — auto-commits).
function insertBlock(chunk) {
  const lines = [];
  lines.push('insert into public.games (slug, title, game_url, thumbnail_url, category, is_working, last_checked) values');
  lines.push(chunk.map(r =>
    `  (${q(r.slug)}, ${q(r.title)}, ${q(r.game_url)}, ${q(r.thumbnail_url)}, ${q(r.category)}, true, now())`
  ).join(',\n'));
  lines.push('on conflict (slug) do update set');
  lines.push([
    '  title = excluded.title,',
    '  game_url = excluded.game_url,',
    '  thumbnail_url = coalesce(excluded.thumbnail_url, public.games.thumbnail_url),',
    '  category = excluded.category,',
    '  is_working = true,',
    '  last_checked = now()',
    "where public.games.game_url like '%y8.com/embed/%';",
  ].join('\n'));
  return lines.join('\n');
}

// Remove any previous output so a changed game count never leaves orphans.
function cleanOld() {
  for (const f of readdirSync(DB_DIR)) {
    if (f === 'y8-games.sql' || f === 'y8-games-check.sql' || /^y8-games-\d+\.sql$/.test(f)) {
      try { unlinkSync(join(DB_DIR, f)); } catch {}
    }
  }
}

function build() {
  let raw;
  try { raw = JSON.parse(readFileSync(IN_JSON, 'utf8')); }
  catch (e) { console.error('[y8-sql] cannot read y8-games.json:', e.message); process.exit(1); }
  const flat = Array.isArray(raw) ? raw : (raw.gamesFlat || raw.games || raw.data || []);

  const bySlug = new Map();
  const stats = { read: flat.length, droppedShape: 0, droppedTrademark: 0, skippedSlope: 0 };
  for (const g of flat) {
    const embedSlug = (g.slug || '').toString().trim();
    const title     = (g.name || g.title || '').toString().trim();
    const embedUrl  = wwwize(g.embedUrl || g.embed_url || (embedSlug ? `https://www.y8.com/embed/${embedSlug}` : ''));
    if (!embedSlug || !title || !/y8\.com\/embed\//i.test(embedUrl)) { stats.droppedShape++; continue; }
    const slug = toSlug(embedSlug);
    if (!slug) { stats.droppedShape++; continue; }
    if (SKIP_SLUGS.has(slug) || SKIP_SLUGS.has(embedSlug)) { stats.skippedSlope++; continue; }
    if (isTrademarkTitle(title)) { stats.droppedTrademark++; continue; }
    // The scraped feed has no category, so mapCategory() would make everything
    // 'arcade'. Use the source category when present, otherwise infer one from
    // the title/slug (shared with the live ingest via lib/categorize.mjs).
    const srcCat = mapCategory(g.category);
    const cand = {
      slug, title: title.slice(0, 255), game_url: embedUrl,
      thumbnail_url: resolveThumb(slug, g.thumbnail || g.thumbnail_url || null),
      category: g.category ? srcCat : guessCategory(title, slug),
    };
    const prev = bySlug.get(slug);
    if (!prev || (!prev.thumbnail_url && cand.thumbnail_url)) bySlug.set(slug, cand);
  }

  const rows = [...bySlug.values()];
  const fileCount = Math.max(1, Math.ceil(rows.length / GAMES_PER_FILE));

  cleanOld();

  const written = [];
  for (let fi = 0, part = 1; fi < rows.length; fi += GAMES_PER_FILE, part++) {
    const slice = rows.slice(fi, fi + GAMES_PER_FILE);
    const name  = `y8-games-${pad2(part)}.sql`;
    const from  = fi + 1;
    const to    = Math.min(fi + GAMES_PER_FILE, rows.length);

    const out = [];
    out.push(`-- db/${name}  —  GENERATED by tools/y8-json-to-sql.mjs. Do not hand-edit.`);
    out.push(`-- ============================================================`);
    out.push(`-- PART ${part} of ${fileCount}   ·   games ${from}..${to} of ${rows.length}`);
    out.push(`-- ============================================================`);
    out.push('-- HOW TO RUN (do this for EACH numbered file, in order):');
    out.push('--   1. Supabase → SQL Editor → New query');
    out.push('--   2. Paste THIS WHOLE FILE → Run');
    out.push('--   3. You will see a number (the running total) at the end. That is');
    out.push('--      your PROOF it saved. The INSERTs themselves say "no rows" —');
    out.push('--      that is normal for an INSERT and does NOT mean nothing happened.');
    out.push('--   4. Run db/schema.sql ONCE before part 01. Safe to re-run any file.');
    out.push('--');
    out.push('-- NO begin/commit on purpose: every INSERT auto-commits the instant it');
    out.push('-- succeeds, so it is permanent immediately and can never roll back.');
    out.push('--');
    out.push('-- Give this run a generous statement timeout (editor default can be');
    out.push('-- only a few seconds, which is what made big loads die midway).');
    out.push("set statement_timeout = '120s';");
    out.push('');

    for (let i = 0; i < slice.length; i += ROWS_PER_INSERT) {
      out.push(insertBlock(slice.slice(i, i + ROWS_PER_INSERT)));
      out.push('');
    }

    out.push('-- ✅ PROOF IT SAVED — this returns ONE row with the live total in your DB.');
    out.push('-- (After part 01 expect ~' + to + '; the number should climb each part.)');
    out.push('select count(*) as total_games_now from public.games;');
    out.push('');

    writeFileSync(join(DB_DIR, name), out.join('\n'));
    written.push(name);
  }

  // Standalone verification helper.
  const chk = [
    '-- db/y8-games-check.sql — paste & Run anytime to confirm the data is really there.',
    '-- Returns ONE row with three numbers. If they look right, your load worked —',
    '-- no matter what the editor did with the query text afterwards.',
    '',
    'select',
    '  count(*)                                                 as total_games,',
    "  count(*) filter (where game_url like '%y8.com/embed/%')  as y8_games,",
    '  count(*) filter (where is_working)                       as working_games',
    'from public.games;',
    '',
    '-- Optional: eyeball the 10 most recently touched rows. Run this block on its',
    '-- own — the editor only shows the result of the LAST query you run.',
    '-- select slug, title, category, is_working, last_checked',
    '--   from public.games order by last_checked desc nulls last limit 10;',
    '',
  ].join('\n');
  writeFileSync(join(DB_DIR, 'y8-games-check.sql'), chk);


  console.log('[y8-sql] stats:', JSON.stringify(stats));
  console.log(`[y8-sql] wrote ${rows.length} games across ${written.length} files (${GAMES_PER_FILE}/file):`);
  for (const n of written) console.log('         db/' + n);
  console.log('         db/y8-games-check.sql');
  console.log('[y8-sql] run order: db/SCHEMA-ONLY.sql FIRST (all 16 migrations, grants last),');
  console.log('         then the files above in numeric order. Full guide: docs/database/RUN-IN-ORDER.md');
}
// Guarded: importing this module (a test, a REPL) must never rewrite files in db/.
if (isMain(import.meta.url)) build();
