// lib/egress.mjs — server-side fetches cross sing-box, and only sing-box.
// ---------------------------------------------------------------------------
// Real sockets, no mocks of our own code. The "daemon" below is a genuine SOCKS5
// server that, like sing-box, dials the destination on the client's behalf — here
// always a local origin standing in for the internet. That lets the tests assert
// the things that actually matter:
//   * what the daemon was ASKED for (the validated address, never the hostname),
//   * that the origin was reached THROUGH it, and
//   * that when it cannot be reached nothing connects directly instead.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEgress } from '../lib/egress.mjs';
import { safeFetch, isPublicAddress, guardedLookup, BlockedDestinationError } from '../lib/safe-fetch.mjs';
import { EgressUnavailableError } from '../lib/egress-policy.mjs';
import {
  openSingboxTunnel, waitForSingbox, egressStats, _resetEgressStats,
} from '../lib/singbox-socket.mjs';

const PUBLIC_A = '93.184.216.34';      // documentation-era public addresses; never actually dialled
const PUBLIC_B = '151.101.1.69';

// ── Harness ────────────────────────────────────────────────────────────────
function shutdown(srv, live) {
  return new Promise((resolve) => { for (const s of live) s.destroy(); srv.close(resolve); });
}

/**
 * A SOCKS5 daemon that RELAYS: it records what each client asked to CONNECT to,
 * then dials `target` (the local origin) and pipes. `replyFor(request, index)`
 * returns a SOCKS reply code (0 = success) so a test can make it refuse.
 */
function startDaemon({ target, replyFor = () => 0x00 }) {
  const requests = [];
  const live = new Set();
  const srv = net.createServer((client) => {
    live.add(client);
    client.on('close', () => live.delete(client));
    client.on('error', () => {});
    let stage = 'greet';
    let buf = Buffer.alloc(0);
    client.on('data', (chunk) => {
      if (stage === 'pipe') return;
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet') {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        buf = buf.subarray(2 + buf[1]);
        client.write(Buffer.from([0x05, 0x00]));
        stage = 'req';
      }
      if (stage === 'req') {
        if (buf.length < 5) return;
        const atyp = buf[3];
        const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : 1 + buf[4];
        const total = 4 + addrLen + 2;
        if (buf.length < total) return;
        const host = atyp === 0x01 ? [...buf.subarray(4, 8)].join('.')
          : atyp === 0x03 ? buf.subarray(5, 4 + addrLen).toString('utf8') : `ipv6:${buf.subarray(4, 20).toString('hex')}`;
        const rec = { atyp, host, port: buf.readUInt16BE(4 + addrLen) };
        requests.push(rec);
        const leftover = buf.subarray(total);
        stage = 'pipe';
        const code = replyFor(rec, requests.length - 1);
        if (code !== 0x00) {
          client.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return client.end();
        }
        const up = net.connect(target);
        live.add(up);
        up.on('close', () => live.delete(up));
        up.on('error', () => client.destroy());
        up.once('connect', () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]));
          client.pipe(up); up.pipe(client);
          if (leftover.length) up.write(leftover);
        });
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve({ port: srv.address().port, requests, close: () => shutdown(srv, live) })));
}

function startOrigin(handler = (_req, res) => res.end('hello from the origin')) {
  const seen = [];
  let accepted = 0;
  const live = new Set();
  const srv = http.createServer((req, res) => { seen.push({ host: req.headers.host, url: req.url }); handler(req, res); });
  srv.on('connection', (s) => { accepted++; live.add(s); s.on('close', () => live.delete(s)); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve({ port: srv.address().port, seen, accepted: () => accepted, close: () => shutdown(srv, live) })));
}

/** dns.lookup stand-in: every name answers with `addresses`, honouring { all: true }. */
const stubLookup = (...addresses) => (host, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const list = addresses.map((a) => ({ address: a, family: net.isIP(a) }));
  return opts?.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
};

const egressFor = (daemonPort, extra = {}, lookupAddrs = [PUBLIC_A]) => createEgress({
  env: { SINGBOX_SOCKS: `127.0.0.1:${daemonPort}`, ...extra },
  lookup: stubLookup(...lookupAddrs),
  isPublic: isPublicAddress,
});

// ───────────────────────────────────────────────────────────────────────────
describe('a fetch is carried by the daemon', () => {
  test('through the tunnel, asking for the VALIDATED ADDRESS and never the hostname', async () => {
    _resetEgressStats();
    const origin = await startOrigin();
    const daemon = await startDaemon({ target: { host: '127.0.0.1', port: origin.port } });
    try {
      const res = await safeFetch('http://example.test/hello?x=1', {
        egress: egressFor(daemon.port), allowHttp: true,
      });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'hello from the origin');

      assert.equal(daemon.requests.length, 1, 'the request did not cross the daemon');
      assert.deepEqual(daemon.requests[0], { atyp: 0x01, host: PUBLIC_A, port: 80 },
        'the daemon must be asked for the address that was validated, as an IPv4 literal');
      assert.notEqual(daemon.requests[0].host, 'example.test',
        'the hostname reached the daemon: DNS could rebind between the check and the dial');
      assert.deepEqual(origin.seen, [{ host: 'example.test', url: '/hello?x=1' }],
        'the origin must still see the real Host header');
      assert.equal(egressStats().fetchViaSingbox, 1);
      assert.equal(egressStats().fetchDirect, 0);
    } finally { await daemon.close(); await origin.close(); }
  });

  test('every request opens its own tunnel: a pooled socket skips the per-request check', async () => {
    const origin = await startOrigin();
    const daemon = await startDaemon({ target: { host: '127.0.0.1', port: origin.port } });
    try {
      const egress = egressFor(daemon.port);
      for (let i = 0; i < 3; i++) {
        const r = await safeFetch('http://example.test/', { egress, allowHttp: true });
        await r.text();
      }
      assert.equal(daemon.requests.length, 3, 'a socket was reused across requests');
    } finally { await daemon.close(); await origin.close(); }
  });

  test('when the daemon refuses one address the next is tried', async () => {
    const origin = await startOrigin();
    const daemon = await startDaemon({
      target: { host: '127.0.0.1', port: origin.port },
      replyFor: (_rec, i) => (i === 0 ? 0x04 : 0x00),          // host unreachable, then fine
    });
    try {
      const res = await safeFetch('http://example.test/', {
        egress: egressFor(daemon.port, {}, [PUBLIC_A, PUBLIC_B]), allowHttp: true,
      });
      assert.equal(res.status, 200);
      assert.deepEqual(daemon.requests.map((r) => r.host), [PUBLIC_A, PUBLIC_B]);
    } finally { await daemon.close(); await origin.close(); }
  });

  test('the SSRF defence still runs first: a hostname that resolves privately never reaches the daemon', async () => {
    const origin = await startOrigin();
    const daemon = await startDaemon({ target: { host: '127.0.0.1', port: origin.port } });
    try {
      // The REAL validating resolver, against the name that always resolves to loopback.
      const egress = createEgress({
        env: { SINGBOX_SOCKS: `127.0.0.1:${daemon.port}` }, lookup: guardedLookup, isPublic: isPublicAddress,
      });
      const agent = egress.agentFor('http:');
      const err = await new Promise((resolve) => {
        const req = http.request({ host: 'localhost', port: origin.port, path: '/', agent });
        req.on('error', resolve); req.on('response', () => resolve(null)); req.end();
      });
      assert.ok(err instanceof BlockedDestinationError, `got ${err && err.constructor.name}`);
      assert.equal(daemon.requests.length, 0, 'the daemon was asked to dial a private address');
      assert.equal(origin.accepted(), 0);
    } finally { await daemon.close(); await origin.close(); }
  });

  test('a private IP literal is refused even if a caller skipped assertFetchable', async () => {
    const daemon = await startDaemon({ target: { host: '127.0.0.1', port: 9 } });
    try {
      const agent = egressFor(daemon.port).agentFor('http:');
      const err = await new Promise((resolve) => {
        const req = http.request({ host: '10.0.0.5', port: 80, path: '/', agent });
        req.on('error', resolve); req.end();
      });
      assert.ok(err instanceof EgressUnavailableError, String(err));
      assert.equal(daemon.requests.length, 0);
    } finally { await daemon.close(); }
  });
});

describe('when the daemon cannot carry it, nothing is dialled directly', () => {
  test('daemon not answering: the fetch is REFUSED and the origin never sees a connection', async () => {
    _resetEgressStats();
    const origin = await startOrigin();
    try {
      await assert.rejects(
        safeFetch('http://example.test/', { egress: egressFor(1), allowHttp: true }),
        (e) => e instanceof EgressUnavailableError && e.code === 'EEGRESS' && /direct egress is refused/.test(e.message),
      );
      assert.equal(origin.accepted(), 0, 'a direct connection was made');
      const st = egressStats();
      assert.equal(st.fetchRefused, 1);
      assert.equal(st.fetchViaSingbox, 0);
      assert.equal(st.fetchDirect, 0);
    } finally { await origin.close(); }
  });

  test('the daemon refusing every address also refuses the fetch', async () => {
    const origin = await startOrigin();
    const daemon = await startDaemon({ target: { host: '127.0.0.1', port: origin.port }, replyFor: () => 0x05 });
    try {
      await assert.rejects(
        safeFetch('http://example.test/', { egress: egressFor(daemon.port, {}, [PUBLIC_A, PUBLIC_B]), allowHttp: true }),
        EgressUnavailableError);
      assert.equal(origin.accepted(), 0);
    } finally { await daemon.close(); await origin.close(); }
  });

  test('an egress failure is not mistaken for a forbidden destination', async () => {
    await assert.rejects(
      safeFetch('http://example.test/', { egress: egressFor(1), allowHttp: true }),
      (e) => !(e instanceof BlockedDestinationError),
    );
  });

  test('production refuses even when every opt-out is set', async () => {
    _resetEgressStats();
    const origin = await startOrigin();
    try {
      const egress = createEgress({
        env: {
          NODE_ENV: 'production', SINGBOX_SOCKS: '127.0.0.1:1',
          SINGBOX_ALLOW_DIRECT: '1', SINGBOX_REQUIRE: '0', SINGBOX_EGRESS: '0',
        },
        lookup: stubLookup('127.0.0.1'), isPublic: () => true,
      });
      await assert.rejects(safeFetch('http://example.test/', { egress, allowHttp: true }), EgressUnavailableError);
      assert.equal(origin.accepted(), 0, 'production dialled directly');
      assert.equal(egressStats().fetchDirect, 0);
    } finally { await origin.close(); }
  });

  test('a developer outside production can opt in, and the direct dial is COUNTED', async () => {
    _resetEgressStats();
    const origin = await startOrigin();
    try {
      const egress = createEgress({
        env: { SINGBOX_SOCKS: '127.0.0.1:1', SINGBOX_ALLOW_DIRECT: '1' },
        lookup: stubLookup('127.0.0.1'), isPublic: () => true,
      });
      // The agent dials the resolved address directly, to the port named in the URL.
      const agent = egress.agentFor('http:');
      const status = await new Promise((resolve, reject) => {
        const req = http.request({ host: 'dev.test', port: origin.port, path: '/', agent }, (r) => { r.resume(); resolve(r.statusCode); });
        req.on('error', reject); req.end();
      });
      assert.equal(status, 200);
      assert.equal(egressStats().fetchDirect, 1, 'a permitted direct dial must never be silent');
      assert.equal(egressStats().fetchViaSingbox, 0);
    } finally { await origin.close(); }
  });
});

// ── TLS ────────────────────────────────────────────────────────────────────
function makeCert(commonName) {
  const dir = mkdtempSync(join(tmpdir(), 'zofhub-egress-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
      '-subj', `/CN=${commonName}`, '-addext', `subjectAltName=DNS:${commonName}`,
    ], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

let certs = null;
try { certs = { good: makeCert('example.test'), other: makeCert('elsewhere.test') }; } catch { /* no openssl */ }

// Some machines run a security product that terminates TLS in the middle — even on
// loopback — and hands the client ITS certificate instead of ours (lib/tls-
// interception.mjs exists for exactly this; it is the documented reason the proxy
// fails on a developer's laptop). A test that trusts our own certificate can never
// pass there, and "it fails on that machine" says nothing about this code. So
// check first, honestly, whether the certificate that arrives is the one we sent,
// and skip with the interceptor's name rather than fail for the wrong reason.
async function tlsReason() {
  if (!certs) return 'openssl is not available';
  const { X509Certificate } = await import('node:crypto');
  const tlsMod = await import('node:tls');
  const srv = https.createServer({ key: certs.good.key, cert: certs.good.cert }, (_q, r) => r.end('x'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    return await new Promise((resolve) => {
      const s = tlsMod.connect({
        host: '127.0.0.1', port: srv.address().port, servername: 'example.test', rejectUnauthorized: false,
      }, () => {
        const got = s.getPeerCertificate(true);
        const mine = new X509Certificate(certs.good.cert).fingerprint256;
        s.destroy();
        resolve(got.fingerprint256 === mine ? false
          : `TLS is being intercepted on this machine (certificate issued by ${got.issuer?.CN || 'an unknown CA'}); `
            + 'a local test certificate cannot be verified here. Runs on a machine without TLS interception.');
      });
      s.on('error', (e) => resolve(`could not run a local TLS server: ${e.message}`));
    });
  } finally { srv.close(); }
}
const TLS_SKIP = await tlsReason();

describe('TLS runs over the tunnel and is still verified', { skip: TLS_SKIP }, () => {
  async function startTlsOrigin() {
    const sni = [];
    const live = new Set();
    const srv = https.createServer({ key: certs.good.key, cert: certs.good.cert }, (_req, res) => res.end('secure hello'));
    srv.on('connection', (s) => { live.add(s); s.on('close', () => live.delete(s)); });
    // The SNI the client sent: what the TLS layer was told the server's NAME is.
    srv.on('secureConnection', (s) => { sni.push(s.servername); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return { port: srv.address().port, sni, close: () => shutdown(srv, live) };
  }

  const get = (agent, { ca, host = 'example.test', ...rest } = {}) => new Promise((resolve) => {
    const req = https.request({ host, port: 443, path: '/', agent, ca, ...rest }, (res) => {
      let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ ok: true, body }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e }));
    req.end();
  });

  test('the handshake happens over the tunnel, for the original HOSTNAME', async () => {
    const origin = await startTlsOrigin();
    const daemon = await startDaemon({ target: { host: '127.0.0.1', port: origin.port } });
    try {
      const agent = egressFor(daemon.port).agentFor('https:');
      const r = await get(agent, { ca: certs.good.cert });
      assert.equal(r.ok, true, r.error && r.error.message);
      assert.equal(r.body, 'secure hello');
      assert.deepEqual(daemon.requests.map((q) => `${q.host}:${q.port}`), [`${PUBLIC_A}:443`],
        'the daemon dialled the address, not the name');
      assert.ok(origin.sni.includes('example.test'), `SNI was ${JSON.stringify(origin.sni)}`);
    } finally { await daemon.close(); await origin.close(); }
  });

  test('a certificate for the wrong name is rejected', async () => {
    const origin = await startTlsOrigin();                     // serves a cert for example.test
    const daemon = await startDaemon({ target: { host: '127.0.0.1', port: origin.port } });
    try {
      const agent = egressFor(daemon.port).agentFor('https:');
      const r = await get(agent, { ca: certs.good.cert, host: 'elsewhere.test' });
      assert.equal(r.ok, false);
      assert.match(String(r.error.code || r.error.message), /ERR_TLS_CERT_ALTNAME_INVALID|altnames/i);
    } finally { await daemon.close(); await origin.close(); }
  });

  test('an untrusted certificate is rejected', async () => {
    const origin = await startTlsOrigin();
    const daemon = await startDaemon({ target: { host: '127.0.0.1', port: origin.port } });
    try {
      const agent = egressFor(daemon.port).agentFor('https:');
      const r = await get(agent, { ca: certs.other.cert });     // trusts a different root
      assert.equal(r.ok, false);
      assert.match(String(r.error.code), /SELF_SIGNED|UNABLE_TO_VERIFY|CERT/i);
    } finally { await daemon.close(); await origin.close(); }
  });

  test('a caller cannot turn verification off', async () => {
    const origin = await startTlsOrigin();
    const daemon = await startDaemon({ target: { host: '127.0.0.1', port: origin.port } });
    try {
      const agent = egressFor(daemon.port).agentFor('https:');
      const r = await get(agent, { rejectUnauthorized: false });  // no ca at all, and asks not to verify
      assert.equal(r.ok, false, 'rejectUnauthorized:false was honoured');
    } finally { await daemon.close(); await origin.close(); }
  });
});

// ── The SOCKS opener ───────────────────────────────────────────────────────
describe('openSingboxTunnel classifies what went wrong', () => {
  test("a daemon that never answers is stage 'daemon'", async () => {
    const e = await openSingboxTunnel('example.test', 80, { env: { SINGBOX_SOCKS: '127.0.0.1:1' } }).catch((x) => x);
    assert.equal(e.egressStage, 'daemon');
  });

  test("a daemon that answers SOCKS and says no to this destination is stage 'upstream'", async () => {
    const daemon = await startDaemon({ target: { host: '127.0.0.1', port: 9 }, replyFor: () => 0x04 });
    try {
      const e = await openSingboxTunnel(PUBLIC_A, 80, { env: { SINGBOX_SOCKS: `127.0.0.1:${daemon.port}` } }).catch((x) => x);
      assert.equal(e.egressStage, 'upstream');
      assert.equal(e.socksReply, 0x04);
    } finally { await daemon.close(); }
  });

  test("something that is not SOCKS5 is stage 'handshake'", async () => {
    const live = new Set();
    const srv = net.createServer((s) => { live.add(s); s.on('error', () => {}); s.write('HTTP/1.1 400 Bad Request\r\n\r\n'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const e = await openSingboxTunnel(PUBLIC_A, 80, {
        env: { SINGBOX_SOCKS: `127.0.0.1:${srv.address().port}` },
      }).catch((x) => x);
      assert.equal(e.egressStage, 'handshake');
    } finally { await shutdown(srv, live); }
  });

  test('a stalled handshake is bounded', async () => {
    const live = new Set();
    const srv = net.createServer((s) => { live.add(s); s.on('error', () => {}); /* never answers */ });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const t0 = Date.now();
      const e = await openSingboxTunnel(PUBLIC_A, 80, {
        env: { SINGBOX_SOCKS: `127.0.0.1:${srv.address().port}` }, timeoutMs: 150,
      }).catch((x) => x);
      assert.match(e.message, /timeout/);
      assert.ok(Date.now() - t0 < 2000);
    } finally { await shutdown(srv, live); }
  });
});

describe('waitForSingbox', () => {
  test('resolves true as soon as the inbound accepts a connection', async () => {
    const daemon = await startDaemon({ target: { host: '127.0.0.1', port: 9 } });
    try {
      assert.equal(await waitForSingbox({ env: { SINGBOX_SOCKS: `127.0.0.1:${daemon.port}` }, timeoutMs: 2000 }), true);
    } finally { await daemon.close(); }
  });

  test('resolves false (never rejects) when nothing is listening', async () => {
    const t0 = Date.now();
    assert.equal(await waitForSingbox({ env: { SINGBOX_SOCKS: '127.0.0.1:1' }, timeoutMs: 400, intervalMs: 100 }), false);
    assert.ok(Date.now() - t0 < 3000, 'it must give up near the timeout');
  });

  test('notices a daemon that comes up while it waits', async () => {
    const probe = net.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port; await new Promise((r) => probe.close(r));   // a free port
    const waiting = waitForSingbox({ env: { SINGBOX_SOCKS: `127.0.0.1:${port}` }, timeoutMs: 4000, intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 200));
    const late = net.createServer((s) => s.destroy());
    await new Promise((r) => late.listen(port, '127.0.0.1', r));
    try { assert.equal(await waiting, true); } finally { await new Promise((r) => late.close(r)); }
  });
});
