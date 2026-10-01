// The production guarantees, checked against a REAL NODE_ENV=production boot.
//
// Most of the suite runs the server with NODE_ENV=test, where the AI fallback
// routes are open to loopback on purpose. The property that matters most —
// "production never runs inference, whoever asks and however" — can only be
// shown by booting production. The same boot carries a known ad and region
// configuration, so the six-network payload, the CSP, and regional routing are
// verified end to end rather than only as pure functions.
//
// The database is blanked (as in test/admin-control-api.test.mjs), so this
// cannot touch live data whatever the developer's .env holds.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 3541;
const BLANK = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'MASQR_ENABLED', 'PROXY_AD_SCRIPTS', 'PROXY_AD_ORIGINS', 'TRUST_PROXY'];

const ENV = {
  NODE_ENV: 'production', PORT: String(PORT), NO_OPEN: '1', CRON_DISABLED: '1', ANURA_PORT: '0',
  EXOCLICK_ENABLED: '1',
  EXOCLICK_HEADER_TAG: '<script async src="https://a.exo.test/ad-provider.js"></script><ins data-zoneid="1"></ins>',
  EXOCLICK_HEADER_TAG__SOUTH_ASIA: '<script async src="https://in.exo.test/ad-provider.js"></script>',
  CLICKADU_ENABLED: '1',
  CLICKADU_PREROLL_VAST: 'https://vast.clickadu.test/v?cb=[CACHEBUSTING]',
  POPADS_ENABLED: '1',
  POPADS_POPUNDER_TAG: '<script>(function(){var s=document.createElement("script");s.src="//c1.popads.test/pop.js";})();</script>',
  REGION_ROUTES: 'SOUTH_ASIA:IN,PK=play-in.example.test;NORTH_AMERICA:US,CA=play-us.example.test',
};

let child;
let log = '';

/** Raw HTTP, so Host and every other header go out exactly as written. */
function req(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    r.on('error', reject);
    r.setTimeout(20_000, () => r.destroy(new Error('timeout')));
    if (body !== undefined) r.write(body);
    r.end();
  });
}

before(async () => {
  const env = { ...process.env, ...ENV };
  for (const k of BLANK) env[k] = '';
  env.NODE_ENV = 'production';
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { if ((await req('/api/health')).status === 200) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('production server did not become healthy:\n' + log.slice(-2000));
});

after(() => { if (child && !child.killed) child.kill('SIGKILL'); });

describe('NODE_ENV=production: the AI fallback routes are closed to everyone', () => {
  const ROUTES = ['/api/ai/text', '/api/ai/image?prompt=cat', '/api/ai/echo'];

  test('even to loopback, with no headers at all', async () => {
    for (const path of ROUTES) {
      for (const method of ['GET', 'POST', 'OPTIONS']) {
        const r = await req(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{"prompt":"hi"}' : undefined });
        assert.equal(r.status, 403, `${method} ${path} → ${r.status}`);
      }
    }
  });

  test('whatever the request claims about being local', async () => {
    const spoof = {
      Host: 'localhost', Origin: 'http://localhost', Referer: 'http://127.0.0.1/',
      'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1', Forwarded: 'for=127.0.0.1',
      'X-Forwarded-Host': 'localhost', 'content-type': 'application/json',
    };
    for (const path of ROUTES) {
      const r = await req(path, { method: 'POST', headers: spoof, body: '{"prompt":"hi"}' });
      assert.equal(r.status, 403, path);
      assert.equal(r.json?.error, 'client_side_only');
    }
  });

  test('in any spelling', async () => {
    for (const path of ['/API/AI/TEXT', '/api/ai/text/', '/api/ai/%74ext', '//api//ai//echo', '/api/ai/image/']) {
      assert.equal((await req(path, { method: 'POST', body: '{}' })).status, 403, path);
    }
  });

  test('the pipeline metadata is not published either', async () => {
    const r = await req('/api/ai/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, mode: 'client-side', serverInference: false });
  });
});

describe('the six-network payload, as a production page receives it', () => {
  const cfgFor = async (surface, headers = {}) => (await req(`/api/site-config?surface=${encodeURIComponent(surface)}`, { headers })).json;

  test('a hub page: the header banner, no pre-roll, no popunder, and the gate applies', async () => {
    const hub = await cfgFor('/');
    assert.equal(hub.adsAllowed, true);
    assert.match(hub.slots.header, /a\.exo\.test/);
    assert.equal(hub.preroll, null);
    assert.equal(hub.popunder, null);
    assert.equal(hub.supportGate, true);
  });

  test('a game page adds the pre-roll and the popunder', async () => {
    const game = await cfgFor('/play/anything');
    assert.equal(game.preroll.vast, 'https://vast.clickadu.test/v?cb=[CACHEBUSTING]');
    assert.equal(game.popunder.provider, 'popads');
  });

  test('the proxy page gets nothing, but still learns whether the gate applies', async () => {
    const px = await cfgFor('/browser');
    assert.equal(px.adsAllowed, false);
    assert.deepEqual(px.slots, { header: '', sidebar: '' });
    assert.equal(px.preroll, null);
    assert.equal(px.popunder, null);
    assert.equal(px.supportGate, true);
  });

  test('the visitor\'s region picks the tag; everyone else gets the global one', async () => {
    assert.match((await cfgFor('/', { 'CF-IPCountry': 'IN' })).slots.header, /in\.exo\.test/);
    assert.match((await cfgFor('/', { 'CF-IPCountry': 'US' })).slots.header, /a\.exo\.test/);
    assert.match((await cfgFor('/', { 'CF-IPCountry': 'XX' })).slots.header, /a\.exo\.test/);
  });

  test('the CSP allows every configured script origin, regional and inline-built included', async () => {
    const csp = (await req('/')).headers['content-security-policy'] || '';
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) || '';
    for (const o of ['https://a.exo.test', 'https://in.exo.test', 'https://c1.popads.test']) {
      assert.ok(scriptSrc.includes(o), `${o} missing from script-src`);
    }
  });

  test('a game page is told a pre-roll exists, so it waits for the config', async () => {
    const games = (await req('/api/games?limit=1')).json;
    const slug = games?.games?.[0]?.slug;
    assert.ok(slug, 'the bundled catalog has no game to open');
    const page = await req(`/play/${encodeURIComponent(slug)}`, { headers: { Accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.match(page.text, /preroll: true \};/);
  });
});

describe('regional routing, as a production edge would drive it', () => {
  const page = (extra = {}) => ({ Accept: 'text/html', 'Sec-Fetch-Dest': 'document', ...extra });

  test('a visitor on the wrong domain is sent to their region\'s, path and query intact', async () => {
    const r = await req('/community?tab=new', { headers: page({ Host: 'zofhub.example.test', 'CF-IPCountry': 'IN' }) });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, 'https://play-in.example.test/community?tab=new');
    assert.match(r.headers['cache-control'] || '', /no-store/);
  });

  test('on their own domain, they stay', async () => {
    const r = await req('/community', { headers: page({ Host: 'play-in.example.test', 'CF-IPCountry': 'IN' }) });
    assert.equal(r.status, 200);
  });

  test('APIs, ads.txt, health and legal pages are never moved', async () => {
    for (const path of ['/api/site-config', '/ads.txt', '/healthz', '/privacy']) {
      const r = await req(path, { headers: page({ Host: 'zofhub.example.test', 'CF-IPCountry': 'IN' }) });
      assert.notEqual(r.status, 302, `${path} was redirected`);
    }
  });

  test('?geo=stay opts out with a Secure cookie, and the cookie is honoured', async () => {
    const r = await req('/?geo=stay', { headers: page({ Host: 'zofhub.example.test', 'CF-IPCountry': 'IN' }) });
    assert.equal(r.status, 200);
    const cookie = [].concat(r.headers['set-cookie'] || []).find((c) => c.startsWith('zh_geo='));
    assert.ok(cookie && /; Secure$/.test(cookie), `bad opt-out cookie: ${cookie}`);
    const again = await req('/', { headers: page({ Host: 'zofhub.example.test', 'CF-IPCountry': 'IN', Cookie: 'zh_geo=stay' }) });
    assert.equal(again.status, 200);
  });

  test('a country outside every region, and no country at all, are left where they are', async () => {
    for (const cc of ['FR', undefined]) {
      const r = await req('/', { headers: page({ Host: 'zofhub.example.test', ...(cc ? { 'CF-IPCountry': cc } : {}) }) });
      assert.equal(r.status, 200, String(cc));
    }
  });
});
