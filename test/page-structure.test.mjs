// Heading structure of the pages as a visitor actually receives them.
//
// WHY THIS FILE EXISTS
// A browser sweep across six pages and three viewports found exactly one
// accessibility fault, and it was on EVERY page: the document outline ran
//
//     h1  ZoFHub — free browser games
//     h2  Top picks for you … h2 All games
//     h4  Play          ← skipped h3
//     h4  Explore
//     h4  Legal
//
// The footer is built once in public/js/layout.js and injected into every page,
// so one wrong heading level was a site-wide fault. A screen-reader user
// navigating by heading level hits a gap and cannot tell whether they have
// missed a section. Nothing renders differently, so nothing catches it by eye —
// the h4 was chosen for its size, which is what CSS is for.
//
// The category page had a second cause: its grid had no heading at all, so its
// outline went h1 → (footer) h3 directly.
//
// This is a STATIC test because the failure is static: the page's own markup
// plus one fixed template. It reconstructs the outline a visitor gets by
// appending the injected footer's headings to each page's own.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LAYOUT = readFileSync(join(ROOT, 'public', 'js', 'layout.js'), 'utf8');

/**
 * Heading levels in source order, e.g. [1,2,2,3].
 *
 * Comments are stripped FIRST. Several of this repo's comments quote the markup
 * they explain — public/index.html has one that reads "The page had no <h1> at
 * all" — and counting those reported a second h1 on a page that renders exactly
 * one. A checker that cries wolf gets muted, which is worse than not having it.
 */
function headings(html) {
  return [...stripComments(html).matchAll(/<h([1-6])[\s>]/gi)].map((m) => Number(m[1]));
}

const stripComments = (html) => String(html).replace(/<!--[\s\S]*?-->/g, '');

/**
 * Strip HTML comments, JS block comments, and JS line comments.
 *
 * The line-comment rule uses a negative lookbehind for ':' so it does not eat
 * the "//" in an https:// URL. Without comment-stripping this checker flagged
 * public/js/game-of-the-day.js, whose comment reads 'No inline onerror="…"
 * here' — i.e. the one file that documents avoiding the very thing being
 * searched for. A checker with a false positive gets muted; muted checkers are
 * worse than absent ones, because they look like coverage.
 */
const stripAllComments = (src) =>
  stripComments(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');

/**
 * A redirect stub is not a page. public/credits.html exists only so that
 * /credits.html reaches /credits even if the server's 301 is ever lost; it has
 * no content and correctly has no h1.
 */
const isRedirectStub = (html) =>
  /<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(stripComments(html));

/** The footer layout.js injects into every page that has a .site-footer. */
function footerHeadings() {
  const at = LAYOUT.indexOf('function mountFooter');
  assert.notEqual(at, -1, 'mountFooter() not found — this test stopped checking anything');
  const body = LAYOUT.slice(at, LAYOUT.indexOf('\nmountFooter();', at));
  return headings(body);
}

function walk(dir, exts, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

/** Pages a visitor can actually land on, with their own markup. */
function shippedPages() {
  const out = [];
  for (const [dir, names] of [
    [join(ROOT, 'public'), readdirSync(join(ROOT, 'public')).filter((n) => n.endsWith('.html'))],
    [join(ROOT, 'legal'), readdirSync(join(ROOT, 'legal')).filter((n) => n.endsWith('.html'))],
  ]) {
    for (const name of names) {
      const html = readFileSync(join(dir, name), 'utf8');
      out.push({ name: `${dir.endsWith('legal') ? 'legal' : 'public'}/${name}`, html });
    }
  }
  return out;
}

const FOOTER = footerHeadings();
const PAGES = shippedPages();

/** First skipped level in a sequence, or null. */
function firstSkip(levels) {
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) return { from: levels[i - 1], to: levels[i], at: i };
  }
  return null;
}

describe('every page has a usable heading outline', () => {
  test('the fixtures parsed', () => {
    assert.ok(PAGES.length >= 6, `only ${PAGES.length} pages found — the loader broke`);
    assert.ok(FOOTER.length >= 3, `parsed ${FOOTER.length} footer headings — expected the three nav columns`);
  });

  test('the injected footer does not skip a level after page content', () => {
    // Pages end at h2 (section titles), so the footer's first heading may be at
    // most h3. This is the site-wide fault: get it wrong here and every page is
    // wrong at once.
    assert.ok(FOOTER[0] <= 3,
      `the footer's first heading is h${FOOTER[0]}; a page ending at h2 would skip a level. ` +
      `Heading level is document structure — set the visual size in CSS instead.`);
  });

  test('no shipped page skips a heading level', () => {
    const offenders = [];
    for (const { name, html } of PAGES) {
      // 404.html is a standalone document; a redirect stub is not a page.
      if (name.endsWith('404.html') || isRedirectStub(html)) continue;
      const own = headings(html);
      if (!own.length) continue;
      // A page with .site-footer receives the injected footer headings too.
      const full = /class="site-footer"/.test(html) ? [...own, ...FOOTER] : own;
      const skip = firstSkip(full);
      if (skip) offenders.push(`${name}: h${skip.from} → h${skip.to}`);
    }
    assert.deepEqual(offenders, [],
      'a skipped level leaves a screen-reader user unable to tell whether they missed a section');
  });

  // REGRESSION: public/js/vibe-finder.js rendered its tiles with
  //     <img … onerror="this.style.display='none'">
  // The site's CSP includes `script-src-attr 'none'` (helmet's default, and
  // verified on the live response header), so that attribute is refused and the
  // handler never ran. A Vibe Finder tile whose thumbnail 404'd kept the
  // browser's broken-image icon forever, while every other tile surface swapped
  // in a branded fallback via wireThumbFallback().
  //
  // The failure is invisible in review — the code looks like a working fallback —
  // and invisible at runtime except as a broken image. So it is checked here.
  test('no shipped code uses an inline event-handler attribute', () => {
    const HANDLER = /\son(?:error|click|load|change|submit|input|mouseover|focus|blur)\s*=\s*["']/gi;
    const offenders = [];
    const scan = (dir, exts) => {
      for (const file of walk(dir, exts)) {
        const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
        // The vendored GUST proxy app is third-party and serves itself.
        if (rel.startsWith('public/gust/')) continue;
        const src = stripAllComments(readFileSync(file, 'utf8'));
        for (const m of src.matchAll(HANDLER)) offenders.push(`${rel}: ${m[0].trim()}`);
      }
    };
    scan(join(ROOT, 'public'), ['.js', '.html']);
    scan(join(ROOT, 'admin-ui'), ['.js', '.html']);
    scan(join(ROOT, 'legal'), ['.html']);
    assert.deepEqual(offenders, [],
      "script-src-attr 'none' refuses these — wire the listener in JS instead");
  });

  test('every page has exactly one h1', () => {
    const offenders = [];
    for (const { name, html } of PAGES) {
      if (isRedirectStub(html)) continue;
      const n = headings(html).filter((l) => l === 1).length;
      // game.html and category.html get their h1 from a server-substituted
      // template, which is still an h1 in the file.
      if (n !== 1) offenders.push(`${name}: ${n} h1`);
    }
    assert.deepEqual(offenders, [], 'each page needs exactly one h1 naming its subject');
  });
});
