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
  const pages = ['/', '/ai', '/browser', '/community',
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

describe('legal pages name the site without requiring SITE_URL', () => {
  // SITE_URL is `sync: false` in render.yaml, so deploying without it is easy
  // and then these pages read "…governs your use of this website". The origin
  // is derived from the request instead — which means the Host header, an
  // ATTACKER-CONTROLLED input, reaches a rendered page. These tests pin the
  // safety properties that make that acceptable.
  //
  // Only cookies/privacy/terms carry the {{SITE_URL}} token; dmca and credits
  // do not, so /privacy is the page under test.
  const SITE_URL_SET = !!(process.env.SITE_URL || '').trim();

  // These use X-Forwarded-Host, NOT Host. Node's fetch() treats Host as a
  // forbidden header and silently drops it, so a test that sets Host exercises
  // nothing and passes no matter what the server does — the first draft of this
  // block did exactly that. X-Forwarded-Host is settable, and it is also the
  // header that actually carries the visitor's domain in production, where the
  // app sits behind Render's proxy.
  const fwd = (host, proto = 'https') =>
    get('/privacy', { headers: { 'X-Forwarded-Host': host, 'X-Forwarded-Proto': proto } });

  test('a legitimate forwarded origin is used (and the header takes effect)', async () => {
    if (SITE_URL_SET) return;   // fast path: one static render, nothing to derive
    const body = await (await fwd('zofhub.example')).text();
    // Doubles as the non-vacuity guard for every case below: if the header were
    // being ignored, this assertion fails and the suite tells you so.
    assert.ok(body.includes('https://zofhub.example'), 'forwarded origin should name the site');
    assert.ok(!body.includes('this website'), 'should no longer use the neutral fallback');
  });

  test('a hostile forwarded host cannot inject markup', async () => {
    const r = await fwd('evil.example"><script>alert(1)</script>');
    const body = await r.text();
    assert.equal(r.status, 200);
    assert.ok(!body.includes('<script>alert(1)</script>'),
      'the host header was interpolated without escaping');
    assert.ok(!/evil\.example"\s*>/.test(body), 'attribute context was broken out of');
  });

  test('a malformed forwarded host falls back instead of rendering junk', async () => {
    if (SITE_URL_SET) return;
    for (const host of ['a b c', '../../etc/passwd', 'x:99999999', 'has_underscore.example']) {
      const body = await (await fwd(host)).text();
      assert.ok(body.includes('this website'),
        `"${host}" should have fallen back to the neutral wording`);
    }
  });

  test('a non-http scheme is rejected', async () => {
    if (SITE_URL_SET) return;
    const body = await (await fwd('zofhub.example', 'javascript')).text();
    assert.ok(body.includes('this website'), 'only http/https may be rendered');
  });

  test('responses Vary on the headers they were templated from', async () => {
    // Without this a shared cache could serve one host's rendered page to a
    // visitor who arrived on a different domain.
    const r = await get('/privacy');
    const vary = (r.headers.get('vary') || '').toLowerCase();
    for (const h of ['host', 'x-forwarded-host', 'x-forwarded-proto']) {
      assert.ok(vary.includes(h), `Vary must list ${h}, got "${vary}"`);
    }
  });

  test('no unsubstituted template token survives on any legal page', async () => {
    for (const p of ['/privacy', '/terms', '/cookies', '/dmca', '/credits']) {
      const body = await (await get(p)).text();
      assert.ok(!/\{\{[A-Z_]+\}\}/.test(body), `${p} rendered a raw {{TOKEN}}`);
    }
  });
});

describe('presence counts survive prototype-colliding slugs', () => {
  // REGRESSION. presenceSnapshot() accumulated into a plain `{}` keyed by a
  // client-supplied slug. On a plain object `games['constructor']` reads back
  // the Object CONSTRUCTOR instead of undefined, so `(fn || 0) + 1`
  // concatenated rather than added and the broadcast payload contained:
  //   {"games":{"constructor":"function Object() { [native code] }1"}}
  // That went to every SSE subscriber. It was not merely an adversarial input:
  // the catalog holds a real game slugged `constructor` (id 6974, "Constructor"),
  // so ordinary play triggered it and that game's live badge never lit up.
  const beat = (sessionId, slug) =>
    get('/api/presence/beat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, slug }),
    });

  test('every count is a number, whatever the slug is called', async () => {
    const hazards = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];
    let last;
    for (const [i, slug] of hazards.entries()) {
      const r = await beat(`proto-test-${i}-${Date.now()}`, slug);
      if (r.status === 429) return;   // rate limiter won the race; not what we're testing
      last = await r.json();
    }
    assert.ok(last && last.games, 'snapshot should carry a games map');
    for (const [slug, count] of Object.entries(last.games)) {
      assert.equal(typeof count, 'number',
        `games["${slug}"] is ${typeof count} (${JSON.stringify(count)}) — prototype leaked in`);
      assert.ok(Number.isFinite(count) && count >= 0, `games["${slug}"] = ${count}`);
    }
  });

  test('a colliding slug is counted, not swallowed', async () => {
    const id = `proto-count-${Date.now()}`;
    const r = await beat(id, 'constructor');
    if (r.status === 429) return;
    const snap = await r.json();
    assert.equal(typeof snap.games.constructor, 'number',
      'the real catalog game slugged "constructor" must get a numeric count');
    assert.ok(snap.games.constructor >= 1, 'its beat should have been recorded');
  });

  test('the snapshot serialises to valid JSON', async () => {
    // Object.create(null) is the fix; this proves it did not break the wire
    // format (JSON.stringify treats a null-prototype object like any other).
    const r = await get('/api/presence');
    assert.equal(r.status, 200);
    const txt = await r.text();
    const j = JSON.parse(txt);
    assert.equal(typeof j.total, 'number');
    assert.equal(typeof j.games, 'object');
    assert.ok(!txt.includes('native code'), 'a function leaked into the payload');
  });
});

describe('AI runs on the visitor device, never on this server', () => {
  // ZoFHub's AI is browser-direct: public/js/pollinations.js calls Pollinations
  // from the visitor's own machine on their own IP. The server-side AI routes
  // survive only as a local-development aid, because Pollinations' Turnstile
  // check rejects browser fetches from http/localhost origins.
  //
  // These tests pin the SERVER half of that guarantee. The client half is a
  // convention a future edit could drop; this one is enforced by the deployment.
  // The suite runs from 127.0.0.1, which the guard allows, so a public client is
  // simulated with X-Forwarded-For (`trust proxy` is on, so that becomes req.ip).
  const asInternetVisitor = (path, init = {}) =>
    get(path, { ...init, headers: { 'X-Forwarded-For': '203.0.113.9', ...(init.headers || {}) } });

  test('an internet visitor cannot make this server generate text', async () => {
    const r = await asInternetVisitor('/api/ai/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'generate something on the server' }),
    });
    assert.equal(r.status, 403, 'server-side text generation must be refused');
    const j = await r.json();
    assert.equal(j.error, 'client_side_only');
  });

  test('an internet visitor cannot make this server generate or proxy an image', async () => {
    // This route pipes the image BYTES through our host — the exact bandwidth
    // that is supposed to stay on the visitor's device.
    const r = await asInternetVisitor('/api/ai/image?prompt=a%20cat');
    assert.equal(r.status, 403, 'server-side image proxying must be refused');
  });

  test('the unreferenced /api/ai/echo route is closed too', async () => {
    const r = await asInternetVisitor('/api/ai/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    assert.equal(r.status, 403);
  });

  test('the metadata routes the browser genuinely needs still work', async () => {
    // /api/ai/key hands over the PUBLISHABLE pk_ key so the browser can call
    // Pollinations itself — serving it is the mechanism that keeps AI off this
    // server, not a leak. It must never carry a secret sk_ key.
    for (const p of ['/api/ai/key', '/api/ai/health', '/api/ai/providers']) {
      const r = await asInternetVisitor(p);
      assert.equal(r.status, 200, `${p} must stay reachable`);
    }
    const { key } = await (await asInternetVisitor('/api/ai/key')).json();
    assert.ok(key === '' || key.startsWith('pk_'), 'only a publishable pk_ key may be served');
    assert.ok(!String(key).startsWith('sk_'), 'a secret key must never be served to the browser');
  });
});

describe('the server is never an AI proxy', () => {
  // Audit findings, each pinned by a test. The suite runs from 127.0.0.1, which
  // aiServerAllowed() treats as local development, so an internet visitor is
  // simulated with X-Forwarded-For (`trust proxy` is on → that becomes req.ip).
  const visitor = (path, init = {}) =>
    get(path, { ...init, headers: { 'X-Forwarded-For': '203.0.113.9', ...(init.headers || {}) } });

  test('/api/vibe does not perform server-side inference', async () => {
    // FOUND IN AUDIT: /api/vibe is not under /api/ai, so it escaped the guard.
    // A mood that missed the curated map sent the visitor's TYPED TEXT to
    // Pollinations from this server. Measured at 3.02s for "relaxing puzzle" —
    // an ordinary query, not an edge case.
    //
    // Latency is the discriminator: the outbound call had a 2.5s abort budget,
    // so a sub-second response proves no upstream request was made.
    for (const q of ['relaxing puzzle', 'qwertyuiop zxcvbnm plughfjord']) {
      const t0 = Date.now();
      const r = await visitor('/api/vibe?q=' + encodeURIComponent(q));
      const ms = Date.now() - t0;
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.ok(ms < 1500, `"${q}" took ${ms}ms — the server appears to have called an AI provider`);
      assert.notEqual(j.source, 'ai', 'source:"ai" means the server ran inference');
      // The feature must still work: the curated map is the source of truth.
      assert.ok(j.games.length > 0, 'Vibe Finder must still return games without the AI');
    }
  });

  test('/asset refuses to fetch AI providers', async () => {
    // FOUND IN AUDIT: /asset is a deliberately general cross-origin GET proxy
    // (it fixes WebGL canvas tainting for games) and "general" included
    // inference endpoints — it fetched text.pollinations.ai and relayed the
    // upstream API response body verbatim.
    for (const u of [
      'https://text.pollinations.ai/hello',
      'https://image.pollinations.ai/prompt/cat',
      'https://aihorde.net/api/v2/status/modes',
      'https://api.openai.com/v1/models',
      'https://generativelanguage.googleapis.com/v1/models',
      'https://api-inference.huggingface.co/models/gpt2',
    ]) {
      const r = await visitor('/asset?u=' + encodeURIComponent(u));
      assert.equal(r.status, 403, `${u} must not be proxied`);
    }
  });

  test('/api/proxy/diag will not fetch an AI provider', async () => {
    // Its own comment says "Direct HEAD", but the probe is fetchAsBrowser(),
    // which issues a full GET with redirects followed — so aimed at an inference
    // endpoint it made this server generate and download AI output.
    for (const u of ['https://text.pollinations.ai/hi', 'https://api.openai.com/v1/models']) {
      const r = await visitor('/api/proxy/diag?u=' + encodeURIComponent(u));
      const j = await r.json();
      assert.equal(j.ok, false, `${u} must not be fetched`);
      assert.match(j.error || '', /AI providers/i);
    }
  });

  test('routes that take a prompt in the QUERY STRING are closed', async () => {
    // Neither performs inference — /api/ai/audio only string-builds a URL the
    // browser plays. They are closed because the prompt travels in the URL, and
    // hosting platforms log request paths: Render's access log would accumulate
    // the text visitors asked to have spoken, in a log this code never writes
    // and cannot clear. Nothing references either route.
    for (const p of ['/api/ai/audio?prompt=private+text', '/api/ai/video?prompt=private+text']) {
      const r = await visitor(p);
      assert.equal(r.status, 403, `${p} must be closed`);
    }
  });

  test('/thumb never proxies an arbitrary host either', async () => {
    // /thumb was already correct — a non-allowlisted host gets a 302 so the
    // BROWSER fetches it, and the server never touches the bytes. Pinning it so
    // that property cannot regress into a general image proxy.
    const r = await visitor('/thumb?u=' + encodeURIComponent('https://image.pollinations.ai/prompt/cat'), { redirect: 'manual' });
    assert.ok(r.status === 302 || r.status === 403, `expected redirect or refusal, got ${r.status}`);
  });

  test('AI pipeline metadata is not published to anonymous callers', async () => {
    // Neither endpoint is called by any client code, yet both described the
    // server-side pipeline: model priority, the upstream endpoint, whether a key
    // is held, and the full provider inventory with URLs and limits. That
    // advertises capability this deployment deliberately does not offer.
    const h = await (await visitor('/api/ai/health')).json();
    assert.equal(h.serverInference, false);
    assert.equal(h.endpoint, undefined, 'must not reveal the upstream endpoint');
    assert.equal(h.models, undefined, 'must not reveal the model inventory');
    assert.equal(h.keyed, undefined, 'must not reveal whether a key is held');

    const p = await (await visitor('/api/ai/providers')).json();
    assert.equal(p.serverInference, false);
    assert.deepEqual(p.text, [], 'must not list text providers');
    assert.deepEqual(p.image, [], 'must not list image providers');
  });

  test('privacy-sensitive browser features are explicitly denied', async () => {
    // Permissions-Policy is an allowlist: anything unlisted falls back to the UA
    // default. These were unlisted, so thousands of embedded third-party game
    // and ad frames inherited the ability to ask for them.
    const pp = ((await get('/')).headers.get('permissions-policy') || '').replace(/\s+/g, '');
    for (const f of ['geolocation', 'camera', 'microphone', 'browsing-topics',
                     'interest-cohort', 'idle-detection', 'local-fonts',
                     'run-ad-auction', 'join-ad-interest-group']) {
      assert.ok(pp.includes(`${f}=()`), `${f} must be explicitly denied`);
    }
  });
});

describe('admin console access control', () => {
  // These assert the invariants that must hold in EVERY configuration, so they
  // are meaningful whether or not this checkout has admin credentials set.
  const anon = (p, init = {}) =>
    get(p, { ...init, headers: { 'X-Forwarded-For': '203.0.113.9', ...(init.headers || {}) } });

  const ADMIN_SECRET = (process.env.ADMIN_SECRET || '').trim();

  test('no admin API answers an anonymous caller', async () => {
    for (const p of ['/api/admin/me', '/api/admin/dashboard', '/api/admin/security',
                     '/api/admin/games', '/api/admin/recommendations']) {
      const r = await anon(p);
      assert.ok(r.status === 401 || r.status === 503,
        `${p} answered ${r.status} to an anonymous caller`);
    }
  });

  test('the dashboard document is never served to an anonymous caller', async () => {
    // REGRESSION, and the sharp one. The console first lived in public/admin/,
    // where express.static served public/admin/admin-dashboard.html with a 200
    // to anybody — the auth route below it never ran. It now lives in admin-ui/,
    // outside the static root, so there is no middleware order to get wrong.
    for (const p of ['/admin/admin-dashboard.html', '/admin/assets/admin.js', '/admin/',
                     '/admin/assets/../admin-dashboard.html', '/admin/assets/constructor',
                     '/admin-ui/admin-dashboard.html', '/admin/index.html']) {
      const r = await anon(p, { redirect: 'manual' });
      const body = r.status === 200 ? await r.text() : '';
      assert.ok(!/id="statGrid"|id="auditOut"/.test(body),
        `${p} leaked the dashboard document (HTTP ${r.status})`);
    }
  });

  test('a credential in the query string is not accepted', async () => {
    // ?key= put an admin credential into the hosting access log, the browser's
    // history, and the Referer of every outbound link on the page.
    if (!ADMIN_SECRET) return;
    const r = await anon('/api/admin/dashboard?key=' + encodeURIComponent(ADMIN_SECRET));
    assert.ok(r.status === 401 || r.status === 503,
      'a secret supplied as a query parameter must not authenticate');
  });

  test('the bearer token still authenticates machines', async () => {
    if (!ADMIN_SECRET) return;
    const r = await anon('/api/admin/dashboard', { headers: { Authorization: `Bearer ${ADMIN_SECRET}` } });
    assert.equal(r.status, 200, 'monitors and CLI tooling must keep working');
    const j = await r.json();
    assert.equal(j.ok, true);
    // Operational state only — never a configured secret.
    const blob = JSON.stringify(j);
    for (const s of [process.env.ADMIN_SECRET, process.env.SUPABASE_SECRET_KEY,
                     process.env.SCORE_SECRET, process.env.ADMIN_SESSION_SECRET,
                     process.env.ADMIN_PASSWORD_HASH].filter(v => v && v.length > 12)) {
      assert.ok(!blob.includes(s), 'the dashboard payload leaked a configured secret');
    }
  });

  test('login rejects with one generic message and never reveals which half was wrong', async () => {
    const attempt = (username, password) => anon('/api/admin/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const bad = await attempt('definitely-not-a-user', 'definitely-not-a-password');
    // 503 when this checkout has no admin credentials configured; 401/429 when it does.
    assert.ok([401, 429, 503].includes(bad.status), `unexpected ${bad.status}`);
    if (bad.status === 401) {
      const j = await bad.json();
      assert.ok(!/user|username|account|exist/i.test(j.error || ''),
        'the error must not indicate whether the username exists');
      assert.ok(!/password/i.test(j.error || ''),
        'the error must not indicate that the password specifically was wrong');
    }
  });

  test('login is not reachable without a request body', async () => {
    const r = await anon('/api/admin/auth/login', { method: 'POST' });
    assert.ok(r.status !== 200, 'an empty login must never succeed');
  });

  test('state-changing admin routes require CSRF when session-authenticated', async () => {
    // With no session cookie the request is rejected at authentication, which is
    // the outer of the two gates. The inner CSRF gate is exercised by the unit
    // tests over csrfOk() in test/admin-auth.test.mjs.
    const r = await anon('/api/admin/games/slope/visibility', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visible: false }),
    });
    assert.ok(r.status === 401 || r.status === 503, `expected refusal, got ${r.status}`);
  });

  test('admin responses are never cached or indexed', async () => {
    const r = await anon('/api/admin/me');
    const cc = (r.headers.get('cache-control') || '').toLowerCase();
    assert.ok(cc.includes('no-store'), `admin responses must not be cached (got "${cc}")`);
    assert.match((r.headers.get('x-robots-tag') || '').toLowerCase(), /noindex/);
  });
});
