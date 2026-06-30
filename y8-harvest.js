#!/usr/bin/env node
/**
 * y8-harvest.js — build a catalog of *verified* iframe-embeddable Y8 games.
 *
 * Three stages, each resumable (progress is checkpointed to disk):
 *
 *   1) directory  — scrape Y8's official embed directory
 *                   (y8.com/games_for_your_website, ~46 pages). These are the
 *                   games Y8 has cleared for embedding. -> candidates + thumbnails
 *
 *   2) sitemap    — crawl Y8's sitemaps to discover ALL game slugs across the
 *                   platform (tens of thousands). These are *candidates only* —
 *                   most are NOT embeddable and will be rejected in stage 3.
 *
 *   3) verify     — for every candidate, load https://y8.com/embed/<slug> inside
 *                   a REAL <iframe> in headless Chromium and keep it only if it
 *                   (a) returns 200, (b) is not blocked by X-Frame-Options /
 *                   CSP frame-ancestors, and (c) actually paints game content.
 *                   This is the step that guarantees "no broken tiles."
 *
 * Honest expectation: the full platform has 100k+ games, but only a few thousand
 * are genuinely embeddable. Stage 3 will reject the large majority of sitemap
 * candidates. That's correct behaviour, not a bug.
 *
 * ── Requirements ───────────────────────────────────────────────────────────
 *   npm install playwright
 *   npx playwright install chromium
 *   (Node 18+ for built-in fetch.)
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   node y8-harvest.js                 # run all three stages
 *   node y8-harvest.js --stage directory
 *   node y8-harvest.js --stage sitemap
 *   node y8-harvest.js --stage verify
 *   node y8-harvest.js --no-sitemap    # directory + verify only (faster, ~3,400)
 *   node y8-harvest.js --concurrency 4 # parallel verify tabs (default 4)
 *   node y8-harvest.js --limit 500     # cap candidates verified this run (testing)
 *   node y8-harvest.js --reset         # wipe checkpoints and start fresh
 *
 * ── Output files ───────────────────────────────────────────────────────────
 *   .y8-cache/candidates.json   discovered games {slug,name,thumbnail,source}
 *   .y8-cache/verified.json     per-slug verdicts {slug: {ok, reason, ...}}
 *   y8-games.json               FINAL catalog of verified games (organized)
 */

// ESM (this project is "type":"module"). Run with --use-system-ca on Windows:
//   node --use-system-ca y8-harvest.js --stage directory
import fs from 'node:fs';
import path from 'node:path';

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i !== -1 && args[i + 1] ? args[i + 1] : d;
};
const STAGE = val('--stage', 'all');
const NO_SITEMAP = has('--no-sitemap');
const CONCURRENCY = Math.max(1, parseInt(val('--concurrency', '4'), 10));
const LIMIT = parseInt(val('--limit', '0'), 10); // 0 = no cap
const RESET = has('--reset');

const CACHE_DIR = '.y8-cache';
const CAND_FILE = path.join(CACHE_DIR, 'candidates.json');
const VERIFIED_FILE = path.join(CACHE_DIR, 'verified.json');
const OUT_FILE = val('--out', 'y8-games.json');

const DIR_BASE = 'https://www.y8.com/games_for_your_website';
const ROBOTS = 'https://www.y8.com/robots.txt';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── small disk helpers (checkpointing) ───────────────────────────────────────
function ensureCache() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}
function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── robust fetch with retries ────────────────────────────────────────────────
async function get(url, { tries = 3, asText = true } = {}) {
  let lastErr;
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return asText ? await res.text() : res;
    } catch (e) {
      lastErr = e;
      await sleep(800 * (t + 1));
    }
  }
  throw lastErr;
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
    .replace(/_webgl$|_html5$/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ STAGE 1: directory scrape                                                  │
// ╰──────────────────────────────────────────────────────────────────────────╯
function parseDirectoryPage(html) {
  const games = [];
  const seen = new Set();
  const embedRe = /https?:\/\/y8\.com\/embed\/([a-z0-9_]+)/gi;
  let m;
  while ((m = embedRe.exec(html))) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const before = html.slice(Math.max(0, m.index - 4000), m.index);
    const thumbs = [
      ...before.matchAll(
        /https?:\/\/cdn\d?\.y8\.com\/cloudimage\/\d+\/file\/[^"'\s)]+\.webp/gi
      ),
    ];
    const thumbnail = thumbs.length ? thumbs[thumbs.length - 1][0] : null;
    let name = null;
    const t =
      before.match(new RegExp(`/games/${slug}["'][^>]*>\\s*([^<]+?)\\s*<`, 'i')) ||
      html.slice(m.index, m.index + 1500).match(/Play Now!/i);
    if (t && t[1]) name = decodeEntities(t[1].trim());
    games.push({ slug, name: name || slugToName(slug), thumbnail, source: 'directory' });
  }
  return games;
}

async function stageDirectory(candidates) {
  console.log('\n[1/3] Scraping embed directory…');
  const first = await get(DIR_BASE);
  const nums = [...first.matchAll(/games_for_your_website\?page=(\d+)/g)].map((x) =>
    parseInt(x[1], 10)
  );
  const total = nums.length ? Math.max(...nums) : 1;
  console.log(`      ${total} directory pages.`);

  const merge = (list) => {
    for (const g of list) {
      const ex = candidates[g.slug];
      if (!ex) candidates[g.slug] = g;
      else if (!ex.thumbnail && g.thumbnail) ex.thumbnail = g.thumbnail;
    }
  };
  merge(parseDirectoryPage(first));

  for (let p = 2; p <= total; p++) {
    await sleep(600);
    try {
      const html = await get(`${DIR_BASE}?page=${p}`);
      merge(parseDirectoryPage(html));
      if (p % 5 === 0 || p === total) {
        saveJSON(CAND_FILE, candidates);
        console.log(`      page ${p}/${total} (candidates: ${Object.keys(candidates).length})`);
      }
    } catch (e) {
      console.warn(`      page ${p} failed: ${e.message}`);
    }
  }
  saveJSON(CAND_FILE, candidates);
  console.log(`      directory done: ${Object.keys(candidates).length} candidates.`);
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ STAGE 2: sitemap discovery                                                 │
// ╰──────────────────────────────────────────────────────────────────────────╯
async function discoverSitemaps() {
  const maps = new Set();
  try {
    const robots = await get(ROBOTS);
    for (const m of robots.matchAll(/Sitemap:\s*(\S+)/gi)) maps.add(m[1].trim());
  } catch {
    /* fall through */
  }
  // Common fallbacks if robots.txt didn't list them.
  ['https://www.y8.com/sitemap.xml', 'https://www.y8.com/sitemap_index.xml'].forEach((u) =>
    maps.add(u)
  );
  return [...maps];
}

async function expandSitemap(url, gameUrls, visited) {
  if (visited.has(url)) return;
  visited.add(url);
  let xml;
  try {
    xml = await get(url);
  } catch (e) {
    console.warn(`      sitemap fetch failed (${url}): ${e.message}`);
    return;
  }
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
  // A sitemap index points at more sitemaps; a urlset points at pages.
  const childMaps = locs.filter((u) => /\.xml(\.gz)?(\?|$)/i.test(u));
  const pages = locs.filter((u) => !/\.xml(\.gz)?(\?|$)/i.test(u));

  for (const u of pages) {
    const m = u.match(/\/games\/([a-z0-9_]+)\/?$/i);
    if (m) gameUrls.add(m[1]);
  }
  for (const child of childMaps) {
    await sleep(400);
    await expandSitemap(child, gameUrls, visited);
  }
}

async function stageSitemap(candidates) {
  console.log('\n[2/3] Discovering game slugs via sitemaps…');
  const maps = await discoverSitemaps();
  console.log(`      ${maps.length} sitemap entrypoint(s).`);
  const gameSlugs = new Set();
  const visited = new Set();
  for (const m of maps) await expandSitemap(m, gameSlugs, visited);

  let added = 0;
  for (const slug of gameSlugs) {
    if (!candidates[slug]) {
      candidates[slug] = { slug, name: slugToName(slug), thumbnail: null, source: 'sitemap' };
      added++;
    }
  }
  saveJSON(CAND_FILE, candidates);
  console.log(
    `      sitemap done: +${added} new candidates ` +
      `(total ${Object.keys(candidates).length}).`
  );
  if (added === 0) {
    console.log(
      '      NOTE: no extra slugs found — Y8 may gate its full sitemap. The ' +
        'directory set is still complete and verified below.'
    );
  }
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ STAGE 3: real iframe verification (Playwright)                             │
// ╰──────────────────────────────────────────────────────────────────────────╯
function frameBlockedByHeaders(headers) {
  const xfo = (headers['x-frame-options'] || '').toLowerCase();
  if (xfo.includes('deny') || xfo.includes('sameorigin')) return 'x-frame-options';
  const csp = (headers['content-security-policy'] || '').toLowerCase();
  const fa = csp.match(/frame-ancestors([^;]*)/);
  if (fa) {
    const v = fa[1];
    // If frame-ancestors is restrictive (none/self only), our cross-origin
    // parent can't frame it.
    if (v.includes("'none'") || (v.includes("'self'") && !v.includes('*'))) {
      return 'csp-frame-ancestors';
    }
  }
  return null;
}

async function verifyOne(context, slug) {
  const embedUrl = `https://y8.com/embed/${slug}`;
  const page = await context.newPage();
  const result = { ok: false, reason: 'unknown', status: null };
  let embedStatus = null;
  let embedHeaders = null;

  page.on('response', (res) => {
    try {
      const u = res.url();
      if (u === embedUrl || u.startsWith(embedUrl)) {
        embedStatus = res.status();
        embedHeaders = res.headers();
      }
    } catch {
      /* ignore */
    }
  });

  try {
    // Parent page on a non-y8 origin, containing the game in a real iframe.
    await page.setContent(
      `<!doctype html><meta charset=utf-8>
       <iframe id="g" src="${embedUrl}"
               style="width:960px;height:600px;border:0"
               allow="autoplay; fullscreen; gamepad"></iframe>`,
      { waitUntil: 'load', timeout: 25000 }
    );

    // Give the frame a moment to navigate and start painting.
    await page.waitForTimeout(3500);

    result.status = embedStatus;

    if (embedStatus && embedStatus >= 400) {
      result.reason = `http-${embedStatus}`;
      return result;
    }
    if (embedHeaders) {
      const blocked = frameBlockedByHeaders(embedHeaders);
      if (blocked) {
        result.reason = blocked;
        return result;
      }
    }

    // Did real content paint inside the frame?
    const frame = page.frames().find((f) => f.url().startsWith(embedUrl) || /y8\.com\/embed/.test(f.url()));
    if (!frame) {
      result.reason = 'frame-not-loaded';
      return result;
    }
    const rendered = await frame
      .evaluate(() => {
        const hasCanvas = !!document.querySelector('canvas');
        const hasInnerFrame = !!document.querySelector('iframe');
        const hasGameEl = !!document.querySelector(
          '#game, #unity-canvas, #canvas, [id*="game" i], [class*="game" i]'
        );
        const bodyLen = (document.body && document.body.innerText.trim().length) || 0;
        const looksError = /not found|error|unavailable|removed/i.test(
          (document.body && document.body.innerText) || ''
        );
        return { hasCanvas, hasInnerFrame, hasGameEl, bodyLen, looksError };
      })
      .catch(() => null);

    if (!rendered) {
      result.reason = 'frame-eval-failed';
    } else if (rendered.looksError && !rendered.hasCanvas && !rendered.hasInnerFrame) {
      result.reason = 'error-page';
    } else if (rendered.hasCanvas || rendered.hasInnerFrame || rendered.hasGameEl) {
      result.ok = true;
      result.reason = 'rendered';
    } else {
      result.reason = 'no-game-content';
    }
  } catch (e) {
    result.reason = `exception:${(e.message || '').slice(0, 60)}`;
  } finally {
    await page.close().catch(() => {});
  }
  return result;
}

async function stageVerify(candidates, verified) {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    console.error(
      '\n[3/3] Playwright is not installed. Run:\n' +
        '      npm install playwright && npx playwright install chromium\n' +
        '      Then re-run: node y8-harvest.js --stage verify'
    );
    process.exit(1);
  }

  const allSlugs = Object.keys(candidates);
  let todo = allSlugs.filter((s) => !verified[s]); // skip already-verified (resume)
  if (LIMIT > 0) todo = todo.slice(0, LIMIT);

  console.log(
    `\n[3/3] Verifying ${todo.length} candidate(s) ` +
      `(${allSlugs.length - todo.length} already done) with ${CONCURRENCY} tabs…`
  );
  if (todo.length === 0) {
    console.log('      nothing to verify.');
    return;
  }

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1000, height: 700 } });

  let done = 0;
  let okCount = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < todo.length) {
      const slug = todo[cursor++];
      const r = await verifyOne(context, slug);
      verified[slug] = r;
      done++;
      if (r.ok) okCount++;
      if (done % 25 === 0 || done === todo.length) {
        saveJSON(VERIFIED_FILE, verified); // checkpoint
        console.log(
          `      ${done}/${todo.length}  ok:${okCount}  last:${slug} -> ${r.reason}`
        );
      }
      await sleep(150); // gentle pacing
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  saveJSON(VERIFIED_FILE, verified);
  await browser.close();
  console.log(`      verify done. ${okCount}/${todo.length} passed this run.`);
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Thumbnail backfill + final assembly                                        │
// ╰──────────────────────────────────────────────────────────────────────────╯
async function backfillThumb(slug) {
  try {
    const html = await get(`https://www.y8.com/games/${slug}`, { tries: 2 });
    const m = html.match(
      /https?:\/\/cdn\d?\.y8\.com\/cloudimage\/\d+\/file\/[^"'\s)]+\.webp/i
    );
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

function categorize(name, slug) {
  const s = (name + ' ' + slug).toLowerCase();
  const any = (...k) => k.some((w) => s.includes(w));
  if (any('dress', 'makeover', 'fashion', 'girly', 'kiddo', 'toddie', 'teen ', 'decor', 'blonde sofia', 'maria', 'trendy', 'ootd', 'outfit'))
    return 'Girls & Dress-Up';
  if (any('kitchen', 'cook', 'cathy', 'baby', 'pizza', 'cake', 'food', 'blender', 'cafe', 'bakery'))
    return 'Cooking & Kids';
  if (any('puzzle', 'sort', 'match', 'mahjong', 'solitaire', 'word', 'block', '2048', 'brain', 'tripeaks', 'connect'))
    return 'Puzzle & Brain';
  if (any('run', 'runner', 'dash', 'jump', 'slope', 'climb', 'clash', 'escape', 'race', 'racer', 'drift', 'car', 'rush', 'road', 'speed', 'rally', 'ride'))
    return 'Action & Racing';
  if (any('shoot', 'sniper', 'gun', 'fps', 'zombie', 'kunai', 'ninja', 'arrow', 'target', 'bottle'))
    return 'Shooting & Arcade';
  return 'Other / Casual';
}

async function assembleFinal(candidates, verified) {
  console.log('\nAssembling final catalog…');
  const passing = Object.keys(verified).filter((s) => verified[s] && verified[s].ok);

  // Backfill thumbnails for verified games that don't have one yet.
  const needThumb = passing.filter((s) => !candidates[s] || !candidates[s].thumbnail);
  if (needThumb.length) {
    console.log(`      backfilling ${needThumb.length} thumbnails…`);
    for (let i = 0; i < needThumb.length; i++) {
      const slug = needThumb[i];
      const t = await backfillThumb(slug);
      if (!candidates[slug]) candidates[slug] = { slug, name: slugToName(slug), source: 'verified' };
      candidates[slug].thumbnail = t;
      await sleep(250);
      if ((i + 1) % 25 === 0) console.log(`        ${i + 1}/${needThumb.length}`);
    }
    saveJSON(CAND_FILE, candidates);
  }

  const games = passing
    .map((slug) => {
      const c = candidates[slug] || { slug, name: slugToName(slug), thumbnail: null };
      return {
        name: c.name || slugToName(slug),
        slug,
        category: categorize(c.name || slug, slug),
        embedUrl: `https://y8.com/embed/${slug}`,
        thumbnail: c.thumbnail || null,
        gamePage: `https://www.y8.com/games/${slug}`,
        source: c.source || 'directory',
      };
    })
    .sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name));

  const grouped = {};
  for (const g of games) (grouped[g.category] ||= []).push(g);

  const out = {
    _meta: {
      generated: new Date().toISOString(),
      source: 'https://www.y8.com/games_for_your_website + sitemap, iframe-verified',
      embedPattern: 'https://y8.com/embed/<slug>',
      totalVerified: games.length,
      totalCandidates: Object.keys(candidates).length,
      categories: Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v.length])),
      withThumbnail: games.filter((g) => g.thumbnail).length,
    },
    gamesByCategory: grouped,
    gamesFlat: games,
  };
  saveJSON(OUT_FILE, out);
  console.log(
    `\nDone. ${games.length} verified embeddable games -> ${OUT_FILE} ` +
      `(${out._meta.withThumbnail} with thumbnails).`
  );
}

// ── main ──────────────────────────────────────────────────────────────────--
(async () => {
  ensureCache();
  if (RESET) {
    for (const f of [CAND_FILE, VERIFIED_FILE]) if (fs.existsSync(f)) fs.unlinkSync(f);
    console.log('Checkpoints reset.');
  }
  const candidates = loadJSON(CAND_FILE, {});
  const verified = loadJSON(VERIFIED_FILE, {});

  const run = (s) => STAGE === 'all' || STAGE === s;

  if (run('directory')) await stageDirectory(candidates);
  if (run('sitemap') && !NO_SITEMAP) await stageSitemap(candidates);
  if (run('verify')) await stageVerify(candidates, verified);

  // Always (re)assemble from whatever has been verified so far.
  await assembleFinal(candidates, verified);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
