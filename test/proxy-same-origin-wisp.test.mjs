// The vendored GUST and HORIZON pages may only ever use THIS site's own /wisp/.
// ---------------------------------------------------------------------------
// Server-side, every stream the tunnel carries crosses sing-box
// (test/egress-*.test.mjs). That is worthless if the BROWSER can be pointed at a
// different tunnel: a visitor who types wss://somewhere-else/wisp/ into GUST's
// "WISP Server" field, or clicks HORIZON's Reset (which used to reset to the
// upstream public host), sends their traffic around this site entirely — past the
// destination policy, past the SSRF filter, past the daemon.
//
// Likewise a proxied page that opens a WebSocket must not have the visitor's
// browser connect to that server DIRECTLY; GUST used to do exactly that.
//
// The helper is also EXECUTED here, against hostile URLs, not just grepped for:
// a check that only reads the source would pass for a function that always
// returned true.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const APPS = {
  gust: { file: 'proxy-engine/assets/gust/index.html', DEFAULT: 'GUST_DEFAULT_WISP', setCalls: 6 },
  horizon: { file: 'proxy-engine/assets/horizon/index.html', DEFAULT: 'ZOF_DEFAULT_WISP', setCalls: 9 },
};

// Pull the helper definitions out of the served file, so what is tested IS what ships.
function helpersOf({ file, DEFAULT }, origin) {
  const src = read(file);
  const start = src.indexOf('function zhWispOk(u)');
  const end = src.indexOf('const zhSetWisp', start);
  const endLine = src.indexOf('\n', end);
  assert.ok(start > -1 && end > start, `${file}: the Wisp pin is missing`);
  const code = src.slice(start, endLine);
  const url = new URL(origin);
  const calls = [];
  const ctx = {
    URL,
    location: { href: `${url.origin}/browser`, host: url.host, protocol: url.protocol },
    [DEFAULT]: `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/wisp/`,
    libcurl: { set_websocket(u) { calls.push(u); return 'set'; } },
  };
  vm.createContext(ctx);
  vm.runInContext(`${code}\nthis.zhWispOk = zhWispOk; this.zhWisp = zhWisp; this.zhSetWisp = zhSetWisp;`, ctx);
  return { ...ctx, calls, DEFAULT_URL: ctx[DEFAULT] };
}

for (const [name, app] of Object.entries(APPS)) {
  describe(`${name}: only this site's own tunnel is ever used`, () => {
    const SITE = 'https://zofhub.example';
    const WSS = 'wss://zofhub.example/wisp/';

    test('the helper accepts exactly the same-origin /wisp/ endpoint', () => {
      const h = helpersOf(app, SITE);
      assert.equal(h.zhWispOk(WSS), true);
      assert.equal(h.zhWisp(WSS), WSS);
    });

    for (const [label, url] of [
      ['another host', 'wss://wisp.mercurywork.shop/'],
      ['another host with the right path', 'wss://evil.example/wisp/'],
      ['a lookalike subdomain', 'wss://zofhub.example.evil.test/wisp/'],
      ['a prefix lookalike', 'wss://evilzofhub.example/wisp/'],
      ['credentials that make the real host look like a path', 'wss://zofhub.example@evil.test/wisp/'],
      ['credentials on the real host', 'wss://user:pw@zofhub.example/wisp/'],
      ['a different port', 'wss://zofhub.example:8443/wisp/'],
      ['a different path', 'wss://zofhub.example/other/'],
      ['no trailing slash', 'wss://zofhub.example/wisp'],
      ['a query string', 'wss://zofhub.example/wisp/?x=1'],
      ['a fragment', 'wss://zofhub.example/wisp/#x'],
      ['plain http', 'http://zofhub.example/wisp/'],
      ['https instead of wss', 'https://zofhub.example/wisp/'],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['a data: URL', 'data:text/plain,x'],
      ['a protocol-relative URL to elsewhere', '//evil.test/wisp/'],
      ['an empty string', ''],
      ['whitespace', '   '],
      ['null', null],
      ['undefined', undefined],
      ['an object', {}],
    ]) {
      test(`${label} is refused and replaced with the site tunnel`, () => {
        const h = helpersOf(app, SITE);
        assert.equal(h.zhWispOk(url), false, JSON.stringify(url));
        assert.equal(h.zhWisp(url), WSS, 'a refused URL must be replaced by the site tunnel, not passed on');
      });
    }

    test('it follows the page: ws:// on an http origin, with its port', () => {
      const h = helpersOf(app, 'http://localhost:8080');
      assert.equal(h.zhWispOk('ws://localhost:8080/wisp/'), true);
      assert.equal(h.zhWispOk('wss://localhost:8080/wisp/'), true, 'wss to the same host is the same origin');
      assert.equal(h.zhWispOk('ws://localhost:9999/wisp/'), false);
      assert.equal(h.zhWispOk('ws://127.0.0.1:8080/wisp/'), false, 'a different name for the same machine is a different origin');
    });

    test('libcurl.set_websocket is only ever called with the pinned URL', () => {
      const h = helpersOf(app, SITE);
      h.zhSetWisp('wss://wisp.mercurywork.shop/');
      h.zhSetWisp(WSS);
      h.zhSetWisp('wss://zofhub.example:1/wisp/');
      h.zhSetWisp(undefined);
      assert.deepEqual(h.calls, [WSS, WSS, WSS, WSS], 'a foreign server reached libcurl');
    });

    test('every call site in the served file goes through the pin', () => {
      const src = read(app.file);
      // A CALL passes an argument; the notices and comments say "set_websocket()" with
      // empty parentheses when they talk about it, which is prose, not a call.
      assert.equal((src.match(/libcurl\.set_websocket\([^)\s]/g) || []).length, 0,
        'a libcurl.set_websocket(...) call bypasses the pin');
      assert.ok((src.match(/zhSetWisp\(/g) || []).length >= app.setCalls,
        `expected at least ${app.setCalls} call sites through zhSetWisp`);
    });

    test('stored values are checked when they are LOADED, not only when they are saved', () => {
      const src = read(app.file);
      assert.match(src, /let WISP = \(function \(\) \{ try \{ return zhWisp\(ls\.getItem\('gust:wisp:v1'\)/);
      assert.doesNotMatch(src, /return ls\.getItem\('gust:wisp:v1'\) \|\|/, 'the stored server is read without the pin');
    });

    test('the settings field refuses a foreign server, and says why', () => {
      const src = read(app.file);
      assert.match(src, /if \(!zhWispOk\(val\)\) \{\s*showStatusMsg\(wispStatus, "This site relays only through its own tunnel/);
      assert.match(src, /if \(v && !zhWispOk\(v\)\) \{\s*if \(fbStatus\) showStatusMsg\(fbStatus, 'This site relays only through its own tunnel\./);
    });

    test('no third-party tunnel is named in the code', () => {
      // The AGPL notice at the top legitimately NAMES the upstream host it replaced;
      // code and strings must not. Strip the HTML comments and whole-line // comments.
      const src = read(app.file).replace(/<!--[\s\S]*?-->/g, '')
        .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      for (const host of ['wisp.mercurywork.shop', 'wisp.rhw.one', 'mages.io', 'nebulaproxy.io', 'anura.pro']) {
        assert.ok(!src.includes(host), `${app.file} still names ${host} outside a comment`);
      }
      const literals = [...src.matchAll(/wss?:\/\/[A-Za-z0-9._-]+\.[a-z]{2,}[^\s"'`<>)]*/g)].map((m) => m[0]);
      // The only host literals allowed are example/placeholder text, and — in HORIZON — the
      // Discord gateway, which its built-in client reaches THROUGH the tunnel (never natively).
      const allowed = (l) => /example\.com/.test(l) || /gateway\.discord\.gg/.test(l);
      assert.deepEqual(literals.filter((l) => !allowed(l)), [], 'a websocket host literal that is not the site tunnel');
    });

    test('the AGPL notice in the file declares the change', () => {
      const src = read(app.file);
      assert.match(src, /2026-11-03/);
      assert.match(src, /only this site's own|ONLY that endpoint|ONLY the Wisp server this page may use|the ONLY Wisp server/i);
    });
  });
}

describe('GUST: a proxied page\'s WebSocket rides the tunnel instead of the visitor\'s own connection', () => {
  const src = read(APPS.gust.file);
  const body = src.slice(src.indexOf('function handleWsOpen'), src.indexOf('function handleWsOpen') + 900);

  test('handleWsOpen opens a libcurl.WebSocket', () => {
    assert.match(body, /new libcurl\.WebSocket\(url, protocols \|\| undefined\)/);
  });

  test('and never a native WebSocket to the page\'s own server', () => {
    assert.doesNotMatch(body, /new WebSocket\(/);
    // No other place in the app creates a native WebSocket either.
    assert.equal((src.match(/new WebSocket\(/g) || []).length, 0, 'GUST creates a native WebSocket somewhere');
  });

  test('the wrapper class libcurl ships is the one that tunnels (FakeWebSocket over CurlWebSocket)', () => {
    const lib = readFileSync(join(ROOT, 'proxy-engine/assets/gust/vendor/libcurl_full.js'), 'utf8');
    assert.match(lib, /WebSocket: FakeWebSocket/);
    assert.match(lib, /this\.socket = new CurlWebSocket\(this\.url, this\.protocols, this\.options\)/);
  });
});

describe('HORIZON: the places that used to name the upstream host are gone', () => {
  const src = read(APPS.horizon.file);

  test('the Reset button resets to the site tunnel', () => {
    assert.match(src, /const defaultWisp = ZOF_DEFAULT_WISP;/);
    assert.doesNotMatch(src, /const defaultWisp = "wss:\/\//);
  });

  test('the built-in Discord client only remembers the site tunnel', () => {
    assert.match(src, /const saved=\(function\(u\)\{try\{const p=new URL\(String\(u\|\|''\),location\.href\);return \(\(p\.protocol==='wss:'\|\|p\.protocol==='ws:'\)&&p\.host===location\.host&&p\.pathname==='\/wisp\/'\)/);
    assert.doesNotMatch(src, /const saved=localStorage\.getItem\('wisp'\)/);
  });

  test('its proxied-page WebSockets already ride the tunnel', () => {
    const at = src.indexOf('function handleWsOpen');
    assert.match(src.slice(at, at + 400), /new libcurl\.WebSocket\(/);
  });
});

describe('the declarations match what is served', () => {
  test('the licence registry records the 2026-11-03 change for both components', async () => {
    const { getComponents } = await import('../lib/licenses.mjs');
    const COMPONENTS = getComponents();
    for (const id of ['gust', 'horizon']) {
      const c = COMPONENTS.find((x) => x.id === id);
      assert.ok(c, id);
      assert.equal(c.modifiedOn, '2026-11-03');
      assert.ok(c.modifications.some((m) => /accepted as a Wisp server/.test(m)), `${id} does not declare the pin`);
    }
    const gust = COMPONENTS.find((x) => x.id === 'gust');
    assert.ok(gust.modifications.some((m) => /libcurl\.WebSocket/.test(m)), 'the WebSocket change is undeclared');
  });
});
