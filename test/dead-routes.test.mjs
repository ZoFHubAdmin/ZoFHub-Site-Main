// Nothing the site ships may point at a route the server does not have.
//
// WHY THIS FILE EXISTS
// The leaderboard was retired server-side — db/feedback.sql dropped `scores`,
// and /api/scores, /api/scores/session and /api/admin/scores/* were deleted from
// server.js — but the CLIENT half was left wired. public/js/game-page.js still
// called bindScores() on every game page, which fired POST /api/scores/session
// immediately on load: a guaranteed 404 on each of ~12,300 game pages, plus a
// "Leaderboard" button whose panel could only ever say "No scores yet" and a
// submit form that could only ever fail. Separately, sitemap.xml still listed
// /leaderboard and all six legal pages still linked to it.
//
// Every one of those is the same mistake: a removal that stopped halfway. None
// of them threw, so nothing failed — the site just quietly pointed at holes.
// These tests make the halfway state fail loudly instead.
//
// Deliberately STATIC analysis, no server boot: this is about what the repo
// contains, it runs in milliseconds, and it stays honest with no credentials.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = readFileSync(join(ROOT, 'server.js'), 'utf8');
const ADMIN_API = readFileSync(join(ROOT, 'lib', 'admin-api.mjs'), 'utf8');

/**
 * Every path the server registers.
 *
 * Two shapes, because server.js uses both:
 *   1. a literal — app.get('/a', …), app.get(['/a','/b'], …), app.use('/a', …)
 *   2. a LOOP over a table — the five legal pages and their `.html` redirect
 *      twins are registered by iterating LEGAL_PAGES / LEGAL_HTML_TWINS, so no
 *      literal ever appears next to an app.get(). Reading only shape 1 reported
 *      /privacy, /terms, /dmca, /cookies and /credits as dead on every page that
 *      links to them — 32 false positives that would have made this suite noise
 *      nobody trusts.
 */
function declaredRoutes(src) {
  const routes = new Set();
  const collect = (blob) => {
    for (const lit of blob.matchAll(/['"`](\/[^'"`]*)['"`]/g)) routes.add(lit[1]);
  };

  // 1. Literals at the call site.
  const call = /\bapp\.(?:get|post|put|delete|patch|all|use)\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|`[^`]*`)/g;
  for (const m of src.matchAll(call)) collect(m[1]);

  // 2. Route tables the server iterates. Named explicitly rather than guessed:
  //    a new table must be added here, and the vacuity guard below fails if the
  //    parse silently stops finding anything.
  const table = (name, open, close) => {
    const at = src.indexOf(name);
    if (at === -1) return;
    const start = src.indexOf(open, at);
    if (start === -1) return;
    collect(src.slice(start, src.indexOf(close, start) + 1));
  };
  table('const LEGAL_PAGES =', '{', '}');
  table('const LEGAL_HTML_TWINS =', '[', ']');

  // 3. The control-plane API registers its routes through ONE helper,
  //    add('<method>', '/api/admin/…', …), in lib/admin-api.mjs — the helper is
  //    what guarantees every one is permission-gated (test/admin-control-api.test.mjs
  //    proves that). Read from that file rather than exempted, so a console call
  //    to a route that module no longer registers still fails here.
  for (const m of ADMIN_API.matchAll(/\badd\(\s*'(?:get|post|put|patch|delete)'\s*,\s*('[^']*')/g)) collect(m[1]);

  return routes;
}

/** Turn an Express path into a matcher: '/embed/:slug' matches '/embed/anything'. */
function routeMatcher(route) {
  const pattern = '^' + route
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[A-Za-z0-9_]+/g, '[^/]+')
    .replace(/\*/g, '.*') + '$';
  return new RegExp(pattern);
}

const ROUTES = [...declaredRoutes(SERVER)];
const MATCHERS = ROUTES.map(routeMatcher);
// express.static serves public/ at the site root, so any path that resolves to a
// real file there is reachable even with no app.get() for it.
const STATIC_TOP = new Set(readdirSync(join(ROOT, 'public')));

function isReachable(path) {
  const clean = path.split(/[?#]/)[0];
  if (clean === '/') return true;
  if (MATCHERS.some(m => m.test(clean))) return true;
  const top = clean.split('/')[1];
  return !!top && STATIC_TOP.has(top);
}

function walk(dir, exts, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some(e => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

const rel = (f) => f.slice(ROOT.length + 1).replace(/\\/g, '/');

describe('the server declares every route the site points at', () => {
  test('server.js registers a recognisable set of routes', () => {
    // Guards the parser itself: if the regex ever stops matching, every test
    // below would pass vacuously by finding nothing to check.
    assert.ok(ROUTES.length >= 40, `only ${ROUTES.length} routes parsed — the parser broke, not the server`);
    assert.ok(ROUTES.includes('/api/games'), 'expected /api/games among the parsed routes');
    // The loop-registered half specifically: without it this suite reports every
    // legal page as dead, which is how it would get muted rather than fixed.
    assert.ok(ROUTES.includes('/privacy'), 'LEGAL_PAGES was not parsed — see declaredRoutes()');
  });

  test('no front-end module fetches an /api path the server does not serve', () => {
    const offenders = [];
    // Only same-origin API paths: a full https:// URL is a third party's.
    const API_CALL = /['"`](\/api\/[A-Za-z0-9/_\-.]*)/g;
    for (const file of [...walk(join(ROOT, 'public', 'js'), ['.js']),
                        ...walk(join(ROOT, 'admin-ui'), ['.js'])]) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(API_CALL)) {
        if (m[0].startsWith('`')) continue;          // template literals: handled below, whole
        const path = m[1].replace(/\/$/, '');
        if (!isReachable(path)) offenders.push(`${rel(file)} → ${path}`);
      }
      // A template literal is compared WHOLE, each ${…} standing for one path
      // segment — the same rule tools/zofaudit/checks_api.py uses. Comparing only
      // the static prefix used to require a route at `/api/x/engines` just
      // because a client calls `/api/x/engines/${id}`, which is how a route with
      // no caller gets added to satisfy a test.
      for (const m of src.matchAll(/`(\/api\/[^`]*)`/g)) {
        const path = m[1].replace(/\$\{[^}]*\}/g, 'X').split(/[?#]/)[0].replace(/\/$/, '');
        if (!isReachable(path)) offenders.push(`${rel(file)} → ${path}`);
      }
    }
    assert.deepEqual(offenders, [],
      'these call an API route server.js no longer defines — finish the removal, or restore the route');
  });

  test('no shipped page links to an internal path that 404s', () => {
    const offenders = [];
    // Root-relative hrefs only. Skips #anchors, mailto:, and absolute URLs.
    const HREF = /href\s*=\s*"(\/[^"#?]*)"/g;
    const pages = [...walk(join(ROOT, 'public'), ['.html']),
                   ...walk(join(ROOT, 'legal'), ['.html']),
                   ...walk(join(ROOT, 'admin-ui'), ['.html'])];
    for (const file of pages) {
      // The vendored GUST proxy app owns its own root and its own paths.
      if (rel(file).startsWith('proxy-engine/assets/gust/')) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(HREF)) {
        if (!isReachable(m[1])) offenders.push(`${rel(file)} → ${m[1]}`);
      }
    }
    assert.deepEqual(offenders, [],
      'these hrefs point at nothing — the /leaderboard link survived on six legal pages exactly this way');
  });

  test('the sitemap only advertises paths that exist', () => {
    // The generator is a run of add('<path>', …) calls, so the paths are literals
    // in server.js and readable without booting. Search Console reports a 404 in
    // a submitted sitemap as an error against the whole file, so one stale entry
    // discredits all ~12,000 real ones.
    const block = SERVER.slice(SERVER.indexOf("app.get('/sitemap.xml'"));
    const literals = [...block.matchAll(/\badd\(\s*'(\/[^']*)'/g)].map(m => m[1]);
    assert.ok(literals.includes('/'), 'sitemap generator not found — this test stopped checking anything');
    const offenders = literals.filter(p => !isReachable(p));
    assert.deepEqual(offenders, [], 'sitemap.xml lists a path with no route');
  });
});

describe('the leaderboard is present on every layer, or on none', () => {
  // This block used to assert the leaderboard was gone. It is back, so the same
  // guard now points at the current intent — and it is still worth having: a
  // HALF-restored feature is the same class of bug in the other direction. A
  // page that invites a score the server cannot store, or a write API no client
  // calls, both fail quietly and both waste somebody's afternoon.
  test('server.js defines the scores API', () => {
    const scoreRoutes = ROUTES.filter((r) => /\/scores(\/|$)/.test(r));
    assert.ok(scoreRoutes.length >= 2,
      `expected the board + submit routes, found: ${scoreRoutes.join(', ') || 'none'}`);
  });

  test('the client that calls it exists', () => {
    const callers = [];
    for (const file of [...walk(join(ROOT, 'public'), ['.js', '.html']),
                        ...walk(join(ROOT, 'admin-ui'), ['.js', '.html'])]) {
      if (rel(file).startsWith('proxy-engine/assets/gust/')) continue;
      if (/['"`]\/api\/(admin\/)?scores/.test(readFileSync(file, 'utf8'))) callers.push(rel(file));
    }
    assert.ok(callers.includes('public/js/leaderboard.js'),
      'the board page does not read the scores API');
    assert.ok(callers.includes('public/js/score-submit.js'),
      'nothing on the site can submit a score');
  });

  test('the client never sends its own moderation verdict', () => {
    // status and flag_reason are decided in lib/scores.mjs, server-side. A
    // client that sent them would be marking its own homework, and the whole
    // quarantine would be advisory.
    for (const f of ['public/js/score-submit.js', 'public/js/leaderboard.js']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      assert.ok(!/\bstatus\s*:\s*['"]/.test(src), `${f} sends a status field`);
      assert.ok(!/flag_reason/.test(src), `${f} sends a flag_reason`);
    }
  });
});
