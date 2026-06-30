// tools/audit-thumbnails.mjs
// ---------------------------------------------------------------------------
// Find EVERY game whose thumbnail doesn't actually load in a browser, and
// optionally fix them by self-hosting a working copy.
//
// WHY a tool (and not a one-off): a thumbnail can be "set" in the DB yet still
// show blank because the publisher's CDN blocks hotlinking (returns 403 to any
// off-site request) or the image was removed (404). The only accurate test is
// to fetch each URL the way a browser does — with the site's own Referer — and
// see what comes back. That needs real network access, so you run this.
//
// Known hotlink-blocked hosts (confirmed 403 to off-site requests):
//   onlinegames.io, cdn.htmlgames.com   ← e.g. "Spacebar Clicker"
// Known-good hosts: img.gamemonetize.com, img.cdn.famobi.com, static.gamezop.com,
//   data.gameflare.com, img.gamedistribution.com
// (The probe still checks every host — individual URLs anywhere can be dead.)
//
// MODES
//   (default)     PROBE only. Writes data/thumbnail-audit.json + prints a
//                 per-host summary and the exact list of broken games. No changes.
//   --self-host   For each broken thumbnail, download a working copy into
//                 public/thumbs/<slug>.<ext> (trying the publisher's own Referer
//                 so hotlink protection lets us through), then add a serve-time
//                 override so the site uses the local image. No DB write.
//   --dry-run     With --self-host: show what would be downloaded, write nothing.
//
// OPTIONS
//   --from-export        read the game list from data/games-export.json (offline
//                        source) instead of Supabase. Probing still needs network.
//   --referer <url>      Referer to probe with (default http://localhost:8080).
//                        Use your real domain to test production behavior.
//   --hosts a,b,c        only probe thumbnails on these hosts (faster targeting).
//   --concurrency <n>    parallel probes (default 12).
//   --limit <n>          only process the first N games (for a quick test).
//
//   Preview broken list:   npm run audit-thumbnails
//   Fix everything:        npm run audit-thumbnails -- --self-host
//   Target the bad hosts:  npm run audit-thumbnails -- --self-host --hosts onlinegames.io,cdn.htmlgames.com
// ---------------------------------------------------------------------------
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
for (const f of ['.env', '.env.example']) {
  const p = join(ROOT, f);
  if (existsSync(p) && typeof process.loadEnvFile === 'function') { try { process.loadEnvFile(p); } catch {} break; }
}

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const SELF_HOST   = has('--self-host');
const DRY         = has('--dry-run');
const FROM_EXPORT = has('--from-export');
const REFERER     = val('--referer', 'http://localhost:8080');
const CONCURRENCY = Math.max(1, parseInt(val('--concurrency', '12'), 10) || 12);
const LIMIT       = parseInt(val('--limit', '0'), 10) || 0;
const HOSTS_FILTER = (val('--hosts', '') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const THUMBS_DIR = join(ROOT, 'public', 'thumbs');
const OVERRIDES_PATH = join(ROOT, 'data', 'catalog-overrides.json');
const REPORT_PATH = join(ROOT, 'data', 'thumbnail-audit.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hostOf = (u) => { try { return new URL(u).host.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

// Referer that satisfies a publisher's hotlink check when downloading.
function publisherReferer(url) {
  const h = hostOf(url);
  if (h.includes('onlinegames.io')) return 'https://www.onlinegames.io/';
  if (h.includes('htmlgames.com'))  return 'https://www.htmlgames.com/';
  if (h.includes('gamemonetize'))   return 'https://gamemonetize.com/';
  if (h.includes('famobi'))         return 'https://games.cdn.famobi.com/';
  if (h.includes('gamedistribution')) return 'https://gamedistribution.com/';
  if (h.includes('gameflare'))      return 'https://www.gameflare.com/';
  if (h.includes('gamezop'))        return 'https://www.gamezop.com/';
  try { return new URL(url).origin + '/'; } catch { return ''; }
}

const MAGIC = (buf) => {
  if (!buf || buf.length < 4) return false;
  const b = buf;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[0] === 0x42 && b[1] === 0x4D) return 'bmp';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  // SVG / XML starts with '<'
  if (b[0] === 0x3C) return 'svg';
  return false;
};

function extFrom(url, contentType, magic) {
  if (magic && magic !== 'svg') return magic === 'jpeg' ? 'jpg' : magic;
  const m = String(url).match(/\.(webp|png|jpe?g|gif|svg)(?:$|[?#])/i);
  if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const ct = contentType || '';
  if (/webp/.test(ct)) return 'webp';
  if (/png/.test(ct)) return 'png';
  if (/gif/.test(ct)) return 'gif';
  if (/svg/.test(ct)) return 'svg';
  return 'jpg';
}

// Probe a URL the way a browser <img> would: real UA + the site's Referer.
// Returns { ok, status, reason, contentType }.
async function probe(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Referer': REFERER,
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!r.ok) { try { await r.body?.cancel(); } catch {} return { ok: false, status: r.status, reason: `HTTP ${r.status}`, contentType: ct }; }
    // Read a small head slice to verify it's really an image (some hotlink
    // walls return 200 + an HTML "denied" page).
    const ab = await r.arrayBuffer();
    const buf = Buffer.from(ab);
    const magic = MAGIC(buf);
    if (ct.startsWith('image/') || magic) {
      if (buf.length < 256) return { ok: false, status: r.status, reason: `tiny (${buf.length}b)`, contentType: ct };
      return { ok: true, status: r.status, reason: 'image', contentType: ct };
    }
    return { ok: false, status: r.status, reason: `not-image (${ct || 'unknown'})`, contentType: ct };
  } catch (e) {
    return { ok: false, status: 0, reason: e.name === 'AbortError' ? 'timeout' : (e.message || 'error'), contentType: '' };
  } finally { clearTimeout(t); }
}

// Download a working copy, trying referers until one yields a real image.
async function download(url, slug) {
  const referers = [publisherReferer(url), '', REFERER];
  for (const ref of referers) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const headers = { 'User-Agent': UA, 'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8' };
      if (ref) headers['Referer'] = ref;
      const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers });
      if (!r.ok) { continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      const magic = MAGIC(buf);
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (buf.length < 256 || !(ct.startsWith('image/') || magic)) continue;
      const ext = extFrom(url, ct, magic);
      if (!DRY) { mkdirSync(THUMBS_DIR, { recursive: true }); writeFileSync(join(THUMBS_DIR, `${slug}.${ext}`), buf); }
      return { path: `/thumbs/${slug}.${ext}`, bytes: buf.length, via: ref || '(no referer)' };
    } catch { /* try next referer */ }
    finally { clearTimeout(t); }
  }
  return null;
}

// ---- load games ----
async function loadGames() {
  if (FROM_EXPORT) {
    const f = join(ROOT, 'data', 'games-export.json');
    const arr = JSON.parse(readFileSync(f, 'utf8'));
    return (Array.isArray(arr) ? arr : (arr.games || [])).map(g => ({ id: g.id, slug: g.slug, title: g.title, game_url: g.game_url, thumbnail_url: g.thumbnail_url }));
  }
  const { getSupabase } = await import('../lib/supabase.mjs');
  const supa = getSupabase();
  if (!supa) { console.error('✗ Supabase not configured. Add creds to .env or use --from-export.'); process.exit(1); }
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supa.from('games').select('id, slug, title, game_url, thumbnail_url').range(from, from + 999);
    if (error) { console.error('✗ Supabase read error:', error.message); process.exit(1); }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

// ---- worker pool ----
async function pool(items, n, worker) {
  let i = 0, done = 0;
  const total = items.length;
  const runners = new Array(Math.min(n, total)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
      done++;
      if (done % 200 === 0 || done === total) process.stdout.write(`\r  …processed ${done}/${total}`);
    }
  });
  await Promise.all(runners);
  if (total) process.stdout.write('\n');
}

// ===========================================================================
(async function main() {
  console.log(`[thumbs] mode: ${SELF_HOST ? (DRY ? 'SELF-HOST (dry run)' : 'SELF-HOST') : 'PROBE only'} · referer: ${REFERER} · concurrency: ${CONCURRENCY}`);

  const { applyCatalogOverrides } = await import('../lib/catalog-overrides.mjs');
  const raw = await loadGames();
  // Apply current overrides: drops removed games and rewrites already-fixed ones
  // to their local /thumbs path so we don't re-probe what's handled.
  let games = applyCatalogOverrides(raw);
  console.log(`[thumbs] catalog: ${raw.length} rows → ${games.length} after overrides (removed ${raw.length - games.length}).`);

  // Build the probe worklist.
  const local = [], empty = [], remote = [];
  for (const g of games) {
    const tu = (g.thumbnail_url || g.thumbnail || '').trim();
    if (!tu) { empty.push(g); continue; }
    if (!/^https?:\/\//i.test(tu)) { local.push(g); continue; }   // /thumbs/... served by us
    if (HOSTS_FILTER.length && !HOSTS_FILTER.includes(hostOf(tu))) continue;
    remote.push({ ...g, _thumb: tu });
  }
  let work = remote;
  if (LIMIT) work = work.slice(0, LIMIT);
  console.log(`[thumbs] local/self-hosted: ${local.length} · empty: ${empty.length} · remote to probe: ${work.length}`);

  // ---- probe ----
  const broken = [];
  const okByHost = {}, badByHost = {};
  await pool(work, CONCURRENCY, async (g) => {
    const res = await probe(g._thumb);
    const h = hostOf(g._thumb);
    if (res.ok) { okByHost[h] = (okByHost[h] || 0) + 1; }
    else { badByHost[h] = (badByHost[h] || 0) + 1; broken.push({ slug: g.slug, title: g.title, host: h, thumbnail_url: g._thumb, reason: res.reason, status: res.status }); }
  });

  console.log(`\n[thumbs] ===== RESULT =====`);
  console.log(`[thumbs] OK: ${work.length - broken.length} · BROKEN: ${broken.length} · empty(no url): ${empty.length}`);
  const hosts = [...new Set([...Object.keys(okByHost), ...Object.keys(badByHost)])].sort((a, b) => (badByHost[b] || 0) - (badByHost[a] || 0));
  console.log(`[thumbs] per-host (ok / broken):`);
  for (const h of hosts) console.log(`   ${h.padEnd(34)} ok=${(okByHost[h] || 0).toString().padStart(5)}  broken=${(badByHost[h] || 0).toString().padStart(5)}`);

  // Write the report (exact broken list).
  const report = { generatedAt: new Date().toISOString(), referer: REFERER, totals: { probed: work.length, ok: work.length - broken.length, broken: broken.length, emptyNoUrl: empty.length }, brokenByHost: badByHost, broken, emptyNoUrl: empty.map(g => ({ slug: g.slug, title: g.title })) };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(`[thumbs] wrote exact broken list → data/thumbnail-audit.json`);

  if (!SELF_HOST) {
    console.log(`\n[thumbs] PROBE-only. To fix: npm run audit-thumbnails -- --self-host`);
    process.exit(0);
  }

  // ---- self-host the broken ones ----
  console.log(`\n[thumbs] self-hosting ${broken.length} broken thumbnail(s)…`);
  const fixed = [], failed = [];
  await pool(broken, Math.min(CONCURRENCY, 8), async (b) => {
    const got = await download(b.thumbnail_url, b.slug);
    if (got) fixed.push({ slug: b.slug, path: got.path, via: got.via, bytes: got.bytes });
    else failed.push(b.slug);
  });
  console.log(`\n[thumbs] downloaded: ${fixed.length} · could-not-fetch: ${failed.length}`);

  // Merge new patches into catalog-overrides.json (skip dupes).
  if (fixed.length && !DRY) {
    const cfg = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
    cfg.patch = cfg.patch || [];
    const patched = new Set(cfg.patch.filter(p => p.match && p.match.slug).map(p => p.match.slug));
    let added = 0;
    for (const f of fixed) {
      if (patched.has(f.slug)) {
        // update existing patch's thumbnail
        const p = cfg.patch.find(p => p.match && p.match.slug === f.slug);
        p.set = { ...(p.set || {}), thumbnail_url: f.path };
      } else {
        cfg.patch.push({ match: { slug: f.slug }, set: { thumbnail_url: f.path } });
        patched.add(f.slug); added++;
      }
    }
    writeFileSync(OVERRIDES_PATH, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`[thumbs] catalog-overrides.json: +${added} new patch(es) (total ${cfg.patch.length}).`);
  }

  if (failed.length) console.log(`[thumbs] NOTE: ${failed.length} couldn't be fetched even with a publisher Referer (listed in data/thumbnail-audit.json under "broken"). These may be genuinely removed upstream.`);
  console.log(`\n[thumbs] Done.${DRY ? ' (dry run — nothing written)' : ' Restart the server to apply: npm run restart'}`);
  process.exit(0);
})().catch(e => { console.error('[thumbs] fatal:', e.message); process.exit(1); });
