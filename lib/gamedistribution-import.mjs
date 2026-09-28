// lib/gamedistribution-import.mjs — GameDistribution catalog → the CMS.
// ---------------------------------------------------------------------------
// SOURCE. GameDistribution's official publisher catalog feed,
//   https://catalog.api.gamedistribution.com/api/v2.0/rss/All/?…&format=json
// — the feed the platform provides so portals can list its games — rather than
// scraping gamedistribution.com/games/, which is a client-rendered app whose
// markup is not a contract. The feed returns each game's own embed URL
// (https://html5.gamedistribution.com/<id>/) and the thumbnails GameDistribution
// publishes for it. robots.txt for gamedistribution.com disallows nothing.
//
// EXACT URLS, NEVER DERIVED. The embed URL is accepted only if it is exactly
// https://html5.gamedistribution.com/<the feed's own id>/ and the thumbnail
// only if it is one of the Asset URLs the feed lists for that id. Neither is
// ever constructed. The page that frames the game adds gd_sdk_referrer_url with
// THIS site's real /play/<slug> URL at render time (server.js
// injectGdReferrer) — the "example.com/games/{game-path}" in GameDistribution's
// sample snippet is a placeholder, and it is never stored.
//
// LICENSING SCREEN. Distribution through the feed is the licence basis
// (public.game_providers.license_basis). On top of that, every game is screened:
//
//   REJECTED, never imported   the feed says it is not live (Status ≠ 2), not
//                              https, not HTML5, or its embed/thumbnail is not
//                              GameDistribution's own URL for that id.
//   HELD FOR HUMAN REVIEW      the title, a tag or the description names a
//                              third-party trademark (the same list the grow job
//                              and y8 ingest enforce), or another provider
//                              already lists a game with the same title.
//   CLEAN                      published automatically when the setting
//                              catalog.gd_auto_publish_clean is on, otherwise
//                              also held for review.
//
// Automated screening cannot decide infringement; it can only make sure a
// person looks at every case where a known mark appears. That is what it does,
// and the review queue records who approved what.
//
// Untrusted input throughout: every field is type-checked, bounded and passed
// through the same validateGameInput an editor faces (lib/cms-service.mjs
// importFromProvider).
// ---------------------------------------------------------------------------

import { safeFetch } from './safe-fetch.mjs';
import { isTrademarkTitle } from './trademark.mjs';
import { slugify, SLUG_RE } from './cms-rules.mjs';
import { normalizeTitle } from './game-discovery.mjs';

export const PROVIDER_ID = 'gamedistribution';
export const IMPORT_ACTOR = Object.freeze({ username: 'import:gamedistribution', via: 'system', role: 'admin' });
export const FEED_BASE = 'https://catalog.api.gamedistribution.com/api/v2.0/rss/All/';
const FEED_QUERY = 'collection=All&categories=All&tags=All&subType=All&type=All&mobile=All&rewarded=all&format=json';
export const PAGE_SIZE = 100;          // the feed's own ceiling, measured: amount=1000 returns 100
export const MAX_PAGES = 300;          // ~30,000 games; the live feed held 10,600 on 2026-09-26
const PAGE_DELAY_MS = 800;             // polite: a full crawl takes ~2.5 minutes
const UA = 'ZoFHub-catalog-sync/1.0';

const MD5_RE = /^[0-9a-f]{32}$/;

// GameDistribution's categories → this catalog's existing category keys. Every
// target already exists in public.game_categories (seeded from the catalog), and
// the importer falls back to `casual` if a deployment lacks one.
export const CATEGORY_MAP = Object.freeze({
  'casual': 'casual', 'puzzle': 'puzzle', 'adventure': 'adventure', 'racing & driving': 'racing',
  'simulation': 'simulator', 'agility': 'skill', 'dress-up': 'girls', 'shooter': 'shooting',
  'battle': 'action', 'strategy': 'strategy', 'match-3': 'match 3 games', 'mahjong & connect': 'mahjong connect',
  '.io': 'multiplayer', 'art': 'casual', 'merge': '2048 & merge', 'cards': 'card games', 'sports': 'sports',
  'football': 'sports', 'basketball': 'sports', 'educational': 'brain games', 'bubble shooter': 'bubble shooter',
  'cooking': 'casual', 'care': 'casual', 'boardgames': 'board', 'quiz': 'brain games', 'jigsaw': 'puzzle',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One page of the feed. Throws on a non-200 or a non-array body. */
export async function fetchGdFeedPage(page, { fetchImpl = safeFetch, timeoutMs = 20000 } = {}) {
  const url = `${FEED_BASE}?${FEED_QUERY}&amount=${PAGE_SIZE}&page=${Number(page)}`;
  const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeoutMs, maxBytes: 8 * 1024 * 1024 });
  if (!r.ok) throw new Error(`feed page ${page}: HTTP ${r.status}`);
  const body = await r.json();
  if (!Array.isArray(body)) throw new Error(`feed page ${page}: not a JSON array`);
  return body;
}

/**
 * Walk every page.
 *
 * A short or empty page USUALLY means the end — but not always. Measured on
 * 2026-09-26: one crawl got an empty page 107 and stopped at 10,600 games; the
 * same feed an hour later ran to page 217 and 21,673. Stopping at the first
 * short page therefore truncated the import while reporting it complete. So a
 * short page is confirmed before it is believed: re-fetched once, and the NEXT
 * page probed. If that next page has games, the short one was a transient gap —
 * the walk continues and the gap is reported.
 */
export async function fetchGdFeed({ fetchPage = fetchGdFeedPage, maxPages = MAX_PAGES, delayMs = PAGE_DELAY_MS, log = () => {} } = {}) {
  const items = [];
  const gaps = [];
  let pages = 0;
  let error = null;
  const get = async (p) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await fetchPage(p); }
      catch (e) { error = e.message; if (attempt < 2) await sleep(1500 * (attempt + 1)); }
    }
    return null;
  };
  for (let p = 1; p <= maxPages; p++) {
    let arr = await get(p);
    if (!arr) { log(`feed stopped at page ${p}: ${error}`); break; }
    error = null;
    if (arr.length < PAGE_SIZE) {
      await sleep(Math.max(delayMs, 1500));
      const again = await get(p);
      if (again && again.length > arr.length) arr = again;
    }
    if (arr.length < PAGE_SIZE && p < maxPages) {
      const next = await get(p + 1);
      if (next && next.length) {
        gaps.push({ page: p, got: arr.length });
        log(`feed page ${p} was short (${arr.length}) but page ${p + 1} is not — continuing`);
        pages = p;
        items.push(...arr);
        continue;
      }
    }
    pages = p;
    items.push(...arr);
    if (arr.length < PAGE_SIZE) break;
    if (p % 20 === 0) log(`feed page ${p}: ${items.length} games so far`);
    await sleep(delayMs);
  }
  return { items, pages, complete: !error, error, gaps };
}

const str = (v, max) => (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Plain text or nothing: an imported description that looks like markup is dropped, not rewritten. */
function plainOrNull(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!t) return null;
  if (/<\s*[a-z!/?]|&#|javascript:|data:text\/html/i.test(t)) return null;
  let out = '';
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if ((c < 0x20 && c !== 0x0a) || c === 0x7f || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) continue;
    out += ch;
  }
  return out.slice(0, max) || null;
}

/** The thumbnail: one of the feed's OWN asset URLs for this id, 4:3 preferred. */
export function pickThumbnail(md5, assets) {
  if (!Array.isArray(assets)) return null;
  const re = new RegExp(`^https://img\\.gamedistribution\\.com/${md5}-(\\d{2,4})x(\\d{2,4})\\.(jpg|jpeg|png|webp)$`);
  const ok = assets.filter((a) => typeof a === 'string' && re.test(a));
  return ok.find((a) => a.includes('-512x384.')) || ok.find((a) => a.includes('-512x512.')) || ok[0] || null;
}

/**
 * Screen one feed record.
 * @returns {{ decision:'reject'|'review'|'clean', reasons:string[], flags:object[], md5?:string }}
 */
export function screenGdItem(item) {
  const reasons = [];
  const flags = [];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { decision: 'reject', reasons: ['not_an_object'], flags };
  const md5 = typeof item.Md5 === 'string' ? item.Md5.toLowerCase() : '';
  const title = str(item.Title, 200);
  if (!MD5_RE.test(md5)) reasons.push('bad_id');
  if (!title) reasons.push('no_title');
  if (item.Status !== 2) reasons.push(`provider_status_${Number.isInteger(item.Status) ? item.Status : 'unknown'}`);
  if (item.Https !== true) reasons.push('not_https');
  if (item.Type !== 'html5') reasons.push('not_html5');
  if (md5 && item.Url !== `https://html5.gamedistribution.com/${md5}/`) reasons.push('embed_url_mismatch');
  if (md5 && !pickThumbnail(md5, item.Asset)) reasons.push('no_thumbnail');
  if (reasons.length) return { decision: 'reject', reasons, flags, md5 };

  if (isTrademarkTitle(title)) flags.push({ code: 'trademark_title', detail: title });
  const tags = Array.isArray(item.Tag) ? item.Tag.filter((t) => typeof t === 'string').slice(0, 40) : [];
  const markTags = tags.filter((t) => isTrademarkTitle(t));
  if (markTags.length) flags.push({ code: 'trademark_tag', detail: markTags.slice(0, 5).join(', ') });
  const desc = typeof item.Description === 'string' ? item.Description.slice(0, 4000) : '';
  if (desc && isTrademarkTitle(desc) && !flags.length) flags.push({ code: 'trademark_description', detail: 'the description names a protected mark' });
  return { decision: flags.length ? 'review' : 'clean', reasons, flags, md5 };
}

/** Map a screened record onto CMS input. `categoryExists` guards the foreign key. */
export function mapGdItem(item, { categoryExists = () => true } = {}) {
  const md5 = item.Md5.toLowerCase();
  const gdCats = Array.isArray(item.Category) ? item.Category.filter((c) => typeof c === 'string') : [];
  let category = 'casual';
  for (const c of gdCats) { const m = CATEGORY_MAP[c.toLowerCase()]; if (m && categoryExists(m)) { category = m; break; } }
  const w = Number(item.Width), h = Number(item.Height);
  const size = (n) => (Number.isInteger(n) && n >= 100 && n <= 4096 ? n : undefined);
  return {
    external_id: md5,
    input: {
      title: str(item.Title, 120),
      provider_id: PROVIDER_ID,
      game_url: `https://html5.gamedistribution.com/${md5}/`,     // === item.Url, checked by screenGdItem
      thumbnail_url: pickThumbnail(md5, item.Asset),
      category,
      description: plainOrNull(item.Description, 4000),
      // Instructions arrive multi-line ("Move with WASD.\nPress Space to jump."),
      // and the short description is a single line by rule — measured: 3,092 of
      // 10,600 games failed validation until line breaks were folded here.
      short_description: plainOrNull(item.Instructions, 1000)?.replace(/\s*\n\s*/g, ' ').slice(0, 280).trim() || null,
      ...(size(w) ? { embed_width: size(w) } : {}),
      ...(size(h) ? { embed_height: size(h) } : {}),
    },
    feed: {
      categories: gdCats.slice(0, 6), tags: (Array.isArray(item.Tag) ? item.Tag : []).filter((t) => typeof t === 'string').slice(0, 12),
      mobile: item.Mobile === 'true', subType: str(item.SubType, 30),
    },
  };
}

/**
 * One import run.
 *
 * @param {object} o
 * @param {object} o.cms            lib/cms-service instance
 * @param {object} o.store          its storage (for the existing-id / slug index)
 * @param {boolean} o.autoPublish   publish CLEAN games (flagged ones always wait)
 * @param {boolean} o.dryRun        screen and plan; write nothing
 * @param {string[]} [o.onlyIds]    restrict to these GameDistribution ids
 * @param {Function} [o.fetchFeed]  injectable for tests
 */
export async function runGdImport({
  cms, store, autoPublish = true, dryRun = false, onlyIds = null,
  fetchFeed: fetchAll = fetchGdFeed, log = () => {}, now = () => new Date(),
} = {}) {
  const startedAt = now().toISOString();
  const report = {
    startedAt, finishedAt: null, dryRun, autoPublish, feed: null,
    counts: { seen: 0, duplicateInFeed: 0, rejected: 0, alreadyPresent: 0, review: 0, clean: 0, published: 0, heldForReview: 0, inserted: 0, failed: 0 },
    rejectReasons: {}, flagCounts: {}, flagged: [], planned: [], failures: [],
  };

  const feed = await fetchAll({ log });
  report.feed = { pages: feed.pages, items: feed.items.length, complete: feed.complete, error: feed.error, gaps: feed.gaps || [] };
  const wanted = onlyIds ? new Set(onlyIds.map((s) => String(s).toLowerCase())) : null;

  // What is already in the catalog: every GameDistribution id, every slug, and
  // every normalised title with the provider that holds it.
  const existingIds = new Set();
  const slugs = new Set();
  const titles = new Map();
  if (store?.catalogIndex) {
    for (const r of await store.catalogIndex()) {
      slugs.add(r.slug);
      if (r.provider_id === PROVIDER_ID && r.external_id) existingIds.add(r.external_id);
      const k = normalizeTitle(r.title);
      if (k && k.length > 3 && !titles.has(k)) titles.set(k, r.provider_id || 'unknown');
    }
  }
  const categories = new Set(store?.listCategories ? (await store.listCategories()).map((c) => c.slug) : []);
  const categoryExists = (c) => !categories.size || categories.has(c);

  const seen = new Set();
  const rows = [];
  for (const item of feed.items) {
    const md5 = typeof item?.Md5 === 'string' ? item.Md5.toLowerCase() : '';
    if (wanted && !wanted.has(md5)) continue;
    report.counts.seen++;
    if (seen.has(md5)) { report.counts.duplicateInFeed++; continue; }
    seen.add(md5);
    const s = screenGdItem(item);
    if (s.decision === 'reject') {
      report.counts.rejected++;
      for (const r of s.reasons) report.rejectReasons[r] = (report.rejectReasons[r] || 0) + 1;
      continue;
    }
    if (existingIds.has(md5)) { report.counts.alreadyPresent++; continue; }
    const m = mapGdItem(item, { categoryExists });
    const flags = [...s.flags];
    const tkey = normalizeTitle(m.input.title);
    const holder = tkey && tkey.length > 3 ? titles.get(tkey) : null;
    if (holder && holder !== PROVIDER_ID) flags.push({ code: 'duplicate_title', detail: `already listed by ${holder}` });
    // Slug: the title's, unless another game holds it.
    let slug = slugify(m.input.title) || `gd-${md5.slice(0, 12)}`;
    if (slugs.has(slug)) slug = `${slug}-gd`.slice(0, 120);
    if (slugs.has(slug)) slug = `${slugify(m.input.title).slice(0, 100)}-${md5.slice(0, 8)}`;
    if (!SLUG_RE.test(slug) || slugs.has(slug)) { report.counts.failed++; report.failures.push({ md5, reason: 'no free slug' }); continue; }
    slugs.add(slug);

    const clean = flags.length === 0;
    for (const f of flags) report.flagCounts[f.code] = (report.flagCounts[f.code] || 0) + 1;
    if (clean) report.counts.clean++; else report.counts.review++;
    const status = clean && autoPublish ? 'published' : 'pending_review';
    if (status === 'published') report.counts.published++; else report.counts.heldForReview++;
    if (!clean && report.flagged.length < 500) report.flagged.push({ md5, title: m.input.title, flags });
    if (report.planned.length < 50 || wanted) report.planned.push({ md5, slug, title: m.input.title, status, thumbnail: m.input.thumbnail_url, flags: flags.map((f) => f.code) });
    rows.push({
      external_id: md5, status,
      input: { ...m.input, slug },
      license_review: {
        screenedAt: startedAt, source: 'gamedistribution-feed', basis: 'provider:gamedistribution',
        decision: clean ? 'clean' : 'review', flags, feed: m.feed,
      },
    });
  }

  if (!dryRun && rows.length) {
    const r = await cms.importFromProvider(IMPORT_ACTOR, rows);
    report.counts.inserted = r.inserted;
    report.counts.failed += r.rejected.length;
    report.failures.push(...r.rejected.slice(0, 100));
  }
  report.finishedAt = now().toISOString();
  return report;
}

export default { runGdImport, fetchGdFeed, fetchGdFeedPage, screenGdItem, mapGdItem, pickThumbnail, CATEGORY_MAP, IMPORT_ACTOR, PROVIDER_ID };
