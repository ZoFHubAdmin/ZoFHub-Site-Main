// Unit tests for the limiter primitive and its client key. The behavioural
// traffic-model tests live in rate-limits.test.mjs; these pin the arithmetic
// that file relies on: continuous refill, independent scopes, and an IP key
// that folds IPv4-mapped IPv6 and groups IPv6 by /64.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, createLimiterSet, clientKey } from '../lib/rate-limit.mjs';

describe('clientKey', () => {
  test('IPv4 is itself; the mapped IPv6 form folds to it', () => {
    assert.equal(clientKey('203.0.113.9'), '203.0.113.9');
    assert.equal(clientKey('::ffff:203.0.113.9'), '203.0.113.9');
    assert.equal(clientKey('::ffff:203.0.113.9'), clientKey('203.0.113.9'));
  });

  test('IPv6 is grouped by /64, so one subscriber is one key', () => {
    const a = clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const b = clientKey('2001:db8:1:2:0:0:0:1');
    assert.equal(a, b, 'two addresses in one /64 must share a bucket');
    assert.match(a, /\/64$/);
    assert.notEqual(a, clientKey('2001:db8:1:3::1'), 'a different /64 is a different key');
  });

  test('empty and unparseable inputs are safe', () => {
    assert.equal(clientKey(''), 'unknown');
    assert.equal(clientKey(undefined), 'unknown');
    assert.equal(clientKey('not an ip'), 'not an ip');   // opaque token passes through unchanged
  });
});

describe('createLimiter', () => {
  test('burst then a steady rate of one per refillMs', () => {
    let t = 0;
    const l = createLimiter({ capacity: 3, refillMs: 1000, now: () => t });
    assert.equal(l.allow('k'), true);
    assert.equal(l.allow('k'), true);
    assert.equal(l.allow('k'), true);
    assert.equal(l.allow('k'), false, 'burst spent');
    t = 1000;
    assert.equal(l.allow('k'), true, 'one token back after one interval');
    assert.equal(l.allow('k'), false);
  });

  test('refill is continuous — fractional intervals accrue, not discarded', () => {
    let t = 0;
    const l = createLimiter({ capacity: 1, refillMs: 1000, now: () => t });
    assert.equal(l.allow('k'), true);
    // Three calls each 500ms apart. The old floor()-and-reset arithmetic threw
    // the leftover 500ms away every time, so the second token never arrived.
    t = 500; assert.equal(l.allow('k'), false);
    t = 1000; assert.equal(l.allow('k'), true, 'two half-intervals must sum to one token');
  });

  test('keys are independent', () => {
    const l = createLimiter({ capacity: 1, refillMs: 1000, now: () => 0 });
    assert.equal(l.allow('a'), true);
    assert.equal(l.allow('a'), false);
    assert.equal(l.allow('b'), true, 'b has its own bucket');
  });

  test('eviction under memory pressure only ever grants a full bucket', () => {
    let t = 0;
    const l = createLimiter({ capacity: 2, refillMs: 1000, maxKeys: 4, now: () => t });
    for (let i = 0; i < 10; i++) l.allow('key' + i);     // forces an eviction
    assert.ok(l.size() <= 4);
    // An evicted key returns with a full burst — eviction can never be used to
    // deny a client, only (harmlessly) to forgive it.
    assert.equal(l.allow('key0'), true);
    assert.equal(l.allow('key0'), true);
  });

  test('a bad configuration throws instead of silently allowing everything', () => {
    assert.throws(() => createLimiter({ capacity: 0, refillMs: 1000 }));
    assert.throws(() => createLimiter({ capacity: 5, refillMs: 0 }));
  });
});

describe('createLimiterSet', () => {
  test('an unknown scope throws — a typo cannot silently share a budget', () => {
    const s = createLimiterSet({ a: { capacity: 1, refillMs: 1000 } });
    assert.throws(() => s.allow('typo', '1.2.3.4'), /unknown rate-limit scope/);
  });

  test('rawKey bypasses IP folding for non-address keys', () => {
    const s = createLimiterSet({ sess: { capacity: 1, refillMs: 1000 } }, { now: () => 0 });
    assert.equal(s.allow('sess', 'session-id-with:colons', { rawKey: true }), true);
    assert.equal(s.allow('sess', 'session-id-with:colons', { rawKey: true }), false);
  });

  test('retryAfterSec is at least one second once a bucket is empty', () => {
    let t = 0;
    const s = createLimiterSet({ a: { capacity: 1, refillMs: 5000 } }, { now: () => t });
    s.allow('a', '1.2.3.4');
    assert.ok(s.retryAfterSec('a', '1.2.3.4') >= 1);
  });
});
