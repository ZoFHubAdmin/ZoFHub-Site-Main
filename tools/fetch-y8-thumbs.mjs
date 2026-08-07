// tools/fetch-y8-thumbs.mjs
// ---------------------------------------------------------------------------
// Fill in `thumbnail_url` for games that have none (the 28 y8 games), and
// optionally SELF-HOST those thumbnails so they can never break.
//
// For each game it finds the source image (override → existing remote URL →
// the y8 page's og:image/twitter:image/cloudimage URL), then writes it back to
// Supabase. Uses your .env SERVICE_ROLE key locally (never printed/uploaded).
//
// MODES
//   (default)      store the REMOTE y8 CDN url. Fast; relies on y8 allowing
//                  hotlinks. If any show the gradient placeholder afterwards,
//                  re-run with --self-host to make them bulletproof.
//   --self-host    DOWNLOAD each y8 thumbnail into public/thumbs/<slug>.<ext>
//                  and store the LOCAL path (/thumbs/<slug>.<ext>). No hotlink,
//                  no CORS, served by ZoFHub itself — permanent fix.
//   --dry-run      show what it WOULD do without writing or downloading.
//
// Safe by design: default mode only touches rows where thumbnail_url IS NULL;
// self-host mode only re-points y8 rows that still use a remote URL (so it is
// resumable/idempotent). Sequential with a short delay (respectful to y8).
// Manual overrides in data/thumbnail-overrides.json ({ "<slug>": "<url>" }) win.
//
//   Preview:    npm run fix-thumbnails -- --dry-run
//   Apply:      npm run fix-thumbnails
//   Bulletproof: npm run fix-thumbnails -- --self-host
// ---------------------------------------------------------------------------
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const f of ['.env', '.env.example']) {
  const p = join(root, f);
  if (existsSync(p) && typeof process.loadEnvFile === 'function') { try { process.loadEnvFile(p); } catch {} break; }
}
// adminKey() reads SUPABASE_SECRET_KEY *and* the legacy SUPABASE_SERVICE_ROLE_KEY,
// so the new-style `sb_secret_…` key works here too. This tool is also spawned by
// server.js at boot (kickThumbnailFetch), where the parent has already normalized
// the names — reading only the legacy name meant it worked when spawned but failed
// when run directly via `npm run fix-thumbnails`. Same script, opposite result.
const { adminKey } = await import('../lib/supabase-keys.mjs');
const SB_URL = process.env.SUPABASE_URL, SB_KEY = adminKey();
if (!SB_URL || !SB_KEY) { console.warn('⚠ Skipping thumbnails — SUPABASE_URL / SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) not set in .env (server still starts).'); process.exit(0); }

const DRY = process.argv.includes('--dry-run');
const SELF_HOST = process.argv.includes('--self-host');
// --missing-only: fetch ONLY rows whose thumbnail is NULL; skip the "manual
// overrides always re-apply" pass. The on-boot fetch uses this so it's a true
// no-op once every thumbnail is present (instead of re-hitting y8 each restart).
const MISSING_ONLY = process.argv.includes('--missing-only');
const UA = 'Mozilla/5.0 (+catalog-thumbnailer)';
const supabase = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const thumbsDir = join(root, 'public', 'thumbs');

let overrides = {};
const ovPath = join(root, 'data', 'thumbnail-overrides.json');
if (existsSync(ovPath)) { try { overrides = JSON.parse(readFileSync(ovPath, 'utf8')); } catch {} }

const sleep = ms => new Promise(r => setTimeout(r, ms));

function pageUrl(gameUrl) {
  const m = String(gameUrl || '').match(/y8\.com\/embed\/([^/?#]+)/i);   // embed → public game page
  return m ? `https://www.y8.com/games/${m[1]}` : null;
}
function extractThumb(html) {
  const meta = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i);
  if (meta) return meta[1];
  const cdn = html.match(/https?:\/\/cdn\d*\.y8\.com\/cloudimage\/[^"'\s)\\]+\.(?:webp|jpe?g|png|gif)/i);
  return cdn ? cdn[0] : null;
}
async function fetchThumbUrl(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!r.ok) return null;
    return extractThumb(await r.text());
  } catch { return null; }
}
function extOf(url, contentType) {
  const m = String(url).match(/\.(webp|png|jpe?g|gif)(?:$|[?#])/i);
  let ext = m ? m[1].toLowerCase()
    : /webp/.test(contentType) ? 'webp' : /png/.test(contentType) ? 'png'
    : /gif/.test(contentType) ? 'gif' : 'jpg';
  return ext === 'jpeg' ? 'jpg' : ext;
}
async function downloadTo(url, slug) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return null;
    const ext = extOf(url, r.headers.get('content-type') || '');
    if (!DRY) { mkdirSync(thumbsDir, { recursive: true }); writeFileSync(join(thumbsDir, `${slug}.${ext}`), buf); }
    return `/thumbs/${slug}.${ext}`;
  } catch { return null; }
}

// Fetch specific rows by slug / numeric id (used so manual overrides ALWAYS
// apply, even when the row already has a thumbnail).
async function fetchByKeys(slugs, ids) {
  const out = [];
  const pull = async (col, vals) => {
    for (let i = 0; i < vals.length; i += 150) {
      const { data, error } = await supabase
        .from('games').select('id, slug, title, game_url, thumbnail_url')
        .in(col, vals.slice(i, i + 150));
      if (error) { console.warn('⚠ Skipping thumbnails — Supabase read error (server still starts):', error.message); process.exit(0); }
      out.push(...(data || []));
    }
  };
  if (slugs.length) await pull('slug', slugs);
  if (ids.length)   await pull('id', ids);
  return out;
}

// Select rows to work on (paged).
async function getTargets() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('games').select('id, slug, title, game_url, thumbnail_url');
    q = SELF_HOST ? q.ilike('game_url', '%y8.com%') : q.is('thumbnail_url', null);
    // .order('id') is load-bearing, not cosmetic: LIMIT/OFFSET with no ORDER BY
    // has no defined row order in Postgres, so a page walk can return one row
    // twice and skip another. A skipped row here is a thumbnail never fetched.
    const { data, error } = await q.order('id', { ascending: true }).range(from, from + 999);
    if (error) { console.error('✗ Supabase read error:', error.message); process.exit(1); }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  // self-host: only localize y8 rows still pointing at a remote URL (or null).
  let list = SELF_HOST ? rows.filter(g => !g.thumbnail_url || /^https?:\/\//i.test(g.thumbnail_url)) : rows;

  // Manual overrides ALWAYS apply — pull their rows in even if they already have
  // a thumbnail, and merge (unique by id). This is what lets you drop verified
  // URLs into data/thumbnail-overrides.json and re-run to set them for good.
  const slugKeys = Object.keys(overrides).filter(k => !/^\d+$/.test(k));
  const idKeys   = Object.keys(overrides).filter(k => /^\d+$/.test(k)).map(Number);
  if (!MISSING_ONLY && (slugKeys.length || idKeys.length)) {
    const extra = await fetchByKeys(slugKeys, idKeys);
    const seen = new Set(list.map(r => r.id));
    for (const r of extra) if (!seen.has(r.id)) { list.push(r); seen.add(r.id); }
  }
  return list;
}

const targets = await getTargets();
console.log(`${targets.length} game(s) to process${SELF_HOST ? ' (self-host mode)' : ''}.${DRY ? '   (dry-run — no writes)' : ''}\n`);

let fixed = 0; const failed = [];
for (const g of targets) {
  // 1) Resolve the SOURCE image URL.
  let src = overrides[g.slug] || overrides[String(g.id)] || null;
  if (!src && SELF_HOST && /^https?:\/\//i.test(g.thumbnail_url || '')) src = g.thumbnail_url;
  if (!src) { const p = pageUrl(g.game_url); if (p) { src = await fetchThumbUrl(p); await sleep(400); } }
  if (!src) { failed.push(g); console.log(`  ✗ ${g.title}  [${g.slug}]`); continue; }

  // 2) Self-host: download it and store the LOCAL path instead of the remote URL.
  let finalUrl = src;
  if (SELF_HOST) {
    let local = await downloadTo(src, g.slug);
    // Self-heal: y8 rotates its cloudimage IDs, so a thumbnail URL we stored
    // earlier can start returning 403 even though the game still has a perfectly
    // good image. When the first download fails, re-resolve the CURRENT image
    // straight from the game's y8 page (og:image) and download that instead.
    if (!local) {
      const p = pageUrl(g.game_url);
      if (p) {
        const fresh = await fetchThumbUrl(p);
        await sleep(400);
        if (fresh && fresh !== src) { local = await downloadTo(fresh, g.slug); if (local) src = fresh; }
      }
    }
    if (!local) { failed.push(g); console.log(`  ✗ download ${g.slug}`); continue; }
    finalUrl = local;
    await sleep(200);
  }

  // 3) Write back to Supabase.
  if (!DRY) {
    const { error } = await supabase.from('games').update({ thumbnail_url: finalUrl }).eq('id', g.id);
    if (error) { failed.push(g); console.log(`  ✗ write ${g.slug}: ${error.message}`); continue; }
  }
  fixed++; console.log(`  ✓ ${g.title} → ${finalUrl.slice(0, 90)}`);
}

console.log(`\nDone. ${fixed} ${DRY ? 'would be ' : ''}fixed · ${failed.length} unresolved.`);
if (failed.length) {
  console.log('\nFor any that stayed unresolved, paste real image URLs into data/thumbnail-overrides.json and re-run:');
  console.log('{');
  failed.forEach((g, i) => console.log(`  "${g.slug}": ""${i < failed.length - 1 ? ',' : ''}   // ${g.title}  —  ${g.game_url}`));
  console.log('}');
}
