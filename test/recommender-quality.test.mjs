// Recommendation QUALITY, across the user profiles that actually break things.
//
// test/recommender.test.mjs already covers the mechanics (does it return games,
// does it exclude played ones). This file covers the properties that were
// silently wrong in production and that no amount of eyeballing would have
// caught, because every failure mode still returns a plausible list of games:
//
//   • a racing-only profile came back 16/18 racing — a filter bubble
//   • a multi-taste profile came back with THREE of its five interests missing
//   • a new visitor with no history came back empty
//
// The catalog here is SYNTHETIC and deterministic. Running these against the
// real 16.8k catalog would make them slow, and worse, make them fail whenever
// the catalog changed — which is a data problem, not a code regression.
// tools/eval-recommendations.py is the harness that measures the real catalog.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { recommend } from '../lib/recommender.mjs';

// ── A small world with clear structure ────────────────────────────────────
// Six categories x 20 games. Attributes are chosen so categories are genuinely
// distinct in attribute space, which is what lets "adjacent" mean anything.
const CATS = {
  racing:      { calm: 0.10, pace: 0.95, brainy: 0.30, challenge: 0.70, social: 0.70, cozy: 0.50 },
  sports:      { calm: 0.20, pace: 0.85, brainy: 0.30, challenge: 0.70, social: 0.90, cozy: 0.50 },
  action:      { calm: 0.10, pace: 0.90, brainy: 0.20, challenge: 0.80, social: 0.60, cozy: 0.30 },
  puzzle:      { calm: 0.90, pace: 0.10, brainy: 0.95, challenge: 0.40, social: 0.10, cozy: 0.55 },
  girls:       { calm: 0.75, pace: 0.40, brainy: 0.20, challenge: 0.15, social: 0.20, cozy: 0.95 },
  clicker:     { calm: 0.80, pace: 0.30, brainy: 0.25, challenge: 0.10, social: 0.10, cozy: 0.60 },
};

const GAMES = [];
const ATTRS = {};
for (const [cat, base] of Object.entries(CATS)) {
  for (let i = 0; i < 20; i++) {
    const slug = `${cat}-${i}`;
    GAMES.push({ slug, title: `${cat} game ${i}`, category: cat, thumbnail: `/t/${slug}.png` });
    // Tiny per-game jitter so games within a category are not byte-identical —
    // an all-identical category would make MMR's diversity term meaningless and
    // the test would pass for the wrong reason.
    ATTRS[slug] = { ...base, session_min: 8 + (i % 5) * 3, confidence: 0.7 };
    ATTRS[slug].pace = Math.min(1, Math.max(0, base.pace + ((i % 3) - 1) * 0.04));
  }
}
const BY_SLUG = new Map(GAMES.map(g => [g.slug, g]));

// Similarity index: games in a category are neighbours of each other. This
// mirrors what tools/build-recommendations.py produces for a real catalog —
// content similarity clusters hard by genre.
const NEIGHBOURS = new Map();
for (const g of GAMES) {
  NEIGHBOURS.set(g.slug, GAMES
    .filter(o => o.category === g.category && o.slug !== g.slug)
    .slice(0, 12)
    .map(o => [o.slug, 0.8]));
}

// The module reads its index from a file at boot. Rather than write one, inject
// the same shape through the documented seam: recommend() only ever reaches the
// index via neighbours(), and with no index loaded it falls back to category
// affinity — which is itself a path worth testing, below.
const base = {
  getGame: (s) => BY_SLUG.get(s),
  pool: () => GAMES,
  playsOf: () => 0,
  attrsOf: (s) => ATTRS[s],
};

const cats = (out) => out.map(g => g.category);
const topShare = (out) => {
  const c = {};
  for (const x of cats(out)) c[x] = (c[x] || 0) + 1;
  return Math.max(...Object.values(c)) / out.length;
};

describe('every profile gets a usable row', () => {
  const profiles = {
    'no history at all':      { history: [], favorites: [] },
    'one game':               { history: ['racing-0'], favorites: [] },
    'two games':              { history: ['racing-0', 'puzzle-0'], favorites: [] },
    'one game on repeat':     { history: Array(8).fill('racing-0'), favorites: ['racing-0'] },
    'single genre':           { history: Array.from({ length: 10 }, (_, i) => `racing-${i}`), favorites: [] },
    'many genres':            { history: ['racing-0', 'puzzle-0', 'girls-0', 'action-0', 'sports-0'], favorites: [] },
    'favourites only':        { history: [], favorites: ['puzzle-1', 'puzzle-2'] },
  };

  for (const [name, p] of Object.entries(profiles)) {
    test(`${name}: full row, no duplicates, all real games`, () => {
      const out = recommend({ ...base, ...p, limit: 12 });
      assert.equal(out.length, 12, `${name} got ${out.length} of 12`);

      const slugs = out.map(g => g.slug);
      assert.equal(new Set(slugs).size, slugs.length, 'a game appears twice');

      const titles = out.map(g => String(g.title).toLowerCase());
      assert.equal(new Set(titles).size, titles.length, 'a title appears twice');

      for (const g of out) assert.ok(BY_SLUG.has(g.slug), `${g.slug} is not in the catalog`);
    });

    test(`${name}: never recommends what they already played`, () => {
      const out = recommend({ ...base, ...p, limit: 12 });
      const seen = new Set([...p.history, ...p.favorites]);
      for (const g of out) {
        assert.ok(!seen.has(g.slug), `${g.slug} was already played/favourited`);
      }
    });

    test(`${name}: every pick is explained`, () => {
      const out = recommend({ ...base, ...p, limit: 12 });
      for (const g of out) {
        assert.ok(g.because && g.because.kind, `${g.slug} has no because`);
      }
    });
  }
});

describe('the filter bubble', () => {
  test('a single-genre profile still leaves its genre', () => {
    // Measured before the fix: 16 of 18 from one category.
    const history = Array.from({ length: 10 }, (_, i) => `racing-${i}`);
    const out = recommend({ ...base, history, favorites: [], limit: 18 });
    const share = topShare(out);
    assert.ok(share <= 0.55, `one category owns ${(share * 100).toFixed(0)}% of the row`);
    assert.ok(new Set(cats(out)).size >= 3, 'row should span at least 3 categories');
  });

  test('a single-genre profile still gets its genre', () => {
    // The opposite failure: over-correcting into irrelevance. Someone who only
    // plays racing must still see racing.
    const history = Array.from({ length: 10 }, (_, i) => `racing-${i}`);
    const out = recommend({ ...base, history, favorites: [], limit: 18 });
    const racing = cats(out).filter(c => c === 'racing').length;
    assert.ok(racing >= 4, `only ${racing} racing games for a racing-only profile`);
  });

  test('adjacent picks feel like the profile, not random', () => {
    const history = Array.from({ length: 10 }, (_, i) => `racing-${i}`);
    const out = recommend({ ...base, history, favorites: [], limit: 18 });
    const adjacent = out.filter(g => g.because.kind === 'adjacent');
    assert.ok(adjacent.length > 0, 'no adjacent-category discovery happened');
    // Racing is fast+competitive. Adjacent picks should be too — sports/action,
    // not puzzle/clicker. This is the difference between "related games from
    // adjacent categories" and "random games".
    for (const g of adjacent) {
      assert.ok(ATTRS[g.slug].pace >= 0.5,
        `${g.slug} (pace ${ATTRS[g.slug].pace}) does not feel like racing`);
    }
  });

  test('a multi-taste profile sees more than its top two tastes', () => {
    // Measured before the fix: racing + girls filled 16 of 18 and puzzle,
    // shooting and sports never appeared at all.
    const history = ['racing-0', 'racing-1', 'puzzle-0', 'puzzle-1',
                     'action-0', 'action-1', 'sports-0', 'sports-1'];
    const out = recommend({ ...base, history, favorites: ['girls-0'], limit: 18 });
    assert.ok(new Set(cats(out)).size >= 4,
      `only ${new Set(cats(out)).size} categories for a 5-taste profile`);
    assert.ok(topShare(out) <= 0.4, `top category owns ${topShare(out)} of the row`);
  });
});

describe('negative signal', () => {
  test('skipped games are never recommended', () => {
    const skips = ['racing-5', 'racing-6', 'racing-7'];
    const out = recommend({
      ...base, history: ['racing-0'], favorites: [], skips, limit: 12,
    });
    for (const s of skips) {
      assert.ok(!out.some(g => g.slug === s), `${s} was skipped but still shown`);
    }
  });

  test('skipping a genre shifts the row away from it', () => {
    const history = Array.from({ length: 6 }, (_, i) => `racing-${i}`);
    const before = recommend({ ...base, history, favorites: [], limit: 18 });
    const skips = Array.from({ length: 12 }, (_, i) => `racing-${i + 6}`);
    const after = recommend({ ...base, history, favorites: [], skips, limit: 18 });
    const rBefore = cats(before).filter(c => c === 'racing').length;
    const rAfter = cats(after).filter(c => c === 'racing').length;
    assert.ok(rAfter <= rBefore,
      `skipping 12 racing games did not reduce racing (${rBefore} -> ${rAfter})`);
  });

  test('one skip does not erase a taste', () => {
    // Asymmetry matters: a play is strong evidence, a skip is weak. A single
    // scroll-past must not undo a demonstrated preference.
    const history = Array.from({ length: 8 }, (_, i) => `racing-${i}`);
    const out = recommend({ ...base, history, favorites: [], skips: ['racing-9'], limit: 18 });
    assert.ok(cats(out).filter(c => c === 'racing').length >= 3,
      'a single skip wiped out the profile');
  });
});

describe('vibe carry-over', () => {
  const meanCalm = (o) => o.reduce((s, g) => s + ATTRS[g.slug].calm, 0) / o.length;

  test('a vibe reorders the feed within the visitor\'s tastes', () => {
    // A profile spanning several tastes is where a mood can legitimately act:
    // it promotes the calm things this person already likes and demotes the
    // frantic ones. Measured: mean calm 0.55 -> 0.71.
    const history = ['racing-0', 'racing-1', 'puzzle-0', 'puzzle-1', 'girls-0', 'clicker-0'];
    const plain = recommend({ ...base, history, favorites: [], limit: 18 });
    const calm = recommend({
      ...base, history, favorites: [], limit: 18,
      vibe: { targets: { calm: { value: 0.95, weight: 2 }, pace: { value: 0.1, weight: 2 } } },
    });
    assert.ok(meanCalm(calm) > meanCalm(plain) + 0.05,
      `a "relaxing" vibe barely moved the feed (${meanCalm(plain).toFixed(2)} -> ${meanCalm(calm).toFixed(2)})`);
    // The profile must survive it — this is a nudge, not a replacement.
    assert.ok(new Set(cats(calm)).size >= 3, 'the vibe collapsed the feed');
  });

  test('a vibe cannot override relevance for a single-taste visitor', () => {
    // This is a DESIGNED BOUND, not a gap. Someone whose entire history is
    // racing has no calm games in their candidate set, and the feed is the
    // ambient surface — a mood typed once must not replace a demonstrated
    // preference there. The Vibe Finder itself is where an explicit request
    // wins outright (lib/vibe-engine.mjs caps taste at 0.3 for that reason).
    const history = Array.from({ length: 8 }, (_, i) => `racing-${i}`);
    const calm = recommend({
      ...base, history, favorites: [], limit: 18,
      vibe: { targets: { calm: { value: 0.95, weight: 2 }, pace: { value: 0.1, weight: 2 } } },
    });
    assert.ok(cats(calm).filter(c => c === 'racing').length >= 3,
      'a passing mood erased a demonstrated preference');
    assert.ok(meanCalm(calm) < 0.5,
      'the feed abandoned relevance to chase a mood');
  });

  test('works with no attributes available', () => {
    // A fresh clone has not run the Python step. The vibe signal must then be
    // ignored rather than crashing or emptying the row.
    const out = recommend({
      ...base, attrsOf: null, history: ['racing-0'], favorites: [], limit: 12,
      vibe: { targets: { calm: { value: 0.9, weight: 2 } } },
    });
    assert.equal(out.length, 12);
  });
});

describe('backwards compatibility', () => {
  test('the pre-existing call signature still works', () => {
    // server.js and the local fallback both called recommend() without skips,
    // vibe or attrsOf. Those must remain optional.
    const out = recommend({
      history: ['racing-0', 'racing-1'],
      favorites: ['puzzle-0'],
      getGame: (s) => BY_SLUG.get(s),
      pool: () => GAMES,
      limit: 10,
    });
    assert.equal(out.length, 10);
    assert.ok(out.every(g => g.because));
  });

  test('cold start returns a full row with no signals at all', () => {
    const out = recommend({
      history: [], favorites: [],
      getGame: (s) => BY_SLUG.get(s), pool: () => GAMES, limit: 12,
    });
    assert.equal(out.length, 12, 'a new visitor got a short row');
    assert.ok(new Set(cats(out)).size >= 3, 'cold start should be broad');
  });
});
