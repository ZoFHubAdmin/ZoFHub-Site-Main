// tools/build-merged.mjs
//
// Merge 4 catalog sources into a single ~<1000-entry top_games.json:
//   1. data/top_games.json    (curated picks — always kept, highest priority)
//   2. everygame.json         (licensed publisher dump — 4 platforms)
//   3. master_games.json      (the big legacy catalog)
//   4. somethingrandom.json   (HTMLGames + Famobi fallback)
//
// Strategy:
//   • Normalize all entries to a common shape
//   • Drop broken / non-iframe embeds (HTML <script> fragments, bare hostnames,
//     Famobi, missing URLs, suspicious fabricated GameDistribution IDs)
//   • Dedupe by slug (curated > everygame > master > somethingrandom)
//   • Score by quality (thumbnail + tags + known platform)
//   • Round-robin per category so no single bucket dominates
//   • Cap at TARGET_COUNT (default 900) for headroom under 1000
//
// Run:
//   node tools/build-merged.mjs
//   node tools/cleanup-ip.mjs       # trims IP/trademark hits from the result
//   node tools/build-curated.mjs    # writes api/games.json

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const TARGET_COUNT = 900;
const GAMEZOP_PUBLISHER_ID = 'zv1y2i8p';

// ---------- normalization helpers ----------
function decodeEntities(s = '') {
  return String(s)
    .replace(/&amp;amp;/g, '&').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—').replace(/&rsquo;/g, '’')
    .replace(/&nbsp;/g, ' ').trim();
}
function slugify(t) {
  return decodeEntities(t || 'game').toLowerCase()
    .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 80) || 'game';
}
function rewriteGamezopUrl(url) {
  if (!url) return url;
  return url.replace(/https?:\/\/[a-z0-9]+\.play\.gamezop\.com/i,
                     `https://${GAMEZOP_PUBLISHER_ID}.play.gamezop.com`);
}

// Category mapping: many spellings → canonical slug used everywhere downstream.
const CAT_MAP = {
  'arcade':'arcade','arcades':'arcade','classic':'arcade',
  'racing':'racing','car':'racing','cars':'racing',
  'shooting':'shooting','shooter':'shooting','shoot':'shooting',
  'action':'action','adventure':'adventure','strategy':'strategy',
  'sports':'sports','sport':'sports',
  'puzzle':'puzzle','puzzles':'puzzle','puzzle games':'puzzle',
  'match 3 games':'puzzle','match3':'puzzle',
  'hidden object games':'puzzle','hidden object':'puzzle',
  'mahjong solitaire':'puzzle','mahjong games':'puzzle','mahjong connect':'puzzle',
  'tripeaks & golf':'card','klondike':'card','solitaire':'card',
  'card games':'card','card':'card',
  'bubble shooter':'arcade','collapse games':'arcade','bejeweled':'arcade',
  'word games':'puzzle','daily puzzles':'puzzle',
  'simulator':'simulator','simulation':'simulator',
  '2 player':'2-player','2-player':'2-player','two player':'2-player',
  'io games':'io-games','io':'io-games','.io':'io-games',
  'clicker':'clicker','idle':'clicker',
  'casual':'casual','hypercasual':'casual',
  'sandbox':'sandbox','survival':'survival','horror':'horror',
  'music':'music','rhythm':'music',
  'girls':'casual','kids':'casual',
};
function canonCategory(raw) {
  if (!raw) return 'arcade';
  const k = String(raw).trim().toLowerCase();
  return CAT_MAP[k] || k.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'arcade';
}

// ---------- skip rules ----------
const BARE_BLOCK_HOSTS = new Set([
  'smashkarts.io','deadshot.io','lolbeans.io','bloxd.io','suroi.io',
  'krunker.io','agar.io','slither.io','venge.io','diep.io','bonk.io',
  '1v1.lol','shellshock.io','footballbros.io',
]);
function isUsable(embedUrl) {
  if (!embedUrl) return false;
  // HTMLGames script-embeds (everygame.json has these for 1,201 games)
  if (/<\s*script|<\s*div|<\s*iframe/i.test(embedUrl)) return false;
  // Famobi never plays (no partner ID)
  if (/famobi\.com/i.test(embedUrl)) return false;
  // Known pirate/proxy mirrors
  if (/duckmath\.org|unblockedgames|coolmathgames/i.test(embedUrl)) return false;
  // S3-hosted unblocked-games dumps (not licensed)
  if (/unblocked-games\.s3\.amazonaws\.com/i.test(embedUrl)) return false;
  let u;
  try { u = new URL(embedUrl); } catch { return false; }
  // Bare-hostname URLs to competitor sites — won't iframe (X-Frame-Options)
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const bare = (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash;
  if (bare && BARE_BLOCK_HOSTS.has(host)) return false;
  // Fabricated GameDistribution IDs (sequential hex like e5f6a7b8c9d0e1f2)
  if (/gamedistribution\.com/i.test(host)) {
    const m = /\/([0-9a-f]{32})\//.exec(u.pathname);
    if (m && /(0123|1234|2345|3456|4567|5678|6789|789a|89ab|9abc|abcd|bcde|cdef|fedc|dcba|cba9|ba98|a987|9876|8765|7654|6543|5432)/.test(m[1])) return false;
    if (m && /(.)\1{3,}/.test(m[1])) return false;
  }
  return true;
}
function inferPlatform(url) {
  if (/gamemonetize\.(co|com)/i.test(url))      return 'GameMonetize';
  if (/gamedistribution\.com/i.test(url))       return 'GameDistribution';
  if (/htmlgames\.com/i.test(url))              return 'HTMLGames';
  if (/play\.gamezop\.com/i.test(url))          return 'Gamezop';
  if (/distribution\.gameflare\.com/i.test(url))return 'GameFlare';
  if (/onlinegames\.io/i.test(url))             return 'OnlineGames.io';
  return 'Other';
}

// ---------- read sources ----------
function readJson(p) {
  try { return JSON.parse(readFileSync(join(ROOT, p), 'utf8')); }
  catch (e) { console.warn(`  skip ${p}: ${e.message}`); return null; }
}
const curated         = readJson('data/top_games.json')    || [];
const everygame       = readJson('everygame.json')         || [];
const master          = readJson('master_games.json')      || [];
const somethingrandom = readJson('somethingrandom.json')   || [];

console.log(`Sources:\n  curated: ${curated.length}\n  everygame: ${everygame.length}\n  master: ${master.length}\n  somethingrandom: ${somethingrandom.length}`);

// ---------- normalize each source ----------
function normFromCurated(c, idx) {
  return {
    title: decodeEntities(c.title),
    embed_url: rewriteGamezopUrl(c.embed || c.embed_url),
    thumbnail: c.image || c.thumbnail || null,
    category: canonCategory(c.category),
    tags: c.tags ? (Array.isArray(c.tags) ? c.tags : String(c.tags).split(',').map(s => s.trim()).filter(Boolean)) : null,
    platform: inferPlatform(c.embed || c.embed_url || ''),
    priority: 0,    // highest priority — curated picks win every dedup
    order: idx,
  };
}
function normFromEverygame(g, idx) {
  return {
    title: decodeEntities(g.title),
    embed_url: rewriteGamezopUrl(g.embed || g.embed_url),
    thumbnail: g.image || g.thumbnail || null,
    category: canonCategory(g.category),
    tags: g.tags ? String(g.tags).split(',').map(s => s.trim()).filter(Boolean) : null,
    platform: inferPlatform(g.embed || g.embed_url || ''),
    priority: 1,
    order: idx,
  };
}
function normFromMaster(g, idx) {
  return {
    title: decodeEntities(g.title),
    embed_url: rewriteGamezopUrl(g.embed_url),
    thumbnail: g.thumbnail || null,
    category: canonCategory(g.category),
    tags: Array.isArray(g.tags) ? g.tags : null,
    platform: g.platform || inferPlatform(g.embed_url || ''),
    priority: 2,
    order: idx,
  };
}
function normFromSomethingrandom(g, idx) {
  return {
    title: decodeEntities(g.title),
    embed_url: rewriteGamezopUrl(g.link || g.embed_url),
    thumbnail: g.thumbnail || null,
    category: canonCategory(g.category),
    tags: null,
    platform: g.source || inferPlatform(g.link || g.embed_url || ''),
    priority: 3,
    order: idx,
  };
}

const all = [
  ...curated.map(normFromCurated),
  ...everygame.map(normFromEverygame),
  ...master.map(normFromMaster),
  ...somethingrandom.map(normFromSomethingrandom),
];

// ---------- filter ----------
const filtered = all.filter(g => g.title && isUsable(g.embed_url));
console.log(`After filter (drop broken/Famobi/bare-host/fake-ID): ${filtered.length}`);

// ---------- dedupe by slug, keep highest priority ----------
const bySlug = new Map();
for (const g of filtered) {
  const slug = slugify(g.title);
  const cur = bySlug.get(slug);
  if (!cur || g.priority < cur.priority) bySlug.set(slug, { ...g, slug });
}
console.log(`After dedupe: ${bySlug.size}`);

// ---------- quality score ----------
function score(g) {
  let s = 0;
  if (g.thumbnail) s += 3;
  if (g.tags?.length) s += 2;
  // Known licensing platforms outrank "Other"
  if (['GameMonetize','GameDistribution','HTMLGames','Gamezop','GameFlare','OnlineGames.io'].includes(g.platform)) s += 3;
  // Curated picks always sort first
  if (g.priority === 0) s += 100;
  // Subtler: earlier in source list (publisher's "featured" ordering) > later
  s += Math.max(0, 5 - Math.floor(g.order / 200));
  return s;
}

// ---------- bucket by category, sort each by score ----------
const buckets = new Map();
for (const g of bySlug.values()) {
  if (!buckets.has(g.category)) buckets.set(g.category, []);
  buckets.get(g.category).push(g);
}
for (const list of buckets.values()) list.sort((a, b) => score(b) - score(a));

console.log(`Categories: ${buckets.size}`);
[...buckets.entries()].sort((a,b)=>b[1].length-a[1].length).slice(0,10)
  .forEach(([k,v]) => console.log(`  ${String(v.length).padStart(5)}  ${k}`));

// ---------- round-robin pick until cap hit ----------
// Each round, take one game from each non-empty category in descending size
// order.  Stops when we reach TARGET_COUNT or all buckets are empty.
const order = [...buckets.keys()].sort((a, b) => buckets.get(b).length - buckets.get(a).length);
const picked = [];
let exhausted = false;
while (picked.length < TARGET_COUNT && !exhausted) {
  exhausted = true;
  for (const cat of order) {
    if (picked.length >= TARGET_COUNT) break;
    const list = buckets.get(cat);
    if (list.length) {
      picked.push(list.shift());
      exhausted = false;
    }
  }
}
console.log(`Picked: ${picked.length} / target ${TARGET_COUNT}`);

// ---------- write top_games.json in the curated shape ----------
const out = picked.map(g => ({
  title: g.title,
  embed: g.embed_url,
  image: g.thumbnail || '',
  category: g.category,
  tags: Array.isArray(g.tags) ? g.tags.join(',') : '',
}));

// Backup current top_games.json once.
const tg = join(ROOT, 'data', 'top_games.json');
const bak = tg + '.before-merge.bak';
if (existsSync(tg) && !existsSync(bak)) copyFileSync(tg, bak);

writeFileSync(tg, JSON.stringify(out, null, 2), 'utf8');
console.log(`\nWrote data/top_games.json — ${out.length} games`);
console.log(`Backup saved at data/top_games.json.before-merge.bak`);

// Final per-category histogram
const finalCats = {};
out.forEach(g => { finalCats[g.category] = (finalCats[g.category] || 0) + 1; });
console.log('\nFinal per-category counts:');
Object.entries(finalCats).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));

console.log('\nNext:  node tools/cleanup-ip.mjs  &&  node tools/build-curated.mjs');
