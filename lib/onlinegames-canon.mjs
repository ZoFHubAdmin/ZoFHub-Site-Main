// OnlineGames.io canonical dataset.
//
// embedonlinegamesio.json is the single source of truth for which OnlineGames.io
// titles this site is allowed to embed. Everything here reconciles the live
// catalog against it: what matches, what must go, what is duplicated, and what
// is missing.
//
// THE TRAP THIS FILE EXISTS TO AVOID
// Searching the catalog for the string "onlinegames.io" finds 348 rows. Only 311
// are OnlineGames.io games. The other 37 are GameDistribution games that merely
// name the site in a tracking parameter:
//
//   https://html5.gamedistribution.com/60a97d02…/?gd_sdk_referrer_url=https://www.onlinegames.io/gt-cars-city-racing/
//
// Those belong to a different provider under a different licence. A text match
// would delete 37 legitimate games, so identity is decided by the URL's HOST and
// never by a substring.
//
// The canonical file has no id and no slug — only title, embed, image, tags and
// description. Identity therefore comes from the normalised embed URL, which is
// the only field that is genuinely unique and stable.

const OG_HOST = /(^|\.)onlinegames\.io$/i;

/** True only when the game is actually SERVED from onlinegames.io. */
export function isOnlineGamesUrl(url) {
  try { return OG_HOST.test(new URL(String(url)).host); } catch { return false; }
}

/**
 * Identity key for an OnlineGames.io embed: host + path, nothing else.
 *
 * Query strings on these URLs carry cache-busters and referrers, not game
 * selection, so two URLs differing only there are the same game. Returns '' for
 * anything not served by OnlineGames.io, so a non-OG row can never collide with
 * a canonical entry.
 */
export function embedKey(url) {
  let u;
  try { u = new URL(String(url)); } catch { return ''; }
  if (!OG_HOST.test(u.host)) return '';
  return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '').toLowerCase()}`;
}

/** The repo's slug convention (tools/add-game.mjs), kept identical on purpose. */
export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// Tag -> site category. Ordered: the FIRST match wins, so the more specific
// buckets are listed before the broad ones. Without an order, "3d,racing,arcade"
// would land in whichever key the object happened to iterate first.
const CATEGORY_RULES = [
  // Modes people deliberately browse for come first — someone looking for a
  // two-player game wants that filter more than they want the genre.
  ['2-player',    ['2-player', 'two-player', '2player']],
  ['io-games',    ['io-games', 'io-game', '.io']],
  // Then GENRE. "multiplayer" sits below these on purpose: it was ranked above
  // them at first, which turned a drift-racing game tagged
  // "3d,car,drift,multiplayer" into category "multiplayer" — true, but useless
  // next to "racing". Mode is the weaker label whenever a genre is present.
  ['racing',      ['racing', 'car', 'cars', 'drift', 'bike', 'motorcycle', 'truck', 'driving']],
  ['shooting',    ['shooting', 'shooter', 'gun', 'guns', 'fps', 'sniper']],
  ['sports',      ['sports', 'football', 'soccer', 'basketball', 'golf', 'pool', 'tennis']],
  ['puzzle',      ['puzzle', 'match-3', 'match3', 'brain', 'logic', 'sudoku', 'jigsaw']],
  ['clicker',     ['clicker', 'idle', 'incremental']],
  ['simulator',   ['simulator', 'simulation', 'tycoon', 'management', 'cooking']],
  ['strategy',    ['strategy', 'tower-defense', 'defense', 'tactics']],
  ['adventure',   ['adventure', 'rpg', 'quest', 'story']],
  ['horror',      ['horror', 'scary', 'zombie', 'zombies']],
  ['action',      ['action', 'fighting', 'fight', 'battle', 'war', 'stickman']],
  // The generic mode label, reached only when no genre tag applied.
  ['multiplayer', ['multiplayer', 'mmo']],
  ['arcade',      ['arcade', 'casual', 'runner', 'platform', 'obby', 'skill']],
];

/** Best-fit site category from the canonical tag string. */
export function categoryFromTags(tags) {
  const list = String(tags || '').toLowerCase().split(/[,\s]+/).map(t => t.trim()).filter(Boolean);
  const set = new Set(list);
  for (const [category, needles] of CATEGORY_RULES) {
    if (needles.some(n => set.has(n))) return category;
  }
  // Never invent a category. 'arcade' is the catalog's own default for an
  // unclassified game, and leaving it blank would hide the game from every
  // browse filter.
  return 'arcade';
}

/** Canonical entry -> the shape the catalog stores. */
export function toCatalogShape(entry) {
  const title = String(entry?.title || '').trim();
  return {
    slug: slugify(title),
    title,
    game_url: String(entry?.embed || '').trim(),
    thumbnail_url: String(entry?.image || '').trim(),
    category: categoryFromTags(entry?.tags),
    tags: String(entry?.tags || '').trim(),
    // Trimmed hard: the canonical descriptions run to several paragraphs, and
    // the catalog uses this for a card blurb and a meta description.
    description: String(entry?.description || '').replace(/\s+/g, ' ').trim().slice(0, 600),
  };
}

/** Index the canonical file, reporting any duplication inside it. */
export function indexCanonical(entries) {
  const list = Array.isArray(entries) ? entries.filter(e => e && typeof e === 'object') : [];
  const byEmbed = new Map();
  const duplicates = [];
  const invalid = [];
  for (const e of list) {
    const key = embedKey(e.embed);
    if (!key) { invalid.push({ title: e.title ?? null, embed: e.embed ?? null }); continue; }
    if (byEmbed.has(key)) { duplicates.push({ title: e.title, key }); continue; }
    byEmbed.set(key, toCatalogShape(e));
  }
  return { byEmbed, duplicates, invalid, total: list.length };
}

/**
 * Reconcile the live catalog against the canonical file.
 *
 * Returns four disjoint sets. Nothing here mutates anything; the caller decides
 * what to do, and the tool that does it writes reviewable override rules rather
 * than touching the database.
 */
export function reconcile(canonicalEntries, catalogRows) {
  const { byEmbed, duplicates: canonDupes, invalid: canonInvalid } = indexCanonical(canonicalEntries);
  const rows = Array.isArray(catalogRows) ? catalogRows.filter(r => r && typeof r === 'object') : [];

  // Only rows genuinely SERVED by onlinegames.io. This is the line that keeps
  // the 37 GameDistribution referrer-param rows out of scope entirely.
  const owned = rows.filter(r => isOnlineGamesUrl(r.game_url || r.embed_url || r.url));
  const ignoredMentions = rows.filter(r =>
    !isOnlineGamesUrl(r.game_url || r.embed_url || r.url) &&
    /onlinegames\.io/i.test(String(r.game_url || r.embed_url || r.url || '')));

  const seen = new Map();          // embedKey -> the row we keep
  const matched = [];              // in canon, first occurrence
  const duplicates = [];           // in canon, but the same embed again
  const nonCanonical = [];         // served by OG, absent from the canonical file

  for (const r of owned) {
    const key = embedKey(r.game_url || r.embed_url || r.url);
    if (!byEmbed.has(key)) { nonCanonical.push(r); continue; }
    if (seen.has(key)) { duplicates.push({ row: r, keeping: seen.get(key) }); continue; }
    seen.set(key, r);
    // Which stored fields disagree with canon, so the caller can patch only
    // what actually differs instead of rewriting every row every run.
    const canon = byEmbed.get(key);
    const drift = {};
    if (String(r.title || '').trim() !== canon.title) drift.title = canon.title;
    if (String(r.thumbnail_url || r.thumbnail || '').trim() !== canon.thumbnail_url) drift.thumbnail_url = canon.thumbnail_url;
    if (String(r.category || '').toLowerCase() !== canon.category) drift.category = canon.category;
    matched.push({ row: r, canon, drift, inSync: Object.keys(drift).length === 0 });
  }

  const missing = [...byEmbed.entries()]
    .filter(([key]) => !seen.has(key))
    .map(([key, canon]) => ({ key, ...canon }));

  return {
    canonical: byEmbed.size,
    canonDuplicates: canonDupes,
    canonInvalid,
    owned: owned.length,
    ignoredMentions: ignoredMentions.length,
    ignoredSample: ignoredMentions.slice(0, 5).map(r => ({ slug: r.slug, url: r.game_url })),
    matched,
    duplicates,
    nonCanonical,
    missing,
  };
}
