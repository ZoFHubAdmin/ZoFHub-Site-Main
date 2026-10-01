// test/wisp-egress-contract.test.mjs
// ---------------------------------------------------------------------------
// The whole sing-box egress design rests on one sentence of somebody else's
// code: wisp-js reads `TCPSocket` out of the options object handed to
// routeRequest, and uses it to dial every TCP stream a visitor opens. That is
// what lets ZoFHub redirect the proxy's egress WITHOUT patching an AGPL engine
// — and it is also a contract nothing in this repo controls.
//
// A dependency bump that renames, drops or stops honouring that option would
// not break a single thing. The tunnel would keep working, pages would keep
// loading, no test would go red — and every byte would quietly go out of Node
// directly again, from the server's own IP, while `singboxSharePct` kept
// reporting 100% because our class would simply never be constructed. Silence
// is the failure mode, so these tests make the noise.
//
// They run against the INSTALLED wisp-js, through its public export map, so
// they fail on the upgrade that breaks the assumption rather than in
// production weeks later.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { routeProxyUpgrade } from '../proxy-engine/mount.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'noop.cjs'));
const haveModules = existsSync(join(root, 'node_modules'));

// LOADED THE WAY PRODUCTION LOADS IT. proxy-engine/mount.mjs reaches the tunnel
// with `require('@mercuryworkshop/wisp-js/server')`, and this package ships a
// DIFFERENT artifact to require() than to import(): the export map sends CJS to
// dist/wisp-server.cjs (a prebuilt bundle) and ESM to src/entrypoints/server.mjs.
// Asserting against the ESM copy would prove the contract holds in code the
// server never executes — a green test for the wrong file.
const SERVER_ENTRY = haveModules ? require.resolve('@mercuryworkshop/wisp-js/server') : null;
const wispServer = () => require('@mercuryworkshop/wisp-js/server').server;

/** A socket class that is unmistakably ours if wisp-js ever constructs it. */
class MarkerSocket {
  constructor(hostname, port) { this.hostname = hostname; this.port = port; }
}

describe('wisp-js still honours an injected socket class', () => {
  test('the bundle production loads is the one under test', (t) => {
    if (!haveModules) return t.skip('node_modules not installed');
    assert.match(
      SERVER_ENTRY.replace(/\\/g, '/'), /\/dist\/wisp-server\.cjs$/,
      'require() now resolves somewhere else — re-check which copy the server runs',
    );
  });

  test('ServerConnection takes TCPSocket from its options', (t) => {
    if (!haveModules) return t.skip('node_modules not installed');

    const { ServerConnection } = wispServer();
    assert.equal(typeof ServerConnection, 'function', 'wisp-js stopped exporting ServerConnection');

    // The constructor only stores the websocket, so a bare object stands in for
    // one; nothing here opens a socket or touches the network.
    const conn = new ServerConnection({}, '/wisp/', { TCPSocket: MarkerSocket });
    assert.equal(
      conn.TCPSocket, MarkerSocket,
      'wisp-js ignored the injected TCPSocket — sing-box egress is silently bypassed',
    );
  });

  test('and does NOT use ours by default, so the option is what does the work', (t) => {
    if (!haveModules) return t.skip('node_modules not installed');

    const conn = new (wispServer().ServerConnection)({}, '/wisp/', {});
    assert.equal(typeof conn.TCPSocket, 'function', 'no default socket class at all');
    assert.notEqual(conn.TCPSocket, MarkerSocket);
    // A guard against a future version that "helpfully" ignores the option when
    // it thinks it knows better: the default must be wisp-js's own class.
    assert.equal(conn.TCPSocket.name, 'NodeTCPSocket');
  });

  test('TCP streams are dialled with that class, not a hard-coded one', (t) => {
    if (!haveModules) return t.skip('node_modules not installed');

    // Read from the function itself rather than from a file path, so this
    // survives a repackaging that moves the source but keeps the behaviour.
    // Storing the class but never using it would satisfy the tests above while
    // still sending every byte out of Node directly.
    const src = wispServer().ServerConnection.prototype.create_stream.toString();
    assert.match(
      src, /this\.TCPSocket/,
      'create_stream no longer dials through the injected class',
    );
  });
});

describe('the upgrade route matches /wisp/ exactly', () => {
  // wisp-js serves TWO protocols on one route and chooses by URL shape:
  // `path.endsWith("/")` gets ServerConnection (Wisp), anything else gets
  // WSProxyConnection — a plain host:port relay that takes (ws, path), ignores
  // conn_options entirely, and hard-codes its own NodeTCPSocket.
  //
  // So `/wisp/example.com:443` is a working proxy connection that never touches
  // sing-box, never appears in egressStats(), and ignores SINGBOX_REQUIRE=1 —
  // whose entire promise is that the server's own IP is not the one the origin
  // sees. A prefix match on '/wisp/' left that reachable by anyone who can type
  // a URL. These tests are that regression.

  const fakeWisp = () => {
    const calls = [];
    return { calls, routeRequest: (...args) => calls.push(args) };
  };

  test('the exact path is routed, with the socket class passed through', () => {
    const wisp = fakeWisp();
    const opts = { TCPSocket: MarkerSocket };
    const handled = routeProxyUpgrade(wisp, { url: '/wisp/' }, 'sock', 'head', opts);

    assert.equal(handled, true);
    assert.equal(wisp.calls.length, 1);
    const [req, socket, head, connOptions] = wisp.calls[0];
    assert.equal(req.url, '/wisp/');
    assert.equal(socket, 'sock');
    assert.equal(head, 'head');
    assert.equal(connOptions.TCPSocket, MarkerSocket, 'egress class did not reach wisp-js');
    assert.notEqual(connOptions, opts, 'options must be copied — wisp-js mutates them (wisp_version)');
  });

  test('the wsproxy shape is refused, not quietly proxied direct', () => {
    for (const url of [
      '/wisp/example.com:443',      // the bypass, exactly as a client would send it
      '/wisp/127.0.0.1:9090',       // aimed at the sing-box management API
      '/wisp/a/b',
    ]) {
      const wisp = fakeWisp();
      assert.equal(routeProxyUpgrade(wisp, { url }, null, null, {}), false, url);
      assert.equal(wisp.calls.length, 0, `${url} reached wisp-js`);
    }
  });

  test('a query string is refused too — wisp-js tests the RAW url', () => {
    // '/wisp/?x=1' does not end in '/', so wisp-js would route it to wsproxy
    // and parse "?x=1" as a host. Normalising it away here would hand the
    // bypass back under a different spelling.
    for (const url of ['/wisp/?x=1', '/wisp/#f', '/wisp']) {
      const wisp = fakeWisp();
      assert.equal(routeProxyUpgrade(wisp, { url }, null, null, {}), false, url);
    }
  });

  test('unrelated upgrades are left alone', () => {
    for (const url of ['/', '/socket.io/', '/ws', '/gust', undefined]) {
      const wisp = fakeWisp();
      assert.equal(routeProxyUpgrade(wisp, { url }, null, null, {}), false, String(url));
    }
    // A missing request object must not throw inside the server's upgrade
    // handler, where a throw would take the connection down uninformatively.
    assert.doesNotThrow(() => routeProxyUpgrade(fakeWisp(), null, null, null, {}));
    assert.equal(routeProxyUpgrade(null, { url: '/wisp/' }, null, null, {}), false,
      'no tunnel mounted must mean not-handled, not a crash');
  });
});

describe('the reason for the exact match is still true upstream', () => {
  test('wsproxy still ignores conn_options and dials its own socket', (t) => {
    if (!haveModules) return t.skip('node_modules not installed');

    // WSProxyConnection is not on the export map, so this reads the bundle —
    // the same file require() just resolved, so there is no second copy to be
    // wrong about. This is the one place reading source is justified, because
    // the claim being checked is about code we deliberately never call. If a
    // future wisp-js starts honouring conn_options here, the exact-path match
    // above could be relaxed; until then it is load-bearing and this says so.
    const src = readFileSync(SERVER_ENTRY, 'utf8');
    assert.match(src, /class WSProxyConnection/,
      'WSProxyConnection is gone from the bundle — re-check the routing branch');
    assert.match(src, /constructor\s*\(\s*ws\s*,\s*path\s*\)/,
      'WSProxyConnection now takes more than (ws, path) — re-check the bypass');
    assert.match(src, /new NodeTCPSocket\(/,
      'WSProxyConnection no longer hard-codes NodeTCPSocket — re-check the bypass');

    // Not an SSRF hole in either branch: wsproxy runs the same filter, so
    // loopback and private ranges stay refused. What the bypass leaks is the
    // egress path, not the target — and this is what keeps that distinction
    // true rather than assumed. (Bare name, not `filter.`: the bundler strips
    // the namespace, and the whole point of this file is to read the bundle.)
    assert.match(src.slice(src.indexOf('class WSProxyConnection')), /is_stream_allowed\(/,
      'wsproxy stopped filtering destinations — this is now an SSRF issue too');
  });
});
