// Operational metrics.
//
// The redaction tests are the important ones. Everything else here is a rollup
// that would be obvious if it broke; a credential written into the error buffer
// would not be, and it would sit in server memory and in an admin's browser
// until someone happened to look.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createErrorLog, redact, signature, summarizeCatalog, MAX_ERRORS } from '../lib/ops-metrics.mjs';

describe('errors must never carry a credential', () => {
  test('every credential shape this repository uses is scrubbed', () => {
    const cases = [
      ['legacy JWT',       'failed: eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abc123XYZ_-'],
      ['supabase secret',  'key sb_secret_AbCdEf0123456789xyz rejected'],
      ['supabase publish', 'using sb_publishable_ZzYyXx99887766554433'],
      ['github token',     'remote: ghp_AbCdEf0123456789AbCdEf0123456789'],
      ['bearer header',    'Authorization: Bearer abcdef0123456789ABCDEF'],
      ['basic header',     'Authorization: Basic dXNlcjpwYXNzd29yZDEyMw=='],
      ['bare token value', 'x-admin-secret: abcdef0123456789abcdef'],
      ['url credentials',  'connect https://admin:hunter2@db.example.com/x failed'],
      ['query parameter',  'GET /api/x?token=s3cr3tvalue123&page=2 failed'],
      ['json field',       '{"password":"hunter2","user":"bob"}'],
      ['env assignment',   'ADMIN_SECRET=abcdef0123456789 was rejected'],
    ];
    for (const [label, input] of cases) {
      const out = redact(input);
      for (const leak of ['eyJhbGciOiJIUzI1NiJ9', 'AbCdEf0123456789xyz', 'ZzYyXx99887766554433',
        'ghp_AbCdEf0123456789', 'abcdef0123456789ABCDEF', 'hunter2', 's3cr3tvalue123',
        'dXNlcjpwYXNzd29yZDEyMw', 'abcdef0123456789abcdef']) {
        assert.ok(!out.includes(leak), `${label} leaked ${leak}: ${out}`);
      }
    }
  });

  test('redaction happens on the way IN, not on the way out', () => {
    // Scrubbing at render time would leave the live secret sitting in server
    // memory for any second bug or heap dump to find.
    const log = createErrorLog();
    log.record(new Error('auth failed for sb_secret_LiveKey0123456789abc'));
    const stored = log.list()[0];
    assert.ok(!stored.message.includes('LiveKey0123456789abc'));
    assert.match(stored.message, /\[supabase-key\]/);
  });

  test('the context fields are scrubbed too', () => {
    const log = createErrorLog();
    log.record(new Error('boom'), { where: 'GET /api/x?apikey=secretvalue999' });
    assert.ok(!log.list()[0].where.includes('secretvalue999'));
  });

  test('ordinary messages survive readable', () => {
    // Over-redaction that mangles every message makes the log useless, which is
    // its own kind of failure.
    for (const msg of [
      'Could not load flagged scores.',
      'ECONNREFUSED 127.0.0.1:5432',
      'relation "scores" does not exist',
      'fetch failed for https://html5.gamedistribution.com/abc/',
    ]) assert.equal(redact(msg), msg, msg);
  });
});

describe('the buffer is bounded and groups repeats', () => {
  test('the same error 5000 times is one entry', () => {
    // Otherwise one failing request evicts every other error in the buffer,
    // exactly when the other errors are what you need.
    const log = createErrorLog();
    for (let i = 0; i < 5000; i++) log.record(new Error('row 42 not found'));
    assert.equal(log.stats().distinct, 1);
    assert.equal(log.stats().total, 5000);
    assert.equal(log.list()[0].count, 5000);
  });

  test('errors differing only by id or timestamp group together', () => {
    const log = createErrorLog();
    log.record(new Error('row 42 not found'));
    log.record(new Error('row 9137 not found'));
    log.record(new Error('failed at 2026-08-02T10:00:00Z'));
    log.record(new Error('failed at 2026-08-02T11:30:00Z'));
    assert.equal(log.stats().distinct, 2);
    assert.equal(signature('row 42 not found'), signature('row 7 not found'));
  });

  test('genuinely different errors stay separate', () => {
    const log = createErrorLog();
    log.record(new Error('database is down'));
    log.record(new Error('thumbnail fetch failed'));
    assert.equal(log.stats().distinct, 2);
  });

  test('the buffer cannot grow without bound', () => {
    const log = createErrorLog({ max: 10 });
    for (let i = 0; i < 100; i++) log.record(new Error(`distinct failure kind ${String.fromCharCode(97 + i % 26)}${i}x`));
    assert.ok(log.stats().distinct <= 10);
    assert.ok(log.stats().dropped > 0);
    assert.ok(log.list({ limit: 999 }).length <= 10, 'limit cannot exceed capacity');
  });

  test('eviction removes the least recently seen, not the first inserted', () => {
    const log = createErrorLog({ max: 2 });
    log.record(new Error('alpha error'));
    log.record(new Error('beta error'));
    log.record(new Error('alpha error'));      // refreshes alpha
    log.record(new Error('gamma error'));      // should evict beta
    const kinds = log.list().map((e) => e.message);
    assert.ok(kinds.some((m) => m.includes('alpha')), 'alpha was seen most recently and must survive');
    assert.ok(!kinds.some((m) => m.includes('beta')));
  });

  test('junk input cannot crash the recorder', () => {
    const log = createErrorLog();
    for (const junk of [null, undefined, 0, '', {}, [], new Error()]) {
      assert.doesNotThrow(() => log.record(junk));
    }
    assert.ok(log.stats().distinct >= 1);
  });

  test('clear empties it', () => {
    const log = createErrorLog();
    log.record(new Error('x'));
    log.clear();
    assert.equal(log.stats().distinct, 0);
    assert.deepEqual(log.list(), []);
  });

  test('the default capacity is sane', () => {
    assert.ok(MAX_ERRORS >= 50 && MAX_ERRORS <= 1000);
  });
});

describe('catalog analytics', () => {
  const games = [
    { slug: 'a', title: 'A', category: 'Arcade',  provider: 'y8',  plays: 100 },
    { slug: 'b', title: 'B', category: 'arcade',  provider: 'y8',  plays: 50 },
    { slug: 'c', title: 'C', category: 'puzzle',  provider: 'gd',  plays: 0 },
    { slug: 'd', title: 'D', category: '',        provider: null },
  ];

  test('totals, ranking and coverage', () => {
    const s = summarizeCatalog(games);
    assert.equal(s.games, 4);
    assert.equal(s.totalPlays, 150);
    assert.equal(s.playedGames, 2);
    assert.equal(s.coverage, 50);
    assert.deepEqual(s.topGames.map((g) => g.slug), ['a', 'b']);
  });

  test('categories are case-folded so Arcade and arcade are one', () => {
    const s = summarizeCatalog(games);
    const arcade = s.categories.find((c) => c.name === 'arcade');
    assert.equal(arcade.count, 2);
    assert.ok(s.categories.some((c) => c.name === 'uncategorised'));
  });

  test('play counts can come from the live map instead of the row', () => {
    // The server keeps plays in memory; requiring them on the row would mean a
    // table scan every time the panel is opened.
    const s = summarizeCatalog([{ slug: 'x', title: 'X' }], new Map([['x', 7]]));
    assert.equal(s.totalPlays, 7);
    assert.equal(s.topGames[0].plays, 7);
  });

  test('ranking is stable for equal play counts', () => {
    const tied = [{ slug: 'z', plays: 5 }, { slug: 'a', plays: 5 }];
    assert.deepEqual(summarizeCatalog(tied).topGames.map((g) => g.slug), ['a', 'z']);
  });

  test('an empty or malformed catalog does not throw', () => {
    assert.doesNotThrow(() => summarizeCatalog());
    assert.equal(summarizeCatalog([]).coverage, 0);
    assert.equal(summarizeCatalog([null, 3, {}]).games, 1);
  });
});
