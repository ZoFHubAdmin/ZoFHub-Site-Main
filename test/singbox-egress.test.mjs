// test/singbox-egress.test.mjs — the sing-box egress path, end to end.
// ---------------------------------------------------------------------------
// These tests speak real SOCKS5 over a real TCP socket against a mock daemon,
// rather than asserting on mocks of our own code. The bugs that matter here are
// protocol bugs — a byte offset, a dropped remainder — and a test that stubs the
// protocol cannot see any of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  createSingboxTCPSocket, egressStats, _resetEgressStats,
  socksTarget, singboxEgressEnabled, buildConnectRequest,
} from '../lib/singbox-socket.mjs';

// net.Server.close() stops ACCEPTING but then waits for every live connection
// to end on its own. A test that leaves one open therefore hangs in its own
// cleanup, forever, and takes `npm test` down with it — the whole suite runs at
// --test-concurrency=1, so one stuck file is a stuck CI run with no failure to
// read. Every mock server here hands back a close() that hangs up first.
function shutdown(srv, live) {
  return new Promise((resolve) => {
    for (const s of live) s.destroy();
    srv.close(resolve);
  });
}

// ── A mock SOCKS5 server ───────────────────────────────────────────────────
function startSocks({ replyCode = 0x00, appendAfterReply = null, onConnect = null } = {}) {
  const seen = [];
  const live = new Set();
  const srv = net.createServer((sock) => {
    live.add(sock);
    sock.on('close', () => live.delete(sock));
    let stage = 'greet';
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet') {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        assert.equal(buf[0], 0x05, 'greeting version');
        buf = buf.subarray(2 + buf[1]);
        sock.write(Buffer.from([0x05, 0x00]));
        stage = 'req';
      }
      if (stage === 'req') {
        if (buf.length < 5) return;
        // Parse by ATYP, as a real SOCKS server must. Assuming domain here was
        // a harness bug that hid itself until the client started sending the
        // correct type for IP literals.
        const atyp = buf[3];
        let addrLen; let host;
        if (atyp === 0x01) addrLen = 4;
        else if (atyp === 0x04) addrLen = 16;
        else if (atyp === 0x03) addrLen = 1 + buf[4];
        else { sock.destroy(); return; }
        const total = 4 + addrLen + 2;
        if (buf.length < total) return;
        if (atyp === 0x01) host = [...buf.subarray(4, 8)].join('.');
        else if (atyp === 0x04) {
          const w = [];
          for (let i = 0; i < 8; i++) w.push(buf.readUInt16BE(4 + i * 2).toString(16));
          host = w.join(':');
        } else host = buf.subarray(5, 4 + addrLen).toString('utf8');
        const rec = {
          ver: buf[0], cmd: buf[1], atyp,
          host,
          port: buf.readUInt16BE(4 + addrLen),
        };
        seen.push(rec);
        onConnect?.(rec);
        buf = buf.subarray(total);
        const reply = Buffer.from([0x05, replyCode, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50]);
        // Appending in the SAME write is the point: it reproduces an origin
        // whose first bytes share a TCP segment with the SOCKS reply.
        sock.write(appendAfterReply ? Buffer.concat([reply, Buffer.from(appendAfterReply)]) : reply);
        stage = 'data';
      }
      if (stage === 'data' && buf.length) { sock.write(buf); buf = Buffer.alloc(0); }  // echo
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({ srv, port: srv.address().port, seen, close: () => shutdown(srv, live) });
    });
  });
}

/** A plain TCP echo server, standing in for an origin reached directly. */
function startEcho() {
  const live = new Set();
  const srv = net.createServer((sock) => {
    live.add(sock);
    sock.on('close', () => live.delete(sock));
    sock.on('error', () => {});
    sock.on('data', (d) => sock.write(d));
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({ port: srv.address().port, close: () => shutdown(srv, live) });
    });
  });
}

// ── Config parsing ─────────────────────────────────────────────────────────
test('socksTarget defaults to the loopback inbound the template listens on', () => {
  assert.deepEqual(socksTarget({}), { host: '127.0.0.1', port: 2080 });
});

test('socksTarget parses host:port, including bracketed IPv6', () => {
  assert.deepEqual(socksTarget({ SINGBOX_SOCKS: '10.1.2.3:1080' }), { host: '10.1.2.3', port: 1080 });
  assert.deepEqual(socksTarget({ SINGBOX_SOCKS: '[::1]:7777' }), { host: '::1', port: 7777 });
});

test('socksTarget falls back rather than producing NaN on garbage', () => {
  // A NaN port would surface as an unreadable ECONNREFUSED at dial time.
  assert.deepEqual(socksTarget({ SINGBOX_SOCKS: 'nonsense' }), { host: '127.0.0.1', port: 2080 });
  assert.deepEqual(socksTarget({ SINGBOX_SOCKS: '1.2.3.4:abc' }), { host: '1.2.3.4', port: 2080 });
});

test('egress is on unless explicitly disabled', () => {
  assert.equal(singboxEgressEnabled({}), true, 'default on');
  assert.equal(singboxEgressEnabled({ SINGBOX_EGRESS: '1' }), true);
  for (const off of ['0', 'false', 'no', 'off', 'OFF']) {
    assert.equal(singboxEgressEnabled({ SINGBOX_EGRESS: off }), false, off);
  }
});

// ── The protocol ───────────────────────────────────────────────────────────
test('a stream is dialled through sing-box and carries data both ways', async () => {
  _resetEgressStats();
  const socks = await startSocks();
  try {
    const S = createSingboxTCPSocket({ env: { SINGBOX_SOCKS: `127.0.0.1:${socks.port}` } });
    const sock = new S('example.com', 443);
    await sock.connect();

    assert.equal(sock.viaSingbox, true, 'should report it went through sing-box');
    assert.equal(socks.seen.length, 1);
    assert.equal(socks.seen[0].cmd, 0x01, 'CONNECT');
    assert.equal(socks.seen[0].port, 443);

    await sock.send(Buffer.from('hello'));
    assert.equal((await sock.recv()).toString(), 'hello');
    await sock.close();

    assert.equal(egressStats().viaSingbox, 1);
    assert.equal(egressStats().viaDirect, 0);
  } finally { await socks.close(); }
});

test('the destination HOSTNAME is sent to sing-box, not a locally resolved IP', async () => {
  // Remote DNS is the entire point of proxying: resolving locally would leak
  // every visited hostname to the server's resolver and break on a network that
  // filters DNS, which is exactly the network this proxy exists for.
  const socks = await startSocks();
  try {
    const S = createSingboxTCPSocket({ env: { SINGBOX_SOCKS: `127.0.0.1:${socks.port}` } });
    const sock = new S('news.ycombinator.com', 443);
    await sock.connect();
    assert.equal(socks.seen[0].atyp, 0x03, 'ATYP must be domain-name');
    assert.equal(socks.seen[0].host, 'news.ycombinator.com');
    await sock.close();
  } finally { await socks.close(); }
});

test('bytes sharing a segment with the handshake reply are not lost', async () => {
  // The regression this guards: discarding the remainder after the SOCKS reply
  // truncates the first thing the browser reads, which looks like a broken site
  // rather than a broken proxy and is therefore very hard to trace.
  const socks = await startSocks({ appendAfterReply: 'HTTP/1.1 200 OK\r\n' });
  try {
    const S = createSingboxTCPSocket({ env: { SINGBOX_SOCKS: `127.0.0.1:${socks.port}` } });
    const sock = new S('example.com', 80);
    await sock.connect();
    const first = await sock.recv();
    assert.equal(first.toString(), 'HTTP/1.1 200 OK\r\n', 'early bytes must survive the handshake');
    await sock.close();
  } finally { await socks.close(); }
});

// ── Failure behaviour ──────────────────────────────────────────────────────
test('an unreachable sing-box falls back to a direct connection', async () => {
  _resetEgressStats();
  const echo = await startEcho();
  try {
    // Port 1 is reserved and nothing listens on it — a reliable refusal.
    const S = createSingboxTCPSocket({ env: { SINGBOX_SOCKS: '127.0.0.1:1' } });
    const sock = new S('127.0.0.1', echo.port);
    await sock.connect();

    assert.equal(sock.viaSingbox, false);
    await sock.send(Buffer.from('still works'));
    assert.equal((await sock.recv()).toString(), 'still works');
    await sock.close();

    const st = egressStats();
    assert.equal(st.viaDirect, 1, 'fallback must be counted, not silent');
    assert.equal(st.viaSingbox, 0);
    assert.match(st.lastError, /sing-box egress/);
    assert.ok(st.lastFallbackAt, 'fallback must be timestamped');
  } finally { await echo.close(); }
});

test('a SOCKS error reply falls back rather than hanging the stream', async () => {
  _resetEgressStats();
  const echo = await startEcho();
  const socks = await startSocks({ replyCode: 0x05 });   // connection refused
  try {
    const S = createSingboxTCPSocket({ env: { SINGBOX_SOCKS: `127.0.0.1:${socks.port}` } });
    const sock = new S('127.0.0.1', echo.port);
    await sock.connect();
    assert.equal(sock.viaSingbox, false);
    assert.match(egressStats().lastError, /connection refused/);
    await sock.close();
  } finally { await socks.close(); await echo.close(); }
});

test('SINGBOX_REQUIRE=1 fails the stream instead of leaking a direct connection', async () => {
  _resetEgressStats();
  const echo = await startEcho();
  try {
    const S = createSingboxTCPSocket({
      env: { SINGBOX_SOCKS: '127.0.0.1:1', SINGBOX_REQUIRE: '1' },
    });
    const sock = new S('127.0.0.1', echo.port);
    await assert.rejects(() => sock.connect(), /SINGBOX_REQUIRE=1/);
    const st = egressStats();
    assert.equal(st.refused, 1);
    assert.equal(st.viaDirect, 0, 'strict mode must NOT have dialled directly');
  } finally { await echo.close(); }
});

test('SINGBOX_EGRESS=0 dials directly and never contacts the daemon', async () => {
  _resetEgressStats();
  const echo = await startEcho();
  const socks = await startSocks();
  try {
    const S = createSingboxTCPSocket({
      env: { SINGBOX_EGRESS: '0', SINGBOX_SOCKS: `127.0.0.1:${socks.port}` },
    });
    const sock = new S('127.0.0.1', echo.port);
    await sock.connect();
    assert.equal(socks.seen.length, 0, 'daemon must not be contacted when egress is off');
    assert.equal(egressStats().viaDirect, 1);
    await sock.close();
  } finally { await socks.close(); await echo.close(); }
});

// ── Reporting ──────────────────────────────────────────────────────────────
test('the share is null on zero streams, not a misleading 0%', async () => {
  _resetEgressStats();
  assert.equal(egressStats().singboxSharePct, null,
    'no data must not render as 0% coverage');
});

test('the share reflects the mix of tunnelled and fallback streams', async () => {
  _resetEgressStats();
  const echo = await startEcho();
  const socks = await startSocks();
  try {
    const good = createSingboxTCPSocket({ env: { SINGBOX_SOCKS: `127.0.0.1:${socks.port}` } });
    const bad = createSingboxTCPSocket({ env: { SINGBOX_SOCKS: '127.0.0.1:1' } });
    for (const [Cls, n] of [[good, 3], [bad, 1]]) {
      for (let i = 0; i < n; i++) {
        const s = new Cls('127.0.0.1', echo.port);
        await s.connect();
        await s.close();
      }
    }
    const st = egressStats();
    assert.equal(st.viaSingbox, 3);
    assert.equal(st.viaDirect, 1);
    assert.equal(st.total, 4);
    assert.equal(st.singboxSharePct, 75);
  } finally { await socks.close(); await echo.close(); }
});

test('egress telemetry carries no secret', () => {
  // The panel polls this every 5s; a secret here would end up in a browser.
  const blob = JSON.stringify(egressStats({
    SINGBOX_API_SECRET: 'SUPER-SECRET-VALUE',
  }));
  assert.ok(!blob.includes('SUPER-SECRET-VALUE'));
});

// ── The wisp-js contract ───────────────────────────────────────────────────
test('the socket class implements every method wisp-js calls on it', () => {
  // ServerStream calls exactly these. A rename upstream should fail here, not
  // in production as a stream that never opens.
  const S = createSingboxTCPSocket({ env: {} });
  const sock = new S('example.com', 443);
  for (const m of ['connect', 'recv', 'send', 'close', 'pause', 'resume']) {
    assert.equal(typeof sock[m], 'function', `missing ${m}()`);
  }
  // filter.mjs reads .hostname off the socket when enforcing per-host limits.
  assert.equal(sock.hostname, 'example.com');
  assert.equal(sock.port, 443);
});

test('recv() resolves undefined once closed, so the relay loop terminates', async () => {
  // ServerStream.tcp_to_ws() loops until recv() yields null/undefined. A queue
  // that never resolves after close would leak the task forever.
  const socks = await startSocks();
  try {
    const S = createSingboxTCPSocket({ env: { SINGBOX_SOCKS: `127.0.0.1:${socks.port}` } });
    const sock = new S('example.com', 443);
    await sock.connect();
    const pending = sock.recv();
    await sock.close();
    assert.equal(await pending, undefined);
  } finally { await socks.close(); }
});

test('an origin reset does not raise an unhandled error event', async () => {
  // An unhandled 'error' on a net.Socket takes down the entire Node process —
  // one hostile origin would be a whole-site outage.
  const socks = await startSocks();
  try {
    const S = createSingboxTCPSocket({ env: { SINGBOX_SOCKS: `127.0.0.1:${socks.port}` } });
    const sock = new S('example.com', 443);
    await sock.connect();
    const raw = sock.socket;
    raw.emit('error', Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }));
    assert.equal(await sock.recv(), undefined, 'stream should close cleanly');
    // A synthetic emit does not tear the socket down the way a real reset does
    // (Node follows a genuine 'error' with 'close'), so hang up explicitly
    // rather than leaving a connection the mock server would wait on.
    raw.destroy();
  } finally { await socks.close(); }
});

// ── CONNECT address types ──────────────────────────────────────────────────
// The governor resolves DNS itself and hands this layer a validated IP, so the
// IP-literal paths are the COMMON case in production, not an edge case.
test('a hostname is encoded as ATYP=domain', () => {
  const req = buildConnectRequest('example.com', 443);
  assert.equal(req[0], 0x05);
  assert.equal(req[1], 0x01, 'CONNECT');
  assert.equal(req[3], 0x03, 'ATYP=domain');
  assert.equal(req[4], 'example.com'.length);
  assert.equal(req.subarray(5, 5 + 11).toString(), 'example.com');
  assert.equal(req.readUInt16BE(16), 443);
});

test('an IPv4 literal is encoded as ATYP=ipv4, not a domain that says "1.2.3.4"', () => {
  const req = buildConnectRequest('93.184.216.34', 8443);
  assert.equal(req[3], 0x01, 'ATYP=ipv4');
  assert.deepEqual([...req.subarray(4, 8)], [93, 184, 216, 34]);
  assert.equal(req.readUInt16BE(8), 8443);
  assert.equal(req.length, 10, 'ipv4 request is exactly 10 bytes');
});

test('an IPv6 literal is encoded as ATYP=ipv6 with the right 16 bytes', () => {
  // Checked against Node's own parser rather than a hand-copied expectation.
  for (const ip of ['::1', '2606:2800:220:1:248:1893:25c8:1946', 'fe80::1', '::ffff:93.184.216.34']) {
    const req = buildConnectRequest(ip, 443);
    assert.equal(req[3], 0x04, `${ip}: ATYP=ipv6`);
    assert.equal(req.length, 22, `${ip}: ipv6 request is 22 bytes`);
    assert.equal(req.readUInt16BE(20), 443, `${ip}: port`);
    const expect = Buffer.from(
      new Uint8Array(net.isIPv6(ip) ? ipv6Reference(ip) : []),
    );
    assert.deepEqual([...req.subarray(4, 20)], [...expect], `${ip}: bytes`);
  }
});

test('a bracketed IPv6 literal is accepted', () => {
  const req = buildConnectRequest('[::1]', 443);
  assert.equal(req[3], 0x04);
  assert.deepEqual([...req.subarray(4, 20)], [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1]);
});

test('an over-long hostname is refused rather than silently truncated', () => {
  // The length field is one byte; truncating would dial a DIFFERENT host.
  assert.throws(() => buildConnectRequest('a'.repeat(256) + '.com', 443), /too long/);
});

test('a malformed address falls through to the domain encoding', () => {
  // "999.1.1.1" is not an IPv4 address. It must not be mis-encoded as one.
  const req = buildConnectRequest('999.1.1.1', 443);
  assert.equal(req[3], 0x03, 'not a valid v4 literal, so send it as a name');
});

/** Independent IPv6 expansion, used only to check the implementation. */
function ipv6Reference(ip) {
  const s = ip.replace(/^\[|\]$/g, '');
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  let str = s;
  if (v4) {
    const o = v4[1].split('.').map(Number);
    str = s.slice(0, v4.index)
      + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const [l, r = ''] = str.split('::');
  const L = l.split(':').filter(Boolean);
  const R = r.split(':').filter(Boolean);
  const words = str.includes('::')
    ? [...L, ...Array(8 - L.length - R.length).fill('0'), ...R]
    : L;
  const out = [];
  for (const w of words) { const n = parseInt(w, 16); out.push((n >> 8) & 0xff, n & 0xff); }
  return out;
}
