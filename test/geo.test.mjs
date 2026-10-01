// Regional domain isolation and regional ad localisation (lib/geo.mjs).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  geoConfig, countryOf, regionOf, routeDecision, isTopLevelNavigation, isNeverRouted, STAY_COOKIE,
} from '../lib/geo.mjs';
import { mintKey, grantKeyFor, GRANT_COOKIE, masqrConfig } from '../lib/masqr.mjs';

const ROUTES = 'SOUTH_ASIA:IN,PK,BD,LK,NP,BT,MV=play-in.example.test,alt-in.example.test;'
  + 'NORTH_AMERICA:US,CA=play-us.example.test;GLOBAL:*=zofhub.example.test';
const cfg = geoConfig({ REGION_ROUTES: ROUTES });
const PAGE = { 'sec-fetch-dest': 'document' };
const decide = (o, grant) => routeDecision({ method: 'GET', url: '/', ...o }, cfg, { grant });

describe('configuration', () => {
  test('a well-formed table parses without warnings', () => {
    assert.deepEqual(cfg.warnings, []);
    assert.deepEqual([...cfg.regionIds], ['SOUTH_ASIA', 'NORTH_AMERICA', 'GLOBAL']);
    assert.equal(cfg.routing, true);
    assert.equal(cfg.fallback.id, 'GLOBAL');
    assert.equal(cfg.header, 'cf-ipcountry');
  });

  test('unset means off, and off means every decision is "none"', () => {
    const off = geoConfig({});
    assert.equal(off.enabled, false);
    assert.equal(off.routing, false);
    assert.deepEqual(routeDecision({ method: 'GET', host: 'x.test', url: '/', headers: { ...PAGE, 'cf-ipcountry': 'IN' } }, off),
      { action: 'none' });
  });

  test('a region with no hosts localises ads but routes nobody', () => {
    const adsOnly = geoConfig({ REGION_ROUTES: 'SOUTH_ASIA:IN,PK' });
    assert.equal(adsOnly.enabled, true);
    assert.equal(adsOnly.routing, false);
    assert.equal(regionOf('IN', adsOnly).id, 'SOUTH_ASIA');
  });

  test('every bad entry is skipped and reported, the rest still apply', () => {
    const c = geoConfig({
      GEO_COUNTRY_HEADER: 'not a header',
      REGION_ROUTES: 'A:IN=http://insecure.test;B:IN,ZZ,USA,FR=1.2.3.4,a.test/path,ok.test;C:*;D:*;junk;'
        + 'E:DE=ok.test;F:XX',
    });
    const w = c.warnings.join('\n');
    for (const needle of ['not a header name', '"http://insecure.test" in A is not an https domain',
      'IN already belongs to A', '"ZZ" in B', '"USA" in B', '"1.2.3.4" in B', '"a.test/path" in B',
      'D and C both claim "*"', '"junk" is not ID:COUNTRIES', 'ok.test is already assigned to B',
      'region F names no valid country']) {
      assert.ok(w.includes(needle), `missing warning: ${needle}\n${w}`);
    }
    assert.equal(c.header, 'cf-ipcountry');
    assert.equal(regionOf('FR', c).id, 'B');
    assert.equal(c.fallback.id, 'C');
  });
});

describe('country and region', () => {
  test('the configured header is read, upper-cased and validated', () => {
    assert.equal(countryOf({ 'cf-ipcountry': 'in' }, cfg), 'IN');
    for (const v of ['XX', 'T1', 'A1', '', 'IND', '1N', undefined]) {
      assert.equal(countryOf({ 'cf-ipcountry': v }, cfg), null, String(v));
    }
    const other = geoConfig({ REGION_ROUTES: ROUTES, GEO_COUNTRY_HEADER: 'X-Country-Code' });
    assert.equal(countryOf({ 'x-country-code': 'us' }, other), 'US');
    assert.equal(countryOf({ 'cf-ipcountry': 'US' }, other), null, 'the default header leaked through');
  });

  test('a listed country gets its region; any other country the catch-all; no country, nothing', () => {
    assert.equal(regionOf('PK', cfg).id, 'SOUTH_ASIA');
    assert.equal(regionOf('CA', cfg).id, 'NORTH_AMERICA');
    assert.equal(regionOf('FR', cfg).id, 'GLOBAL');
    assert.equal(regionOf(null, cfg), null);
  });
});

describe('routing decisions', () => {
  test('a visitor on another region\'s domain is sent to their own, path and query intact', () => {
    const d = decide({ host: 'zofhub.example.test', url: '/play/slope?ref=tt', headers: { ...PAGE, 'cf-ipcountry': 'IN' } });
    assert.deepEqual(d, { action: 'redirect', region: 'SOUTH_ASIA', location: 'https://play-in.example.test/play/slope?ref=tt' });
  });

  test('any of a region\'s own hosts is home — no loop, no bounce between them', () => {
    for (const host of ['play-in.example.test', 'alt-in.example.test', 'PLAY-IN.example.test.']) {
      assert.equal(decide({ host, headers: { ...PAGE, 'cf-ipcountry': 'IN' } }).action, 'none', host);
    }
  });

  test('US school traffic on the Indian domain goes back to the US domain', () => {
    assert.equal(decide({ host: 'play-in.example.test', headers: { ...PAGE, 'cf-ipcountry': 'US' } }).location,
      'https://play-us.example.test/');
  });

  test('only top-level page loads are routed', () => {
    const h = { 'cf-ipcountry': 'IN' };
    assert.equal(decide({ method: 'POST', host: 'x.test', headers: { ...h, ...PAGE } }).action, 'none');
    for (const dest of ['iframe', 'script', 'image', 'empty', 'serviceworker']) {
      assert.equal(decide({ host: 'x.test', headers: { ...h, 'sec-fetch-dest': dest } }).action, 'none', dest);
    }
    assert.equal(decide({ host: 'x.test', headers: { ...h, accept: 'application/json' } }).action, 'none');
    assert.equal(decide({ host: 'x.test', headers: { ...h, accept: 'text/html,*/*' } }).action, 'redirect');
    assert.equal(isTopLevelNavigation('HEAD', PAGE), true);
  });

  test('health, ads.txt, robots, legal, API, assets and proxy internals are never moved', () => {
    for (const url of ['/healthz', '/api/site-config', '/ads.txt', '/robots.txt', '/sitemap.xml', '/privacy',
      '/dmca', '/assets/logo.png', '/js/layout.js', '/embed/slope', '/uv/uv.bundle.js', '/wisp/', '/admin']) {
      assert.equal(isNeverRouted(url), true, url);
      assert.equal(decide({ host: 'x.test', url, headers: { ...PAGE, 'cf-ipcountry': 'IN' } }).action, 'none', url);
    }
    assert.equal(isNeverRouted('/browser'), false, 'the proxy page is exactly what should be isolated');
  });

  test('?geo=stay opts out, and the cookie keeps it that way', () => {
    const stay = decide({ host: 'x.test', url: '/?geo=stay', headers: { ...PAGE, 'cf-ipcountry': 'IN' } });
    assert.equal(stay.action, 'stay');
    assert.match(stay.cookie, new RegExp(`^${STAY_COOKIE}=stay; Path=/; Max-Age=604800; SameSite=Lax$`));
    assert.equal(decide({ host: 'x.test', headers: { ...PAGE, 'cf-ipcountry': 'IN', cookie: 'a=1; zh_geo=stay' } }).action, 'none');
  });

  test('an unknown country, or an absolute-form target, is left alone', () => {
    assert.equal(decide({ host: 'x.test', headers: PAGE }).action, 'none');
    assert.equal(decide({ host: 'x.test', url: 'http://evil.test/', headers: { ...PAGE, 'cf-ipcountry': 'IN' } }).action, 'none');
  });

  test('it holds no state: the same input always gives the same answer, fast', () => {
    const input = { method: 'GET', host: 'zofhub.example.test', url: '/browser', headers: { ...PAGE, 'cf-ipcountry': 'IN' } };
    const first = JSON.stringify(routeDecision(input, cfg));
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 100_000; i++) routeDecision(input, cfg);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(JSON.stringify(routeDecision(input, cfg)), first);
    // Generous on purpose — this guards against an accidental O(n) or a network
    // call creeping in, not against a slow CI machine.
    assert.ok(ms < 4000, `100k decisions took ${ms.toFixed(0)}ms`);
  });
});

describe('a MASQR key crosses the regional redirect', () => {
  const masqr = masqrConfig({ MASQR_ENABLED: '1', MASQR_SECRET: 'a-test-secret-that-is-long-enough' });

  test('a valid grant rides the redirect as ?k=, computed only when a redirect happens', () => {
    const key = mintKey(masqr.secret, { ttlMs: 60_000 });
    let calls = 0;
    const grant = () => { calls++; return grantKeyFor(masqr, `${GRANT_COOKIE}=${key}`); };
    const d = routeDecision({ method: 'GET', host: 'zofhub.example.test', url: '/browser?x=1',
      headers: { ...PAGE, 'cf-ipcountry': 'IN' } }, cfg, { grant });
    assert.equal(d.location, `https://play-in.example.test/browser?x=1&k=${encodeURIComponent(key)}`);
    assert.equal(calls, 1);
    routeDecision({ method: 'GET', host: 'play-in.example.test', url: '/', headers: { ...PAGE, 'cf-ipcountry': 'IN' } }, cfg, { grant });
    assert.equal(calls, 1, 'the grant was verified for a request that was not redirected');
  });

  test('an expired, forged or absent grant is never promoted into a link', () => {
    const expired = mintKey(masqr.secret, { ttlMs: 1, now: Date.now() - 10_000 });
    const forged = mintKey('some-other-secret-entirely-xyz', { ttlMs: 60_000 });
    for (const cookie of [`${GRANT_COOKIE}=${expired}`, `${GRANT_COOKIE}=${forged}`, '', 'x=1']) {
      assert.equal(grantKeyFor(masqr, cookie), '', cookie);
    }
    assert.equal(grantKeyFor(masqrConfig({}), `${GRANT_COOKIE}=${mintKey(masqr.secret)}`), '', 'gate off, but a key was returned');
  });
});
