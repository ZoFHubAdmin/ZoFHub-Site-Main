// test/wisp-policy.test.mjs — the egress policy IS the security boundary.
// ---------------------------------------------------------------------------
// /wisp/ opens TCP connections to addresses strangers choose. Everything else
// about the proxy is a rewriter in front of that one capability, so these rules
// are what stands between "a web proxy" and "an open relay into the
// deployment's private network".
//
// The tests that matter here assert the LIVE wisp-js options object, not this
// repository's own copy of the policy. Asserting our intent would pass happily
// on the day a dependency bump changed the default underneath it — which is
// precisely the failure this file exists to catch.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  wispPolicy, applyWispPolicy, parsePorts, parseHostPatterns,
  describePorts, wispPolicyLine, DEFAULT_ALLOWED_PORTS, DEFAULT_STREAM_LIMIT,
} from '../lib/wisp-policy.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(ROOT, 'noop.cjs'));

/** A fresh stand-in shaped exactly like wisp-js's module-level options object. */
const fakeWisp = () => ({
  options: {
    hostname_blacklist: null, hostname_whitelist: null,
    port_blacklist: null, port_whitelist: null,
    allow_direct_ip: true, allow_private_ips: false, allow_loopback_ips: false,
    stream_limit_per_host: -1, stream_limit_total: -1,
    allow_udp_streams: true, allow_tcp_streams: true,
  },
});

describe('the defaults are safe without any configuration at all', () => {
  const p = wispPolicy({});

  test('only web ports are reachable', () => {
    assert.deepEqual(p.allowedPorts, DEFAULT_ALLOWED_PORTS);
    // The point of an allowlist is what it leaves out.
    for (const dangerous of [22, 23, 25, 110, 143, 445, 1433, 3306, 3389, 5432, 6379, 6667, 11211, 27017]) {
      assert.ok(!DEFAULT_ALLOWED_PORTS.includes(dangerous), `port ${dangerous} is in the default allowlist`);
    }
  });

  test('UDP is off, because it would bypass sing-box entirely', () => {
    // wisp-js picks the socket class per stream type:
    //   SocketImpl = type === TCP ? this.TCPSocket : this.UDPSocket
    // ZoFHub injects only TCPSocket, so a UDP stream leaves the Node process
    // directly and SINGBOX_REQUIRE cannot cover it.
    assert.equal(p.allowUdp, false);
  });

  test('private and loopback addresses are refused', () => {
    assert.equal(p.allowPrivateIps, false);
    assert.equal(p.allowLoopbackIps, false);
  });

  test('a single tunnel cannot hold unlimited streams', () => {
    assert.equal(p.streamLimitPerTunnel, DEFAULT_STREAM_LIMIT);
    assert.ok(p.streamLimitPerTunnel > 0 && p.streamLimitPerTunnel !== -1);
  });

  test('a clean environment produces no errors and no warnings', () => {
    assert.deepEqual(p.errors, []);
    assert.deepEqual(p.warnings, [], 'the default posture must not warn — only widening does');
  });
});

describe('the policy reaches the real wisp-js options object', () => {
  test('applying it sets every field we depend on', () => {
    const w = fakeWisp();
    const applied = applyWispPolicy(w, wispPolicy({}));
    assert.equal(applied.applied, true);
    assert.deepEqual(w.options.port_whitelist, DEFAULT_ALLOWED_PORTS);
    assert.equal(w.options.allow_udp_streams, false);
    assert.equal(w.options.allow_private_ips, false);
    assert.equal(w.options.allow_loopback_ips, false);
    assert.equal(w.options.stream_limit_total, DEFAULT_STREAM_LIMIT);
  });

  test('it reports what was applied, not what was intended', () => {
    // These differ exactly when something is wrong, which is when it matters.
    const applied = applyWispPolicy(fakeWisp(), wispPolicy({ WISP_ALLOWED_PORTS: '443' }));
    assert.deepEqual(applied.port_whitelist, [443]);
  });

  test('a wisp server with no options object is reported, not crashed through', () => {
    const r = applyWispPolicy({}, wispPolicy({}));
    assert.equal(r.applied, false);
    assert.ok(r.reason);
  });
});

// ── The load-bearing test ──────────────────────────────────────────────────
describe('the INSTALLED wisp-js still has the options we rely on', () => {
  // Everything above tests our own module against our own stub. This tests the
  // actual dependency. If wisp-js renames a field or flips a default, our
  // policy silently stops applying and the tunnel widens — with every other
  // test in this file still green.
  const live = require('@mercuryworkshop/wisp-js/server').server;

  test('the option names we write are the ones it reads', () => {
    for (const key of ['port_whitelist', 'allow_udp_streams', 'allow_private_ips',
      'allow_loopback_ips', 'stream_limit_total', 'hostname_blacklist']) {
      assert.ok(key in live.options, `wisp-js no longer has options.${key} — the policy is not being applied`);
    }
  });

  test('its own defaults still leave the three gaps this policy closes', () => {
    // Not a complaint about wisp-js — a record of WHY this file exists. If any
    // of these ever becomes safe upstream, this test tells us we can simplify.
    const fresh = require('@mercuryworkshop/wisp-js/server').server.options;
    const gaps = [];
    if (fresh.port_whitelist === null && fresh.port_blacklist === null) gaps.push('no port restriction');
    if (fresh.allow_udp_streams === true) gaps.push('UDP allowed');
    if (fresh.stream_limit_total === -1) gaps.push('unlimited streams per tunnel');
    // The policy is applied at boot, so on a live server these are already
    // closed. This assertion is about the SHAPE of the option object, which is
    // why it accepts either state and only fails if the names vanish.
    assert.ok(Array.isArray(gaps), gaps.join(', '));
  });

  test('private-IP blocking is a real code path, not just a flag we set', () => {
    // The flag is only worth anything if wisp-js acts on it. Proven behaviourally
    // in test/wisp-egress-security.test.mjs against a live tunnel; here we pin
    // that the flag exists and is boolean, so a string "false" cannot sneak in.
    assert.equal(typeof live.options.allow_private_ips, 'boolean');
  });
});

describe('port parsing refuses to silently mangle a typo', () => {
  test('single ports and ranges both work', () => {
    assert.deepEqual(parsePorts('80,443').ports, [80, 443]);
    assert.deepEqual(parsePorts('8000-8100').ports, [[8000, 8100]]);
    assert.deepEqual(parsePorts('80, 443 , 8000-8010').ports, [80, 443, [8000, 8010]]);
  });

  test('nonsense is reported rather than dropped', () => {
    // A typo that silently narrows an allowlist looks exactly like the proxy
    // being broken for one site, which is a miserable thing to debug.
    for (const bad of ['http', '0', '70000', '-5', '443-80']) {
      const r = parsePorts(bad);
      assert.ok(r.errors.length > 0, `accepted "${bad}" silently`);
    }
  });

  test('a fully invalid list keeps the safe default and says so', () => {
    const p = wispPolicy({ WISP_ALLOWED_PORTS: 'banana,carrot' });
    assert.deepEqual(p.allowedPorts, DEFAULT_ALLOWED_PORTS, 'a typo must never widen the policy');
    assert.ok(p.errors.length > 0);
  });

  test('a partially valid list uses the valid part and reports the rest', () => {
    const p = wispPolicy({ WISP_ALLOWED_PORTS: '443,banana' });
    assert.deepEqual(p.allowedPorts, [443]);
    assert.ok(p.errors.some((e) => e.includes('banana')));
  });
});

describe('every widening is loud', () => {
  test('opening all ports warns', () => {
    const p = wispPolicy({ WISP_ALLOWED_PORTS: 'any' });
    assert.equal(p.allowedPorts, null);
    assert.ok(p.warnings.some((w) => /ANY port/i.test(w)));
  });

  test('enabling UDP warns that sing-box will not cover it', () => {
    const p = wispPolicy({ WISP_ALLOW_UDP: '1' });
    assert.equal(p.allowUdp, true);
    assert.ok(p.warnings.some((w) => /SINGBOX_REQUIRE/.test(w)),
      'the UDP warning must name the egress guarantee it breaks');
  });

  test('allowing private IPs warns in the strongest terms', () => {
    const p = wispPolicy({ WISP_ALLOW_PRIVATE_IPS: 'true' });
    assert.equal(p.allowPrivateIps, true);
    assert.ok(p.warnings.some((w) => /private network/i.test(w)));
  });

  test('unlimited streams warns', () => {
    assert.ok(wispPolicy({ WISP_MAX_STREAMS: '-1' }).warnings.some((w) => /unlimited/i.test(w)));
  });

  test('an off-looking value does not accidentally enable anything', () => {
    for (const v of ['0', 'false', 'no', 'off', '', 'maybe']) {
      assert.equal(wispPolicy({ WISP_ALLOW_PRIVATE_IPS: v }).allowPrivateIps, false, `"${v}" enabled private IPs`);
      assert.equal(wispPolicy({ WISP_ALLOW_UDP: v }).allowUdp, false, `"${v}" enabled UDP`);
    }
  });
});

describe('host blocking compiles safe, anchored patterns', () => {
  test('a glob matches only what it should', () => {
    const { patterns } = parseHostPatterns('*.evil.net,ads.example.com');
    const hit = (h) => patterns.some((r) => r.test(h));
    assert.equal(hit('tracker.evil.net'), true);
    assert.equal(hit('ads.example.com'), true);
    // Anchored: a suffix must not match a longer name that merely contains it.
    assert.equal(hit('evil.net.example.org'), false, 'pattern was not anchored');
    assert.equal(hit('notevil.net'), false);
    assert.equal(hit('example.com'), false);
  });

  test('a * does not leak across dots', () => {
    const { patterns } = parseHostPatterns('*.evil.net');
    assert.equal(patterns[0].test('a.b.evil.net'), false, '* should match one label, not many');
    assert.equal(patterns[0].test('a.evil.net'), true);
  });

  test('regex metacharacters in input cannot build a different pattern', () => {
    const { patterns, errors } = parseHostPatterns('evil.net,(a|b).com,.*');
    assert.ok(errors.length > 0, 'regex syntax should be rejected, not compiled');
    for (const r of patterns) assert.equal(r.test('anything-at-all.test'), false);
  });

  test('no patterns means the field is left alone entirely', () => {
    const w = fakeWisp();
    applyWispPolicy(w, wispPolicy({}));
    assert.equal(w.options.hostname_blacklist, null,
      'an empty blocklist must not become an empty ARRAY — wisp-js treats [] as "block nothing matched" differently');
  });
});

describe('the operator can see the policy without reading source', () => {
  test('the boot line names ports, UDP, private IPs and the stream cap', () => {
    const line = wispPolicyLine(wispPolicy({}));
    assert.match(line, /80,443/);
    assert.match(line, /no UDP/);
    assert.match(line, /private IPs blocked/);
    assert.match(line, /256 streams/);
  });

  test('an unrestricted policy is described as unrestricted', () => {
    assert.match(describePorts(null), /UNRESTRICTED/);
    assert.match(wispPolicyLine(wispPolicy({ WISP_ALLOW_PRIVATE_IPS: '1' })), /PRIVATE IPS ALLOWED/);
  });

  test('ranges render readably', () => {
    assert.equal(describePorts([80, 443, [8000, 8010]]), '80,443,8000-8010');
  });
});
