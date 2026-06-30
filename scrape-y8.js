#!/usr/bin/env node
/**
 * scrape-y8.js  (ESM)
 * Walks every page of Y8's official embed directory
 * (https://www.y8.com/games_for_your_website) and produces a JSON catalog of
 * iframe-embeddable games, each with: name, slug, embedUrl, thumbnail, gamePage.
 *
 * The embed directory is Y8's own "Games for your website" feature — the
 * intended, sanctioned way to embed their games via <iframe>.
 *
 * Usage (CLI):
 *   node scrape-y8.js                 # all pages -> y8-games.json
 *   node scrape-y8.js --pages 5       # first 5 pages only
 *   node scrape-y8.js --out games.json
 *
 * Programmatic (cron / ingest):
 *   import { scrapeY8 } from './scrape-y8.js';
 *   const games = await scrapeY8({ pages: 4 });           // returns gamesFlat[]
 *   await scrapeY8({ pages: 0, out: 'y8-games.json' });   // also writes the file
 *
 * No external dependencies — uses regex on the raw HTML.
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BASE = 'https://www.y8.com/games_for_your_website';
const DEFAULT_DELAY_MS = 700; // be polite to Y8's servers
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(page) {
  const url = page === 1 ? BASE : `${BASE}?page=${page}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`);
  return res.text();
}

function detectTotalPages(html) {
  // Pagination links look like ?page=46 — grab the largest.
  const nums = [...html.matchAll(/games_for_your_website\?page=(\d+)/g)].map((m) => parseInt(m[1], 10));
  return nums.length ? Math.max(...nums) : 1;
}

/**
 * Each game card contains a thumbnail <img cloudimage…>, a /games/<slug> link
 * and the embed url https://y8.com/embed/<slug>. We anchor on the embed URL
 * (the canonical, unique key) and look backwards in the same card for the
 * nearest thumbnail + a human-readable title.
 */
function parseGames(html) {
  const games = [];
  const embedRe = /https?:\/\/(?:www\.)?y8\.com\/embed\/([a-z0-9_]+)/gi;
  let m;
  const seen = new Set();
  while ((m = embedRe.exec(html))) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);

    const windowStart = Math.max(0, m.index - 4000);
    const chunk = html.slice(windowStart, m.index);

    // Thumbnail: last cloudimage URL before the embed link (retina or normal).
    const thumbMatches = [
      ...chunk.matchAll(/https?:\/\/cdn\d?\.y8\.com\/cloudimage\/\d+\/file\/[^"'\s)]+\.webp/gi),
    ];
    const thumbnail = thumbMatches.length ? thumbMatches[thumbMatches.length - 1][0] : null;

    // Title: alt/anchor text tied to /games/<slug>.
    let name = null;
    const titleRe = new RegExp(`/games/${slug}["'][^>]*>\\s*([^<]+?)\\s*<`, 'i');
    const t = chunk.match(titleRe) || html.slice(m.index, m.index + 2000).match(titleRe);
    if (t) name = decodeEntities(t[1].trim());
    if (!name) name = slugToName(slug);

    games.push({
      name,
      slug,
      embedUrl: `https://www.y8.com/embed/${slug}`,
      thumbnail,
      gamePage: `https://www.y8.com/games/${slug}`,
    });
  }
  return games;
}

function decodeEntities(s) {
  return s
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function slugToName(slug) {
  return slug
    .replace(/_webgl$/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** For any game still missing a thumbnail, fetch its game page and pull the
 *  cloudimage URL there (og:image / main img). */
async function backfillThumbnail(game) {
  try {
    const res = await fetch(game.gamePage, { headers: { 'User-Agent': UA } });
    if (!res.ok) return;
    const html = await res.text();
    const m = html.match(/https?:\/\/cdn\d?\.y8\.com\/cloudimage\/\d+\/file\/[^"'\s)]+\.webp/i);
    if (m) game.thumbnail = m[0];
  } catch { /* ignore */ }
}

/**
 * Scrape Y8's embed directory.
 * @returns {Promise<Array<{name,slug,embedUrl,thumbnail,gamePage}>>}
 */
export async function scrapeY8({ pages = 0, out = null, delayMs = DEFAULT_DELAY_MS, backfill = true, onLog = () => {} } = {}) {
  onLog('Fetching page 1 to detect catalog size…');
  const first = await fetchPage(1);
  const total = pages > 0 ? pages : detectTotalPages(first);
  onLog(`Scraping ${total} page(s).`);

  const all = new Map(); // slug -> game (dedupes across pages)
  for (const g of parseGames(first)) all.set(g.slug, g);

  for (let p = 2; p <= total; p++) {
    await sleep(delayMs);
    try {
      const html = await fetchPage(p);
      const found = parseGames(html);
      for (const g of found) if (!all.has(g.slug)) all.set(g.slug, g);
      onLog(`page ${p}/${total} -> ${found.length} games (total ${all.size})`);
    } catch (e) {
      onLog(`page ${p} failed: ${e.message}`);
    }
  }

  if (backfill) {
    const missing = [...all.values()].filter((g) => !g.thumbnail);
    if (missing.length) {
      onLog(`Backfilling ${missing.length} thumbnails from game pages…`);
      for (const g of missing) { await sleep(delayMs); await backfillThumbnail(g); }
    }
  }

  const list = [...all.values()];
  if (out) {
    // Write in the {_meta, gamesFlat} shape the ingest reads.
    const payload = {
      _meta: {
        source: BASE,
        embedPattern: 'https://www.y8.com/embed/<slug>',
        scrapedAt: new Date().toISOString(),
        pages: total,
        count: list.length,
      },
      gamesFlat: list,
    };
    writeFileSync(out, JSON.stringify(payload, null, 2));
    const withThumbs = list.filter((g) => g.thumbnail).length;
    onLog(`Done. ${list.length} games written to ${out} (${withThumbs} with thumbnails).`);
  }
  return list;
}

// ---- CLI ----
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => { const i = args.indexOf(flag); return i !== -1 && args[i + 1] ? args[i + 1] : def; };
  const pages = parseInt(getArg('--pages', '0'), 10);
  const out = getArg('--out', 'y8-games.json');
  scrapeY8({ pages, out, onLog: (m) => console.log(m) }).catch((e) => {
    console.error('scrape-y8 failed:', e?.message || e);
    process.exit(1);
  });
}
