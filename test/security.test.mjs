// Security regression tests — CORS policy and rate-limit configurability.
//
// Boots its own server so it can assert on the cross-origin gate without
// interfering with test/server.test.mjs.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.TEST_PORT_SEC) || 3398;
const BASE = `http://127.0.0.1:${PORT}`;
let child;

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', NO_OPEN: '1', CRON_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(2000) })).ok) return; }
    catch { /* not up */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server did not start');
});
after(() => { if (child && !child.killed) child.kill('SIGKILL'); });

describe('CORS policy — open reads, same-origin writes', () => {
  test('cross-origin GET is allowed (the catalog is public data)', async () => {
    const r = await fetch(BASE + '/api/games?limit=2', {
      headers: { Origin: 'https://evil.example' },
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(r.status, 200);
  });

  test('cross-origin WRITE is blocked with 403 JSON', async () => {
    // REGRESSION: `app.use(cors())` sent Access-Control-Allow-Origin:* on every
    // route, so any site could drive our write endpoints using its visitors'
    // IPs and burn our rate limits.
    const r = await fetch(BASE + '/api/for-you', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ history: [], limit: 4 }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(r.status, 403);
    assert.match(r.headers.get('content-type') || '', /json/);
    const j = await r.json();
    assert.equal(j.error, 'cross_origin_write_blocked');
  });

  test('same-origin WRITE still works', async () => {
    const r = await fetch(BASE + '/api/for-you', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: BASE },
      body: JSON.stringify({ history: [], limit: 4 }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(r.status, 200, 'our own frontend must not be blocked');
  });

  test('a request with no Origin header still works (curl, server-to-server)', async () => {
    const r = await fetch(BASE + '/api/for-you', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history: [], limit: 4 }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(r.status, 200);
  });
});

describe('input validation', () => {
  test('malformed JSON is rejected without a stack trace', async () => {
    const r = await fetch(BASE + '/api/for-you', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: 'not json at all', signal: AbortSignal.timeout(15000),
    });
    assert.equal(r.status, 400);
    const body = await r.text();
    assert.ok(!/ at .*\.(mjs|js):\d+|node:internal/.test(body), 'leaked a stack trace');
  });

  test('oversized query parameters do not crash the server', async () => {
    const huge = 'x'.repeat(5000);
    const r = await fetch(`${BASE}/api/games?q=${huge}`, { signal: AbortSignal.timeout(20000) });
    assert.ok(r.status < 500, `expected a handled response, got ${r.status}`);
  });

  test('weather rejects a timezone that is not a timezone', async () => {
    const r = await fetch(BASE + '/api/weather?tz=' + encodeURIComponent('http://169.254.169.254/'),
      { signal: AbortSignal.timeout(15000) });
    assert.equal(r.status, 400);
  });
});
