// ZoFHub · tools/restore-games.mjs
// ---------------------------------------------------------------------------
// Rebuild the Supabase `games` table from the JSON data sources in this repo.
// Use this if the catalog ever gets wiped/shrunk (e.g. an over-aggressive
// cleanup that DELETES rows). It UPSERTS by slug — it NEVER deletes anything —
// so it's safe to run any time and is fully idempotent (re-running just updates).
//
//   npm run restore-games          # writes to Supabase
//   npm run restore-games -- --dry-run   # counts only, writes nothing
//
// It unions every source, deduped by slug (first source wins), and validates
// each row (needs slug + title + an http(s) game_url). `data/games-export.json`
// is a direct snapshot of the table, so it's listed first (authoritative).
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { isTrademarkTitle } from '../lib/cron-jobs.mjs';   // same trademark blocklist the cron/ingest use — no drift

const DRY = process.argv.includes('--dry-run');

const slugify = t => (t || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const isUrl   = u => typeof u === 'string' && /^https?:\/\//i.test(u);
const readJson = p => { try { return JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')); } catch { return null; } };
const asArray  = d => Array.isArray(d) ? d : (d && (d.games || d.gamesFlat || d.data || d.items || d.results)) || [];

// Map a raw row from each source into the games-table shape.
function norm(g, src) {
  let slug, title = g.title || g.name || '', game_url = '', thumb = '',
      category = (g.category || '').toString().toLowerCase().trim(), is_working = true;
  if (src === 'export')      { slug = g.slug;            game_url = g.game_url;  thumb = g.thumbnail_url; is_working = g.is_working !== false; }
  else if (src === 'api')    { slug = g.slug;            game_url = g.embed_url; thumb = g.thumbnail; }
  else if (src === 'y8')     { slug = slugify(g.slug || g.name); game_url = g.embedUrl || g.game_url; thumb = g.thumbnail; }
  else                       { slug = slugify(title);    game_url = g.embed_url || g.embed || g.link || g.game_url || ''; thumb = g.thumbnail || g.image || g.thumbnail_url || ''; }
  title = (title || '').toString().trim().slice(0, 255);
  slug  = (slug  || '').toString().trim();
  if (!slug || !title || !isUrl(game_url)) return null;
  if (isTrademarkTitle(title)) return null;   // copyright: never restore trademark/IP clones (Mario, FNAF, Squid Game, …)
  return { slug, title, game_url, thumbnail_url: thumb || '', category: category || 'arcade', is_working };
}

// Source priority: authoritative table snapshot first, then the raw feeds.
const SOURCES = [
  ['data/games-export.json', 'export'],
  ['api/games.json',         'api'],
  ['y8-games.json',          'y8'],
  ['master_games.json',      'master'],
  ['everygame.json',         'other'],
  ['somethingrandom.json',   'other'],
  ['data/top_games.json',    'other'],
];

const bySlug = new Map();
for (const [p, src] of SOURCES) {
  const arr = asArray(readJson(p));
  let added = 0;
  for (const g of arr) { const r = norm(g, src); if (r && !bySlug.has(r.slug)) { bySlug.set(r.slug, r); added++; } }
  console.log(`  ${p.padEnd(28)} ${String(arr.length).padStart(6)} raw  +${added} new  (total ${bySlug.size})`);
}
const rows = [...bySlug.values()];
console.log(`\nUnique valid games: ${rows.length} (working: ${rows.filter(r => r.is_working).length})`);

if (DRY) { console.log('\n[dry-run] nothing written.'); process.exit(0); }

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }

const supa = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const BATCH = 500; let done = 0, errs = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  let ok = false;
  for (let a = 0; a < 2 && !ok; a++) {
    const { error } = await supa.from('games').upsert(chunk, { onConflict: 'slug' });
    if (error) { if (a === 1) { errs++; console.log(`  batch@${i} ERR ${error.message}`); } else await new Promise(r => setTimeout(r, 600)); }
    else ok = true;
  }
  if (ok) { done += chunk.length; if (((i / BATCH) | 0) % 5 === 0) console.log(`  ...${done}/${rows.length}`); }
}
const cnt = async mod => (await mod(supa.from('games').select('*', { count: 'exact', head: true }))).count;
console.log(`\nUpsert complete: ${done} written, ${errs} failed batches.`);
console.log(`DB now — total: ${await cnt(x => x)}, shown: ${await cnt(x => x.eq('is_working', true))}`);
