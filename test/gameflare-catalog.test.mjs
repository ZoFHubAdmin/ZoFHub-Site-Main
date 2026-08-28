// GameFlare catalog — the data policy, and the rules the UI must not break.
//
// WHAT THESE TESTS ARE ACTUALLY GUARDING
// The supplied dataset contains 298 records and ZERO that may be shown to the
// public. Every one of the interesting failure modes here looks like a helpful
// improvement from the inside:
//
//   • "the catalog is empty, let's fall back to the not-testable candidates"
//   • "embed_url is null on 289 records, let's derive it from gameflare_url"
//   • "the iframe failed, let's open the game on gameflare.com instead"
//
// Each of those directly violates the dataset's own global_embedding_policy, and
// each would ship silently because the site would look BETTER afterwards. So the
// assertions below are mostly about what must NOT happen.
//
// Pure filesystem + module tests. No server, no network, no browser.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseCatalog, validateRecord, filterGames, findBySlug, categoriesOf,
  isSafeSlug, ELIGIBLE_STATUS,
  ALLOWED_EMBED_PREFIX, ALLOWED_CANONICAL_PREFIX, ALLOWED_THUMBNAIL_PREFIX,
} from '../lib/gameflare-catalog.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = join(ROOT, 'data', 'gameflare_verified_games.json');

/** A record that passes everything, so each test can break exactly one thing. */
const good = (over = {}) => ({
  id: 'gameflare:test-game',
  slug: 'test-game',
  name: 'Test Game',
  rank: 1,
  gameflare_url: 'https://www.gameflare.com/online-game/test-game/',
  embed_url: 'https://www.gameflare.com/embed/test-game/',
  thumbnail_url: 'https://data.gameflare.com/games/1/abc-400-300.jpg',
  metadata: { categories: ['Action'], developer: null, rating_percent: 90, play_count: null, play_count_display: '458.5k' },
  iframe_compatibility: { status: ELIGIBLE_STATUS },
  ...over,
});
const doc = (over = {}) => ({ dataset: {}, games: [], failed_games: [], not_testable_games: [], ...over });

// ── The supplied file ──────────────────────────────────────────────────────
describe('the supplied dataset', () => {
  test('it is present and parses', () => {
    assert.ok(existsSync(DATA), 'data/gameflare_verified_games.json is missing');
    const res = parseCatalog(readFileSync(DATA, 'utf8'));
    assert.equal(res.ok, true, res.error || '');
  });

  test('it exposes ZERO public games — the whole point of this integration', () => {
    // If this ever fails, the dataset changed. That is fine and expected one
    // day, but it must be a deliberate, noticed event rather than a surprise,
    // because it is the moment real third-party games start rendering.
    const res = parseCatalog(readFileSync(DATA, 'utf8'));
    assert.equal(res.games.length, 0,
      'the supplied dataset has no verified_working games; a non-zero count means '
      + 'the data changed and the exposure decision needs re-reviewing');
    assert.equal(res.counts.eligible, 0);
  });

  test('all 298 records are accounted for, none silently dropped', () => {
    const res = parseCatalog(readFileSync(DATA, 'utf8'));
    assert.equal(res.counts.records, 298);
    assert.equal(res.counts.excludedByStatus, 298, 'every record is excluded by status policy');
  });
});

// ── Status policy ──────────────────────────────────────────────────────────
describe('status policy', () => {
  test('verified_working inside `games` is eligible', () => {
    const res = parseCatalog(doc({ games: [good()] }));
    assert.equal(res.games.length, 1);
    assert.equal(res.games[0].slug, 'test-game');
  });

  for (const status of ['not_testable', 'failed_blank_screen', 'failed_network_dependency',
    'failed_legacy_technology', 'unknown', 'verified', 'VERIFIED_WORKING', '']) {
    test(`status "${status}" is excluded`, () => {
      const res = parseCatalog(doc({ games: [good({ iframe_compatibility: { status } })] }));
      assert.equal(res.games.length, 0, `"${status}" must not be publicly exposable`);
    });
  }

  test('records in failed_games / not_testable_games never become eligible', () => {
    // Even a record that is verified_working in the WRONG array stays out. The
    // array is part of the contract, not just the status field.
    const res = parseCatalog(doc({
      failed_games: [good()],
      not_testable_games: [good({ id: 'x', slug: 'y' })],
    }));
    assert.equal(res.games.length, 0);
    assert.equal(res.counts.excludedByStatus, 2);
  });
});

// ── URL allowlists ─────────────────────────────────────────────────────────
describe('URL allowlists', () => {
  test('the prefixes are the exact ones the brief specifies', () => {
    assert.equal(ALLOWED_EMBED_PREFIX, 'https://www.gameflare.com/embed/');
    assert.equal(ALLOWED_CANONICAL_PREFIX, 'https://www.gameflare.com/online-game/');
    assert.equal(ALLOWED_THUMBNAIL_PREFIX, 'https://data.gameflare.com/');
  });

  const rejects = [
    ['null embed_url (the 289 discovery candidates)', { embed_url: null }],
    ['http embed', { embed_url: 'http://www.gameflare.com/embed/x/' }],
    ['lookalike host', { embed_url: 'https://www.gameflare.com.evil.test/embed/x/' }],
    ['subdomain swap', { embed_url: 'https://evil.gameflare.com/embed/x/' }],
    ['wrong path', { embed_url: 'https://www.gameflare.com/online-game/x/' }],
    ['protocol-relative', { embed_url: '//www.gameflare.com/embed/x/' }],
    ['javascript: URL', { embed_url: 'javascript:alert(1)' }],
    ['data: URL', { embed_url: 'data:text/html,<script>alert(1)</script>' }],
    ['thumbnail off-host', { thumbnail_url: 'https://evil.test/x.jpg' }],
    ['canonical off-host', { gameflare_url: 'https://evil.test/online-game/x/' }],
  ];
  for (const [label, over] of rejects) {
    test(`rejects ${label}`, () => {
      assert.equal(validateRecord(good(over)).ok, false);
      assert.equal(parseCatalog(doc({ games: [good(over)] })).games.length, 0);
    });
  }

  test('a rejected record NEVER contributes a URL to the output', () => {
    // The failure mode this guards: partially accepting a record and rendering
    // its thumbnail while refusing its embed.
    const res = parseCatalog(doc({ games: [good({ embed_url: null })] }));
    assert.deepEqual(res.games, []);
    assert.equal(res.counts.rejectedInvalid, 1);
    assert.ok(res.rejected[0].errors.some(e => e.startsWith('embed_url')));
  });
});

// ── Malformed input ────────────────────────────────────────────────────────
describe('malformed data never throws', () => {
  for (const [label, input] of [
    ['invalid JSON text', '{ not json'],
    ['null', null],
    ['an array', []],
    ['a number', 42],
    ['empty object', {}],
    ['games not an array', { games: 'nope', failed_games: [], not_testable_games: [] }],
    ['missing not_testable_games', { games: [], failed_games: [] }],
  ]) {
    test(`survives ${label}`, () => {
      const res = parseCatalog(input);
      assert.equal(res.ok, false);
      assert.deepEqual(res.games, [], 'a rejected dataset must expose no games');
      assert.ok(typeof res.error === 'string' && res.error.length > 0);
    });
  }

  test('a malformed record does not poison its neighbours', () => {
    const res = parseCatalog(doc({ games: [good(), null, good({ id: 'b', slug: 'b-game' }), { junk: true }] }));
    assert.equal(res.games.length, 2);
    assert.equal(res.counts.rejectedInvalid, 2);
  });
});

// ── Identity ───────────────────────────────────────────────────────────────
describe('id and slug uniqueness', () => {
  test('duplicate slug keeps the first and counts the rest', () => {
    const res = parseCatalog(doc({ games: [good({ rank: 1 }), good({ id: 'other', rank: 2 })] }));
    assert.equal(res.games.length, 1);
    assert.equal(res.counts.duplicates, 1);
    assert.equal(res.games[0].rank, 1);
  });

  test('duplicate id is also collapsed', () => {
    const res = parseCatalog(doc({ games: [good(), good({ slug: 'different-slug' })] }));
    assert.equal(res.games.length, 1);
    assert.equal(res.counts.duplicates, 1);
  });

  test('unsafe slugs are rejected before they can reach a route', () => {
    for (const slug of ['../etc/passwd', 'a/b', 'UPPER', 'has space', '', '-leading', 'x'.repeat(200)]) {
      assert.equal(isSafeSlug(slug), false, `${JSON.stringify(slug)} must not be a usable slug`);
      assert.equal(validateRecord(good({ slug })).ok, false);
    }
    assert.equal(isSafeSlug('super-bear-adventure'), true);
  });

  test('findBySlug refuses traversal and unknown slugs', () => {
    const games = parseCatalog(doc({ games: [good()] })).games;
    assert.equal(findBySlug(games, 'test-game').slug, 'test-game');
    assert.equal(findBySlug(games, '../../secret'), null);
    assert.equal(findBySlug(games, 'nope'), null);
    assert.equal(findBySlug(games, undefined), null);
  });
});

// ── Projection ─────────────────────────────────────────────────────────────
describe('the public projection carries no evidence', () => {
  test('failure, legal and harness fields are not copied through', () => {
    const res = parseCatalog(doc({
      games: [good({
        failure: { reason: 'secret', evidence: 'screenshot' },
        commercial_use: { status: 'not_verified', notes: 'internal' },
        verification: { parent_test_origin: 'https://3000-internal.manus.computer/' },
        technical_verification: { console_audit: { fatal_errors: ['x'] } },
        evidence_urls: ['https://example.test/'],
      })],
    }));
    const g = res.games[0];
    const serialized = JSON.stringify(g);
    for (const leak of ['failure', 'commercial_use', 'evidence', 'parent_test_origin',
      'console_audit', 'manus.computer', 'technical_verification']) {
      assert.ok(!serialized.includes(leak), `public object leaked "${leak}"`);
    }
    assert.deepEqual(Object.keys(g).sort(), [
      'canonicalUrl', 'categories', 'developer', 'embedUrl', 'id', 'name',
      'playCount', 'playCountDisplay', 'rank', 'ratingPercent', 'slug',
      'status', 'thumbnailUrl',
    ]);
  });

  test('abbreviated play count is never parsed into a number', () => {
    const g = parseCatalog(doc({ games: [good()] })).games[0];
    assert.equal(g.playCountDisplay, '458.5k');
    assert.equal(g.playCount, null, '"458.5k" must not become 458500 — that invents precision');
  });

  test('null developer is dropped rather than rendered as "null"', () => {
    const g = parseCatalog(doc({ games: [good()] })).games[0];
    assert.equal(g.developer, null);
  });
});

// ── Search / filter / sort ─────────────────────────────────────────────────
describe('filtering and sorting', () => {
  const games = parseCatalog(doc({
    games: [
      good({ id: 'a', slug: 'alpha', name: 'Alpha Racer', rank: 3,
             metadata: { categories: ['Racing'], rating_percent: 70, play_count: 10, developer: 'Studio A' } }),
      good({ id: 'b', slug: 'bravo', name: 'Bravo Puzzle', rank: 1,
             metadata: { categories: ['Puzzle'], rating_percent: 95, play_count: 5, developer: null } }),
      good({ id: 'c', slug: 'charlie', name: 'charlie action', rank: 2,
             metadata: { categories: ['Action', 'Puzzle'], rating_percent: null, play_count: null, developer: 'Studio A' } }),
    ],
  })).games;

  test('default order is rank', () => {
    assert.deepEqual(filterGames(games).map(g => g.slug), ['bravo', 'charlie', 'alpha']);
  });

  test('search is case-insensitive and does not mutate the source', () => {
    const before = games.map(g => g.slug).join(',');
    assert.deepEqual(filterGames(games, { q: 'PUZZLE' }).map(g => g.slug), ['bravo']);
    assert.deepEqual(filterGames(games, { q: 'charlie' }).map(g => g.slug), ['charlie']);
    assert.equal(games.map(g => g.slug).join(','), before, 'the source array was reordered');
  });

  test('category filter matches any of a game\'s categories', () => {
    assert.deepEqual(filterGames(games, { category: 'Puzzle' }).map(g => g.slug), ['bravo', 'charlie']);
  });

  test('developer filter works only on real values', () => {
    assert.deepEqual(filterGames(games, { developer: 'Studio A' }).map(g => g.slug), ['charlie', 'alpha']);
  });

  test('rating sort puts unrated last, not at zero', () => {
    assert.deepEqual(filterGames(games, { sort: 'rating' }).map(g => g.slug), ['bravo', 'alpha', 'charlie']);
  });

  test('play-count sort uses the numeric field only', () => {
    assert.deepEqual(filterGames(games, { sort: 'plays' }).map(g => g.slug), ['alpha', 'bravo', 'charlie']);
  });

  test('unknown sort falls back to rank instead of throwing', () => {
    assert.deepEqual(filterGames(games, { sort: 'drop table' }).map(g => g.slug), ['bravo', 'charlie', 'alpha']);
  });

  test('categoriesOf is deduped and sorted', () => {
    assert.deepEqual(categoriesOf(games), ['Action', 'Puzzle', 'Racing']);
  });

  test('an empty catalog filters to empty without error', () => {
    assert.deepEqual(filterGames([], { q: 'anything' }), []);
    assert.deepEqual(categoriesOf([]), []);
  });
});

// ── The rules the UI must not break ────────────────────────────────────────
describe('client code honours the embedding policy', () => {
  const player = readFileSync(join(ROOT, 'public', 'js', 'gameflare-player.js'), 'utf8');
  const catalog = readFileSync(join(ROOT, 'public', 'js', 'gameflare-catalog.js'), 'utf8');
  const playHtml = readFileSync(join(ROOT, 'public', 'gameflare-play.html'), 'utf8');
  // Strip comments so prose ABOUT a forbidden pattern is not mistaken for the
  // pattern. Both files discuss window.open at length in order to forbid it.
  const code = (src) => src.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const playerCode = code(player);
  const catalogCode = code(catalog);

  test('the fixtures were actually read', () => {
    assert.ok(playerCode.includes('gf-stage') && catalogCode.includes('gf-grid'));
  });

  test('never opens a new tab or window', () => {
    for (const [name, src] of [['player', playerCode], ['catalog', catalogCode]]) {
      assert.ok(!/window\.open\s*\(/.test(src), `${name} calls window.open`);
      assert.ok(!/target\s*=\s*['"]_blank['"]/.test(src), `${name} sets target=_blank`);
      assert.ok(!/\.target\s*=\s*['"]_blank['"]/.test(src), `${name} sets .target=_blank`);
    }
    assert.ok(!/target=["']_blank["']/.test(playHtml), 'player HTML has a _blank target');
  });

  test('never navigates the parent to gameflare.com', () => {
    for (const [name, src] of [['player', playerCode], ['catalog', catalogCode]]) {
      assert.ok(!/location\s*\.\s*(href|assign|replace)\s*[=(]/.test(src),
        `${name} assigns location — the player must stay on the internal route`);
    }
  });

  test('the iframe src is the exact embed_url, never derived', () => {
    assert.ok(/frame\.src\s*=\s*game\.embedUrl/.test(playerCode),
      'the iframe src must be the exact validated embed URL');
    // No string-building of a gameflare URL anywhere in the client.
    for (const [name, src] of [['player', playerCode], ['catalog', catalogCode]]) {
      assert.ok(!/['"`]https:\/\/www\.gameflare\.com/.test(src),
        `${name} hard-codes a gameflare.com URL — it must only use dataset values`);
    }
  });

  test('adds no sandbox attribute (the dataset was verified without one)', () => {
    assert.ok(!/sandbox/i.test(playerCode), 'player sets a sandbox attribute');
    assert.ok(!/sandbox/i.test(playHtml), 'player HTML sets a sandbox attribute');
  });

  test('exactly one iframe can exist, and it is created in one place', () => {
    assert.equal((playerCode.match(/createElement\(\s*['"]iframe['"]\s*\)/g) || []).length, 1);
    assert.ok(/stage\.replaceChildren\(\s*frame\s*\)/.test(playerCode),
      'the stage must be replaced wholesale so a second frame cannot accumulate');
    assert.ok(!/<iframe/i.test(playHtml), 'the player HTML must not ship a static iframe');
    assert.ok(!/createElement\(\s*['"]iframe['"]\s*\)/.test(catalogCode),
      'catalog cards must never create a hidden iframe');
  });

  test('no dataset value is written as HTML', () => {
    for (const [name, src] of [['player', playerCode], ['catalog', catalogCode]]) {
      assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src),
        `${name} writes HTML from data`);
    }
  });

  test('advertising slots are outside the stage and empty by default', () => {
    // Structural: both ad slots must be siblings of the stage, never inside it.
    const stageIdx = playHtml.indexOf('id="gf-stage"');
    const slots = [...playHtml.matchAll(/data-gf-ad="(above|below)"/g)];
    assert.equal(slots.length, 2, 'expected exactly two ad slots');
    assert.ok(stageIdx > 0);
    // Every slot ships hidden, and nothing in the client writes to them.
    assert.equal((playHtml.match(/class="gf-ad-slot"[^>]*hidden/g) || []).length, 2,
      'both advertising slots must ship hidden — commercial use is not verified');
    assert.ok(!/gf-ad/.test(playerCode), 'the player must not populate an ad slot');
  });

  test('a load event is not reported as gameplay verification', () => {
    assert.ok(!/verified|guaranteed|confirmed playable/i.test(playerCode.match(/setStatus\([^)]*\)/g)?.join(' ') || ''),
      'no status message may claim verification');
  });
});

// ── Server wiring ──────────────────────────────────────────────────────────
describe('server routes', () => {
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8');

  test('the catalog and player routes exist', () => {
    assert.ok(src.includes("app.get('/gameflare'"), 'missing /gameflare');
    assert.ok(src.includes("app.get('/gameflare/play/:slug'"), 'missing internal player route');
    assert.ok(src.includes("app.get('/api/gameflare/games'"), 'missing catalog API');
    assert.ok(src.includes("app.get('/api/gameflare/games/:slug'"), 'missing single-game API');
  });

  test('the admin audit route is authenticated', () => {
    const i = src.indexOf("app.get('/api/admin/gameflare-audit'");
    assert.ok(i > 0, 'missing admin audit route');
    const body = src.slice(i, src.indexOf('\napp.', i + 1));
    assert.ok(/requireAdmin\s*\(/.test(body),
      'the audit view exposes excluded candidates and MUST call requireAdmin');
  });

  test('GameFlare games are not merged into the main catalog', () => {
    // The main catalog blocks gameflare.com host-wide at the serve layer. If
    // these records were pushed into CATALOG they would be stripped there, and
    // the two rule sets would fight silently.
    assert.ok(!/CATALOG\.games\.push[\s\S]{0,120}GAMEFLARE/.test(src));
    assert.ok(!/setCatalog\([^)]*GAMEFLARE/.test(src));
  });
});
