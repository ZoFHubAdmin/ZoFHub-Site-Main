// The sing-box adapter.
//
// sing-box is an OPTIONAL, externally-run GPL-3.0 daemon. ZoFHub reads its
// Clash-compatible management API and nothing more — it does not bundle, build,
// start or derive from it.
//
// ── THE BUG THIS SUITE EXISTS TO PREVENT ───────────────────────────────────
// A telemetry panel pointed at a daemon that is not running renders zeroes, and
// zeroes read as "up, no traffic" when the truth is "there is no such service".
// That is worse than having no panel, because it looks like a working monitor.
// So every failure path must return `reachable:false` and must NOT carry
// live/uploadBytes/downloadBytes at all.
//
// Pure: `fetchImpl` is injected, so nothing here opens a socket.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { singboxTelemetry, singboxConfigured } from '../lib/singbox.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV = { SINGBOX_API_URL: 'http://127.0.0.1:9090', SINGBOX_API_SECRET: 's' };

/** A fetch stand-in that answers however the test needs. */
const jsonOk = (body) => async () => ({ ok: true, status: 200, json: async () => body });
const status = (code) => async () => ({ ok: false, status: code, json: async () => ({}) });
const boom = (name) => async () => { const e = new Error('nope'); e.name = name; throw e; };

// The stats fields that must NEVER appear on a failure.
const STAT_FIELDS = ['live', 'uploadBytes', 'downloadBytes', 'memoryBytes'];

describe('configuration', () => {
  test('unset is a first-class, non-error state', async () => {
    assert.equal(singboxConfigured({}), false);
    const r = await singboxTelemetry({}, { fetchImpl: boom('Error') });
    assert.deepEqual(r, { reachable: false, configured: false, reason: 'not-configured' });
  });

  test('an unset URL never even attempts a request', async () => {
    let called = false;
    await singboxTelemetry({}, { fetchImpl: async () => { called = true; } });
    assert.equal(called, false, 'the adapter called fetch with no URL configured');
  });

  test('a trailing slash on the URL does not produce a double slash', async () => {
    let seen = '';
    await singboxTelemetry(
      { SINGBOX_API_URL: 'http://127.0.0.1:9090/' },
      { fetchImpl: async (u) => { seen = u; return { ok: true, status: 200, json: async () => ({}) }; } },
    );
    assert.equal(seen, 'http://127.0.0.1:9090/connections');
  });
});

describe('a reachable daemon', () => {
  const BODY = {
    uploadTotal: 12345678,
    downloadTotal: 98765432,
    memory: 41943040,
    connections: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  };

  test('reports live connections and cumulative bytes', async () => {
    const r = await singboxTelemetry(ENV, { fetchImpl: jsonOk(BODY) });
    assert.equal(r.reachable, true);
    assert.equal(r.configured, true);
    assert.equal(r.live, 3);
    assert.equal(r.uploadBytes, 12345678);
    assert.equal(r.downloadBytes, 98765432);
    assert.equal(r.memoryBytes, 41943040);
  });

  test('sends the secret as a bearer token', async () => {
    let headers = null;
    await singboxTelemetry(ENV, {
      fetchImpl: async (_u, init) => { headers = init.headers; return { ok: true, status: 200, json: async () => ({}) }; },
    });
    assert.equal(headers.authorization, 'Bearer s');
  });

  test('a missing secret sends no authorization header at all', async () => {
    // Loopback with no secret is a legitimate sing-box setup; sending
    // "Bearer undefined" would be rejected by a daemon that expects none.
    let headers = null;
    await singboxTelemetry({ SINGBOX_API_URL: ENV.SINGBOX_API_URL }, {
      fetchImpl: async (_u, init) => { headers = init.headers; return { ok: true, status: 200, json: async () => ({}) }; },
    });
    assert.equal(headers.authorization, undefined);
  });

  test('a malformed but successful body degrades to zeros, not NaN', async () => {
    // A 200 that is not the shape we expect is still "reachable" — the daemon
    // answered. But NaN in a dashboard is worse than 0, and `undefined.length`
    // would throw and take the whole /api/admin/proxy response down.
    const r = await singboxTelemetry(ENV, { fetchImpl: jsonOk({ connections: 'not-an-array' }) });
    assert.equal(r.reachable, true);
    assert.equal(r.live, 0);
    for (const f of STAT_FIELDS) assert.ok(Number.isFinite(r[f]), `${f} is not a finite number`);
  });
});

describe('failure is always honest', () => {
  const CASES = [
    ['a dead daemon', boom('TypeError'), 'unreachable'],
    ['a timeout', boom('AbortError'), 'timeout'],
    ['a wrong secret (401)', status(401), 'unauthorized'],
    ['a forbidden secret (403)', status(403), 'unauthorized'],
    ['a server error (500)', status(500), 'http-500'],
    ['a wrong path (404)', status(404), 'http-404'],
    ['a non-JSON body', async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } }), 'bad-response'],
  ];

  for (const [label, fetchImpl, reason] of CASES) {
    test(`${label} reports reachable:false with reason "${reason}"`, async () => {
      const r = await singboxTelemetry(ENV, { fetchImpl });
      assert.equal(r.reachable, false);
      assert.equal(r.configured, true);
      assert.equal(r.reason, reason);
    });

    test(`${label} carries NO stats that could read as "idle"`, async () => {
      // The whole point. A dashboard must be unable to render 0 connections /
      // 0 bytes for a daemon that never answered.
      const r = await singboxTelemetry(ENV, { fetchImpl });
      for (const f of STAT_FIELDS) {
        assert.equal(r[f], undefined, `a failure carried ${f} — it can render as "up but idle"`);
      }
    });
  }

  test('it never rejects, whatever fetch does', async () => {
    // /api/admin/proxy awaits this inline. One dead daemon must not be able to
    // take down the whole proxy telemetry endpoint.
    for (const impl of [boom('Error'), async () => { throw 'a string, not an Error'; }, async () => null]) {
      await assert.doesNotReject(() => singboxTelemetry(ENV, { fetchImpl: impl }));
    }
  });
});

describe('it is wired in, and wired in safely', () => {
  const server = readFileSync(join(ROOT, 'server.js'), 'utf8');

  test('/api/admin/proxy actually reports it', () => {
    assert.match(server, /singboxTelemetry/, 'server.js never calls the adapter');
    const at = server.indexOf("app.get('/api/admin/proxy'");
    assert.notEqual(at, -1);
    const body = server.slice(at, at + 1600);
    assert.match(body, /await singboxTelemetry\(\)/, 'the endpoint does not await the adapter');
    assert.match(body, /\bsingbox,/, 'the endpoint does not include the singbox block');
    assert.match(body, /requirePerm\(req, res, 'telemetry\.read'\)/, 'the endpoint is not permission-gated');
  });

  test('the adapter never returns the URL or the secret', () => {
    // This object is embedded verbatim in /api/admin/proxy, which the browser
    // reads. Asserted on VALUES, not on field names: the console legitimately
    // NAMES these variables in its help text ("SINGBOX_API_SECRET is wrong or
    // missing"), and a substring check for the name only tests the test.
    const URL_V = 'http://10.1.2.3:9090';
    const SECRET_V = 'sb-secret-DO-NOT-LEAK-42';
    const results = [];
    for (const impl of [
      async () => ({ ok: true, status: 200, json: async () => ({ connections: [] }) }),
      async () => ({ ok: false, status: 401, json: async () => ({}) }),
      async () => { throw new Error('down'); },
    ]) {
      results.push(singboxTelemetry(
        { SINGBOX_API_URL: URL_V, SINGBOX_API_SECRET: SECRET_V }, { fetchImpl: impl },
      ));
    }
    return Promise.all(results).then((all) => {
      for (const r of all) {
        const json = JSON.stringify(r);
        assert.ok(!json.includes(SECRET_V), `the adapter leaked the API secret: ${json}`);
        assert.ok(!json.includes(URL_V), `the adapter leaked the API URL: ${json}`);
      }
    });
  });

  test('the admin console never calls the management API itself', () => {
    // It is a loopback admin surface: reaching it means rewriting routing and
    // enumerating every live connection. The console must only ever read
    // ZoFHub's own /api/admin/proxy.
    const ui = readFileSync(join(ROOT, 'admin-ui', 'assets', 'admin.js'), 'utf8');
    assert.ok(!/fetch\([^)]*9090/.test(ui), 'the admin console fetches the Clash API directly');
    assert.ok(!/new WebSocket\([^)]*9090/.test(ui), 'the admin console opens a socket to the Clash API');
    assert.match(ui, /api\('\/api\/admin\/proxy'\)/,
      'the console should read sing-box through ZoFHub, not directly');
  });

  // EVERY shipped profile, not just the default one. The REALITY profile is the
  // one nobody looks at until the day they deploy it, which is exactly how a
  // second config ends up being the way in.
  const PROFILES = ['config.template.json', 'config.reality.template.json'];

  // What a tunnelled client must never be able to reach through the daemon:
  // the management API and the web server on loopback, the cloud metadata
  // endpoint that hands out credentials, and whatever else shares the host's
  // private network.
  const MUST_REJECT = [
    '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
    '169.254.0.0/16', '100.64.0.0/10', '0.0.0.0/8',
    '::1/128', 'fc00::/7', 'fe80::/10',
  ];

  for (const file of PROFILES) {
    test(`${file} is valid JSON, binds the API to loopback, and rejects private ranges`, () => {
      const cfg = JSON.parse(readFileSync(join(ROOT, 'deploy', 'singbox', file), 'utf8'));

      const controller = cfg.experimental.clash_api.external_controller;
      assert.match(controller, /^127\.0\.0\.1:/,
        `the management API is bound to ${controller} — it must be loopback-only`);

      // ASSERT THE PROPERTY, NOT ONE SPELLING OF IT. sing-box removed the
      // `block` outbound type after 1.11 and replaced it with a route
      // `action: "reject"`. The first version of this test looked only for
      // `outbound: "block"`, so it failed the CORRECT modern config and would
      // have passed a config that no current sing-box can even load.
      const rejecting = cfg.route.rules.filter(r => r.action === 'reject' || r.outbound === 'block');
      const covered = new Set(rejecting.flatMap(r => r.ip_cidr || []));
      for (const cidr of MUST_REJECT) {
        assert.ok(covered.has(cidr),
          `${file} lets a tunnelled client reach ${cidr} — every profile must reject the same ranges`);
      }

      // A `block` outbound is not merely legacy: `sing-box check` rejects it, so
      // the supervisor would refuse to start and managed mode would never come up.
      assert.ok(!(cfg.outbounds || []).some(o => o.type === 'block'),
        `${file} declares a "block" outbound, removed after sing-box 1.11 — it will fail \`sing-box check\``);
    });
  }

  test('no sing-box source or binary is vendored into this repo', () => {
    // The integration is over a network API on purpose: that is what keeps
    // sing-box a separate program rather than something this codebase derives
    // from. Vendoring it would change that analysis entirely.
    const cfg = readFileSync(join(ROOT, 'deploy', 'singbox', 'docker-compose.yml'), 'utf8');
    assert.match(cfg, /image:\s*ghcr\.io\/sagernet\/sing-box/,
      'sing-box should run as its own upstream image, not be built here');
    assert.ok(!/build:\s*\.\/singbox/.test(cfg), 'the compose file builds sing-box from source');
  });
});
