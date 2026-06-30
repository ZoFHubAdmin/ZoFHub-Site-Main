// lib/catalog-overrides.mjs
//
// Serve-time catalog overrides — fix the DISPLAY of specific games (rename,
// re-thumbnail, re-categorize) or hide junk games, WITHOUT touching the
// Supabase database. Applied every time the catalog is served, so the result
// is deterministic and fully controlled from a file in the repo.
//
// Why this exists:
//   The live catalog comes from Supabase. Editing one game's title/thumbnail
//   in the DB requires a privileged write the app process may not be able to
//   make from every environment. This override file is the reliable, in-repo
//   way to guarantee a game shows up correctly the moment the server restarts.
//
// Config: data/catalog-overrides.json
//   {
//     "patch": [
//       { "match": { "slug": "slope-rolling" },
//         "set": { "title": "Slope", "thumbnail_url": "/thumbs/slope.png" } },
//       { "match": { "urlIncludes": "0022998ce3c54962be6ffe178229b168" },
//         "set": { "title": "Slope", "thumbnail_url": "/thumbs/slope.png" } }
//     ],
//     "remove": [
//       { "titleAllOf": ["elon", "money"] },
//       { "titleAllOf": ["bill", "gates", "money"] },
//       { "slug": "some-broken-slug" }
//     ]
//   }
//
// Matching is case-insensitive. A patch matches by exact slug OR by a substring
// of the game's URL. A remove rule matches by exact slug OR when the title
// contains ALL of the given substrings.
//
// Hardened: never throws. A missing/malformed file just means "no overrides".
// Hot-reloads when the file's mtime changes, so edits take effect on the next
// catalog refresh without needing a code change.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, '..', 'data', 'catalog-overrides.json');

let mtime = -1;
let bySlug = new Map();        // slug(lower) -> set object
let byUrlIncludes = [];        // [{ needle(lower), set }]
let removeRules = [];          // [{ slug? , titleAllOf?: [lower...] }]
let addList = [];              // [{ slug, title, game_url, thumbnail_url, category }]

function compile(raw) {
  const nextSlug = new Map();
  const nextUrl = [];
  const nextRemove = [];
  const nextAdd = [];

  const patches = Array.isArray(raw?.patch) ? raw.patch : [];
  for (const p of patches) {
    if (!p || typeof p !== 'object' || !p.set || typeof p.set !== 'object') continue;
    const m = p.match || {};
    if (m.slug) nextSlug.set(String(m.slug).toLowerCase(), p.set);
    if (m.urlIncludes) nextUrl.push({ needle: String(m.urlIncludes).toLowerCase(), set: p.set });
  }

  const removes = Array.isArray(raw?.remove) ? raw.remove : [];
  for (const r of removes) {
    if (!r || typeof r !== 'object') continue;
    if (r.slug) nextRemove.push({ slug: String(r.slug).toLowerCase() });
    if (Array.isArray(r.titleAllOf) && r.titleAllOf.length) {
      nextRemove.push({ titleAllOf: r.titleAllOf.map(s => String(s).toLowerCase()) });
    }
    // Remove every game whose URL contains this substring — used to drop a whole
    // distributor/host (e.g. licensing decisions) without listing each slug.
    if (r.urlIncludes) nextRemove.push({ urlIncludes: String(r.urlIncludes).toLowerCase() });
    // Like urlIncludes but matches ONLY the parsed host — so it won't false-match
    // a substring that appears in a query param (e.g. gd_sdk_referrer_url=...).
    if (r.hostIncludes) nextRemove.push({ hostIncludes: String(r.hostIncludes).toLowerCase() });
  }

  // New games to inject into the catalog (e.g. self-hosted games served from
  // /games/...). Each needs at least slug + title + game_url.
  const adds = Array.isArray(raw?.add) ? raw.add : [];
  for (const a of adds) {
    if (!a || typeof a !== 'object' || !a.slug || !a.game_url) continue;
    nextAdd.push({
      slug: String(a.slug),
      title: a.title || a.slug,
      game_url: a.game_url,
      embed_url: a.game_url,
      thumbnail: a.thumbnail_url || '',
      thumbnail_url: a.thumbnail_url || '',
      category: (a.category || 'arcade').toString().toLowerCase(),
      orientation: a.orientation || 'landscape',
    });
  }

  bySlug = nextSlug;
  byUrlIncludes = nextUrl;
  removeRules = nextRemove;
  addList = nextAdd;
}

function loadIfChanged() {
  try {
    if (!existsSync(FILE)) {
      if (mtime !== 0) { compile({}); mtime = 0; }
      return;
    }
    const mt = statSync(FILE).mtimeMs;
    if (mt === mtime) return;
    compile(JSON.parse(readFileSync(FILE, 'utf8')));
    mtime = mt;
    console.log(`[overrides] loaded: ${bySlug.size + byUrlIncludes.length} patch rule(s), ${removeRules.length} remove rule(s).`);
  } catch (e) {
    console.warn('[overrides] load failed (ignoring overrides):', e.message);
  }
}

function findPatch(slug, url) {
  const s = (slug || '').toLowerCase();
  if (s && bySlug.has(s)) return bySlug.get(s);
  const u = (url || '').toLowerCase();
  if (u) for (const r of byUrlIncludes) if (u.includes(r.needle)) return r.set;
  return null;
}

function shouldRemove(slug, titleLower, urlLower, hostLower) {
  const s = (slug || '').toLowerCase();
  for (const r of removeRules) {
    if (r.slug && r.slug === s) return true;
    if (r.titleAllOf && r.titleAllOf.every(t => titleLower.includes(t))) return true;
    if (r.urlIncludes && urlLower && urlLower.includes(r.urlIncludes)) return true;
    if (r.hostIncludes && hostLower && hostLower.includes(r.hostIncludes)) return true;
  }
  return false;
}

// True when at least one rule exists (cheap fast-path guard).
export function hasOverrides() {
  loadIfChanged();
  return bySlug.size > 0 || byUrlIncludes.length > 0 || removeRules.length > 0 || addList.length > 0;
}

// Filter + patch an array of game objects. Works with both runtime shapes:
//   in-memory CATALOG: { slug, title, embed_url, thumbnail, category }
//   Supabase page row:  { id, slug, title, game_url, thumbnail_url, category }
// Mutates objects in place (callers own them) and returns the filtered array.
// `opts.injectAdds` controls whether `add` games are PREPENDED to this array.
// It must be true ONLY when processing the full catalog (in-memory CATALOG) or
// the FIRST page of a paginated response — otherwise the same add-game would be
// prepended to every page and show up duplicated across the grid.
export function applyCatalogOverrides(games, opts = {}) {
  const injectAdds = opts.injectAdds !== false; // default true (full-catalog use)
  if (!Array.isArray(games)) return games;
  loadIfChanged();
  if (!hasOverrides()) return games;

  const out = [];
  for (const g of games) {
    if (!g || typeof g !== 'object') { if (g != null) out.push(g); continue; }
    const titleLower = (g.title || '').toLowerCase();
    const rawUrl = (g.game_url || g.embed_url || g.url || '');
    const urlLower = rawUrl.toLowerCase();
    let hostLower = '';
    try { hostLower = new URL(rawUrl).host.toLowerCase(); } catch { /* relative/local url */ }
    if (shouldRemove(g.slug, titleLower, urlLower, hostLower)) continue;

    const patch = findPatch(g.slug, g.game_url || g.embed_url || g.url);
    if (patch) {
      if (patch.title != null) g.title = patch.title;
      if (patch.thumbnail_url != null) {
        // Set BOTH field names so every consumer (frontend reads `thumbnail`,
        // the spec page-endpoint reads `thumbnail_url`) gets the override.
        g.thumbnail = patch.thumbnail_url;
        g.thumbnail_url = patch.thumbnail_url;
      }
      if (patch.category != null) g.category = String(patch.category).toLowerCase();
    }
    out.push(g);
  }

  // Inject "add" games that aren't already present (by slug). Prepended so they
  // surface near the top of the (id-desc / popularity) ordering. Gated by
  // injectAdds so paginated pages 2+ don't each re-prepend the same game.
  if (injectAdds && addList.length) {
    const present = new Set(out.map(g => (g.slug || '').toLowerCase()));
    const inject = addList.filter(a => !present.has(a.slug.toLowerCase()));
    if (inject.length) return inject.map(a => ({ ...a })).concat(out);
  }
  return out;
}
