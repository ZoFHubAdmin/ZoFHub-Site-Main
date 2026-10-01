// test/resource-guard.test.mjs — the guard that restarts the container before
// the OOM killer does.
// ---------------------------------------------------------------------------
// The failure this prevents is specific. A long proxy video session or a heavy
// gameplay run grows RSS; the container hits its cgroup limit; the kernel kills
// the process mid-request. Every open Wisp tunnel drops at once and the restart
// is ungraceful.
//
// The defence is a probe that turns unhealthy BEFORE that point, so the platform
// rolls the container while it can still finish what it is doing. That only
// works if three things line up, and for a long time the third did not:
//
//   1. a ceiling that reflects the CONTAINER, not the host's total RAM
//   2. a route that returns a FAILING status when the ceiling is approached
//   3. the platform actually PROBING that route
//
// (3) was wired to /api/health, which always answers 200 no matter how close to
// death the process is — so the ceiling was computed, displayed in the admin
// console, and acted upon by nobody. These tests pin all three together,
// because any one of them alone is inert.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const server = readFileSync(join(ROOT, 'server.js'), 'utf8');

describe('the platform probes the route that can actually fail', () => {
  test('render.yaml health check points at /healthz', () => {
    const yaml = readFileSync(join(ROOT, 'render.yaml'), 'utf8');
    const m = /^\s*healthCheckPath:\s*(\S+)/m.exec(yaml);
    assert.ok(m, 'render.yaml declares no healthCheckPath at all');
    assert.equal(m[1], '/healthz',
      `health check probes ${m[1]}, which cannot report memory pressure — '
      + 'the restart guard would never fire`);
  });

  test('/api/health is NOT the probe, because it always answers ok', () => {
    // Asserting the reason, not just the setting. /api/health reports liveness
    // and runs a live Supabase check; using it as the probe would also let a
    // third party's outage restart a healthy container.
    const route = server.slice(server.indexOf("app.get('/api/health'"));
    const body = route.slice(0, route.indexOf('});'));
    assert.ok(!/res\.status\(503\)/.test(body),
      '/api/health now returns 503 — if it gained a memory gate, revisit this');
  });
});

describe('the ceiling is the container, and the default is 85%', () => {
  test('the documented default is 85%', () => {
    assert.match(server, /raw > 0 && raw <= 100 \? raw : 85/,
      'HEALTH_MEM_MAX_PCT no longer defaults to 85%');
  });

  test('an out-of-range setting falls back rather than disabling the check', () => {
    // 0 would mean "always unhealthy" and 200 would mean "never" — both are
    // typos, and neither should silently become policy.
    const block = server.slice(server.indexOf('const HEALTH_MEM_MAX_PCT'));
    assert.match(block.slice(0, 600), /Number\.isFinite\(raw\) && raw > 0 && raw <= 100/);
  });

  test('both RSS-against-cgroup and V8 heap are considered, worst wins', () => {
    // Either one alone hides a real death: the heap can look fine while the
    // container's RSS limit is hit, and vice versa.
    const fn = server.slice(server.indexOf('function memoryReport'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /rssPct/, 'RSS is not measured');
    assert.match(body, /heapPct/, 'V8 heap is not measured');
    assert.match(body, /Math\.max\(rssPct, heapPct\)/, 'the reported figure is not the worse of the two');
  });

  test('a cgroup "unlimited" sentinel is not mistaken for a real limit', () => {
    // v2 writes "max", v1 writes a number near 2^63. Read naively, either makes
    // RSS permanently 0% of the ceiling and the guard never fires.
    const block = server.slice(server.indexOf('const CONTAINER_MEM_LIMIT'));
    assert.match(block.slice(0, 800), /raw === 'max'/, 'cgroup v2 "max" is not handled');
    assert.match(block.slice(0, 800), /n <= totalmem\(\)/, 'the cgroup v1 sentinel is not rejected');
  });
});

describe('the catalog stays in memory and refreshes on a timer', () => {
  test('refresh is every 30 minutes, not per request', () => {
    assert.match(server, /CATALOG_REFRESH_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/,
      'the catalog refresh interval is no longer 30 minutes');
  });

  test('a failed refresh keeps the catalog already in memory', () => {
    // The dangerous shape is a refresh that empties CATALOG on a Supabase blip:
    // the homepage goes blank because a background job failed.
    const fn = server.slice(server.indexOf('async function refreshCatalogFromSupabase'));
    assert.match(fn.slice(0, 2500), /return false|catch/,
      'refreshCatalogFromSupabase has no failure path that preserves the old catalog');
  });

  test('reads are served from memory, not a query per visitor', () => {
    // The whole point: the AI Vibe Finder can scan the catalog without putting
    // a query on the connection pool for every request.
    assert.match(server, /rows = CATALOG\.games/,
      'catalog reads no longer come from the in-memory copy');
  });
});

describe('the Wisp tunnel reclaims what it opens', () => {
  test('idle tunnels are closed on a timer', () => {
    assert.match(server, /WISP_IDLE_MS/, 'no idle timeout for proxy tunnels');
    assert.match(server, /WISP_KEEPALIVE_MS/, 'no keepalive, so idle cannot be distinguished from dead');
  });

  test('there is a global cap and a per-client cap', () => {
    // One client must not be able to exhaust the tunnel budget for everyone.
    assert.match(server, /WISP_MAX_TUNNELS/, 'no global tunnel cap');
    assert.match(server, /WISP_MAX_PER_IP/, 'no per-client tunnel cap');
    // Refusals go through refuseUpgrade(), which writes a real status line so a
    // client can back off instead of retrying a bare RST forever. Both the
    // helper's status line AND each cap's use of it are pinned.
    assert.match(server, /function refuseUpgrade\(socket, status, text\)[\s\S]{0,400}HTTP\/1\.1 \$\{status\} \$\{text\}/,
      'refuseUpgrade no longer writes an HTTP status line');
    assert.match(server, /WISP_MAX_TUNNELS\) \{[^}]*refuseUpgrade\(socket, 503, 'Service Unavailable'\)/, 'a refused tunnel gets no answer');
    assert.match(server, /WISP_MAX_PER_IP\) \{[^}]*refuseUpgrade\(socket, 429, 'Too Many Requests'\)/, 'a per-client refusal gets no answer');
  });

  test('a closed tunnel gives its slot back', () => {
    // The key is stored ON the socket because the request headers may be gone
    // by close time — reading req again there would decrement the wrong bucket
    // and leak capacity until restart.
    assert.match(server, /socket\._wispIpKey/, 'the per-client bucket cannot be decremented on close');
  });
});

// ── Live behaviour ─────────────────────────────────────────────────────────
describe('/healthz answers what an orchestrator can act on', () => {
  const PORT = 8534;
  let srv;

  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });

  before(async () => {
    const env = { ...process.env };
    try {
      for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
        if (m && !env[m[1]]) env[m[1]] = m[2];
      }
    } catch { /* optional */ }
    srv = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, PORT: String(PORT), NO_OPEN: '1', CRON_DISABLED: '1', NODE_ENV: 'test' },
    });
    srv.stdout.resume(); srv.stderr.resume();
    for (let i = 0; i < 120; i++) {
      try { if ((await get('/healthz')).status) return; } catch { /* booting */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('server did not start');
  });

  after(() => { try { srv?.kill('SIGKILL'); } catch { /* gone */ } });

  test('a healthy process answers 200 with a verdict and no numbers', () => {
    // The verdict is unauthenticated on purpose — a probe cannot present a
    // token, and a probe that always 401s can never trigger the restart it
    // exists to trigger.
    return get('/healthz').then(({ status, body }) => {
      assert.equal(status, 200);
      const json = JSON.parse(body);
      assert.equal(json.ok, true);
      assert.equal(json.status, 'ok');
      // No memory figures, uptime or job names to an anonymous caller.
      assert.equal(json.memory, undefined, '/healthz leaks memory figures anonymously');
      assert.equal(json.uptime, undefined, '/healthz leaks uptime anonymously');
      assert.equal(json.cron, undefined, '/healthz leaks job names anonymously');
    });
  });

  test('HEAD carries the same verdict, for probes that use it', async () => {
    const { status } = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: PORT, path: '/healthz', method: 'HEAD' },
        (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 200);
  });

  test('the threshold is what decides, proven by moving it', async () => {
    // The only honest way to show the gate works without manufacturing an OOM:
    // set the ceiling below current usage and watch the SAME route flip to 503.
    const env = { ...process.env, PORT: '8535', NO_OPEN: '1', CRON_DISABLED: '1', NODE_ENV: 'test' };
    try {
      for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
        if (m && !env[m[1]]) env[m[1]] = m[2];
      }
    } catch { /* optional */ }
    env.HEALTH_MEM_MAX_PCT = '0.0001';   // any live process is over this
    // A breach must now persist for HEALTH_SUSTAIN_MS before the verdict flips
    // (so a GC spike cannot recycle a healthy instance). Zero here keeps this
    // test about the THRESHOLD; the sustain window has its own test.
    env.HEALTH_SUSTAIN_MS = '0';

    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    child.stdout.resume(); child.stderr.resume();
    try {
      let res = null;
      for (let i = 0; i < 120; i++) {
        try {
          res = await new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port: 8535, path: '/healthz' }, (r) => {
              let b = ''; r.setEncoding('utf8');
              r.on('data', (c) => { b += c; });
              r.on('end', () => resolve({ status: r.statusCode, body: b }));
            });
            req.on('error', reject);
            req.setTimeout(3000, () => req.destroy(new Error('timeout')));
            req.end();
          });
          break;
        } catch { await new Promise((r) => setTimeout(r, 500)); }
      }
      assert.ok(res, 'the low-ceiling server never answered');
      assert.equal(res.status, 503,
        'memory above the ceiling did not produce a failing status — nothing would restart');
      const json = JSON.parse(res.body);
      assert.equal(json.ok, false);
      assert.equal(json.status, 'degraded');
    } finally {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  });
});
