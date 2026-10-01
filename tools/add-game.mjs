// tools/add-game.mjs — add ONE specific game to the live catalog by URL.
// ---------------------------------------------------------------------------
// The Y8 tools (`y8-scrape`/`y8-sync`) pull the WHOLE Y8 embed directory in
// bulk. This is the opposite: a surgical "add exactly this one game" command,
// so you can grab a single title you like from Y8 (or GameDistribution /
// GameMonetize / OnlineGames.io / HTMLGames / Famobi / GameFlare) and it goes
// straight into the live Supabase catalog — no hand-written SQL.
//
// Usage (note the `--` so npm passes the flags through):
//   npm run add-game -- --url "https://www.y8.com/embed/slope" --title "Slope" --category arcade
//   npm run add-game -- --url "https://html5.gamedistribution.com/XXXXXXXX/"
//
// Flags:
//   --url       (required) the embeddable iframe URL from a trusted host
//   --title     display name           (default: derived from the slug)
//   --slug      URL id → /play/<slug>   (default: derived from title/url)
//   --category  arcade|racing|shooting|action|puzzle|sports|adventure|casual|board|simulator
//                                        (default: arcade)
//   --thumb     thumbnail image URL     (default: none → a branded tile is shown)
//   --no-verify skip the live "does it load + allow embedding" check
//
// It refuses non-https URLs, hosts that aren't licensed to embed, trademarked
// titles, and (unless --no-verify) URLs that are dead or block framing (which
// would black-screen). Then it UPSERTS one row into `games` (safe to re-run).
// Restart the server or wait ≤30 min for it to appear.
// ---------------------------------------------------------------------------
import '../lib/load-env.mjs';                         // MUST be first — loads .env
import { getSupabase, isSupabaseConfigured } from '../lib/supabase.mjs';
import { isTrademarkTitle } from '../lib/cron-jobs.mjs';   // same trademark blocklist as the site

// This is a CLI script, not a module: its top level mutates the live catalog.
// ESM runs that top level on import, so importing it would perform the write.
// Refuse loudly instead. Running it normally is unaffected.
import { isMain } from './_is-main.mjs';
if (!isMain(import.meta.url)) {
  throw new Error(
    'tools/add-game.mjs is a command-line script and must not be imported — ' +
    'importing it would run it against the live database. Run it with node instead.'
  );
}


// ---- parse --flag value args ----
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) { args[key] = next; i++; } else { args[key] = true; }
}

const die = (msg) => { console.error(msg); process.exit(1); };

const url = String(args.url || '').trim();
if (!url) die('Missing --url.\n  Example: npm run add-game -- --url "https://www.y8.com/embed/slope" --title "Slope" --category arcade');
if (!/^https:\/\//i.test(url)) die('❌ The URL must start with https://');

// ---- trusted embed hosts (same allowlist the recommend form + grow job use) ----
const TRUSTED = ['gamedistribution.com', 'onlinegames.io', 'gamemonetize.com', 'gamemonetize.co', 'htmlgames.com', 'famobi.com', 'gameflare.com'];
const isY8Embed = /^https:\/\/(www\.)?y8\.com\/embed\//i.test(url);
function hostOk(u) {
  try { const h = new URL(u).host.toLowerCase(); return isY8Embed || TRUSTED.some(s => h === s || h.endsWith('.' + s)); }
  catch { return false; }
}
if (!hostOk(url)) die('❌ That host isn\'t in the trusted embed allowlist.\n   Allowed: GameDistribution, OnlineGames.io, GameMonetize, HTMLGames, Famobi, GameFlare, or a y8.com/embed/ link.\n   (Other hosts usually block iframing or aren\'t licensed to embed.)');

// ---- slug + title ----
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
let slug = args.slug ? slugify(args.slug) : '';
let title = String(args.title || '').trim();
if (!slug) {
  if (title) slug = slugify(title);
  else { try { slug = slugify(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch {} }
}
if (!title) title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
if (!slug || !title) die('❌ Couldn\'t work out a slug/title from that URL. Pass --slug and --title explicitly.');
if (isTrademarkTitle(title)) die(`❌ "${title}" looks like a trademarked name we can't host. Pick a different title/game.`);

const CATEGORIES = ['arcade', 'racing', 'shooting', 'action', 'puzzle', 'sports', 'adventure', 'casual', 'board', 'simulator'];
let category = String(args.category || 'arcade').toLowerCase();
if (!CATEGORIES.includes(category)) { console.warn(`⚠  Unknown category "${category}" → using "arcade". Valid: ${CATEGORIES.join(', ')}`); category = 'arcade'; }
const thumbnail_url = String(args.thumb || '').trim() || null;

// ---- live verify: reachable + not frame-blocked (so it can't black-screen) ----
if (!args['no-verify']) {
  process.stdout.write('Checking the game loads and allows embedding… ');
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36', 'Range': 'bytes=0-4096' } });
    clearTimeout(t);
    if (r.status >= 400) { console.log(''); die(`❌ The URL returned HTTP ${r.status} — it's dead or wrong. Not adding.`); }
    const xfo = (r.headers.get('x-frame-options') || '').toLowerCase();
    const csp = r.headers.get('content-security-policy') || '';
    const frameBlocked = /\b(deny|sameorigin)\b/.test(xfo) || (/frame-ancestors\b/i.test(csp) && !/frame-ancestors\s+[^;]*\*/i.test(csp));
    if (frameBlocked) { console.log(''); die('❌ This page refuses to be embedded (X-Frame-Options / CSP) — it would show a black screen.\n   Not adding. Add --no-verify to force it if you\'re certain.'); }
    console.log('OK ✓');
  } catch (e) {
    console.log('');
    die(`❌ Couldn't reach the URL (${e.name === 'AbortError' ? 'timeout' : e.message}). Not adding.\n   Add --no-verify to skip this check.`);
  }
}

// ---- upsert into Supabase ----
if (!isSupabaseConfigured()) die('❌ Supabase not configured — check .env has SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.');
const supa = getSupabase();
const row = { slug, title, game_url: url, thumbnail_url, category, is_working: true };
const { error } = await supa.from('games').upsert(row, { onConflict: 'slug' });
if (error) die('❌ Insert failed: ' + error.message);

console.log(`\n✅ Added "${title}" to the catalog.`);
console.log(`   slug:     ${slug}`);
console.log(`   category: ${category}`);
console.log(`   URL:      /play/${slug}`);
console.log(`\nRun \`npm run restart\` (or wait ≤30 min) for it to appear on the live site.`);
process.exit(0);
