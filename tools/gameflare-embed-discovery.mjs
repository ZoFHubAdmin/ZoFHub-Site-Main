// tools/gameflare-embed-discovery.mjs — recover official embed URLs (spec Phase 1).
// ---------------------------------------------------------------------------
//   npm run gameflare:embeds                    # every record with no embed URL
//   npm run gameflare:embeds -- --limit 20
//   npm run gameflare:embeds -- --slug angry-birds
//   npm run gameflare:embeds -- --recheck       # re-visit ones already resolved
//
// Visits each record's own `gameflare_url` in real Chromium and reads the embed
// URL that GameFlare publishes there — from its "Embed code" widget, with the
// rendered player iframe as a cross-check. Writes
// data/gameflare-embed-discovery.json.
//
// This does NOT verify anything. A recovered URL means "GameFlare says to embed
// this"; whether the game then loads and plays is Phase 2's question, and the
// two must not be conflated (spec: never treat reachability as gameplay).
//
// ── Why a browser rather than fetch() ──────────────────────────────────────
// www.gameflare.com sits behind a Cloudflare managed challenge: a plain HTTPS
// GET returns 403 "Just a moment…" with no page content. The challenge clears
// on its own in a real browser executing real JavaScript, which is what this is.
// robots.txt is `User-agent: *` with no Disallow rules. One page per game, once,
// at low concurrency with a delay between requests.
//
// A real user-agent string is set because Playwright's default advertises
// "HeadlessChrome", which the challenge refuses. Two further constraints came
// out of measurement, not guesswork: clearance holds only for the first
// navigation in a context, so each page gets a fresh one; and a missing game is
// served as HTTP 200 with a 404 BODY, so existence is decided on page text.
// ---------------------------------------------------------------------------
import { readFileSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyPage, summarise, EMBED_STATUS } from '../lib/gameflare-embed-extract.mjs';
import { isSafeSlug, ALLOWED_CANONICAL_PREFIX } from '../lib/gameflare-catalog.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, 'data', 'gameflare_verified_games.json');
const OUTPUT = join(ROOT, 'data', 'gameflare-embed-discovery.json');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const LIMIT = Number(arg('limit', Infinity));
const CONCURRENCY = Math.max(1, Math.min(4, Number(arg('concurrency', 3))));
const ONLY = arg('slug', '');
const RECHECK = has('recheck');
const DELAY_MS = Number(arg('delay', 1200));
const NAV_TIMEOUT = Number(arg('timeout', 45000));
const CHALLENGE_WAIT = Number(arg('challenge-wait', 30000));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  console.error('Playwright is required:\n  npm install --include=dev\n  npx playwright install chromium');
  process.exit(2);
}

// ── Work list ──────────────────────────────────────────────────────────────
if (!existsSync(SOURCE)) { console.error(`missing ${SOURCE}`); process.exit(2); }
const doc = JSON.parse(readFileSync(SOURCE, 'utf8'));
const allRecords = [doc.games, doc.failed_games, doc.not_testable_games]
  .filter(Array.isArray).flat();

const prior = existsSync(OUTPUT) ? JSON.parse(readFileSync(OUTPUT, 'utf8')) : { results: [] };
const priorBySlug = new Map((prior.results || []).map(r => [r.slug, r]));

const hasEmbed = (r) => typeof r.embed_url === 'string' && r.embed_url.trim().length > 0;

let work = allRecords.filter(r => !hasEmbed(r));
if (ONLY) work = allRecords.filter(r => r.slug === ONLY);
if (!RECHECK && !ONLY) {
  // A slug already resolved to a real URL is not re-fetched. Anything that
  // failed IS retried, because unreachable/challenged are transient conditions
  // and re-asking is the only way to tell a transient failure from a real one.
  work = work.filter(r => priorBySlug.get(r.slug)?.status !== EMBED_STATUS.FOUND);
}
if (Number.isFinite(LIMIT)) work = work.slice(0, LIMIT);

const skipped = [];
work = work.filter(r => {
  if (!isSafeSlug(r.slug)) { skipped.push({ slug: String(r.slug), why: 'unsafe slug' }); return false; }
  if (typeof r.gameflare_url !== 'string' || !r.gameflare_url.startsWith(ALLOWED_CANONICAL_PREFIX)) {
    skipped.push({ slug: r.slug, why: 'gameflare_url off allowlist' }); return false;
  }
  return true;
});

console.log(`[embeds] ${allRecords.length} records · ${allRecords.filter(hasEmbed).length} already carry an embed URL`);
console.log(`[embeds] visiting ${work.length} game page(s), concurrency ${CONCURRENCY}, ${DELAY_MS}ms between requests`);
if (skipped.length) console.log(`[embeds] ${skipped.length} skipped before any request (unsafe slug / off-allowlist URL)`);
if (!work.length) { console.log('[embeds] nothing to do.'); process.exit(0); }

// ── Drive ──────────────────────────────────────────────────────────────────
const browser = await chromium.launch({
  headless: true,
  // Playwright's default flags set navigator.webdriver, which the challenge
  // treats as disqualifying. Nothing here changes what the page returns — it
  // only stops a real browser being refused for being automated.
  args: ['--disable-blink-features=AutomationControlled'],
});
console.log(`[embeds] Chromium ${browser.version()}\n`);

/** Read one game page. Returns the raw facts; classification happens in lib/. */
async function capture(record) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 }, locale: 'en-US', userAgent: UA,
  });
  try {
    const page = await ctx.newPage();
    // Ads and analytics are a large share of the bytes and none of the answer.
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (/doubleclick\.net|googlesyndication|google-analytics|googletagmanager|adinplay|adnxs/i.test(u)) {
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(record.gameflare_url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    let title = await page.title().catch(() => '');
    const deadline = Date.now() + CHALLENGE_WAIT;
    while (Date.now() < deadline && /just a moment|attention required|checking your browser/i.test(title)) {
      await page.waitForTimeout(1000);
      title = await page.title().catch(() => title);
    }

    return await page.evaluate(() => ({
      title: document.title || '',
      bodyText: (document.body?.innerText || '').slice(0, 4000),
      textareas: [...document.querySelectorAll('textarea')]
        .map(t => t.value || t.textContent || '').filter(Boolean),
      inGameSrc: document.querySelector('#iframe-in-game')?.getAttribute('src') ?? null,
      finalUrl: location.href,
    }));
  } catch (e) {
    return { error: e.message.split('\n')[0] };
  } finally {
    await ctx.close().catch(() => {});
  }
}

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < work.length) {
    const rec = work[cursor++];
    const captured = await capture(rec);
    const verdict = classifyPage(captured);
    results.push({
      slug: rec.slug,
      name: rec.name ?? null,
      gameflareUrl: rec.gameflare_url,
      status: verdict.status,
      reason: verdict.reason,
      embedUrl: verdict.embedUrl,
      evidence: verdict.evidence,
      finalUrl: captured.finalUrl ?? null,
      checkedAt: new Date().toISOString(),
    });
    const tag = verdict.status === EMBED_STATUS.FOUND ? 'FOUND'
      : verdict.status === EMBED_STATUS.INVALID ? 'INVALID' : 'NONE ';
    console.log(`  [${tag}] ${rec.slug.padEnd(38)} ${verdict.reason}`);
    if (DELAY_MS) await new Promise(r => setTimeout(r, DELAY_MS));
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, worker));
await browser.close();

// ── Persist ────────────────────────────────────────────────────────────────
// Prior results for slugs not revisited are carried forward, so a --limit run
// builds on earlier passes instead of discarding them.
const merged = new Map(priorBySlug);
for (const r of results) merged.set(r.slug, r);

const rows = [...merged.values()].sort((a, b) => a.slug.localeCompare(b.slug));
const summary = summarise(rows);
const recordsWithEmbedBefore = allRecords.filter(hasEmbed).length;

await writeFile(OUTPUT, JSON.stringify({
  generated_at: new Date().toISOString(),
  browser: 'Chromium',
  source: 'data/gameflare_verified_games.json',
  method: 'official GameFlare "Embed code" widget, cross-checked against the page player iframe',
  totals: {
    total_records: allRecords.length,
    records_with_embed_url_before: recordsWithEmbedBefore,
    records_with_embed_url_after: recordsWithEmbedBefore + summary.found,
    records_still_missing: allRecords.length - recordsWithEmbedBefore - summary.found,
    invalid_embed_urls: summary.invalid,
    unavailable: summary.unavailable,
    duplicate_embed_urls: summary.duplicates.length,
  },
  by_reason: summary.byReason,
  duplicates: summary.duplicates,
  skipped_before_request: skipped,
  results: rows,
}, null, 2) + '\n');

console.log('\n──────── Phase 1 ────────');
console.log(`total records                    ${allRecords.length}`);
console.log(`records with embed URLs before   ${recordsWithEmbedBefore}`);
console.log(`records with embed URLs after    ${recordsWithEmbedBefore + summary.found}`);
console.log(`records still missing            ${allRecords.length - recordsWithEmbedBefore - summary.found}`);
console.log(`invalid embed URLs               ${summary.invalid}`);
console.log(`duplicate embed URLs             ${summary.duplicates.length}`);
console.log('\nby reason:');
for (const [k, v] of Object.entries(summary.byReason).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}
console.log(`\n[embeds] → ${OUTPUT.replace(ROOT, '.')}`);
