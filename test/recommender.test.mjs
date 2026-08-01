// Unit tests for lib/recommender.mjs
//
// Runs against a synthetic catalog rather than the real one, so the suite is
// deterministic and does not need data/game-similarity.json to have been built.
// The recommender falls back to category affinity when the index is absent,
// which is exactly the path a fresh clone exercises.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { recommend } from '../lib/recommender.mjs';

// 60 games over 4 categories, plus a deliberate duplicate title.
function makeCatalog() {
  const cats = ['racing', 'puzzle', 'shooting', 'arcade'];
  const games = [];
  for (let i = 0; i < 60; i++) {
    const c = cats[i % cats.length];
    games.push({
      slug: `${c}-${i}`,
      title: `${c[0].toUpperCase() + c.slice(1)} Game ${i}`,
      category: c,
      thumbnail: `/thumbs/${c}-${i}.webp`,
      plays: i % 7,
    });
  }
  // Same title under a different slug — the catalog really does contain these.
  games.push({ slug: 'racing-dupe', title: 'Racing Game 0', category: 'racing', thumbnail: '/t.webp', plays: 0 });
  return games;
}

const catalog = makeCatalog();
const bySlug = new Map(catalog.map(g => [g.slug, g]));
const getGame = (s) => bySlug.get(s);
const pool = () => catalog;
const opts = { getGame, pool, playsOf: (s) => (bySlug.get(s) || {}).plays || 0 };

describe('recommend — core contract', () => {
  test('returns the requested number of games', () => {
    const out = recommend({ history: ['racing-0', 'racing-4', 'racing-8'], limit: 12, ...opts });
    assert.equal(out.length, 12);
  });

  test('never recommends a game the user already played', () => {
    const history = ['racing-0', 'racing-4', 'racing-8', 'puzzle-1'];
    const out = recommend({ history, limit: 18, ...opts });
    for (const g of out) {
      assert.ok(!history.includes(g.slug), `${g.slug} was already played`);
    }
  });

  test('never recommends a favourite back to the user', () => {
    const favorites = ['puzzle-1', 'puzzle-5'];
    const out = recommend({ history: ['racing-0'], favorites, limit: 18, ...opts });
    for (const g of out) assert.ok(!favorites.includes(g.slug));
  });

  test('returns no duplicate slugs', () => {
    const out = recommend({ history: ['racing-0', 'puzzle-1'], limit: 18, ...opts });
    assert.equal(new Set(out.map(g => g.slug)).size, out.length);
  });

  test('returns no duplicate TITLES', () => {
    // REGRESSION: the similarity index once returned "Turn 90" twice under two
    // slugs, and the row rendered the same game side by side.
    const out = recommend({ history: ['racing-4', 'racing-8'], limit: 18, ...opts });
    const titles = out.map(g => String(g.title).toLowerCase());
    assert.equal(new Set(titles).size, titles.length, 'duplicate titles in one row');
  });

  test('every pick carries an attribution', () => {
    // The UI says "Because you played X", so every item must know its reason.
    const out = recommend({ history: ['racing-0', 'racing-4'], limit: 12, ...opts });
    for (const g of out) {
      assert.ok(g.because && typeof g.because.kind === 'string', `${g.slug} has no attribution`);
    }
  });
});

describe('recommend — the failure modes found in testing', () => {
  test('COLD START returns a full row instead of nothing', () => {
    // REGRESSION: with no history the loop exited immediately and a new visitor
    // saw an empty row.
    const out = recommend({ history: [], favorites: [], limit: 12, ...opts });
    assert.equal(out.length, 12, 'a first-time visitor must still get games');
  });

  test('SINGLE-GENRE taste still fills the row', () => {
    // REGRESSION: an all-racing history hit the category quota and the row
    // stopped at 5 of 12.
    const history = ['racing-0', 'racing-4', 'racing-8', 'racing-12'];
    const out = recommend({ history, limit: 12, ...opts });
    assert.equal(out.length, 12);
    const racing = out.filter(g => g.category === 'racing').length;
    assert.ok(racing >= 6, `a racing fan should get mostly racing, got ${racing}/12`);
  });

  test('single-genre taste still leaves room for discovery', () => {
    // REGRESSION: the opposite failure — deferred picks filled every slot and
    // exploration was squeezed to zero, producing a filter bubble.
    const history = ['racing-0', 'racing-4', 'racing-8', 'racing-12'];
    const out = recommend({ history, limit: 12, ...opts });
    assert.ok(out.some(g => g.because.kind === 'discover'),
      'at least one discovery slot should survive');
  });

  test('unknown slugs in history are ignored, not fatal', () => {
    const out = recommend({ history: ['does-not-exist', 'racing-0'], limit: 10, ...opts });
    assert.equal(out.length, 10);
  });

  test('limit larger than the catalog does not hang or throw', () => {
    const out = recommend({ history: ['racing-0'], limit: 500, ...opts });
    assert.ok(out.length > 0);
    assert.ok(out.length <= catalog.length);
  });
});

describe('recommend — diversity', () => {
  test('a mixed history produces a mixed row', () => {
    const out = recommend({ history: ['racing-0', 'puzzle-1', 'shooting-2'], limit: 12, ...opts });
    const cats = new Set(out.map(g => g.category));
    assert.ok(cats.size >= 2, `expected several categories, got ${[...cats].join(',')}`);
  });

  test('no single category takes the entire row for a mixed history', () => {
    const out = recommend({ history: ['racing-0', 'puzzle-1', 'shooting-2', 'arcade-3'], limit: 12, ...opts });
    const counts = {};
    for (const g of out) counts[g.category] = (counts[g.category] || 0) + 1;
    const biggest = Math.max(...Object.values(counts));
    assert.ok(biggest < out.length, 'one category should not own the whole row');
  });
});
