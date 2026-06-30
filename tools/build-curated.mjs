// tools/build-curated.mjs
//
// Build api/games.json from data/top_games.json ONLY.
// (Skips master_games.json and somethingrandom.json — start small and grow.)
//
// Run:  node tools/build-curated.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const GAMEZOP_PUBLISHER_ID = 'zv1y2i8p';

// Canonical category map.  Anything not in here keeps its slug but falls back
// to "Other" in nav.  Order here = sort order on the homepage.
const CATEGORIES = [
  { slug: 'racing',    label: 'Racing',    icon: 'car' },
  { slug: 'arcade',    label: 'Arcade',    icon: 'joystick' },
  { slug: 'shooting',  label: 'Shooting',  icon: 'target' },
  { slug: 'action',    label: 'Action',    icon: 'bolt' },
  { slug: 'sports',    label: 'Sports',    icon: 'ball' },
  { slug: 'puzzle',    label: 'Puzzle',    icon: 'puzzle' },
  { slug: 'simulator', label: 'Simulator', icon: 'cube' },
  { slug: '2-player',  label: '2-Player',  icon: 'users' },
  { slug: 'io-games',  label: 'IO Games',  icon: 'globe' },
  { slug: 'clicker',   label: 'Clicker',   icon: 'tap' },
  { slug: 'casual',    label: 'Casual',    icon: 'smile' },
  { slug: 'strategy',  label: 'Strategy',  icon: 'chess' },
  { slug: 'card',      label: 'Card',      icon: 'card' },
  { slug: 'survival',  label: 'Survival',  icon: 'compass' },
  { slug: 'adventure', label: 'Adventure', icon: 'compass' },
  { slug: 'sandbox',   label: 'Sandbox',   icon: 'cube' },
  { slug: 'music',     label: 'Music',     icon: 'note' },
  { slug: 'horror',    label: 'Horror',    icon: 'ghost' },
];
const CATEGORY_LOOKUP = new Map(CATEGORIES.map(c => [c.slug, c]));

function normCategorySlug(raw) {
  if (!raw) return 'other';
  return String(raw).trim().toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'other';
}

function slugify(t) {
  return String(t || 'game').toLowerCase()
    .replace(/&amp;/g, 'and').replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'game';
}

function decodeEntities(s = '') {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—').replace(/&rsquo;/g, '’')
    .replace(/&nbsp;/g, ' ');
}

function rewriteGamezopUrl(url) {
  if (!url) return url;
  return url.replace(/https?:\/\/[a-z0-9]+\.play\.gamezop\.com/i,
                     `https://${GAMEZOP_PUBLISHER_ID}.play.gamezop.com`);
}

function inferPlatform(url) {
  if (!url) return 'Unknown';
  if (/gamemonetize\.(co|com)/i.test(url))      return 'GameMonetize';
  if (/gamedistribution\.com/i.test(url))       return 'GameDistribution';
  if (/htmlgames\.com/i.test(url))              return 'HTMLGames';
  if (/play\.gamezop\.com/i.test(url))          return 'Gamezop';
  if (/distribution\.gameflare\.com/i.test(url))return 'GameFlare';
  if (/onlinegames\.io/i.test(url))             return 'OnlineGames.io';
  return 'Other';
}

// ---------- main ----------
const curated = JSON.parse(readFileSync(join(ROOT, 'data', 'top_games.json'), 'utf8'));

const seen = new Set();
const games = [];
for (let i = 0; i < curated.length; i++) {
  const c = curated[i];
  const title = decodeEntities((c.title || '').trim());
  if (!title) continue;
  const slugBase = slugify(title);
  let slug = slugBase, n = 2;
  while (seen.has(slug)) slug = `${slugBase}-${n++}`;
  seen.add(slug);

  const embedUrl = rewriteGamezopUrl(c.embed || c.embed_url || c.link);
  if (!embedUrl) continue;

  const catSlug = normCategorySlug(c.category);
  const tags = c.tags
    ? (Array.isArray(c.tags) ? c.tags : String(c.tags).split(',').map(s => s.trim()).filter(Boolean))
    : null;

  games.push({
    slug,
    title,
    description: null,
    embed_url: embedUrl,
    thumbnail: c.image || c.thumbnail || null,
    category: catSlug,
    category_label: CATEGORY_LOOKUP.get(catSlug)?.label || (catSlug.charAt(0).toUpperCase() + catSlug.slice(1).replace(/-/g, ' ')),
    tags,
    platform: inferPlatform(embedUrl),
    orientation: 'landscape',
    width: 1280,
    height: 720,
    monetizable: true,
    is_featured: i < 18,                    // first 18 surfaced as hero
    is_trending: i >= 18 && i < 36,         // next 18 as "trending"
    is_new:      i >= 36 && i < 54,         // next 18 as "fresh drops"
    is_curated: true,
    plays: 0
  });
}

// Compute category counts and the in-order list of categories that actually
// have at least one game (drop empty buckets from nav).
const counts = {};
for (const g of games) counts[g.category] = (counts[g.category] || 0) + 1;
const categoriesUsed = CATEGORIES
  .filter(c => counts[c.slug])
  .map(c => ({ ...c, count: counts[c.slug] }));

const payload = {
  generatedAt: new Date().toISOString(),
  count: games.length,
  categories: categoriesUsed,
  games
};

mkdirSync(join(ROOT, 'api'), { recursive: true });
writeFileSync(join(ROOT, 'api', 'games.json'), JSON.stringify(payload, null, 2), 'utf8');
console.log(`Wrote api/games.json — ${games.length} games across ${categoriesUsed.length} categories`);
console.log('Categories:');
categoriesUsed.forEach(c => console.log(`  ${String(c.count).padStart(4)}  ${c.label}  (/category/${c.slug})`));
