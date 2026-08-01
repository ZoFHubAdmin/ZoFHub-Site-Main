// Integration tests — boots the real server and exercises it over HTTP.
//
// These are the tests that would have caught the bugs found by hand during the
// audit: pages that 404 while claiming thousands of results, error bodies that
// leaked upstream hostnames, and pagination that silently died after page 5.
//
// Supabase is optional here. Without credentials the server falls back to its
// bundled catalog, so this suite runs on a fresh clone and in CI with no
// secrets — which is the point: a test that needs production keys is a test
// nobody runs.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Load the same env file the SERVER loads. Without this the test process has no
// secrets, so the "no response body contains a real secret VALUE" test below
// compared every response against an EMPTY list and passed vacuously — the
// strongest assertion in this file could never fail. The spawned server read
// .env through its own loader and did hold the real keys, so only the watcher
// was blind.
//
// This keeps the no-secrets property intact: with no .env (fresh clone, CI) the
// loader sets nothing, the list is empty, and the suite still runs — it just
// falls back to the pattern assertions, exactly as it does today.
import '../lib/load-env.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.TEST_PORT) || 3399;
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 90_000;

let child;

async function get(path, opts = {}) {
  return fetch(BASE + path, { signal: AbortSignal.timeout(20_000), ...opts });
}

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});   // drain so the pipe never fills and stalls
  child.stderr.on('data', () => {});

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server did not become healthy within ' + BOOT_TIMEOUT_MS + 'ms');
});

after(() => { if (child && !child.killed) child.kill('SIGKILL'); });

describe('pages and routes', () => {
  const pages = ['/', '/ai', '/browser', '/community', '/leaderboard',
                 '/credits', '/licenses', '/privacy', '/terms', '/dmca', '/cookies'];
  for (const p of pages) {
    test(`GET ${p} -> 200`, async () => {
      const r = await get(p);
      assert.equal(r.status, 200, `${p} returned ${r.status}`);
      assert.match(r.headers.get('content-type') || '', /html/);
    });
  }

  test('legal .html twins redirect to the canonical path', async () => {
    for (const p of ['/credits.html', '/privacy.html', '/terms.html',
                     '/dmca.html', '/cookies.html', '/licenses.html']) {
      const r = await get(p, { redirect: 'manual' });
      assert.equal(r.status, 301, `${p} should 301`);
    }
  });

  test('unknown page returns 404, not 200', async () => {
    const r = await get('/this-page-does-not-exist-' + Date.now());
    assert.equal(r.status, 404);
  });
});

describe('security headers and error hygiene', () => {
  test('sets the standard protective headers', async () => {
    const r = await get('/');
    const h = (n) => r.headers.get(n);
    assert.ok(h('content-security-policy'), 'CSP missing');
    assert.equal(h('x-content-type-options'), 'nosniff');
    assert.ok(h('referrer-policy'), 'Referrer-Policy missing');
  });

  test('does not advertise the server framework', async () => {
    const r = await get('/');
    assert.equal(r.headers.get('x-powered-by'), null, 'x-powered-by leaks the stack');
  });

  test('no response body contains a real secret VALUE', async () => {
    // Checks the actual configured secrets rather than a pattern. The pattern
    // version of this test flagged /api/health for the string "service_role",
    // which turned out to be a key-type LABEL, not a key — a false positive
    // that would have trained everyone to ignore the test. Comparing against
    // the real values can only fire on a genuine leak.
    const secrets = [
      process.env.SUPABASE_SECRET_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY,
      process.env.SUPABASE_ANON_KEY, process.env.POLLINATIONS_PUBLIC_KEY,
      process.env.ADMIN_SECRET, process.env.SCORE_SECRET, process.env.CRON_SECRET,
      // The PUBLISHABLE key is browser-safe in general, but this app has no
      // client-side Supabase SDK — the browser only ever calls our own /api
      // routes. So it has no reason to appear in a response either, and if it
      // ever does, someone has added a browser client and should be made to
      // think about RLS coverage before shipping it.
      process.env.SUPABASE_PUBLISHABLE_KEY,
    ].filter(s => typeof s === 'string' && s.length > 12);

    // Make the coverage VISIBLE. An empty list is legitimate (CI runs with no
    // secrets) but it must not look like a pass — this test silently checked
    // nothing for its entire existence because the test process never loaded
    // .env. If a .env is present, it must have yielded something to search for.
    const { existsSync } = await import('node:fs');
    if (existsSync(join(root, '.env'))) {
      assert.ok(secrets.length > 0,
        '.env exists but no secrets were loaded — this test would pass vacuously');
    }
    console.error(`      (checking ${secrets.length} configured secret value(s))`);

    for (const p of ['/', '/api/health', '/api/games?limit=2', '/api/ai/health', '/api/categories']) {
      const body = await (await get(p)).text();
      for (const s of secrets) {
        assert.ok(!body.includes(s), `${p} leaked a configured secret`);
      }
      // A JWT anywhere in a public body is a leak regardless of which one.
      assert.ok(!/eyJhbGciOi[A-Za-z0-9._-]{20,}/.test(body), `${p} leaked a JWT`);
    }
  });

  test('unauthenticated health does not disclose configuration detail', async () => {
    // Not a credential, but free reconnaissance: which key class the server
    // holds and the exact runtime version to match against CVEs.
    const j = await (await get('/api/health')).json();
    assert.equal(j.status, 'ok');
    assert.equal(j.supabase.keyType, undefined, 'key type must not be public');
    assert.equal(j.node, undefined, 'Node version must not be public');
    // Whether the server holds a write-capable key is reconnaissance too: it
    // tells an attacker if there is an admin key on this host worth going after.
    assert.equal(j.supabase.writable, undefined, 'write capability must not be public');
  });

  test('a 404 body carries no stack trace', async () => {
    const body = await (await get('/nope-' + Date.now())).text();
    assert.ok(!/ at .*\.mjs:\d+|at Module\._compile|node:internal/.test(body),
      '404 leaked a stack trace');
  });
});

describe('/api/games — pagination', () => {
  test('reports an honest total and exact page sizes', async () => {
    // REGRESSION: this endpoint once advertised 16,820 games while pages 6
    // through ~83 returned zero, because rows were filtered AFTER pagination.
    const p1 = await (await get('/api/games?page=1&limit=24')).json();
    assert.ok(p1.total > 0);
    assert.equal(p1.games.length, 24);
    assert.equal(p1.pages, Math.ceil(p1.total / 24));

    const mid = Math.max(2, Math.floor(p1.pages / 2));
    const pm = await (await get(`/api/games?page=${mid}&limit=24`)).json();
    assert.equal(pm.games.length, 24, `page ${mid} should be full`);

    const pl = await (await get(`/api/games?page=${p1.pages}&limit=24`)).json();
    assert.ok(pl.games.length > 0, 'last page must not be empty');
    assert.equal((p1.pages - 1) * 24 + pl.games.length, p1.total,
      'page sizes must add up to the reported total');
  });

  test('consecutive pages do not overlap', async () => {
    const a = await (await get('/api/games?page=3&limit=40')).json();
    const b = await (await get('/api/games?page=4&limit=40')).json();
    const setA = new Set(a.games.map(g => g.slug));
    assert.equal(b.games.filter(g => setA.has(g.slug)).length, 0);
  });

  test('search collapses repeated titles', async () => {
    const j = await (await get('/api/games?q=game&limit=40')).json();
    const titles = j.games.map(g => String(g.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
    assert.equal(new Set(titles).size, titles.length, 'search returned duplicate titles');
  });
});

describe('/api/for-you — recommendations', () => {
  test('returns attributed, non-duplicated games', async () => {
    const cat = await (await get('/api/games?limit=4')).json();
    const history = cat.games.map(g => g.slug);
    const r = await get('/api/for-you', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history, limit: 12 }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.games.length > 0);
    assert.equal(new Set(j.games.map(g => g.slug)).size, j.games.length);
    for (const g of j.games) {
      assert.ok(!history.includes(g.slug), 'recommended a game already played');
      assert.ok(g.because, 'missing attribution');
    }
  });

  test('is never cached by a shared cache', async () => {
    const r = await get('/api/for-you', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history: [], limit: 4 }),
    });
    assert.match(r.headers.get('cache-control') || '', /no-store/,
      'a personalised response must not be shareable');
  });

  test('caps absurd input instead of trusting it', async () => {
    const r = await get('/api/for-you', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history: Array(5000).fill('x'), limit: 99999 }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.games.length <= 36, 'limit must be capped');
  });
});

describe('/api/weather', () => {
  test('resolves a location from an IANA timezone', async () => {
    const r = await get('/api/weather?tz=' + encodeURIComponent('Europe/London'));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(typeof j.current.temperature, 'number');
    assert.ok(j.current.text && j.current.icon);
    assert.ok(Array.isArray(j.daily) && j.daily.length >= 1);
  });

  test('rejects an unresolvable location with 400, not a guess', async () => {
    // A weather feature inventing a temperature is the one thing it must never do.
    for (const q of ['?tz=not-a-timezone', '', '?city=']) {
      const r = await get('/api/weather' + q);
      assert.equal(r.status, 400, `expected 400 for "${q}"`);
      const j = await r.json();
      assert.equal(j.ok, false);
      assert.ok(!('current' in j), 'must not return fabricated conditions');
    }
  });
});

describe('/api/ai/health', () => {
  test('reports model health without exposing secrets', async () => {
    const r = await get('/api/ai/health');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.models) && j.models.length > 0);
    assert.ok(Array.isArray(j.priority) && j.priority.length > 0);
    assert.equal(typeof j.keyed, 'boolean');
    const blob = JSON.stringify(j);
    assert.ok(!/pk_[A-Za-z0-9]{6}|Bearer |apikey/i.test(blob), 'leaked a credential');
  });
});

describe('rate limiting', () => {
  test('a burst of writes is eventually rejected with a JSON 429', async () => {
    let limited = null;
    for (let i = 0; i < 60 && !limited; i++) {
      const r = await get('/api/for-you', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ history: [], limit: 1 }),
      });
      if (r.status === 429) limited = r;
    }
    assert.ok(limited, 'burst was never rate limited');
    assert.match(limited.headers.get('content-type') || '', /json/,
      '429 must be JSON, not an HTML error page');
    const j = await limited.json();
    assert.ok(j.error, '429 body must name the error');
  });
});
