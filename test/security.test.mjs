// Security regression tests — CORS policy and rate-limit configurability.
//
// Boots its own server so it can assert on the cross-origin gate without
// interfering with test/server.test.mjs.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

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

  test('array/object query parameters do not crash the catalog routes', async () => {
    // ?q[]=a makes req.query.q an array; ?q[x]=1 makes it an object. Calling
    // string methods on either used to throw a 500 from any URL.
    for (const qs of ['q[]=a&q[]=b', 'q[x]=1', 'category[]=puzzle', 'category[x]=1']) {
      const r = await fetch(`${BASE}/api/games?${qs}`, { signal: AbortSignal.timeout(15000) });
      assert.ok(r.status < 500, `${qs} produced ${r.status}`);
    }
  });

  test('an oversized JSON body is refused, not parsed', async () => {
    const big = JSON.stringify({ message: 'x'.repeat(200_000) });
    const r = await fetch(BASE + '/api/feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: big, signal: AbortSignal.timeout(15000),
    });
    assert.equal(r.status, 413, 'a 200kb body should exceed the 100kb JSON limit');
  });
});

describe('SSRF — caller-supplied URLs cannot reach this host or its network', () => {
  // /asset and /thumb fetch a URL from ?u=. The address is validated at connect
  // time (lib/safe-fetch.mjs), so neither a private literal nor an obfuscated
  // one nor an AI endpoint can be reached, and /thumb is not an open redirect.
  const internal = [
    'https://127.0.0.1/', 'https://localhost/', 'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.1/', 'https://192.168.0.1/', 'https://[::1]/',
    'https://0x7f000001/', 'https://2130706433/',           // hex / decimal 127.0.0.1
  ];

  test('/asset refuses internal and obfuscated hosts', async () => {
    for (const u of internal) {
      const r = await fetch(`${BASE}/asset?u=${encodeURIComponent(u)}`, { signal: AbortSignal.timeout(15000) });
      assert.ok(r.status === 400 || r.status === 403, `${u} was not refused (${r.status})`);
    }
  });

  test('/asset refuses AI provider hosts', async () => {
    for (const u of ['https://text.pollinations.ai/x', 'https://api.openai.com/v1/x']) {
      const r = await fetch(`${BASE}/asset?u=${encodeURIComponent(u)}`, { signal: AbortSignal.timeout(15000) });
      assert.equal(r.status, 403, `${u} was not refused`);
    }
  });

  test('/thumb refuses a non-allowlisted host instead of redirecting to it', async () => {
    const r = await fetch(`${BASE}/thumb?u=${encodeURIComponent('https://evil.example/x.png')}`, {
      redirect: 'manual', signal: AbortSignal.timeout(15000),
    });
    assert.equal(r.status, 400, 'a non-allowlisted host must be refused, not 302-redirected (open redirect)');
  });

  test('error bodies from the proxies carry no internal detail', async () => {
    const r = await fetch(`${BASE}/asset?u=${encodeURIComponent('https://127.0.0.1/')}`, { signal: AbortSignal.timeout(15000) });
    const body = await r.text();
    assert.ok(!/127\.0\.0\.1|ECONN|node:internal|at .*\.mjs:\d+/.test(body), `leaked detail: ${body.slice(0, 80)}`);
  });
});

describe('health probes answer what an orchestrator can act on', () => {
  test('/livez, /readyz and /healthz are all reachable and JSON', async () => {
    for (const p of ['/livez', '/readyz', '/healthz']) {
      const r = await fetch(BASE + p, { signal: AbortSignal.timeout(15000) });
      assert.ok(r.status === 200 || r.status === 503, `${p} → ${r.status}`);
      const j = await r.json();
      assert.equal(typeof j.ok, 'boolean');
    }
  });

  test('an anonymous /healthz leaks no memory, uptime or job detail', async () => {
    const j = await (await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(15000) })).json();
    assert.equal(j.memory, undefined, 'memory figures must not reach an anonymous caller');
    assert.equal(j.uptime, undefined);
    assert.equal(j.cron, undefined);
    assert.equal(j.eventLoop, undefined);
  });
});

// ── Every admin route must enforce, not merely resolve ─────────────────────
//
// adminGate() is mounted on /admin and /api/admin, which makes it LOOK like the
// prefix is protected. It is not: the middleware only sets `req.admin` and calls
// next(), and each route is expected to call requireAdmin() itself. Forgetting
// that does not fail loudly — the route just answers 200 to the whole internet.
//
// That is not hypothetical. GET /api/admin/ads shipped without the call and
// served the full advertising configuration unauthenticated; it was found only
// by comparing its status code against /api/admin/dashboard. A structural check
// is the only thing that catches the next one.
describe('admin routes fail closed', () => {
  const src = readFileSync(join(root, 'server.js'), 'utf8');

  // Route registration -> the source between it and the next top-level route.
  const routes = [];
  const RE = /^app\.(get|post|put|patch|delete)\(\s*'(\/api\/admin\/[^']*)'/gm;
  let m;
  while ((m = RE.exec(src))) {
    const start = m.index;
    const next = src.indexOf('\napp.', start + 1);
    routes.push({
      method: m[1].toUpperCase(),
      path: m[2],
      body: src.slice(start, next === -1 ? src.length : next),
    });
  }

  test('there are admin routes to check', () => {
    assert.ok(routes.length >= 10, `only found ${routes.length} admin routes — the scan broke`);
  });

  // requirePerm(req, res, '<permission>') is the OTHER acceptable gate: it
  // authorises a permission, and it authenticates first by calling requireAdmin
  // itself. Accepting it here would be taking that on trust, so the test below
  // proves the indirection before this one relies on it — an authorisation
  // wrapper that forgot to authenticate would otherwise turn this whole check
  // into a rubber stamp.
  test('requirePerm authenticates before it authorises', () => {
    const at = src.indexOf('function requirePerm(');
    assert.notEqual(at, -1, 'requirePerm() not found — the exemption below is unearned');
    const body = src.slice(at, src.indexOf('\nfunction ', at + 10));
    const authAt = body.indexOf('requireAdmin(req, res)');
    const permAt = body.indexOf('rbac.can(');
    assert.ok(authAt !== -1, 'requirePerm never calls requireAdmin');
    assert.ok(permAt !== -1, 'requirePerm never consults the permission model');
    assert.ok(authAt < permAt,
      'requirePerm checks the permission before authenticating — an anonymous '
      + 'caller must get 401, and req.admin is not trustworthy until requireAdmin ran');
  });

  test('every /api/admin route calls requireAdmin', () => {
    const unguarded = routes
      .filter(r => !/requireAdmin\s*\(/.test(r.body))
      // …or requirePerm(), which calls requireAdmin() itself — proved above.
      .filter(r => !/requirePerm\s*\(\s*req\s*,\s*res\s*,/.test(r.body))
      // The auth endpoints are exempt BY DESIGN, not by oversight: /auth/login
      // is how a caller becomes an admin in the first place, and /auth/logout
      // destroys a session, which must work even for a session already expired
      // or otherwise unresolvable. Everything else must fail closed.
      .filter(r => !/\/auth\/(login|logout)$/.test(r.path))
      .map(r => `${r.method} ${r.path}`);
    assert.deepEqual(unguarded, [],
      'these admin routes never call requireAdmin() and answer unauthenticated:\n  '
      + unguarded.join('\n  '));
  });

  test('every state-changing admin route also checks CSRF', () => {
    // A browser carries an admin session cookie automatically, so a POST that
    // only checks requireAdmin is forgeable from any page the admin visits.
    const unguarded = routes
      .filter(r => r.method !== 'GET')
      .filter(r => !/requireAdminCsrf\s*\(/.test(r.body))
      // Login/logout establish or destroy the session and are exempt by design.
      .filter(r => !/\/auth\/(login|logout)/.test(r.path))
      .map(r => `${r.method} ${r.path}`);
    assert.deepEqual(unguarded, [],
      'these state-changing admin routes have no CSRF check:\n  ' + unguarded.join('\n  '));
  });
});
