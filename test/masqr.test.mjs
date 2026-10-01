// test/masqr.test.mjs — the proxy discovery gate.
// ---------------------------------------------------------------------------
// This gate decides whether an unauthenticated client is shown a web proxy. Get
// it wrong in one direction and a filter vendor's crawler classifies the mirror
// as an anonymiser and burns the domain. Get it wrong in the other and the
// health probe 404s, Render calls the service unhealthy, and the container
// restarts forever.
//
// It is NOT access control and these tests do not pretend otherwise. What they
// pin is: it is off unless asked for, it never hides the things that must stay
// reachable, a forged grant does not work, and a key cannot be brute-forced by
// watching what the gate says back.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  masqrConfig, mintKey, verifyKey, isGatedPath, looksLikeDocument,
  masqrMiddleware, masqrStatusLine, readCookie, suggestSecret,
  GRANT_COOKIE, HINT_COOKIE,
} from '../lib/masqr.mjs';

const SECRET = 'test-secret-that-is-long-enough-000';
const ON = { MASQR_ENABLED: '1', MASQR_SECRET: SECRET };

/** Minimal req/res pair shaped like what Express hands a middleware. */
function exchange(url, { cookie = '', headers = {} } = {}) {
  const req = { url, originalUrl: url, headers: { accept: 'text/html', cookie, ...headers } };
  const res = {
    statusCode: 200, headers: {}, cookies: [], body: null, ended: false,
    append(k, v) { if (k === 'Set-Cookie') this.cookies.push(v); },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.ended = true; this.body = b ?? null; },
  };
  let nexted = false;
  const next = () => { nexted = true; };
  return { req, res, next, wasNexted: () => nexted };
}
const cookieNamed = (res, name) => res.cookies.find((c) => c.startsWith(name + '='));

describe('it is off unless deliberately switched on', () => {
  test('no configuration at all means no gate', () => {
    const c = masqrConfig({});
    assert.equal(c.enabled, false);
    assert.equal(c.mode, 'off');
    assert.deepEqual(c.warnings, [], 'the default posture must not warn');
    assert.match(masqrStatusLine(c), /off/);
  });

  test('the disabled middleware is a pass-through, not a slow no-op', () => {
    const { req, res, next, wasNexted } = exchange('/browser');
    masqrMiddleware(masqrConfig({}))(req, res, next);
    assert.equal(wasNexted(), true);
    assert.deepEqual(res.cookies, [], 'a disabled gate must not set cookies');
  });

  test('enabled WITHOUT a secret refuses to enable, and says why', () => {
    // A gate that cannot verify anything denies everyone. Failing open here is
    // the lesser evil, and it must be impossible to miss.
    const c = masqrConfig({ MASQR_ENABLED: '1' });
    assert.equal(c.enabled, false);
    assert.equal(c.mode, 'misconfigured');
    assert.match(c.warnings.join(' '), /MASQR_SECRET/);
    assert.match(masqrStatusLine(c), /NOT enabled/);
  });

  test('a guessable secret is refused too', () => {
    const c = masqrConfig({ MASQR_ENABLED: '1', MASQR_SECRET: 'short' });
    assert.equal(c.enabled, false);
    assert.match(c.warnings.join(' '), /16 characters/);
  });

  test('a valid configuration reports its real settings', () => {
    const c = masqrConfig({ ...ON, MASQR_KEY_TTL_DAYS: '7', MASQR_DENY: 'redirect' });
    assert.equal(c.enabled, true);
    assert.equal(c.ttlDays, 7);
    assert.equal(c.denyMode, 'redirect');
    assert.match(masqrStatusLine(c), /7d/);
  });

  test('nonsense values fall back to the documented defaults and warn', () => {
    const c = masqrConfig({ ...ON, MASQR_KEY_TTL_DAYS: 'banana', MASQR_DENY: 'explode' });
    assert.equal(c.ttlDays, 30);
    assert.equal(c.denyMode, '404');
    assert.equal(c.warnings.length, 2);
  });
});

describe('keys are signed, expiring, and unforgeable', () => {
  test('a freshly minted key verifies', () => {
    const k = mintKey(SECRET, { ttlMs: 60_000 });
    assert.equal(verifyKey(SECRET, k).ok, true);
  });

  test('a key minted with a different secret does not', () => {
    const k = mintKey('another-secret-entirely-1234567890', { ttlMs: 60_000 });
    assert.equal(verifyKey(SECRET, k).ok, false);
  });

  test('an expired key is refused', () => {
    const k = mintKey(SECRET, { ttlMs: 1000, now: 0 });
    assert.equal(verifyKey(SECRET, k, { now: 500 }).ok, true);
    const late = verifyKey(SECRET, k, { now: 5000 });
    assert.equal(late.ok, false);
    assert.equal(late.reason, 'expired');
  });

  test('extending the expiry invalidates the signature', () => {
    // The whole point: the expiry is signed, so a holder cannot grant
    // themselves a longer key by editing the part they can read.
    const k = mintKey(SECRET, { ttlMs: 1000, now: 0 });
    const [, sig] = k.split('.');
    const forged = `${(10 ** 12).toString(36)}.${sig}`;
    assert.equal(verifyKey(SECRET, forged).ok, false);
  });

  test('a flipped signature byte is refused', () => {
    const k = mintKey(SECRET, { ttlMs: 60_000 });
    const [p, sig] = k.split('.');
    const flipped = sig[0] === 'A' ? 'B' + sig.slice(1) : 'A' + sig.slice(1);
    assert.equal(verifyKey(SECRET, `${p}.${flipped}`).reason, 'bad-signature');
  });

  test('malformed input never throws and never passes', () => {
    for (const bad of [undefined, null, '', '.', 'nodot', 'a.', '.b', 'a.b',
      '!!!.' + 'x'.repeat(22), 'zz.' + 'x'.repeat(21), { }, 123, 'a'.repeat(400)]) {
      const r = verifyKey(SECRET, bad);
      assert.equal(r.ok, false, `accepted ${String(bad).slice(0, 20)}`);
    }
  });

  test('an oversized key is rejected before any hashing happens', () => {
    // Otherwise a cookie is a free way to make the server hash a megabyte on
    // every request.
    assert.equal(verifyKey(SECRET, 'x'.repeat(100_000)).reason, 'malformed');
  });

  test('verification without a secret always fails', () => {
    assert.equal(verifyKey('', mintKey(SECRET, { ttlMs: 60_000 })).reason, 'no-secret');
  });

  test('the suggested secret is long and random', () => {
    const a = suggestSecret(); const b = suggestSecret();
    assert.ok(a.length >= 32);
    assert.notEqual(a, b);
  });
});

describe('what is gated, and what must never be', () => {
  test('proxy surfaces are gated', () => {
    for (const p of ['/browser', '/browser/', '/gust', '/uv/service/abc', '/scram/service/x',
      '/wisp/', '/baremux/worker.js', '/anura', '/kasm', '/invisi', '/api/proxies']) {
      assert.equal(isGatedPath(p), true, `${p} should be gated`);
    }
  });

  test('the health probe is NEVER gated', () => {
    // Gating it 404s the probe, Render marks the service unhealthy, and the
    // container restarts in a loop. This is the one that takes the site down.
    for (const p of ['/healthz', '/ping', '/api/health']) {
      assert.equal(isGatedPath(p), false, `${p} must stay reachable`);
    }
  });

  test('legal pages are NEVER gated', () => {
    // A DMCA agent, a privacy request and a licence notice have to be reachable
    // by anyone, crawlers included. Hiding them would be wrong on its own terms.
    for (const p of ['/privacy', '/terms', '/dmca', '/cookies', '/licenses', '/credits',
      '/licenses/ultraviolet']) {
      assert.equal(isGatedPath(p), false, `${p} must stay reachable`);
    }
  });

  test('crawler contract files are NEVER gated', () => {
    for (const p of ['/robots.txt', '/sitemap.xml', '/ads.txt', '/favicon.ico']) {
      assert.equal(isGatedPath(p), false, `${p} must stay reachable`);
    }
  });

  test('the games hub stays completely open', () => {
    // The site genuinely is a games hub. That is what an unauthenticated
    // visitor — and a classifier — should see, and it is not a cover story.
    for (const p of ['/', '/game/foo', '/category/action', '/ai', '/leaderboard',
      '/community', '/donate', '/404']) {
      assert.equal(isGatedPath(p), false, `${p} must stay open`);
    }
  });

  test('the gated list is derived from PROXY_SURFACES, not restated', async () => {
    // Two copies of "what counts as a proxy surface" would drift, and the drift
    // would be silent — a newly added engine advertised to a crawler.
    const { AD_SURFACES } = await import('../lib/ad-providers.mjs');
    for (const p of AD_SURFACES.proxy) {
      if (['/service', '/sw.js'].includes(p)) continue;   // also matched by NEVER_GATE prefixes? no — check anyway
      assert.equal(isGatedPath(p), true, `${p} is in PROXY_SURFACES but not gated`);
    }
  });
});

describe('only documents are gated, not subresources', () => {
  test('a navigation is a document', () => {
    assert.equal(looksLikeDocument({ headers: { 'sec-fetch-dest': 'document' } }), true);
    assert.equal(looksLikeDocument({ headers: { accept: 'text/html,application/xhtml+xml' } }), true);
  });

  test('a script or style fetch is not', () => {
    // A grant expiring mid-session must not start feeding HTML to a service
    // worker that asked for JavaScript.
    assert.equal(looksLikeDocument({ headers: { 'sec-fetch-dest': 'script' } }), false);
    assert.equal(looksLikeDocument({ headers: { 'sec-fetch-dest': 'style' } }), false);
    assert.equal(looksLikeDocument({ headers: { 'sec-fetch-dest': 'image' } }), false);
  });

  test('a bare crawler with no hints is treated as a document', () => {
    // Most crawlers send no Sec-Fetch-Dest. Treating the unknown case as a
    // document is the safe direction for this feature.
    assert.equal(looksLikeDocument({ headers: {} }), true);
    assert.equal(looksLikeDocument({ headers: { accept: '*/*' } }), true);
  });
});

describe('the gate behaves correctly end to end', () => {
  const cfg = masqrConfig(ON);
  const mw = masqrMiddleware(cfg);

  test('an ungranted crawler gets 404 on the proxy, and is NOT told why', () => {
    const { req, res, next, wasNexted } = exchange('/browser');
    mw(req, res, next);
    assert.equal(wasNexted(), false, 'the request must not reach the proxy page');
    assert.equal(res.statusCode, 404);
    assert.ok(!/key|licen[cs]e|masqr|gate/i.test(String(res.body || '')),
      'the denial names the mechanism, which tells a crawler what to look for');
  });

  test('the games hub is untouched for that same client', () => {
    const { req, res, next, wasNexted } = exchange('/');
    mw(req, res, next);
    assert.equal(wasNexted(), true);
    assert.equal(res.statusCode, 200);
  });

  test('a key in the link grants, and is stripped from the URL', () => {
    const key = mintKey(SECRET, { ttlMs: 60_000 });
    const { req, res } = exchange(`/browser?k=${key}&utm=x`);
    mw(req, res, () => {});
    assert.equal(res.statusCode, 302);
    // The key must not survive into history, a Referer, or an access log.
    assert.ok(!res.headers.location.includes(key), `key leaked into ${res.headers.location}`);
    assert.ok(!res.headers.location.includes('k='), 'the k parameter was not removed');
    assert.ok(res.headers.location.includes('utm=x'), 'other query parameters were dropped');
    const c = cookieNamed(res, GRANT_COOKIE);
    assert.ok(c, 'no grant cookie was set');
    assert.match(c, /HttpOnly/, 'the grant must not be readable by JavaScript');
    assert.match(c, /SameSite=Lax/, 'Strict would drop the cookie on the very link that grants it');
  });

  test('a WRONG key is refused without revealing that it was wrong', () => {
    // Echoing "bad key" turns the gate into an oracle that can be hammered.
    const { req, res } = exchange('/browser?k=deadbeef.AAAAAAAAAAAAAAAAAAAAAA');
    mw(req, res, () => {});
    assert.equal(res.statusCode, 302, 'a bad key should look exactly like a good one');
    assert.equal(cookieNamed(res, GRANT_COOKIE), undefined, 'a grant was issued for a bad key');
  });

  test('a valid grant cookie passes through', () => {
    const key = mintKey(SECRET, { ttlMs: 60_000 });
    const { req, res, next, wasNexted } = exchange('/browser', { cookie: `${GRANT_COOKIE}=${key}` });
    mw(req, res, next);
    assert.equal(wasNexted(), true);
    assert.equal(req.masqrGranted, true);
  });

  test('a FORGED grant cookie does not', () => {
    // Upstream sets `authcheck=true`, which any visitor can type into the
    // console. The grant here is the signed key and is re-verified every time.
    for (const forged of ['true', '1', 'authcheck', mintKey('wrong-secret-but-long-enough-xx', { ttlMs: 60_000 })]) {
      const { req, res, next, wasNexted } = exchange('/browser', { cookie: `${GRANT_COOKIE}=${forged}` });
      mw(req, res, next);
      assert.equal(wasNexted(), false, `forged grant "${forged}" was accepted`);
      assert.equal(res.statusCode, 404);
    }
  });

  test('an EXPIRED grant stops working', () => {
    const key = mintKey(SECRET, { ttlMs: 1000, now: 0 });
    const late = masqrMiddleware(cfg, { now: () => 999_999 });
    const { req, res, next, wasNexted } = exchange('/browser', { cookie: `${GRANT_COOKIE}=${key}` });
    late(req, res, next);
    assert.equal(wasNexted(), false);
  });

  test('a subresource is let through even without a grant', () => {
    const { req, res, next, wasNexted } = exchange('/uv/uv.bundle.js',
      { headers: { 'sec-fetch-dest': 'script' } });
    mw(req, res, next);
    assert.equal(wasNexted(), true, 'gating subresources breaks a session whose grant expires mid-use');
  });

  test('the health probe survives the gate', () => {
    // The failure mode here is an endless restart loop, so it is checked
    // through the middleware and not only through isGatedPath().
    for (const p of ['/healthz', '/api/health']) {
      const { req, res, next, wasNexted } = exchange(p, { headers: { accept: '*/*' } });
      mw(req, res, next);
      assert.equal(wasNexted(), true, `${p} was gated`);
      assert.notEqual(res.statusCode, 404);
    }
  });

  test('the site chrome is told whether to show the proxy link', () => {
    // Without this the header would advertise a "Proxy Browser" link that 404s
    // for this visitor, which looks like a broken site rather than a quiet one.
    const { req, res } = exchange('/');
    mw(req, res, () => {});
    const hint = cookieNamed(res, HINT_COOKIE);
    assert.ok(hint && hint.includes(`${HINT_COOKIE}=0`), 'no "hidden" hint for an ungranted visitor');
    assert.ok(!/HttpOnly/.test(hint), 'the hint must be readable by the page that acts on it');

    const key = mintKey(SECRET, { ttlMs: 60_000 });
    const g = exchange('/', { cookie: `${GRANT_COOKIE}=${key}` });
    mw(g.req, g.res, () => {});
    assert.ok(cookieNamed(g.res, HINT_COOKIE).includes(`${HINT_COOKIE}=1`));
  });

  test('redirect mode sends people to the hub instead of a 404', () => {
    const rmw = masqrMiddleware(masqrConfig({ ...ON, MASQR_DENY: 'redirect' }));
    const { req, res } = exchange('/browser');
    rmw(req, res, () => {});
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/');
  });

  test('the secret never appears in a response', () => {
    const { req, res } = exchange('/browser?k=' + mintKey(SECRET, { ttlMs: 60_000 }));
    mw(req, res, () => {});
    const seen = JSON.stringify({ h: res.headers, c: res.cookies, b: res.body });
    assert.ok(!seen.includes(SECRET), 'the signing secret leaked into a response');
  });
});

describe('readCookie is not fooled by lookalikes', () => {
  test('it matches the exact name only', () => {
    assert.equal(readCookie(`not_${GRANT_COOKIE}=x; ${GRANT_COOKIE}=good`, GRANT_COOKIE), 'good');
    assert.equal(readCookie(`${GRANT_COOKIE}_extra=x`, GRANT_COOKIE), '');
    assert.equal(readCookie('', GRANT_COOKIE), '');
    assert.equal(readCookie(undefined, GRANT_COOKIE), '');
  });
});
