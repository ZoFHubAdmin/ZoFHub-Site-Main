// tools/export-games.mjs
// ---------------------------------------------------------------------------
// Pull the FULL Supabase games catalog to a local file so it can be audited
// and edited offline (y8 list, missing thumbnails, etc.).
//
// Uses the SERVICE_ROLE key from your local .env — it is read on your machine
// only and never printed or uploaded. Pages through the whole table in 1000-row
// chunks, so it handles 12K+ rows without timing out or running out of memory.
//
//   Run:  npm run export-games            (defaults to the `games` table)
//         npm run export-games games_public   (override the table name)
//   Out:  data/games-export.json
// ---------------------------------------------------------------------------
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const f of ['.env', '.env.example']) {
  const p = join(root, f);
  if (existsSync(p) && typeof process.loadEnvFile === 'function') { try { process.loadEnvFile(p); } catch {} break; }
}

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('✗ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1);
}

const TABLE = process.argv[2] || 'games';
const PAGE = 1000;
const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

console.log(`Exporting "${TABLE}" in pages of ${PAGE}…`);
const all = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await supabase.from(TABLE).select('*').range(from, from + PAGE - 1);
  if (error) {
    console.error(`✗ Supabase error on "${TABLE}":`, error.message);
    if (TABLE === 'games') console.error('  Tip: try  npm run export-games games_public');
    process.exit(1);
  }
  all.push(...(data || []));
  process.stdout.write(`  pulled ${all.length}\r`);
  if (!data || data.length < PAGE) break;
}

const out = join(root, 'data', 'games-export.json');
writeFileSync(out, JSON.stringify(all));

// Instant summary so you immediately see what we're working with.
const url = g => g.embed_url || g.embed || g.iframe_src || '';
const thumb = g => g.thumbnail || g.image || g.thumb || '';
const y8 = all.filter(g => /y8\.com/i.test(url(g))).length;
const noThumb = all.filter(g => !String(thumb(g)).trim()).length;
console.log(`\n✓ ${all.length} rows → ${out}`);
console.log(`  y8.com games: ${y8}   ·   missing thumbnail: ${noThumb}`);
