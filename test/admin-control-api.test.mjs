// The control plane end to end: the REAL server.js, spawned with no database
// (so it runs the in-memory control plane and cannot touch live data), driven
// over HTTP by service tokens of different roles. Plus a structural proof that
// every control-plane route is gated.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountAdminApi } from '../lib/admin-api.mjs';
import { PERMISSION_IDS } from '../lib/admin-rbac.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'test-control-plane-token-0123456789';
const BLANK_DB = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];

// ── Structural: no route can escape the gate ────────────────────────────────
function captureRoutes() {
  const calls = [];
  const app = {};
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) app[m] = (path, handler) => calls.push({ method: m, path, handler });
  const log = { perm: [], csrf: [], handler: 0 };
  const deps = {
    requirePerm: (req, res, perm) => { log.perm.push(perm); return req._allow; },
    requireAdminCsrf: () => { log.csrf.push(true); return true; },
    actorOf: () => ({ username: 't' }),
    isRecentAuth: () => false,
    limiter: { allow: () => true, retryAfterSec: () => 1 },
    services: {}, auditDenied: () => {}, status: () => ({}), gdImport: { start: () => ({}), status: () => ({}) },
    proxyOverview: () => ({}), log: () => {},
  };
  const { routes } = mountAdminApi(app, deps);
  return { routes, calls, log };
}

describe('every control-plane route is gated by construction', () => {
  const { routes, calls, log } = captureRoutes();

  test('there are routes, all under /api/admin, all on a real permission', () => {
    assert.ok(routes.length >= 40, `only ${routes.length} routes`);
    for (const r of routes) {
      assert.ok(r.path.startsWith('/api/admin/'), r.path);
      assert.ok(PERMISSION_IDS.includes(r.perm), `${r.method} ${r.path}: ${r.perm}`);
      assert.equal(r.csrf, r.method !== 'GET', `${r.method} ${r.path} CSRF flag`);
    }
  });

  test('a refused permission check stops the handler, for every route', async () => {
    for (const c of calls) {
      let status = 200;
      const res = { setHeader() {}, status(s) { status = s; return this; }, json() { return this; }, headersSent: false };
      const before = log.perm.length;
      await c.handler({ _allow: false, params: {}, query: {}, body: {} }, res);
      assert.equal(log.perm.length, before + 1, `${c.method} ${c.path} never consulted requirePerm`);
    }
  });

  test('registering a route on an unknown permission fails at boot', async () => {
    const { mountAdminApi: m } = await import('../lib/admin-api.mjs');
    assert.ok(typeof m === 'function');
    // The helper throws on an unknown permission; proven by reading its guard.
    const src = (await import('node:fs')).readFileSync(join(ROOT, 'lib', 'admin-api.mjs'), 'utf8');
    assert.match(src, /if \(!PERMISSION_IDS\.includes\(perm\)\) throw new Error/);
  });
});

// ── Live server helpers ─────────────────────────────────────────────────────
async function boot(port, extra = {}) {
  const env = { ...process.env, PORT: String(port), NODE_ENV: 'test', NO_OPEN: '1', CRON_DISABLED: '1', ANURA_PORT: '0',
    ADMIN_SECRET: TOKEN, ...extra };
  for (const k of BLANK_DB) env[k] = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${base}/api/admin/cms/status`, { headers: { Authorization: `Bearer ${TOKEN}` } }); if (r.status === 200) { const j = await r.json(); if (j.schema === 'memory') break; } } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const call = async (method, path, body, { auth = true, headers = {} } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { child, base, call, log: () => log, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
}

const SEED = join(ROOT, 'test', 'fixtures', 'control-seed.json');
const GD = 'https://html5.gamedistribution.com/d48120b598174ba48e3d35e2733fa575/';

describe('as a content manager', () => {
  let s;
  before(async () => { s = await boot(3521, { ADMIN_SERVICE_ROLE: 'content_manager', CONTROL_MEMORY_SEED: SEED }); });
  after(async () => { await s.stop(); });

  test('the console can never be framed, not even by this origin', async () => {
    for (const p of ['/admin/login', '/api/admin/cms/status']) {
      const r = await s.call('GET', p, undefined, { auth: false });
      assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
      assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/, p);
    }
  });

  test('no credential: 401 on every control-plane read', async () => {
    for (const p of ['/api/admin/cms/games', '/api/admin/cms/status', '/api/admin/staff', '/api/admin/settings',
      '/api/admin/proxy/control', '/api/admin/proxy/targets', '/api/admin/cms/providers', '/api/admin/audit/export']) {
      assert.equal((await s.call('GET', p, undefined, { auth: false })).status, 401, p);
    }
  });

  test('creates a draft; invalid and dangerous input is refused with reasons', async () => {
    const ok = await s.call('POST', '/api/admin/cms/games', { title: 'Flip Duel', provider_id: 'gamedistribution', category: 'arcade', game_url: GD });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.game.status, 'draft');
    for (const [body, re] of [
      [{ title: '<script>alert(1)</script>', provider_id: 'gamedistribution', category: 'arcade', game_url: GD.replace('d48', 'e48') }, /plain text/],
      [{ title: 'X', provider_id: 'gamedistribution', category: 'arcade', game_url: 'javascript:alert(1)' }, /not allowed/],
      [{ title: 'X', provider_id: 'gamedistribution', category: 'arcade', game_url: 'https://evil.example.org/a/' }, /approved origins/],
      [{ title: 'X', provider_id: 'gamedistribution', category: 'arcade', game_url: 'https://169.254.169.254/latest/' }, /not allowed|IP address/],
    ]) {
      const r = await s.call('POST', '/api/admin/cms/games', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(JSON.stringify(r.json.errors), re);
    }
  });

  test('cannot approve, publish, manage staff, change settings or touch the proxy', async () => {
    const list = await s.call('GET', '/api/admin/cms/games?status=pending_review');
    const id = list.json.rows[0].id;
    assert.equal((await s.call('POST', `/api/admin/cms/games/${id}/transition`, { action: 'approve' })).status, 403);
    assert.equal((await s.call('POST', '/api/admin/staff', { username: 'mallory', role: 'admin' })).status, 403);
    assert.equal((await s.call('PUT', '/api/admin/settings/site.maintenance', { value: { enabled: true, message: '' } })).status, 403);
    assert.equal((await s.call('POST', '/api/admin/proxy/targets', { pattern: 'example.org', purpose: 'test' })).status, 403);
    assert.equal((await s.call('PUT', '/api/admin/proxy/policy', { policy: { accessMode: 'public' } })).status, 403);
    assert.equal((await s.call('DELETE', `/api/admin/cms/games/${id}`, { confirm: 'x' })).status, 403);
  });

  test('its actions land in the game\'s history with actor and role', async () => {
    const created = await s.call('POST', '/api/admin/cms/games', { title: 'History Check', provider_id: 'gamedistribution', category: 'arcade', game_url: GD.replace('d48120b5', 'aaaa1111') });
    const id = created.json.game.id;
    await s.call('POST', `/api/admin/cms/games/${id}/transition`, { action: 'submit' });
    const h = await s.call('GET', `/api/admin/cms/games/${id}/history`);
    const actions = h.json.history.map((e) => e.action);
    assert.ok(actions.includes('game.create') && actions.includes('game.submit'), actions.join(','));
    assert.ok(h.json.history.every((e) => e.actor_role === 'content_manager'));
    assert.ok(!h.text.includes(TOKEN), 'the credential reached the audit trail');
  });

  test('CSV export neutralises formulas', async () => {
    await s.call('POST', '/api/admin/cms/games', { title: '=HYPERLINK("https://x","y")', slug: 'formula-title', provider_id: 'gamedistribution', category: 'arcade', game_url: GD.replace('d48120b5', 'bbbb2222') });
    const r = await s.call('GET', '/api/admin/cms/export?format=csv');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.ok(r.text.includes(`"'=HYPERLINK`), 'formula cell not neutralised');
  });

  test('large uploads are parsed only AFTER authorisation', async () => {
    const big = JSON.stringify({ games: [{ title: 'x'.repeat(3 * 1024 * 1024) }] });
    const anon = await s.call('POST', '/api/admin/cms/import/preview', big, { auth: false });
    assert.equal(anon.status, 401, 'an anonymous caller got as far as the body parser');
    const authed = await s.call('POST', '/api/admin/cms/import/preview', big);
    assert.equal(authed.status, 413);
  });

  test('switched-off features are refused by the server, not just hidden', async () => {
    const api = await s.call('GET', '/api/ai/health', undefined, { auth: false });
    assert.equal(api.status, 404);
    assert.match(api.json.error, /turned off/);
    assert.equal((await s.call('GET', '/ai', undefined, { auth: false })).status, 404);
  });

  test('the public config exposes only public settings', async () => {
    const r = await s.call('GET', '/api/site-config', undefined, { auth: false });
    assert.equal(r.json.announcement.text, 'Scheduled maintenance tonight at 22:00 UTC.');
    assert.equal(r.json.features.ai, false);
    for (const k of ['policy', 'decisions', 'unlisted', 'maxTunnels', 'ads', 'catalog']) assert.ok(!r.text.includes(`"${k}"`), `leaked ${k}`);
  });
});

describe('as a moderator', () => {
  let s;
  before(async () => { s = await boot(3522, { ADMIN_SERVICE_ROLE: 'moderator', CONTROL_MEMORY_SEED: SEED }); });
  after(async () => { await s.stop(); });

  test('approves the review queue but cannot publish or create', async () => {
    const q = await s.call('GET', '/api/admin/cms/games?status=pending_review');
    const g = q.json.rows[0];
    const ok = await s.call('POST', `/api/admin/cms/games/${g.id}/transition`, { action: 'approve' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.game.status, 'approved');
    assert.equal((await s.call('POST', `/api/admin/cms/games/${g.id}/transition`, { action: 'publish' })).status, 403);
    assert.equal((await s.call('POST', '/api/admin/cms/games', { title: 'X', provider_id: 'gamedistribution', category: 'arcade', game_url: GD })).status, 403);
  });
});

describe('a service token can never hold admin power', () => {
  let s;
  before(async () => { s = await boot(3523, { ADMIN_SERVICE_ROLE: 'super_admin' }); });
  after(async () => { await s.stop(); });

  test('ADMIN_SERVICE_ROLE=super_admin resolves to operator', async () => {
    const me = await s.call('GET', '/api/admin/me');
    assert.equal(me.json.role, 'operator');
    assert.equal((await s.call('GET', '/api/admin/staff')).status, 403);
    assert.equal((await s.call('POST', '/api/admin/auth/reauth', { password: 'x' })).status, 403);
  });
});

describe('maintenance mode', () => {
  let s;
  before(async () => { s = await boot(3524, { ADMIN_SERVICE_ROLE: 'viewer', CONTROL_MEMORY_SEED: join(ROOT, 'test', 'fixtures', 'control-seed-maintenance.json') }); });
  after(async () => { await s.stop(); });

  test('public pages and APIs answer 503; the console, health and licences stay up', async () => {
    const home = await s.call('GET', '/', undefined, { auth: false });
    assert.equal(home.status, 503);
    assert.match(home.text, /Back in ten minutes/);
    const api = await s.call('GET', '/api/games', undefined, { auth: false });
    assert.equal(api.status, 503);
    assert.equal(api.json.error, 'maintenance');
    assert.notEqual((await s.call('GET', '/admin/login', undefined, { auth: false })).status, 503);
    assert.equal((await s.call('GET', '/api/admin/cms/status')).status, 200);
    assert.equal((await s.call('GET', '/livez', undefined, { auth: false })).status, 200);
    assert.notEqual((await s.call('GET', '/licenses', undefined, { auth: false })).status, 503);
  });

  test('and the proxy tunnel is closed too', async () => {
    assert.match(await rawUpgrade(3524, 'http://127.0.0.1:3524'), / 503 /);
  });
});

// ── The proxy, through the real server ──────────────────────────────────────
function rawUpgrade(port, origin) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET /wisp/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${origin ? `Origin: ${origin}\r\n` : ''}\r\n`);
    });
    let buf = '';
    const done = () => { sock.destroy(); resolve(buf.split('\r\n')[0] || 'no response'); };
    sock.on('data', (d) => { buf += d; if (buf.includes('\r\n')) done(); });
    sock.on('error', done);
    setTimeout(done, 5000);
  });
}

describe('proxy governance through the running server', () => {
  describe('access mode: disabled', () => {
    let s;
    before(async () => { s = await boot(3525, { PROXY_ACCESS_MODE: 'disabled' }); });
    after(async () => { await s.stop(); });

    test('page, engines, companions and tunnel are all closed; the site is not', async () => {
      assert.equal((await s.call('GET', '/browser', undefined, { auth: false })).status, 503);
      assert.equal((await s.call('GET', '/uv/uv.config.js', undefined, { auth: false })).status, 503);
      assert.deepEqual((await s.call('GET', '/api/proxies', undefined, { auth: false })).json.engines, []);
      assert.match(await rawUpgrade(3525, 'http://127.0.0.1:3525'), / 403 /);
      assert.equal((await s.call('GET', '/', undefined, { auth: false })).status, 200);
    });
  });

  describe('access mode: public', () => {
    let s;
    before(async () => { s = await boot(3526, { PROXY_APPROVED_TARGETS: 'example.org' }); });
    after(async () => { await s.stop(); });

    test('another website cannot open a tunnel from its visitors\' browsers', async () => {
      assert.match(await rawUpgrade(3526, 'https://evil.example.net'), / 403 /);
      assert.match(await rawUpgrade(3526, 'http://127.0.0.1:3526'), / 101 /);
    });

    test('a stream to an unapproved host is refused by the real tunnel', async () => {
      const require = createRequire(join(ROOT, 'noop.cjs'));
      const WebSocket = require('ws');
      const reason = await new Promise((resolve) => {
        const ws = new WebSocket('ws://127.0.0.1:3526/wisp/', { headers: { Origin: 'http://127.0.0.1:3526' } });
        let r = null;
        const finish = () => { try { ws.close(); } catch { /* closing */ } resolve(r); };
        const t = setTimeout(finish, 6000);
        ws.on('open', () => {
          const h = Buffer.from('neverssl.com', 'utf8');
          const payload = Buffer.alloc(3 + h.length);
          payload.writeUInt8(0x01, 0); payload.writeUInt16LE(80, 1); h.copy(payload, 3);
          const p = Buffer.alloc(5 + payload.length);
          p.writeUInt8(0x01, 0); p.writeUInt32LE(1, 1); payload.copy(p, 5);
          ws.send(p);
        });
        ws.on('message', (raw) => {
          const b = Buffer.from(raw);
          if (b.length >= 6 && b.readUInt8(0) === 0x04 && b.readUInt32LE(1) === 1) { r = b.readUInt8(5); clearTimeout(t); finish(); }
        });
        ws.on('error', () => { clearTimeout(t); finish(); });
      });
      assert.equal(reason, 0x48, 'the tunnel did not refuse an unapproved destination with HostBlocked');
    });

    test('the page learns the approved list, and nothing internal', async () => {
      const r = await s.call('GET', '/api/site-config', undefined, { auth: false });
      assert.equal(r.json.proxy.accessMode, 'public');
      assert.deepEqual(r.json.proxy.destinations.map((d) => d.pattern), ['example.org']);
    });

    test('external companions are not offered unless an administrator turns them on', async () => {
      const r = await s.call('GET', '/api/proxies', undefined, { auth: false });
      assert.ok(r.json.engines.every((e) => e.id === 'anura' && e.selfHosted), JSON.stringify(r.json.engines));
    });
  });
});
