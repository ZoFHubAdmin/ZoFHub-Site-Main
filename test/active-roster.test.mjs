// The active-games roster: "show 100 now, grow +30 every 36h".
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRoster, poolSlugs, reconcileRoster, growRoster, selectActive,
} from '../lib/active-roster.mjs';

const game = (slug) => ({ slug, title: slug });
const pool = (n, prefix = 'g') => Array.from({ length: n }, (_, i) => game(`${prefix}-${i}`));

describe('normalizeRoster', () => {
  test('coerces junk into a well-formed roster', () => {
    assert.deepEqual(normalizeRoster(null), { cap: null, slugs: [], updatedAt: null, lastGrowAt: null });
    const r = normalizeRoster({ cap: 100, slugs: ['A', 'a', ' b ', '', 3], updatedAt: 'x' });
    assert.equal(r.cap, 100);
    assert.deepEqual(r.slugs, ['a', 'b', '3']); // lowercased, trimmed, deduped, dropped empty
    assert.equal(r.updatedAt, 'x');
  });
});

describe('selectActive — the cap', () => {
  test('cap <= 0 means NO cap: the whole pool passes through, nothing persisted', () => {
    const p = pool(500);
    for (const c of [0, -1, undefined, null]) {
      const r = selectActive(p, { slugs: [] }, c);
      assert.equal(r.games.length, 500);
      assert.equal(r.capped, false);
      assert.deepEqual(r.roster.slugs, []);
    }
  });

  test('a cap of 100 yields exactly 100 active games from a big pool', () => {
    const r = selectActive(pool(12000), { slugs: [] }, 100);
    assert.equal(r.capped, true);
    assert.equal(r.games.length, 100);
    assert.equal(r.roster.slugs.length, 100);
  });

  test('a cap larger than the pool yields the whole pool, not a crash', () => {
    const r = selectActive(pool(40), { slugs: [] }, 100);
    assert.equal(r.games.length, 40);
    assert.equal(r.roster.slugs.length, 40);
  });

  test('active games are returned IN POOL ORDER, not roster order', () => {
    // roster lists g-2 before g-0, but the pool order is g-0, g-1, g-2…
    const r = selectActive(pool(5), { slugs: ['g-2', 'g-0'] }, 3);
    assert.deepEqual(r.games.map((g) => g.slug), ['g-0', 'g-1', 'g-2']);
  });
});

describe('reconcileRoster — stability is the whole point', () => {
  test('an existing roster is preserved, only filled up to the floor', () => {
    const slugs = poolSlugs(pool(1000));
    const r = reconcileRoster(slugs, ['g-900', 'g-901'], 5);
    // the two chosen stay, and are filled to 5 from the front of the pool
    assert.equal(r.slugs.length, 5);
    assert.ok(r.slugs.includes('g-900') && r.slugs.includes('g-901'));
  });

  test('delisted slugs (gone from the pool) are dropped', () => {
    const slugs = poolSlugs(pool(10));
    const r = reconcileRoster(slugs, ['g-1', 'deleted-game', 'g-2'], 3);
    assert.ok(!r.slugs.includes('deleted-game'));
    assert.equal(r.slugs.length, 3);
  });

  test('a roster already ABOVE the floor keeps all of it (floor, not ceiling)', () => {
    const slugs = poolSlugs(pool(1000));
    const existing = slugs.slice(0, 130);          // grown past 100
    const r = reconcileRoster(slugs, existing, 100);
    assert.equal(r.slugs.length, 130);             // not truncated back to 100
  });

  test('the reconciled set never exceeds the pool', () => {
    const r = reconcileRoster(poolSlugs(pool(7)), [], 100);
    assert.equal(r.slugs.length, 7);
  });
});

describe('growRoster — the +30 every 36h job', () => {
  test('adds exactly N new games from the pool', () => {
    const slugs = poolSlugs(pool(1000));
    const start = slugs.slice(0, 100);
    const r = growRoster(slugs, start, 30);
    assert.equal(r.added, 30);
    assert.equal(r.slugs.length, 130);
    // the new ones are the next unused pool entries, order preserved
    assert.deepEqual(r.slugs.slice(100), slugs.slice(100, 130));
  });

  test('is idempotent once the pool is exhausted', () => {
    const slugs = poolSlugs(pool(20));
    const full = [...slugs];
    const r = growRoster(slugs, full, 30);
    assert.equal(r.added, 0);
    assert.equal(r.slugs.length, 20);
  });

  test('never duplicates a slug already in the roster', () => {
    const slugs = poolSlugs(pool(50));
    const r = growRoster(slugs, ['g-5', 'g-6'], 10);
    assert.equal(new Set(r.slugs).size, r.slugs.length);
    assert.ok(r.slugs.includes('g-5') && r.slugs.includes('g-6'));
  });

  test('promoting grows the ACTIVE set on the next selectActive', () => {
    const p = pool(1000);
    const seeded = selectActive(p, { slugs: [] }, 100);
    assert.equal(seeded.games.length, 100);
    const grown = growRoster(poolSlugs(p), seeded.roster.slugs, 30);
    const after = selectActive(p, grown, 100);
    assert.equal(after.games.length, 130);   // 100 → 130 after one grow cycle
  });
});
