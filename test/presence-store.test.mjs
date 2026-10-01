// lib/presence-store.mjs holds the live "N playing now" sessions. These tests
// pin the properties server.js depends on: TTL expiry, the per-address session
// cap, prototype-safe slug keys, slug validation, and the memoised snapshot.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPresenceStore } from '../lib/presence-store.mjs';

describe('presence store', () => {
  test('counts live sessions and per-game totals', () => {
    let t = 0;
    const s = createPresenceStore({ isKnownSlug: () => true, now: () => t });
    s.beat('sessionAAAA', 'tetris', 'ip1');
    s.beat('sessionBBBB', 'tetris', 'ip2');
    s.beat('sessionCCCC', 'snake', 'ip3');
    const snap = s.snapshot();
    assert.equal(snap.total, 3);
    assert.equal(snap.games.tetris, 2);
    assert.equal(snap.games.snake, 1);
  });

  test('a session expires after the TTL', () => {
    let t = 0;
    const s = createPresenceStore({ ttlMs: 8000, maxAgeMs: 0, isKnownSlug: () => true, now: () => t });
    s.beat('sessionAAAA', 'tetris', 'ip1');
    t = 7999; assert.equal(s.snapshot().total, 1);
    t = 8001; assert.equal(s.snapshot().total, 0, 'a stale session must drop out');
  });

  test('leave removes a session immediately', () => {
    const s = createPresenceStore({ isKnownSlug: () => true, maxAgeMs: 0, now: () => 0 });
    s.beat('sessionAAAA', 'tetris', 'ip1');
    assert.equal(s.snapshot().total, 1);
    s.leave('sessionAAAA');
    assert.equal(s.snapshot().total, 0);
  });

  test('one address cannot exceed the per-address session cap', () => {
    const s = createPresenceStore({ maxSessionsPerKey: 5, maxAgeMs: 0, now: () => 0 });
    let accepted = 0;
    for (let i = 0; i < 50; i++) if (s.beat(`sess${i}xxxx`, null, 'one-ip').accepted) accepted++;
    assert.equal(accepted, 5);
    assert.equal(s.beat('anotherXX', null, 'different-ip').accepted, true, 'a different address is unaffected');
  });

  test('a slug named like a prototype key cannot corrupt the snapshot', () => {
    const s = createPresenceStore({ isKnownSlug: () => true, now: () => 0 });
    s.beat('sessionAAAA', 'constructor', 'ip1');
    s.beat('sessionBBBB', '__proto__', 'ip2');
    const snap = s.snapshot();
    assert.equal(snap.games.constructor, 1, 'a real game slugged "constructor" must count');
    assert.equal(typeof snap.total, 'number');
    assert.doesNotThrow(() => JSON.stringify(snap));
    assert.ok(!JSON.stringify(snap).includes('native code'), 'a function leaked into the payload');
  });

  test('an unknown or malformed slug is counted as "no game", not rejected wholesale', () => {
    const s = createPresenceStore({ isKnownSlug: (x) => x === 'real-game', now: () => 0 });
    const r = s.beat('sessionAAAA', 'not-in-catalog', 'ip1');
    assert.equal(r.accepted, true, 'the visitor is still present');
    assert.equal(s.snapshot().total, 1);
    assert.equal(Object.keys(s.snapshot().games).length, 0, 'but not attributed to a game');
  });

  test('a bad session id is refused', () => {
    const s = createPresenceStore({ now: () => 0 });
    assert.equal(s.beat('', 'g', 'ip').accepted, false);
    assert.equal(s.beat('short', 'g', 'ip').accepted, false);       // < 8 chars
    assert.equal(s.beat('has spaces!!', 'g', 'ip').accepted, false);
    assert.equal(s.beat('a'.repeat(65), 'g', 'ip').accepted, false); // > 64 chars
  });

  test('snapshotJson matches the object and is memoised within its window', () => {
    let t = 0;
    const s = createPresenceStore({ isKnownSlug: () => true, minRecomputeMs: 250, maxAgeMs: 1000, now: () => t });
    s.beat('sessionAAAA', 'tetris', 'ip1');
    const j1 = s.snapshotJson();
    assert.deepEqual(JSON.parse(j1), JSON.parse(JSON.stringify(s.snapshot())));
    s.beat('sessionBBBB', 'tetris', 'ip2');
    t = 100;                                    // inside the recompute floor
    assert.equal(JSON.parse(s.snapshotJson()).total, 1, 'memoised within the window');
    t = 1001;                                   // past maxAgeMs
    assert.equal(JSON.parse(s.snapshotJson()).total, 2, 'recomputed after the window');
  });

  test('the store is globally bounded and refuses new sessions when full', () => {
    const s = createPresenceStore({ maxSessions: 10, maxSessionsPerKey: 100, maxAgeMs: 0, now: () => 0 });
    let accepted = 0;
    for (let i = 0; i < 25; i++) if (s.beat(`sess${i}yyyy`, null, `ip${i}`).accepted) accepted++;
    assert.equal(accepted, 10, 'a full store refuses NEW sessions rather than evicting live ones');
  });
});
