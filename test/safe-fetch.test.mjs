// lib/safe-fetch.mjs is the boundary between "a URL this code chose" and "a URL
// that arrived from a query string, a third-party feed, or a community post".
// Its whole job is that no such URL — and no redirect one produces — can reach
// this host's own network or the cloud metadata service. These tests pin the
// address policy and the redirect re-validation without any network I/O.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  isPublicAddress, assertFetchable, safeFetch, BlockedDestinationError,
} from '../lib/safe-fetch.mjs';

/**
 * A dns.lookup stand-in that answers 127.0.0.1 in whichever shape was asked
 * for, and records which hostnames it was asked about.
 */
function stubLookup(seen = []) {
  const fn = (host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    seen.push(host);
    if (opts && opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
    else cb(null, '127.0.0.1', 4);
  };
  fn.seen = seen;
  return fn;
}

describe('the address policy', () => {
  test('ordinary public addresses are allowed', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.0'.replace('203.0.113', '93.184.216'), '2606:4700:4700::1111']) {
      assert.equal(isPublicAddress(ip), true, ip);
    }
  });

  test('loopback, private, link-local and metadata are refused', () => {
    for (const ip of [
      '127.0.0.1', '127.255.255.254', '10.0.0.5', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    ]) {
      assert.equal(isPublicAddress(ip), false, `${ip} was treated as public`);
    }
  });

  test('the documented public-range examples (198.18/15, 192.0.2, 203.0.113) are refused', () => {
    for (const ip of ['198.18.0.1', '198.19.255.255', '192.0.2.5', '203.0.113.9']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
  });
});

describe('assertFetchable', () => {
  const blocked = (u, o) => assert.throws(() => assertFetchable(u, o), BlockedDestinationError, u);
  const ok = (u, o) => assert.doesNotThrow(() => assertFetchable(u, o), u);

  test('scheme, credentials and port are enforced', () => {
    ok('https://example.com/game/');
    blocked('http://example.com/');                       // http off by default
    ok('http://example.com/', { allowHttp: true });
    blocked('ftp://example.com/');
    blocked('https://user:pass@example.com/');            // credentials in URL
    blocked('https://example.com:22/');                   // odd port
    ok('https://example.com:8443/');
  });

  test('IP-literal and internal hostnames are refused before any lookup', () => {
    blocked('https://127.0.0.1/');
    blocked('https://[::1]/');
    blocked('https://169.254.169.254/latest/meta-data/');
    blocked('https://localhost/');
    blocked('https://db.internal/');
    blocked('https://thing.local/');
  });

  test('a plain public URL passes', () => {
    ok('https://img.gamemonetize.com/abc/512x384.jpg');
  });
});

describe('safeFetch against a loopback server refuses to connect', () => {
  // The server is on 127.0.0.1, so a direct fetch would succeed — proving the
  // refusal comes from the address policy, not from the host being unreachable.
  //
  // Each listener is on an EPHEMERAL port, which the default port allowlist
  // refuses by itself. Both tests therefore allow that one port explicitly;
  // without it they used to pass on the port check alone, before the rule they
  // are named after was ever consulted.
  const listen = async (handler) => {
    const server = http.createServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, port: server.address().port };
  };
  // Pretend example.test resolves to our loopback listener, so the FIRST hop is
  // allowed and only what follows it is under test. Honours `all: true` — Node
  // asks for every address (happy eyeballs) and rejects a bare string reply,
  // which is why an earlier stub could never have completed a first hop.
  const lookup = stubLookup();

  test('a direct loopback URL is blocked by the address policy', async () => {
    let hit = false;
    const { server, port } = await listen((_req, res) => { hit = true; res.end('should never be read'); });
    try {
      await assert.rejects(
        safeFetch(`http://127.0.0.1:${port}/`, { allowHttp: true, allowedPorts: new Set(['', String(port)]) }),
        (e) => e instanceof BlockedDestinationError && /not public/.test(e.message),
      );
      assert.equal(hit, false, 'a connection was made');
    } finally {
      server.close();
    }
  });

  test('a redirect INTO loopback is caught at the second hop', async () => {
    // A "public" server that 302s to the metadata service. The redirect target
    // must be re-validated, which is the hop the old redirect:'follow' code skipped.
    const seen = [];
    const { server, port } = await listen((req, res) => {
      seen.push(req.url);
      if (req.url === '/start') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();
      }
      res.end('metadata');
    });
    try {
      await assert.rejects(
        safeFetch(`http://example.test:${port}/start`, { allowHttp: true, lookup, allowedPorts: new Set(['', String(port)]) }),
        (e) => e instanceof BlockedDestinationError && /not public/.test(e.message),
      );
      assert.deepEqual(seen, ['/start'], 'the first hop must have been made, and only the first');
    } finally {
      server.close();
    }
  });
});

describe('denyHost is enforced on every hop', () => {
  // The server passes lib/ai-hosts.mjs here, so an AI inference endpoint is
  // refused whether it is named directly or reached by a redirect.
  const isAi = (h) => /(^|\.)pollinations\.ai\.?$/i.test(h);

  test('the first hop is refused before any lookup or connection', async () => {
    const lookup = stubLookup();
    await assert.rejects(
      safeFetch('https://text.pollinations.ai/hello', { denyHost: isAi, lookup }),
      (e) => e instanceof BlockedDestinationError && /not fetched by this server/.test(e.message),
    );
    assert.deepEqual(lookup.seen, [], 'a refused host was still resolved');
    assert.throws(() => assertFetchable('https://image.pollinations.ai./p', { denyHost: isAi }), BlockedDestinationError);
  });

  test('a public host that redirects to a denied host is stopped at the second hop', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url);
      res.writeHead(302, { location: 'https://text.pollinations.ai/generate-on-your-bill' });
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const lookup = stubLookup();
    try {
      await assert.rejects(
        safeFetch(`http://relay.test:${port}/go`, {
          allowHttp: true, lookup, denyHost: isAi, allowedPorts: new Set(['', String(port)]),
        }),
        (e) => e instanceof BlockedDestinationError && /not fetched by this server/.test(e.message),
      );
      assert.deepEqual(seen, ['/go']);
      // Only the first host was ever resolved: the AI host never reached DNS.
      assert.deepEqual(lookup.seen, ['relay.test']);
    } finally {
      server.close();
    }
  });

  test('without denyHost nothing changes', () => {
    assert.doesNotThrow(() => assertFetchable('https://text.pollinations.ai/x'));
  });
});
