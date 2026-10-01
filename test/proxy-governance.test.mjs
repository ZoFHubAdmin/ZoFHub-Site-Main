// Proxy governance: which destinations the tunnel may reach, decided by an
// administrator-managed allowlist. Covers target validation, the decision
// engine, connect-time DNS guarding, session tracking, the service's step-up
// rules, and — against the real wisp-js filter — that the hook installed on the
// live options object actually refuses what it should.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateTargetInput, validatePolicy, createProxyGovernor, resolveGuarded, createSessionTracker,
  targetsFromEnv, normalizeHost, DEFAULT_POLICY,
} from '../lib/proxy-control.mjs';
import { createProxyService } from '../lib/proxy-service.mjs';
import { createMemoryStore } from '../lib/cms-store-memory.mjs';
import { ServiceError } from '../lib/cms-service.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe('what may be approved at all', () => {
  test('single sites and subdomain wildcards are fine', () => {
    assert.equal(validateTargetInput({ pattern: 'en.wikipedia.org', purpose: 'reference' }).ok, true);
    assert.equal(validateTargetInput({ pattern: '*.khanacademy.org', purpose: 'coursework' }).ok, true);
  });

  test('nothing that amounts to "the whole internet" can be approved', () => {
    const refused = [
      '*', '*.*', 'com', '*.com', '*.co.uk', '*.github.io', '*.vercel.app', '*.amazonaws.com',
      '*.nip.io', '10.0.0.1.nip.io', 'x.sslip.io', 'a.localtest.me',
    ];
    for (const pattern of refused) {
      assert.equal(validateTargetInput({ pattern, purpose: 'test' }).ok, false, `${pattern} was accepted`);
    }
  });

  test('internal names and IP literals are never destinations', () => {
    for (const pattern of ['localhost', 'printer.local', 'db.internal', 'nas.lan', 'router.home.arpa', '127.0.0.1', '169.254.169.254', '[::1]']) {
      assert.equal(validateTargetInput({ pattern, purpose: 'test' }).ok, false, pattern);
    }
  });

  test('ports are web ports only, and a purpose is mandatory', () => {
    assert.equal(validateTargetInput({ pattern: 'example.org', ports: [22], purpose: 'x1x' }).ok, false);
    assert.equal(validateTargetInput({ pattern: 'example.org', ports: [3306], purpose: 'x1x' }).ok, false);
    assert.equal(validateTargetInput({ pattern: 'example.org' }).ok, false);
    assert.equal(validateTargetInput({ pattern: 'example.org', purpose: 'x', expires_at: '2000-01-01' }).ok, false);
  });

  test('the environment list obeys the same rules', () => {
    const r = targetsFromEnv('example.org, *.com, *.wikipedia.org:443/80, localhost');
    assert.deepEqual(r.rows.map((x) => x.pattern), ['example.org', '*.wikipedia.org']);
    assert.equal(r.errors.length, 2);
  });

  test('hostnames are normalised to lowercase ASCII', () => {
    assert.equal(normalizeHost('EXAMPLE.org.'), 'example.org');
    assert.equal(normalizeHost('bücher.example'), 'xn--bcher-kva.example');
    assert.equal(normalizeHost('1.2.3.4'), null);
  });
});

describe('the decision engine', () => {
  const gov = createProxyGovernor();
  gov.setTargets([
    { id: 1, pattern: 'example.org', ports: [443], status: 'approved' },
    { id: 2, pattern: '*.wikipedia.org', ports: [80, 443], status: 'approved' },
    { id: 3, pattern: 'pending.example.net', ports: [443], status: 'pending' },
    { id: 4, pattern: 'gone.example.net', ports: [443], status: 'revoked' },
    { id: 5, pattern: 'old.example.net', ports: [443], status: 'approved', expires_at: '2001-01-01T00:00:00Z' },
  ]);
  const d = (host, port = 443, staff = false) => gov.evaluate({ host, port, staff });

  test('default is refusal: an unlisted host is never allowed', () => {
    assert.equal(d('neverssl.com').decision, 'REVIEW');
    assert.equal(createProxyGovernor().evaluate({ host: 'example.org', port: 443 }).decision, 'REVIEW');
  });

  test('approved hosts pass, on approved ports only', () => {
    assert.equal(d('example.org').decision, 'ALLOW');
    assert.equal(d('example.org', 80).reason, 'port_not_approved');
    assert.equal(d('en.wikipedia.org', 80).decision, 'ALLOW');
  });

  test('a wildcard covers subdomains, not the bare domain or look-alikes', () => {
    assert.equal(d('wikipedia.org').decision, 'REVIEW');
    assert.equal(d('evilwikipedia.org').decision, 'REVIEW');
    assert.equal(d('wikipedia.org.evil.net').decision, 'REVIEW');
  });

  test('pending, revoked and expired entries do not pass', () => {
    assert.equal(d('pending.example.net').reason, 'pending_target');
    assert.equal(d('gone.example.net').reason, 'revoked_target');
    assert.equal(d('old.example.net').reason, 'expired_target');
  });

  test('IP literals and internal names are refused before any list lookup', () => {
    assert.equal(d('127.0.0.1').reason, 'ip_literal');
    assert.equal(d('::1').reason, 'ip_literal');
    assert.equal(d('metadata.google.internal').reason, 'internal_host');
  });

  test('access mode and global ports apply to everything', () => {
    gov.setPolicy({ ...DEFAULT_POLICY, allowedPorts: [443] });
    assert.equal(d('en.wikipedia.org', 80).reason, 'port_not_allowed');
    gov.setPolicy({ ...DEFAULT_POLICY, accessMode: 'staff' });
    assert.equal(d('example.org').reason, 'staff_only');
    assert.equal(d('example.org', 443, true).decision, 'ALLOW');
    gov.setPolicy({ ...DEFAULT_POLICY, accessMode: 'disabled' });
    assert.equal(d('example.org', 443, true).reason, 'proxy_disabled');
    gov.setPolicy(DEFAULT_POLICY);
  });

  test('refused hostnames are remembered as counts only, bounded', () => {
    const g = createProxyGovernor({ unlistedCap: 3 });
    for (const h of ['a-site.org', 'b-site.org', 'c-site.org', 'd-site.org', 'a-site.org']) g.evaluate({ host: h, port: 443 });
    const u = g.stats().unlisted;
    assert.equal(u.length, 3);
    assert.deepEqual(Object.keys(u[0]).sort(), ['count', 'host', 'lastSeen']);
  });
});

describe('connect-time DNS guard (the rebinding window)', () => {
  const lookup = (answers) => async () => answers;
  test('every resolved address must be public', async () => {
    assert.equal(await resolveGuarded('x.example', { lookup: lookup([{ address: '93.184.215.14', family: 4 }]) }), '93.184.215.14');
    for (const bad of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.1', '::1', 'fd00::1', '100.64.0.1']) {
      await assert.rejects(resolveGuarded('x.example', { lookup: lookup([{ address: '93.184.215.14', family: 4 }, { address: bad, family: bad.includes(':') ? 6 : 4 }]) }),
        (e) => e.reason === 'private_address', bad);
    }
  });
  test('a lookup failure refuses rather than falling through', async () => {
    await assert.rejects(resolveGuarded('x.example', { lookup: async () => { throw new Error('ENOTFOUND'); } }), (e) => e.reason === 'dns_failure');
  });
});

describe('policy bounds', () => {
  test('limits move inside hard bounds only', () => {
    assert.equal(validatePolicy({ maxTunnels: 100000 }).ok, false);
    assert.equal(validatePolicy({ allowedPorts: [22] }).ok, false);
    assert.equal(validatePolicy({ accessMode: 'everyone' }).ok, false);
    assert.equal(validatePolicy({ maxTunnels: 10, maxPerClient: 20 }).ok, false);
    assert.deepEqual(validatePolicy({ extra: 'ignored' }).value, { ...DEFAULT_POLICY });
  });
});

describe('sessions: counts and timestamps, never destinations', () => {
  test('lifecycle, termination and bounded history', () => {
    let t = 0;
    const s = createSessionTracker({ now: () => t, historySize: 2 });
    let killed = null;
    const a = s.open({ clientTag: 'abcd', kill: (r) => { killed = r; } });
    s.streamOpened(a); s.streamOpened(a); s.streamClosed(a); s.denied(a);
    const [row] = s.list();
    assert.equal(row.streams, 2); assert.equal(row.activeStreams, 1); assert.equal(row.denied, 1);
    assert.equal('kill' in row, false);
    for (const k of Object.keys(row)) assert.ok(!/host|url|target|dest/i.test(k), `session record carries ${k}`);
    t = 10_000;
    assert.deepEqual(s.expired({ maxSessionMs: 5_000 }), [[a, 'max_lifetime']]);
    assert.equal(s.terminate(a, 'terminated_by_admin'), true);
    assert.equal(killed, 'terminated_by_admin');
    s.close(s.open(), 'x'); s.close(s.open(), 'y');
    assert.equal(s.history().length, 2);
  });
});

describe('the proxy service', () => {
  const ADMIN = { username: 'ada', via: 'session', role: 'admin', userId: 'u1' };
  const ANALYST = { username: 'ann', via: 'session', role: 'analyst', userId: 'u2' };
  const make = async (env = {}) => {
    const gov = createProxyGovernor();
    const audit = [];
    const svc = createProxyService({ store: createMemoryStore(), governor: gov, sessions: createSessionTracker(), audit: (e) => audit.push(e), env });
    await svc.load();
    return { gov, svc, audit };
  };
  const status = (fn, code) => assert.rejects(fn, (e) => e instanceof ServiceError && e.status === code);

  test('a new destination is a proposal; approval needs a fresh password and then applies live', async () => {
    const { gov, svc, audit } = await make();
    const t = await svc.createTarget(ADMIN, { pattern: 'example.org', purpose: 'reference material' });
    assert.equal(t.status, 'pending');
    assert.equal(gov.evaluate({ host: 'example.org', port: 443 }).decision, 'REVIEW');
    await status(() => svc.setTargetStatus(ADMIN, t.id, 'approve'), 401);
    await svc.setTargetStatus(ADMIN, t.id, 'approve', { reauthenticated: true });
    assert.equal(gov.evaluate({ host: 'example.org', port: 443 }).decision, 'ALLOW');
    await svc.setTargetStatus(ADMIN, t.id, 'revoke');              // revoking never needs a password
    assert.equal(gov.evaluate({ host: 'example.org', port: 443 }).reason, 'revoked_target');
    assert.deepEqual(audit.map((a) => a.action), ['proxy.target.create', 'proxy.target.approve', 'proxy.target.revoke']);
  });

  test('widening an approved entry sends it back for approval', async () => {
    const { gov, svc } = await make();
    const t = await svc.createTarget(ADMIN, { pattern: 'example.org', purpose: 'reference material' });
    await svc.setTargetStatus(ADMIN, t.id, 'approve', { reauthenticated: true });
    const w = await svc.updateTarget(ADMIN, t.id, { pattern: '*.example.org' });
    assert.equal(w.status, 'pending');
    assert.equal(gov.evaluate({ host: 'a.example.org', port: 443 }).decision, 'REVIEW');
  });

  test('an approved destination cannot be deleted without revoking it first', async () => {
    const { svc } = await make();
    const t = await svc.createTarget(ADMIN, { pattern: 'example.org', purpose: 'reference material' });
    await svc.setTargetStatus(ADMIN, t.id, 'approve', { reauthenticated: true });
    await status(() => svc.deleteTarget(ADMIN, t.id), 409);
  });

  test('raising a limit needs a password; lowering never does', async () => {
    const { svc } = await make();
    await svc.setPolicy(ADMIN, { maxTunnels: 100 });
    await status(() => svc.setPolicy(ADMIN, { maxTunnels: 600 }), 401);
    await svc.setPolicy(ADMIN, { maxTunnels: 600 }, { reauthenticated: true });
    await svc.setPolicy(ADMIN, { accessMode: 'disabled' });
    await status(() => svc.setPolicy(ADMIN, { accessMode: 'public' }), 401);
  });

  test('read-only roles cannot change anything', async () => {
    const { svc } = await make();
    await svc.listTargets(ANALYST);
    await status(() => svc.createTarget(ANALYST, { pattern: 'example.org', purpose: 'xyz' }), 403);
    await status(() => svc.setPolicy(ANALYST, { maxTunnels: 10 }), 403);
    await status(() => svc.setEngine(ANALYST, 'scramjet', { enabled: false }), 403);
  });

  test('a stored row the console would refuse is ignored, not applied', async () => {
    const store = createMemoryStore();
    await store.insertTarget({ pattern: '*.com', ports: [443], status: 'approved', purpose: 'sneaked in', created_by: 'sql' });
    const gov = createProxyGovernor();
    const svc = createProxyService({ store, governor: gov, sessions: createSessionTracker(), env: {} });
    await svc.load();
    assert.equal(gov.evaluate({ host: 'anything.com', port: 443 }).decision, 'REVIEW');
    assert.ok(svc.status().problems.some((p) => p.includes('*.com')));
  });

  test('PROXY_ACCESS_MODE sets the starting mode; external companions start OFF', async () => {
    const { svc } = await make({ PROXY_ACCESS_MODE: 'staff' });
    assert.equal(svc.policy.accessMode, 'staff');
    assert.equal(svc.engineEnabled('external'), false);
    assert.equal(svc.engineEnabled('scramjet'), true);
  });
});

describe('the hook on the REAL wisp-js server production loads', () => {
  // The same object server.js configures: require('@mercuryworkshop/wisp-js/server').server.
  // An upgrade is routed into it exactly as server.js does, and the stream is
  // requested with raw Wisp packets, so this is the production refusal path.
  const require = createRequire(join(ROOT, 'noop.cjs'));
  const WebSocket = require('ws');
  const wisp = require('@mercuryworkshop/wisp-js/server').server;
  const saved = { hostname_whitelist: wisp.options.hostname_whitelist, allow_direct_ip: wisp.options.allow_direct_ip };
  let host, port;
  const sockets = new Set();

  after(async () => {
    Object.assign(wisp.options, saved);
    for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
    if (host) await new Promise((r) => host.close(r));
  });

  const pkt = (type, stream, payload) => {
    const b = Buffer.alloc(5 + payload.length);
    b.writeUInt8(type, 0); b.writeUInt32LE(stream, 1); payload.copy(b, 5);
    return b;
  };
  const connect = (hostname, p) => {
    const h = Buffer.from(hostname, 'utf8');
    const b = Buffer.alloc(3 + h.length);
    b.writeUInt8(0x01, 0); b.writeUInt16LE(p, 1); h.copy(b, 3);
    return b;
  };
  function dial(hostname, p) {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/wisp/`);
      let reason = null;
      const done = () => { try { ws.close(); } catch { /* closing */ } resolve(reason); };
      const timer = setTimeout(done, 5000);
      ws.on('open', () => ws.send(pkt(0x01, 1, connect(hostname, p))));
      ws.on('message', (raw) => {
        const b = Buffer.from(raw);
        if (b.length >= 6 && b.readUInt8(0) === 0x04 && b.readUInt32LE(1) === 1) { reason = b.readUInt8(5); clearTimeout(timer); done(); }
      });
      ws.on('error', () => { clearTimeout(timer); done(); });
    });
  }

  test('unapproved hosts, IP literals and the metadata address are refused with HostBlocked', async () => {
    const { createServer } = await import('node:http');
    const { routeProxyUpgrade } = await import('../proxy-engine/mount.mjs');
    const gov = createProxyGovernor();
    gov.setTargets([{ id: 1, pattern: 'example.org', ports: [443], status: 'approved' }]);
    wisp.options.hostname_whitelist = [{ test: (h) => gov.evaluate({ host: h, port: null, staff: true }).decision === 'ALLOW' }];
    wisp.options.allow_direct_ip = false;
    host = createServer((_q, s) => { s.statusCode = 404; s.end(); });
    host.on('upgrade', (req, socket, head) => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      if (!routeProxyUpgrade(wisp, req, socket, head, {})) socket.destroy();
    });
    port = await new Promise((r) => host.listen(0, '127.0.0.1', () => r(host.address().port)));
    const HOST_BLOCKED = 0x48;
    assert.equal(await dial('neverssl.com', 80), HOST_BLOCKED, 'an unapproved public host was not refused');
    assert.equal(await dial('127.0.0.1', 443), HOST_BLOCKED, 'an IP literal was not refused');
    assert.equal(await dial('169.254.169.254', 80), HOST_BLOCKED, 'the metadata address was not refused');
    assert.equal(await dial('wikipedia.org', 443), HOST_BLOCKED, 'a host outside the list was not refused');
    assert.ok(gov.stats().decisions.unlisted >= 2);
  });
});
