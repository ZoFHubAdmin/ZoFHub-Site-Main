// The active-games roster: "serve exactly N games, and never grow on your own".
//
// The semantics here REVERSED: the cap used to be a floor so a grow job could
// push the roster past it. It is now a hard ceiling, and the grow helper is
// gone. The test named for the 129-slug roster is the regression that matters —
// that is the state this machine was actually found in.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as roster from '../lib/active-roster.mjs';
import {
  normalizeRoster, poolSlugs, reconcileRoster, selectActive,
} from '../lib/active-roster.mjs';

const game = (slug) => ({ slug, title: slug });
const pool = (n, prefix = 'g') => Array.from({ length: n }, (_, i) => game(`${prefix}-${i}`));

describe('normalizeRoster', () => {
  test('coerces junk into a well-formed roster', () => {
    assert.deepEqual(normalizeRoster(null), { cap: null, slugs: [], updatedAt: null });
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

describe('reconcileRoster — stability, under a hard ceiling', () => {
  test('an existing roster is preserved, and filled up to the target', () => {
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

  test('the reconciled set never exceeds the pool', () => {
    const r = reconcileRoster(poolSlugs(pool(7)), [], 100);
    assert.equal(r.slugs.length, 7);
  });

  // ── The reversal, stated as a test ──────────────────────────────────────
  test('a roster OVER the target is truncated back to it (ceiling, not floor)', () => {
    const slugs = poolSlugs(pool(1000));
    const existing = slugs.slice(0, 130);          // as the retired grow job left it
    const r = reconcileRoster(slugs, existing, 100);
    assert.equal(r.slugs.length, 100);             // truncated, not kept at 130
  });

  test('truncation keeps the FRONT of the roster, so the original set survives', () => {
    const slugs = poolSlugs(pool(500));
    const seeded = slugs.slice(0, 100);                       // the intended 100
    const grown = [...seeded, ...slugs.slice(100, 129)];      // +29 the job appended
    const r = reconcileRoster(slugs, grown, 100);
    assert.deepEqual(r.slugs, seeded, 'the originally-seeded 100 are exactly what is left');
  });
});

describe('the 129-game roster this machine was found with', () => {
  // data/active-roster.json held 129 slugs while every surface claimed 100,
  // because selectActive could not shrink a roster. It can now.
  test('a 129-slug roster serves exactly 100 games under a cap of 100', () => {
    const p = pool(5000);
    const over = { slugs: poolSlugs(p).slice(0, 129) };
    const r = selectActive(p, over, 100);
    assert.equal(r.games.length, 100);
    assert.equal(r.roster.slugs.length, 100, 'and the persisted roster is corrected too');
  });

  test('re-selecting is idempotent — it settles at 100 and stays there', () => {
    const p = pool(5000);
    let r = selectActive(p, { slugs: poolSlugs(p).slice(0, 129) }, 100);
    const first = r.roster.slugs;
    r = selectActive(p, r.roster, 100);
    assert.deepEqual(r.roster.slugs, first);
    assert.equal(r.games.length, 100);
  });
});

describe('the growth machinery is GONE, not merely unscheduled', () => {
  test('growRoster is no longer exported — there is nothing to re-wire', () => {
    assert.equal(roster.growRoster, undefined);
    assert.equal(roster.default.growRoster, undefined);
  });

  test('a repeated selectActive can never increase the served count', () => {
    const p = pool(2000);
    let r = selectActive(p, { slugs: [] }, 100);
    for (let i = 0; i < 25; i++) {
      r = selectActive(p, r.roster, 100);
      assert.equal(r.games.length, 100, `grew on pass ${i}`);
    }
  });
});
