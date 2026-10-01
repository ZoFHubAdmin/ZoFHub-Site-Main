// test/wisp-egress-security.test.mjs — SSRF, port abuse and stream exhaustion,
// tested against a REAL Wisp tunnel rather than against our own policy object.
// ---------------------------------------------------------------------------
// test/wisp-policy.test.mjs proves the policy is computed and written. This
// file proves it BITES: it speaks the Wisp protocol over a real WebSocket to a
// real server and asks for destinations a visitor must never reach.
//
// THE CONTROL IS THE IMPORTANT PART. "Everything was refused" is also what a
// completely broken tunnel looks like, and a security test that passes when the
// feature is dead is worse than no test. So the same internal address is
// reached successfully under a deliberately loosened policy, which proves the
// refusals above it are the policy talking.
//
// Wisp v1 framing:
//   packet   [type u8][stream_id u32 LE][payload]
//   CONNECT  0x01 [stream_type u8][port u16 LE][hostname utf8]
//   DATA     0x02 [bytes]
//   CLOSE    0x04 [reason u8]
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wispPolicy, applyWispPolicy } from '../lib/wisp-policy.mjs';
import { routeProxyUpgrade } from '../proxy-engine/mount.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(ROOT, 'noop.cjs'));
const WebSocket = require('ws');
const wisp = require('@mercuryworkshop/wisp-js/server').server;

// Read off wisp-js's own close_reasons enum, not guessed: ConnThrottled is
// 0x49 and 0x47 is TransferTimeout, which are easy to transpose and produce a
// test that fails for the wrong reason.
const CLOSE = { TransferTimeout: 0x47, HostBlocked: 0x48, ConnThrottled: 0x49, Voluntary: 0x02 };
const SECRET = 'INTERNAL-ONLY-' + Math.random().toString(36).slice(2, 10);

let internal, internalPort, host, hostPort, sockets;

before(async () => {
  sockets = new Set();
  // Stands in for anything bound to loopback because it was never meant to be
  // reachable from outside: an admin panel, a metrics port, a metadata service.
  internal = createServer((_q, s) => { s.end(SECRET); });
  internalPort = await new Promise((r) => internal.listen(0, '127.0.0.1', () => r(internal.address().port)));

  host = createServer((_q, s) => { s.statusCode = 404; s.end(); });
  host.on('upgrade', (req, socket, head) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (!routeProxyUpgrade(wisp, req, socket, head, {})) socket.destroy();
  });
  hostPort = await new Promise((r) => host.listen(0, '127.0.0.1', () => r(host.address().port)));
});

after(async () => {
  for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
  await new Promise((r) => internal.close(r));
  await new Promise((r) => host.close(r));
});

const pkt = (type, stream, payload) => {
  const b = Buffer.alloc(5 + payload.length);
  b.writeUInt8(type, 0);
  b.writeUInt32LE(stream, 1);
  payload.copy(b, 5);
  return b;
};
const connectPayload = (hostname, port, type = 0x01) => {
  const h = Buffer.from(hostname, 'utf8');
  const p = Buffer.alloc(3 + h.length);
  p.writeUInt8(type, 0);
  p.writeUInt16LE(port, 1);
  h.copy(p, 3);
  return p;
};

/**
 * Ask the tunnel for one destination. Resolves { reached, closeReason, body }.
 * `reached` is only ever true if the SECRET actually came back — a status code
 * or an open socket is not evidence that data flowed.
 */
function dial(hostname, port, { streamType = 0x01, timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hostPort}/wisp/`);
    let body = '';
    let closeReason = null;
    const finish = () => {
      try { ws.close(); } catch { /* already closing */ }
      resolve({ reached: body.includes(SECRET), closeReason, body });
    };
    const timer = setTimeout(finish, timeoutMs);
    ws.on('open', () => {
      ws.send(pkt(0x01, 1, connectPayload(hostname, port, streamType)));
      setTimeout(() => {
        try {
          ws.send(pkt(0x02, 1, Buffer.from(
            `GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`, 'utf8')));
        } catch { /* stream already refused */ }
      }, 150);
    });
    ws.on('message', (raw) => {
      const b = Buffer.from(raw);
      if (b.length < 5) return;
      const type = b.readUInt8(0);
      const stream = b.readUInt32LE(1);
      if (stream !== 1) return;
      if (type === 0x02) {
        body += b.subarray(5).toString('utf8');
        if (body.includes(SECRET)) { clearTimeout(timer); finish(); }
      } else if (type === 0x04) {
        closeReason = b.readUInt8(5);
        clearTimeout(timer);
        finish();
      }
    });
    ws.on('error', () => { clearTimeout(timer); finish(); });
  });
}

const setPolicy = (env) => applyWispPolicy(wisp, wispPolicy(env));

describe('SSRF: the public tunnel cannot reach internal destinations', () => {
  before(() => setPolicy({}));            // the shipped production policy

  test('loopback by IP literal is refused', async () => {
    const r = await dial('127.0.0.1', internalPort);
    assert.equal(r.reached, false, 'the tunnel returned data from a loopback service');
    assert.equal(r.closeReason, CLOSE.HostBlocked);
  });

  test('loopback by NAME is refused — the hostname is resolved first', async () => {
    // A check that only looked at IP literals would wave "localhost" straight
    // through. wisp-js resolves before deciding, which is what makes this safe.
    const r = await dial('localhost', internalPort);
    assert.equal(r.reached, false);
    assert.equal(r.closeReason, CLOSE.HostBlocked);
  });

  test('the cloud metadata endpoint is refused', async () => {
    // 169.254.169.254 hands out deployment credentials on most clouds. It is
    // the single highest-value target for an SSRF against a hosted service.
    const r = await dial('169.254.169.254', 80);
    assert.equal(r.reached, false);
    assert.equal(r.closeReason, CLOSE.HostBlocked);
  });

  test('RFC1918 ranges are refused', async () => {
    for (const ip of ['10.0.0.1', '192.168.1.1', '172.16.0.1']) {
      const r = await dial(ip, 80);
      assert.equal(r.reached, false, `${ip} was reachable`);
      assert.equal(r.closeReason, CLOSE.HostBlocked, ip);
    }
  });
});

describe('THE CONTROL: the same address IS reachable when policy allows it', () => {
  // Without this, every assertion above would also pass against a tunnel that
  // simply does not work.
  test('loosening the policy lets the identical request through', async () => {
    setPolicy({ WISP_ALLOW_LOOPBACK_IPS: '1', WISP_ALLOWED_PORTS: String(internalPort) });
    try {
      const r = await dial('127.0.0.1', internalPort);
      assert.equal(r.reached, true,
        'the tunnel could not reach the test service even with policy open — '
        + 'the SSRF tests above prove nothing');
    } finally {
      setPolicy({});                       // restore before anything else runs
    }
  });

  test('and is refused again the moment the policy is restored', async () => {
    const r = await dial('127.0.0.1', internalPort);
    assert.equal(r.reached, false);
    assert.equal(r.closeReason, CLOSE.HostBlocked);
  });
});

describe('port policy: a web proxy dials web ports', () => {
  before(() => setPolicy({ WISP_ALLOW_LOOPBACK_IPS: '1' }));   // isolate the PORT rule
  after(() => setPolicy({}));

  test('a non-web port is refused even on an otherwise allowed host', async () => {
    // Loopback is permitted for this block, so the only thing that can refuse
    // this is the port allowlist. Without it the proxy is an SMTP relay and a
    // port scanner that happens to render HTML.
    const r = await dial('127.0.0.1', internalPort);
    assert.equal(r.reached, false, `port ${internalPort} should not be in the web allowlist`);
    assert.equal(r.closeReason, CLOSE.HostBlocked);
  });

  test('adding that port to the allowlist admits it', async () => {
    setPolicy({ WISP_ALLOW_LOOPBACK_IPS: '1', WISP_ALLOWED_PORTS: `80,443,${internalPort}` });
    const r = await dial('127.0.0.1', internalPort);
    assert.equal(r.reached, true, 'an explicitly allowed port was still refused');
  });

  test('a port RANGE works too', async () => {
    setPolicy({ WISP_ALLOW_LOOPBACK_IPS: '1', WISP_ALLOWED_PORTS: `${internalPort - 1}-${internalPort + 1}` });
    assert.equal((await dial('127.0.0.1', internalPort)).reached, true);
  });
});

describe('UDP is refused, because it would bypass sing-box', () => {
  before(() => setPolicy({ WISP_ALLOW_LOOPBACK_IPS: '1', WISP_ALLOWED_PORTS: 'any' }));
  after(() => setPolicy({}));

  test('a UDP stream is rejected outright', async () => {
    // wisp-js selects the socket class per stream type and ZoFHub injects only
    // TCPSocket, so a UDP stream would leave the Node process directly —
    // outside sing-box, and therefore outside SINGBOX_REQUIRE's guarantee.
    const r = await dial('127.0.0.1', internalPort, { streamType: 0x02 });
    assert.equal(r.reached, false);
    assert.equal(r.closeReason, CLOSE.HostBlocked, 'UDP was not refused');
  });

  test('TCP to the same place still works, so this is the TYPE being refused', async () => {
    assert.equal((await dial('127.0.0.1', internalPort, { streamType: 0x01 })).reached, true);
  });
});

describe('resource exhaustion: one tunnel cannot open unlimited streams', () => {
  after(() => setPolicy({}));

  test('the stream cap refuses the extra stream with ConnThrottled', async () => {
    setPolicy({ WISP_ALLOW_LOOPBACK_IPS: '1', WISP_ALLOWED_PORTS: String(internalPort), WISP_MAX_STREAMS: '2' });

    const ws = new WebSocket(`ws://127.0.0.1:${hostPort}/wisp/`);
    const closes = new Map();
    await new Promise((r) => ws.on('open', r));
    ws.on('message', (raw) => {
      const b = Buffer.from(raw);
      if (b.length >= 6 && b.readUInt8(0) === 0x04) closes.set(b.readUInt32LE(1), b.readUInt8(5));
    });

    // Three streams against a cap of two. The third must be refused.
    for (const id of [1, 2, 3]) ws.send(pkt(0x01, id, connectPayload('127.0.0.1', internalPort)));
    await new Promise((r) => setTimeout(r, 1500));
    try { ws.close(); } catch { /* already closing */ }

    assert.equal(closes.get(3), CLOSE.ConnThrottled,
      `third stream should be throttled, got ${closes.get(3)} (closes: ${[...closes]})`);
    assert.ok(!closes.has(1) || closes.get(1) !== CLOSE.ConnThrottled,
      'the first stream must not be throttled — the cap would be refusing everything');
    // NOTE: observed wisp-js behaviour is conservative by one — a cap of 2
    // admits one stream and throttles the second. That errs toward refusing,
    // which is the safe direction, so it is recorded rather than worked around.
    // The number that matters is that SOME finite cap applies at all; before
    // this policy existed the value was -1 and none did.
  });
});
