// The catalog freeze: the catalog is a curated set of a fixed size, and nothing
// adds to it without a person deliberately, temporarily opening the gate.
//
// Every test here injects `now`, so none of them depend on the wall clock.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BASELINE, MIN_UNLOCK_MINUTES, MAX_UNLOCK_MINUTES, DEFAULT_UNLOCK_MINUTES,
  LOCK_REASON, normalizeUnlock, clampMinutes, isUnlocked, remainingMs,
  mayAddGame, describeLock,
} from '../lib/catalog-lock.mjs';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const inMinutes = (m) => new Date(NOW + m * 60_000).toISOString();
const unlockedFor = (m) => ({ enabled: true, until: inMinutes(m), minutes: m });

describe('normalizeUnlock — anything it cannot read means LOCKED', () => {
  test('junk of every shape becomes the locked state', () => {
    for (const bad of [null, undefined, 0, '', 'yes', [], [1], true, NaN]) {
      const s = normalizeUnlock(bad);
      assert.equal(s.enabled, false, `${JSON.stringify(bad)} must not unlock`);
      assert.equal(s.until, null);
    }
  });

  test('an "enabled" unlock with NO expiry is not a valid unlock', () => {
    // The time limit is the safety property; without one there is no unlock.
    const s = normalizeUnlock({ enabled: true, until: null });
    assert.equal(s.enabled, false);
    assert.equal(isUnlocked({ enabled: true, until: null }, NOW), false);
  });

  test('an unparseable expiry is rejected rather than trusted', () => {
    assert.equal(isUnlocked({ enabled: true, until: 'next Tuesday' }, NOW), false);
  });

  test('a well-formed unlock survives normalisation intact', () => {
    const s = normalizeUnlock({ enabled: true, until: inMinutes(30), minutes: 30, by: 'owner' });
    assert.equal(s.enabled, true);
    assert.equal(s.until, inMinutes(30));
    assert.equal(s.by, 'owner');
  });
});

describe('clampMinutes — the unlock window has a floor and a ceiling', () => {
  test('values are clamped into the permitted range', () => {
    assert.equal(clampMinutes(1), MIN_UNLOCK_MINUTES);
    assert.equal(clampMinutes(-99), MIN_UNLOCK_MINUTES);
    assert.equal(clampMinutes(999999), MAX_UNLOCK_MINUTES);
    assert.equal(clampMinutes(60), 60);
  });
  test('nonsense falls back to the default rather than to "forever"', () => {
    for (const bad of [undefined, null, 'abc', NaN, {}]) {
      assert.equal(clampMinutes(bad), DEFAULT_UNLOCK_MINUTES);
    }
  });
});

describe('isUnlocked / remainingMs — expiry is evaluated, never scheduled', () => {
  test('an unlock inside its window is in force', () => {
    assert.equal(isUnlocked(unlockedFor(30), NOW), true);
    assert.equal(remainingMs(unlockedFor(30), NOW), 30 * 60_000);
  });

  test('an unlock past its window is NOT in force, with nothing having run', () => {
    // This is the restart case: the unlock was written, the process died, and
    // the window passed while nothing was alive to flip a flag.
    const stale = { enabled: true, until: inMinutes(-1), minutes: 60 };
    assert.equal(isUnlocked(stale, NOW), false);
    assert.equal(remainingMs(stale, NOW), 0);
  });

  test('the boundary is exclusive — an unlock expiring exactly now is closed', () => {
    assert.equal(isUnlocked({ enabled: true, until: inMinutes(0) }, NOW), false);
  });
});

describe('mayAddGame — headroom below the baseline, refusal at it', () => {
  test('below the baseline, adding needs no unlock at all', () => {
    const r = mayAddGame({ unlock: null, publishedCount: 98, baseline: 100, now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.unlocked, false, 'allowed by headroom, not by an unlock');
    assert.equal(r.headroom, 2);
  });

  test('adding exactly up TO the baseline is allowed', () => {
    assert.equal(mayAddGame({ unlock: null, publishedCount: 99, baseline: 100, now: NOW }).ok, true);
  });

  test('at the baseline, a locked catalog refuses', () => {
    const r = mayAddGame({ unlock: null, publishedCount: 100, baseline: 100, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.code, LOCK_REASON.AT_BASELINE);
    assert.match(r.reason, /locked at its 100-game baseline/);
    assert.equal(r.headroom, 0);
  });

  test('over the baseline (the 129 case) also refuses', () => {
    const r = mayAddGame({ unlock: null, publishedCount: 129, baseline: 100, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.headroom, 0);
  });

  test('a live unlock permits adding past the baseline — the whole point', () => {
    const r = mayAddGame({ unlock: unlockedFor(30), publishedCount: 100, baseline: 100, now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.unlocked, true);
  });

  test('an EXPIRED unlock refuses, and says that it expired', () => {
    const r = mayAddGame({
      unlock: { enabled: true, until: inMinutes(-5), minutes: 60 },
      publishedCount: 100, baseline: 100, now: NOW,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, LOCK_REASON.EXPIRED);
    assert.match(r.reason, /expired/);
  });

  test('a BULK add is judged on the whole batch, not one row at a time', () => {
    // 90 published + 400 imported must refuse, even though 90 < 100.
    const r = mayAddGame({ unlock: null, publishedCount: 90, baseline: 100, adding: 400, now: NOW });
    assert.equal(r.ok, false);
    // …while a batch that fits inside the headroom is fine.
    assert.equal(mayAddGame({ unlock: null, publishedCount: 90, baseline: 100, adding: 10, now: NOW }).ok, true);
    assert.equal(mayAddGame({ unlock: null, publishedCount: 90, baseline: 100, adding: 11, now: NOW }).ok, false);
  });

  test('missing/garbage inputs fail CLOSED at the default baseline', () => {
    const r = mayAddGame({ unlock: 'definitely-unlocked', publishedCount: 500 });
    assert.equal(r.ok, false);
    assert.equal(r.baseline, DEFAULT_BASELINE);
  });

  test('called with nothing at all, it does not throw and does not open', () => {
    const r = mayAddGame();
    assert.equal(typeof r.ok, 'boolean');
    assert.equal(r.baseline, DEFAULT_BASELINE);
  });
});

describe('describeLock — what the console shows an operator', () => {
  test('a locked catalog reads as locked, with its headroom', () => {
    const d = describeLock({ unlock: null, publishedCount: 100, baseline: 100, now: NOW });
    assert.equal(d.unlocked, false);
    assert.equal(d.baseline, 100);
    assert.equal(d.publishedCount, 100);
    assert.equal(d.headroom, 0);
    assert.equal(d.until, null);
    assert.equal(d.remainingMs, 0);
  });

  test('an unlocked catalog carries a countdown, so the limit is visible', () => {
    const d = describeLock({ unlock: unlockedFor(45), publishedCount: 100, baseline: 100, now: NOW });
    assert.equal(d.unlocked, true);
    assert.equal(d.remainingMs, 45 * 60_000);
    assert.equal(d.until, inMinutes(45));
  });

  test('an expired unlock is reported as expired, not merely absent', () => {
    const d = describeLock({
      unlock: { enabled: true, until: inMinutes(-10), minutes: 60 },
      publishedCount: 100, baseline: 100, now: NOW,
    });
    assert.equal(d.unlocked, false);
    assert.equal(d.expiredAt, inMinutes(-10));
  });

  test('it states that unlocking enables NO scheduler', () => {
    // Load-bearing: an operator must not read "unlock" as "turn the importer
    // back on". There is no importer to turn on.
    assert.equal(describeLock({ unlock: unlockedFor(10), now: NOW }).affectsSchedulers, false);
  });
});
