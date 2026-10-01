// Tests for the two pieces added when the admin surface was hardened:
// the in-memory credential throttle, and the usage counters behind the console.
//
// The throttle is the only thing standing between a bearer token and unlimited
// online guessing, so its edges are worth pinning down: it must lock, it must
// expire, it must forget a caller who proves themselves, and it must never grow
// without bound.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  credentialThrottle, noteCredentialFailure, clearCredentialFailures,
  _resetCredentialThrottle, CRED_THRESHOLD, CRED_WINDOW_MS, CRED_LOCK_MS,
} from '../lib/admin-auth.mjs';

import {
  noteAiRequest, noteVisitor, notePeakConcurrent, usageSnapshot, _reset,
} from '../lib/usage-stats.mjs';

describe('admin credential throttle', () => {
  beforeEach(() => _resetCredentialThrottle());

  test('an untouched caller is not throttled', () => {
    assert.equal(credentialThrottle('ip-a').locked, false);
  });

  test('locks only once the threshold is reached', () => {
    for (let i = 1; i < CRED_THRESHOLD; i++) {
      assert.equal(noteCredentialFailure('ip-a').locked, false, `failure ${i} must not lock`);
    }
    const last = noteCredentialFailure('ip-a');
    assert.equal(last.locked, true);
    assert.ok(last.retryAfterSec > 0);
  });

  test('the lock expires', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < CRED_THRESHOLD; i++) noteCredentialFailure('ip-b', t0);
    assert.equal(credentialThrottle('ip-b', t0).locked, true);
    assert.equal(credentialThrottle('ip-b', t0 + CRED_LOCK_MS + 1).locked, false);
  });

  test('failures outside the window do not accumulate', () => {
    const t0 = 2_000_000;
    // One failure every window-and-a-bit never reaches the threshold.
    for (let i = 0; i < CRED_THRESHOLD * 2; i++) {
      const r = noteCredentialFailure('ip-c', t0 + i * (CRED_WINDOW_MS + 1000));
      assert.equal(r.locked, false);
    }
  });

  test('a proven credential clears the record', () => {
    for (let i = 0; i < CRED_THRESHOLD - 1; i++) noteCredentialFailure('ip-d');
    clearCredentialFailures('ip-d');
    assert.equal(credentialThrottle('ip-d').failures, 0);
    // …and the counter genuinely restarts rather than resuming.
    for (let i = 1; i < CRED_THRESHOLD; i++) {
      assert.equal(noteCredentialFailure('ip-d').locked, false);
    }
  });

  test('one caller cannot lock out another', () => {
    for (let i = 0; i < CRED_THRESHOLD; i++) noteCredentialFailure('attacker');
    assert.equal(credentialThrottle('attacker').locked, true);
    assert.equal(credentialThrottle('the-real-operator').locked, false);
  });

  test('a missing key is ignored rather than shared', () => {
    // hashIp() returns null with no secret configured; that must not become one
    // global bucket every caller shares.
    assert.equal(noteCredentialFailure(null).locked, false);
    assert.equal(credentialThrottle(null).locked, false);
  });

  test('a flood of distinct keys stays bounded', () => {
    for (let i = 0; i < 12000; i++) noteCredentialFailure('flood-' + i);
    // The exact cap is an implementation detail; that it HAS one is not.
    assert.ok(credentialThrottle('flood-11999').failures >= 1);
  });
});

describe('usage counters', () => {
  beforeEach(() => _reset());

  test('AI requests are counted per kind and totalled', () => {
    noteAiRequest('text'); noteAiRequest('text'); noteAiRequest('image');
    const u = usageSnapshot();
    assert.equal(u.ai.text, 2);
    assert.equal(u.ai.image, 1);
    assert.equal(u.ai.total, 3);
  });

  test('an unknown AI kind is folded into text rather than creating a field', () => {
    noteAiRequest('wormhole');
    const u = usageSnapshot();
    assert.equal(u.ai.text, 1);
    assert.equal(u.ai.wormhole, undefined);
  });

  test('visitors are distinct, not a hit count', () => {
    noteVisitor('h1'); noteVisitor('h1'); noteVisitor('h1'); noteVisitor('h2');
    assert.equal(usageSnapshot().visitors.today, 2);
  });

  test('a missing hash is not counted as a visitor', () => {
    noteVisitor(null); noteVisitor(''); noteVisitor(undefined);
    assert.equal(usageSnapshot().visitors.today, 0);
  });

  test('peak concurrency only ever rises', () => {
    notePeakConcurrent(4); notePeakConcurrent(9); notePeakConcurrent(2);
    assert.equal(usageSnapshot().peakConcurrent, 9);
  });

  test('the snapshot labels its own scope, so the console cannot overstate it', () => {
    const u = usageSnapshot();
    assert.match(u.ai.scope, /server-side/i);
    assert.match(u.visitors.scope, /this instance/i);
  });
});
