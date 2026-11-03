// lib/egress-guard.mjs — the wall under everything: no direct outbound connection
// that is not loopback or an explicitly named infrastructure host.
//
// Two kinds of test. Most run against FAKE net/dgram modules, so the decision
// logic is exercised exhaustively without touching the network. The last group
// installs the guard on the REAL net module and proves the claim that justifies
// putting it there: that node:http, node:https, node:tls and the built-in fetch
// are all stopped by wrapping one method.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import {
  installEgressGuard, egressGuardStats, buildInfraAllowlist, isLoopbackHost, connectTarget,
} from '../lib/egress-guard.mjs';

// A stand-in for node:net that records what the ORIGINAL connect was asked.
function fakeNet() {
  const calls = [];
  class Socket {
    connect(...args) { calls.push(args); return this; }
    destroy(err) { this.destroyedWith = err; return this; }
  }
  return { Socket, calls };
}
function fakeDgram() {
  const calls = [];
  class Socket {
    send(...args) { calls.push(['send', args]); }
    connect(...args) { calls.push(['connect', args]); }
    emit(name, err) { this.emitted = [name, err]; }
  }
  return { Socket, calls };
}

let guard = null;
afterEach(() => { guard?.uninstall(); guard = null; });

const install = (opts = {}) => {
  const n = fakeNet(); const d = fakeDgram();
  const log = [];
  guard = installEgressGuard({
    env: { NODE_ENV: 'test' }, netModule: n, dgramModule: d, log: (m) => log.push(m), ...opts,
  });
  return { n, d, log, sock: () => new n.Socket() };
};
const tick = () => new Promise((r) => setImmediate(r));

// ───────────────────────────────────────────────────────────────────────────
describe('what counts as loopback', () => {
  for (const h of ['localhost', 'LOCALHOST', 'localhost.', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '0.0.0.0', '::',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '', undefined]) {
    test(`${JSON.stringify(h)} is loopback`, () => assert.equal(isLoopbackHost(h), true));
  }
  for (const h of ['93.184.216.34', '10.0.0.5', '192.168.1.1', '169.254.169.254', 'example.com', 'localhost.example.com',
    '127.0.0.1.evil.com', '2606:4700::1111', '::ffff:93.184.216.34', '128.0.0.1']) {
    test(`${JSON.stringify(h)} is NOT loopback`, () => assert.equal(isLoopbackHost(h), false));
  }
});

describe('reading a destination out of net.Socket.connect', () => {
  test('connect(options)', () => assert.deepEqual(connectTarget([{ host: 'a.test', port: 443 }]), { host: 'a.test', port: 443 }));
  test('connect(options) with hostname', () => assert.deepEqual(connectTarget([{ hostname: 'a.test', port: '80' }]), { host: 'a.test', port: 80 }));
  test('connect(port, host)', () => assert.deepEqual(connectTarget([443, 'a.test']), { host: 'a.test', port: 443 }));
  test('connect(port) means localhost', () => assert.deepEqual(connectTarget([8080]), { host: 'localhost', port: 8080 }));
  test('options without a host mean localhost', () => assert.deepEqual(connectTarget([{ port: 80 }]), { host: 'localhost', port: 80 }));
  test("Node's internal normalised [options, cb] form", () =>
    assert.deepEqual(connectTarget([[{ host: 'a.test', port: 1 }, () => {}]]), { host: 'a.test', port: 1 }));
  test('a unix socket path is local', () => {
    assert.deepEqual(connectTarget([{ path: '/tmp/x.sock' }]), { local: true });
    assert.deepEqual(connectTarget(['/tmp/x.sock']), { local: true });
    assert.deepEqual(connectTarget([{ path: '\\\\.\\pipe\\x' }]), { local: true });
  });
  test('something with no destination at all is unclassifiable, not allowed by guesswork', () => {
    assert.equal(connectTarget([{}]), null);
    assert.equal(connectTarget([]), null);
  });
});

describe('the infrastructure allowlist comes from the environment', () => {
  test('a database host, a cache host, a mail provider, a swap provider, companions', () => {
    const hosts = buildInfraAllowlist({
      SUPABASE_URL: 'https://abcd1234.supabase.co',
      REDIS_URL: 'rediss://default:hunter2@cache.example.net:6380',
      RESEND_API_KEY: 're_123',
      SWAP_PROVIDER: 'sideshift',
      PROXY_NAUTILUS_URL: 'https://nautilus.example.org/app',
      PROXY_KASM_URL: 'https://kasm.example.org:8443',
      SINGBOX_API_URL: 'http://127.0.0.1:9090',
    });
    for (const h of ['abcd1234.supabase.co', 'cache.example.net', 'api.resend.com', 'sideshift.ai',
      'nautilus.example.org', 'kasm.example.org', '127.0.0.1']) {
      assert.ok(hosts.includes(h), `${h} missing from ${JSON.stringify(hosts)}`);
    }
  });

  test('a connection string contributes its HOST only, never its credentials', () => {
    const blob = JSON.stringify(buildInfraAllowlist({ REDIS_URL: 'rediss://default:hunter2@cache.example.net:6380' }));
    assert.ok(!blob.includes('hunter2'), 'a password leaked into the allowlist');
    assert.ok(!blob.includes('default'), 'a username leaked into the allowlist');
  });

  test('nothing unconfigured is reachable: no key means no mail provider, no swap provider', () => {
    const hosts = buildInfraAllowlist({});
    assert.deepEqual(hosts, []);
    assert.ok(!buildInfraAllowlist({ RESEND_API_KEY: '   ' }).includes('api.resend.com'));
    assert.ok(!buildInfraAllowlist({ SWAP_PROVIDER: 'somebody-else' }).includes('sideshift.ai'));
  });

  test('EGRESS_DIRECT_ALLOW adds hosts, trimmed and lowercased', () => {
    assert.deepEqual(buildInfraAllowlist({ EGRESS_DIRECT_ALLOW: ' DB.Internal.Example , *.metrics.example,, ' }),
      ['*.metrics.example', 'db.internal.example']);
  });

  test('a non-default SOCKS inbound host is allowed, so the daemon is never locked out', () => {
    assert.ok(buildInfraAllowlist({ SINGBOX_SOCKS: '10.1.2.3:1080' }).includes('10.1.2.3'));
  });

  test('garbage in the environment does not throw', () => {
    assert.doesNotThrow(() => buildInfraAllowlist({ SUPABASE_URL: 'not a url', REDIS_URL: '%%%', PROXY_KASM_URL: '::' }));
  });
});

describe('enforce mode', () => {
  test('loopback passes straight through to the real connect', () => {
    const { n, sock } = install();
    sock().connect({ host: '127.0.0.1', port: 2080 });
    sock().connect(9090, 'localhost');
    assert.equal(n.calls.length, 2);
    assert.equal(guard.stats().blocked, 0);
  });

  test('a unix socket passes', () => {
    const { n, sock } = install();
    sock().connect({ path: '/var/run/x.sock' });
    assert.equal(n.calls.length, 1);
  });

  test('an arbitrary public host is REFUSED asynchronously, with a coded error, and never connects', async () => {
    const { n, sock } = install();
    const s = sock();
    const ret = s.connect({ host: '93.184.216.34', port: 443 });
    assert.equal(ret, s, 'connect() must return the socket, as the real one does');
    assert.equal(n.calls.length, 0, 'the real connect was reached');
    assert.equal(s.destroyedWith, undefined, 'the error must arrive asynchronously, after the caller attached a handler');
    await tick();
    assert.equal(s.destroyedWith.code, 'EEGRESS_BLOCKED');
    assert.match(s.destroyedWith.message, /sing-box/);
    assert.equal(guard.stats().blocked, 1);
  });

  test('private addresses are refused too: the guard is not an SSRF allowlist in reverse', () => {
    const { n, sock } = install();
    for (const h of ['10.0.0.5', '192.168.0.1', '169.254.169.254', '172.16.0.9']) sock().connect({ host: h, port: 80 });
    assert.equal(n.calls.length, 0);
    assert.equal(guard.stats().blocked, 4);
  });

  test('a named infrastructure host passes; its neighbours do not', () => {
    const { n, sock } = install({ allow: ['abcd.supabase.co', '*.metrics.example'] });
    sock().connect({ host: 'abcd.supabase.co', port: 443 });
    sock().connect({ host: 'ABCD.supabase.co.', port: 443 });
    sock().connect({ host: 'a.b.metrics.example', port: 443 });
    assert.equal(n.calls.length, 3);
    sock().connect({ host: 'other.supabase.co', port: 443 });          // a different project
    sock().connect({ host: 'metrics.example', port: 443 });            // the apex of a wildcard
    sock().connect({ host: 'evilabcd.supabase.co', port: 443 });       // a suffix trick
    sock().connect({ host: 'abcd.supabase.co.evil.test', port: 443 }); // a prefix trick
    assert.equal(n.calls.length, 3, 'a near-miss was let through');
    assert.equal(guard.stats().blocked, 4);
  });

  test('statistics name hosts and counts, never anything else', () => {
    const { sock } = install({ allow: [] });
    for (let i = 0; i < 3; i++) sock().connect({ host: 'tracker.example', port: 443 });
    sock().connect({ host: 'other.example', port: 80 });
    const st = guard.stats();
    assert.equal(st.byHost['tracker.example'], 3);
    assert.equal(st.byHost['other.example'], 1);
    assert.equal(st.lastBlocked.host, 'other.example');
    assert.equal(st.lastBlocked.port, 80);
    assert.equal(st.lastBlocked.enforced, true);
    assert.ok(!JSON.stringify(st).match(/password|secret|token/i));
  });

  test('the allowlist is reported, so an operator can see what is reachable directly', () => {
    install({ allow: ['abcd.supabase.co'] });
    assert.deepEqual(guard.stats().directAllowlist, ['abcd.supabase.co']);
  });

  test('a loop cannot flood the log: one line per host per minute, but every refusal is counted', () => {
    const { sock, log } = install({ allow: [] });
    for (let i = 0; i < 50; i++) sock().connect({ host: 'spam.example', port: 443 });
    assert.equal(log.length, 1);
    assert.match(log[0], /BLOCKED direct tcp connection to spam\.example:443/);
    assert.equal(guard.stats().blocked, 50);
  });

  test('the observer hears every refusal and cannot veto or break one', () => {
    const seen = [];
    const { n, sock } = install({ allow: [], onBlock: (i) => { seen.push(i.host); throw new Error('observer exploded'); } });
    assert.doesNotThrow(() => sock().connect({ host: 'x.example', port: 1 }));
    assert.deepEqual(seen, ['x.example']);
    assert.equal(n.calls.length, 0, 'a throwing observer let the connection through');
  });

  test('the origin of a refusal is the file that asked, not Node or the guard', () => {
    const { sock } = install({ allow: [] });
    sock().connect({ host: 'x.example', port: 1 });
    const origin = guard.stats().lastBlocked.origin;
    assert.ok(origin, 'no origin recorded');
    assert.match(origin, /egress-guard\.test\.mjs/);
    assert.doesNotMatch(origin, /node:/);
  });

  test('installing twice returns the same guard', () => {
    const a = install().n;
    const again = installEgressGuard({ env: { NODE_ENV: 'test' }, netModule: fakeNet(), dgramModule: fakeDgram() });
    assert.equal(again, guard);
    assert.ok(a);
  });

  test('uninstall restores the original connect exactly', () => {
    const n = fakeNet(); const d = fakeDgram();
    const before = n.Socket.prototype.connect;
    guard = installEgressGuard({ env: { NODE_ENV: 'test' }, netModule: n, dgramModule: d, log: () => {} });
    assert.notEqual(n.Socket.prototype.connect, before);
    guard.uninstall(); guard = null;
    assert.equal(n.Socket.prototype.connect, before);
  });
});

describe('UDP', () => {
  test('a datagram to a public host is refused; loopback is not', async () => {
    const { d } = install({ allow: [] });
    const s = new d.Socket();
    s.send(Buffer.from('x'), 53, '8.8.8.8');
    s.send(Buffer.from('x'), 0, 1, 53, '8.8.4.4');                 // the offset/length form
    s.send(Buffer.from('x'), 8125, '127.0.0.1');
    await tick();
    assert.equal(d.calls.length, 1, 'only the loopback datagram may be sent');
    assert.equal(guard.stats().blocked, 2);
  });

  test('the refusal reaches the send callback when there is one', async () => {
    const { d } = install({ allow: [] });
    let got;
    new d.Socket().send(Buffer.from('x'), 53, '8.8.8.8', (e) => { got = e; });
    await tick();
    assert.equal(got.code, 'EEGRESS_BLOCKED');
  });

  test('dgram connect() to a public host is refused', async () => {
    const { d } = install({ allow: [] });
    const s = new d.Socket();
    s.connect(53, '8.8.8.8');
    await tick();
    assert.equal(d.calls.length, 0);
    assert.equal(s.emitted[1].code, 'EEGRESS_BLOCKED');
  });
});

describe('modes', () => {
  test('warn: allowed through but counted and logged as "would block" (a developer opt-out)', () => {
    const { n, sock, log } = install({ allow: [], mode: 'warn' });
    sock().connect({ host: '93.184.216.34', port: 80 });
    assert.equal(n.calls.length, 1, 'warn mode must not refuse');
    const st = guard.stats();
    assert.equal(st.blocked, 0);
    assert.equal(st.warned, 1);
    assert.equal(st.lastBlocked.enforced, false);
    assert.match(log[0], /WOULD BLOCK/);
  });

  test('a developer who permits direct egress gets warn by default, so bypasses are still visible', () => {
    const n = fakeNet();
    guard = installEgressGuard({
      env: { NODE_ENV: 'development', SINGBOX_ALLOW_DIRECT: '1' }, netModule: n, dgramModule: fakeDgram(), log: () => {},
    });
    assert.equal(guard.mode, 'warn');
  });

  test('the default, with nothing set, is enforce', () => {
    guard = installEgressGuard({ env: {}, netModule: fakeNet(), dgramModule: fakeDgram(), log: () => {} });
    assert.equal(guard.mode, 'enforce');
  });

  test('a developer can turn the guard off with EGRESS_GUARD=off', () => {
    const n = fakeNet();
    const before = n.Socket.prototype.connect;
    guard = installEgressGuard({
      env: { NODE_ENV: 'development', EGRESS_GUARD: 'off' }, netModule: n, dgramModule: fakeDgram(), log: () => {},
    });
    assert.equal(guard.mode, 'off');
    assert.equal(n.Socket.prototype.connect, before, 'an off guard must not wrap anything');
    assert.equal(guard.stats().installed, false);
  });

  for (const attempt of [{ mode: 'off' }, { mode: 'warn' }, { env: { NODE_ENV: 'production', EGRESS_GUARD: 'off' } },
    { env: { NODE_ENV: 'production', EGRESS_GUARD: 'warn', SINGBOX_ALLOW_DIRECT: '1' } }]) {
    test(`production is ALWAYS enforce: ${JSON.stringify(attempt)}`, () => {
      const n = fakeNet(); const sock = new n.Socket();
      guard = installEgressGuard({
        netModule: n, dgramModule: fakeDgram(), allow: [], log: () => {},
        ...attempt, env: { NODE_ENV: 'production', ...(attempt.env || {}) },
      });
      assert.equal(guard.mode, 'enforce');
      sock.connect({ host: '93.184.216.34', port: 80 });
      assert.equal(n.calls.length, 0, 'production let a direct connection through');
    });
  }
});

describe('on the REAL net module, every client is stopped by the one wrapper', () => {
  function realGuard() {
    const log = [];
    guard = installEgressGuard({ env: { NODE_ENV: 'test' }, allow: [], log: (m) => log.push(m) });
    return log;
  }

  test('net.connect', async () => {
    realGuard();
    const err = await new Promise((resolve) => { const s = net.connect({ host: '93.184.216.34', port: 80 }); s.on('error', resolve); s.on('connect', () => resolve(null)); });
    assert.equal(err?.code, 'EEGRESS_BLOCKED');
  });

  test('node:http', async () => {
    realGuard();
    const err = await new Promise((resolve) => { http.get('http://93.184.216.34/', () => resolve(null)).on('error', resolve); });
    assert.equal(err?.code, 'EEGRESS_BLOCKED');
  });

  test('node:https', async () => {
    realGuard();
    const err = await new Promise((resolve) => { https.get('https://93.184.216.34/', () => resolve(null)).on('error', resolve); });
    assert.equal(err?.code, 'EEGRESS_BLOCKED');
  });

  test('node:tls', async () => {
    realGuard();
    const err = await new Promise((resolve) => { const s = tls.connect({ host: '93.184.216.34', port: 443 }); s.on('error', resolve); s.on('secureConnect', () => resolve(null)); });
    assert.equal(err?.code, 'EEGRESS_BLOCKED');
  });

  test('the built-in fetch (undici)', async () => {
    realGuard();
    await assert.rejects(fetch('http://93.184.216.34/', { signal: AbortSignal.timeout(3000) }),
      (e) => e.cause?.code === 'EEGRESS_BLOCKED' || /EEGRESS_BLOCKED/.test(String(e.cause?.message || e.message)));
  });

  test('loopback still works end to end under the guard', async () => {
    realGuard();
    const srv = http.createServer((_q, r) => r.end('local ok'));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const body = await (await fetch(`http://127.0.0.1:${srv.address().port}/`)).text();
      assert.equal(body, 'local ok');
      assert.equal(guard.stats().blocked, 0);
    } finally { await new Promise((r) => srv.close(r)); }
  });

  test('egressGuardStats() reflects the installed guard, and is honest when there is none', () => {
    assert.equal(egressGuardStats().installed, false);
    realGuard();
    assert.equal(egressGuardStats().installed, true);
    assert.equal(egressGuardStats().mode, 'enforce');
    guard.uninstall(); guard = null;
    assert.equal(egressGuardStats().installed, false);
  });
});
