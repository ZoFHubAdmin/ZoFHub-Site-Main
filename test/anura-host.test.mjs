// test/anura-host.test.mjs — AnuraOS as a first-class proxy-browser engine.
// ---------------------------------------------------------------------------
// AnuraOS is a whole web OS that assumes it owns a site root, so ZoFHub gives it
// a real ORIGIN (a second port, or a hostname) instead of a subpath. These tests
// pin the parts of that which are easy to break and silent when broken:
//
//   * WHICH origin is offered, and that it follows the request — a URL baked to
//     one hostname would send mirror visitors back to a blocked domain;
//   * that the config rewrite (the one AGPL §5 change) actually lands, because
//     without a wisp-url AnuraOS has no tunnel and fails with no error of its own;
//   * that this origin is a file server for ONE app and not an open one.
//
// The bundle is ~51 MB and gitignored, so anything needing real files skips
// when it is absent — and says so, rather than passing vacuously.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  anuraExposure, anuraUrlFor, anuraBundlePresent, anuraHandler, ANURA_DIR,
} from '../lib/anura-host.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HAVE_BUNDLE = anuraBundlePresent();

// A request stub shaped like the fields the module actually reads.
const req = (host, extra = {}) => ({ headers: { host, ...extra }, protocol: 'http' });

describe('which origin is offered, and why', () => {
  test('an external deployment wins, and we serve nothing', () => {
    const e = anuraExposure({ PROXY_ANURA_URL: 'https://anura.example/' }, { present: true });
    assert.equal(e.mode, 'external');
    assert.equal(e.serves, false, 'we must not also serve a copy');
    assert.equal(anuraUrlFor(req('zofhub.test'), e), 'https://anura.example/');
  });

  test('a named host takes the main listener', () => {
    const e = anuraExposure({ ANURA_HOST: 'anura.zofhub.test' }, { present: true });
    assert.equal(e.mode, 'host');
    assert.equal(e.serves, true);
    assert.equal(anuraUrlFor(req('zofhub.test'), e), 'http://anura.zofhub.test/');
  });

  test('otherwise a second port, which needs no DNS at all', () => {
    const e = anuraExposure({}, { present: true });
    assert.equal(e.mode, 'port');
    assert.equal(e.port, 8095, 'the documented default port changed');
    assert.equal(e.serves, true);
  });

  test('no bundle means NO entry, not a broken one', () => {
    // Advertising an engine that 404s is worse than not offering it.
    const e = anuraExposure({}, { present: false });
    assert.equal(e.mode, 'absent');
    assert.equal(anuraUrlFor(req('zofhub.test'), e), null);
  });

  test('ANURA_PORT=0 is a real opt-out', () => {
    for (const v of ['0', 'off', 'false', 'no']) {
      const e = anuraExposure({ ANURA_PORT: v }, { present: true });
      assert.equal(e.mode, 'disabled', `ANURA_PORT=${v} did not disable it`);
      assert.equal(anuraUrlFor(req('zofhub.test'), e), null);
    }
  });

  test('a nonsense port is refused rather than guessed at', () => {
    for (const v of ['banana', '-1', '70000']) {
      assert.equal(anuraExposure({ ANURA_PORT: v }, { present: true }).mode, 'disabled', v);
    }
  });
});

describe('the offered URL follows the request, so a mirror works', () => {
  const e = anuraExposure({}, { present: true });

  test('it carries the hostname the visitor is already using', () => {
    assert.equal(anuraUrlFor(req('localhost:8080'), e), 'http://localhost:8095/');
    assert.equal(anuraUrlFor(req('mirror-7.example:8080'), e), 'http://mirror-7.example:8095/');
  });

  test('a proxied https deployment stays https', () => {
    const r = req('zofhub.test', { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mirror.example' });
    assert.equal(anuraUrlFor(r, e), 'https://mirror.example:8095/');
  });

  test('no hostname is ever baked in', () => {
    // The failure this prevents: the mirror offering an engine on the domain
    // that was blocked in the first place.
    const a = anuraUrlFor(req('first.example:8080'), e);
    const b = anuraUrlFor(req('second.example:8080'), e);
    assert.notEqual(a, b);
    assert.ok(!b.includes('first.example'));
  });
});

describe('the one declared modification actually lands', () => {
  test('config.json is served with a same-origin wisp-url', (t) => {
    if (!HAVE_BUNDLE) return t.skip('vendor/anura absent — run `npm run fetch-anura`');

    const serve = anuraHandler(ANURA_DIR, { port: 8095 });
    const chunks = [];
    const res = {
      headers: {}, statusCode: 200,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(b) { if (b) chunks.push(b); this.ended = true; },
    };
    serve({ method: 'GET', url: '/config.json', headers: { host: 'mirror.example:8080' }, socket: {} }, res);

    const cfg = JSON.parse(Buffer.concat(chunks.map(Buffer.from)).toString('utf8'));
    // WITHOUT THIS, ANURAOS HAS NO NETWORK. lib/Anura.js does
    // `new Networking(settings.get("wisp-url"))` and upstream ships no such key.
    assert.equal(cfg.defaultsettings['wisp-url'], 'ws://mirror.example:8095/wisp/',
      'the wisp-url was not injected, or not derived from the request');
    // Everything else upstream set must survive the rewrite.
    assert.equal(cfg.defaultsettings['launcher-keybind'], true, 'other defaults were lost');
    assert.ok(Array.isArray(cfg.apps) && cfg.apps.length, 'the app list was lost');
    assert.equal(res.headers['cache-control'], 'no-store',
      'a host-derived config must not be cached across hosts');
  });

  test('it is declared as an AGPL §5 modification', () => {
    const lic = readFileSync(join(ROOT, 'lib', 'licenses.mjs'), 'utf8');
    const entry = lic.slice(lic.indexOf("id: 'anura'"), lic.indexOf("id: 'libcurl-js'"));
    assert.match(entry, /modified:\s*true/, 'the config rewrite is not declared');
    assert.match(entry, /wisp-url/, 'the change notice does not say what changed');
    assert.match(entry, /modifiedSourceAt/, 'no §13 pointer to the corresponding source');
  });

  test('the change-notice route is served, not a dead link', () => {
    // A §13 offer that 404s is worse than claiming none.
    const server = readFileSync(join(ROOT, 'server.js'), 'utf8');
    assert.match(server, /app\.get\('\/licenses\/anura-modifications'/,
      'licenses.mjs points at a route nothing serves');
    assert.ok(server.indexOf("app.get('/licenses/anura-modifications'")
      < server.indexOf("app.get('/licenses/:id'"),
      'the :id route would swallow the change-notice route');
  });
});

describe('this origin is a file server for ONE app', () => {
  // A REAL writable, because the handler streams file responses with
  // `createReadStream(...).pipe(res)`. A plain object stub throws inside pipe,
  // which reads as a header assertion failing and sends you hunting the wrong bug.
  const call = (url, method = 'GET') => new Promise((resolve) => {
    const serve = anuraHandler(ANURA_DIR, { port: 8095 });
    const chunks = [];
    const res = new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } });
    res.headers = {};
    res.statusCode = 200;
    res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; };
    res.body = () => Buffer.concat(chunks);
    res.on('finish', () => resolve(res));
    serve({ method, url, headers: { host: 'x.test' }, socket: {} }, res);
    // Non-streamed paths call end() synchronously; give 'finish' a tick, and
    // fall back so a handler that never ends cannot hang the suite silently.
    setTimeout(() => resolve(res), 2000).unref?.();
  });

  test('traversal out of the bundle is refused', async () => {
    for (const u of ['/../.env', '/../../package.json', '/../../../etc/passwd']) {
      const res = await call(u);
      assert.ok(res.statusCode === 403 || res.statusCode === 404, `${u} returned ${res.statusCode}`);
    }
  });

  test('writes are refused', async () => {
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      assert.equal((await call('/', m)).statusCode, 405, `${m} was not refused`);
    }
  });

  test('cross-origin isolation headers are on EVERY response, 404s included', async () => {
    // One response missing them costs the whole document its SharedArrayBuffer,
    // and v86 then fails to start for a reason that looks unrelated.
    for (const u of ['/', '/definitely-not-here']) {
      const h = (await call(u)).headers;
      assert.equal(h['cross-origin-opener-policy'], 'same-origin', u);
      assert.equal(h['cross-origin-embedder-policy'], 'require-corp', u);
      assert.equal(h['x-content-type-options'], 'nosniff', u);
    }
  });

  test('wasm is served as application/wasm', async (t) => {
    if (!HAVE_BUNDLE) return t.skip('vendor/anura absent — run `npm run fetch-anura`');
    // The wrong type fails WebAssembly.instantiateStreaming outright.
    const wasm = join(ANURA_DIR, 'browser', 'assets');
    if (!existsSync(wasm)) return t.skip('bundle layout changed');
    const name = readFileSync(join(ANURA_DIR, 'browser', 'index.html'), 'utf8');
    assert.ok(name.length > 0);
    const res = await call('/browser/assets/scramjet-BuhKAYHW.wasm');
    if (res.statusCode === 404) return t.skip('bundle refreshed — hashed wasm name changed');
    assert.equal(res.headers['content-type'], 'application/wasm');
  });
});

describe('it never becomes an advertising surface', () => {
  test('/anura is classified as proxy infrastructure', async () => {
    const { isAdSurface } = await import('../lib/ad-providers.mjs');
    assert.equal(isAdSurface('/anura'), false);
  });
});
