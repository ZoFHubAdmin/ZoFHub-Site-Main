// test/kasm-host.test.mjs — Kasm Workspaces as a proxy-browser engine.
// ---------------------------------------------------------------------------
// The one thing this integration has to get right is the DIFFERENCE between a
// Kasm box that is switched off and one that is running normally behind the
// self-signed certificate its own startup script generates. Those two look
// identical to an ordinary fetch, and confusing them produces the worst
// possible outcome: "offline" printed next to a service that is working, or a
// frame offered for an origin the browser will silently refuse to load.
//
// So the probe is exercised against REAL TLS servers — one with an untrusted
// certificate, one plain http, one not listening — rather than against a stub
// that would only prove the stub agrees with itself.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  kasmExposure, kasmProbe, kasmEmbedAdvice, kasmNotice, kasmEntry,
  kasmStatusLine, isPrivateHost,
} from '../lib/kasm-host.mjs';

const req = (host, extra = {}) => ({ headers: { host, ...extra }, protocol: 'http' });

describe('configuration: absent, broken and valid are three different answers', () => {
  test('unset means the engine simply is not offered', () => {
    const e = kasmExposure({});
    assert.equal(e.mode, 'absent');
    assert.equal(kasmEntry(req('z.test'), e, { up: true }), null, 'an unconfigured engine must not appear');
  });

  test('an unparseable URL is DISABLED with a reason, not silently ignored', () => {
    // The whole point of the split: a typo must be visible. Falling back to
    // "absent" would hide the one setting the operator would have checked.
    for (const bad of ['kasm.example.com:6901', 'not a url', 'ftp://kasm.example/']) {
      const e = kasmExposure({ PROXY_KASM_URL: bad });
      assert.equal(e.mode, 'disabled', `accepted ${bad}`);
      assert.ok(e.reason && e.reason.includes('PROXY_KASM_URL'), `no usable reason for ${bad}`);
      assert.match(kasmStatusLine(e), /disabled/);
    }
  });

  test('a valid URL is carried through with its origin and scheme classified', () => {
    const e = kasmExposure({ PROXY_KASM_URL: 'https://kasm.example.com:6901/' });
    assert.equal(e.mode, 'external');
    assert.equal(e.origin, 'https://kasm.example.com:6901');
    assert.equal(e.secure, true);
    assert.equal(e.private, false);
    assert.equal(e.label, 'Kasm Workspace', 'the documented default label changed');
  });

  test('KASM_LABEL names the image, and cannot carry markup', () => {
    assert.equal(kasmExposure({ PROXY_KASM_URL: 'https://k.example/', KASM_LABEL: 'Kali Desktop' }).label,
      'Kali Desktop');
    // It reaches a dropdown and a note. The client renders it as text, and this
    // is the second half of that guarantee.
    const nasty = kasmExposure({ PROXY_KASM_URL: 'https://k.example/', KASM_LABEL: '<img src=x onerror=alert(1)>' });
    assert.ok(!/[<>&"'`]/.test(nasty.label), `markup survived: ${nasty.label}`);
    // An all-markup label must not collapse to an empty dropdown entry.
    assert.ok(nasty.label.length > 0);
  });
});

describe('private addresses are recognised, because the probe runs server-side', () => {
  test('loopback, RFC1918, CGNAT, link-local and intranet names are private', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.50', '172.16.0.1',
      '172.31.255.254', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1',
      'kasmbox', 'desktop.local', 'box.internal', 'server.lan']) {
      assert.equal(isPrivateHost(h), true, `${h} should be private`);
    }
  });

  test('public addresses are not', () => {
    for (const h of ['kasm.example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '100.128.0.1']) {
      assert.equal(isPrivateHost(h), false, `${h} should be public`);
    }
  });

  test('a private host says so in the note instead of implying visitors can reach it', () => {
    const e = kasmExposure({ PROXY_KASM_URL: 'http://192.168.1.50:6901/' });
    assert.equal(e.private, true);
    const note = kasmNotice(e, { up: true, tls: 'none' }, { embeddable: true, blockers: [] });
    assert.match(note, /private address/i);
    assert.match(note, /192\.168\.1\.50/);
  });
});

// ── The live probe ─────────────────────────────────────────────────────────
// A certificate is generated per run into a temp directory and deleted after.
// It is never written into the repository: a committed private key is a
// committed private key even when it is only a test fixture, and it would trip
// every secret scanner pointed at this tree for the rest of the project's life.
let CERT = null;
let certDir = null;

before(() => {
  try {
    certDir = mkdtempSync(join(tmpdir(), 'zofhub-kasm-'));
    const pem = join(certDir, 'self.pem');
    // Deliberately the SAME shape the container generates, CN and all, so the
    // stock-certificate branch of kasmNotice() is exercised for real:
    //   workspaces-core-images/src/common/startup_scripts/vnc_startup.sh:597
    execFileSync('openssl', [
      'req', '-x509', '-nodes', '-days', '1', '-newkey', 'rsa:2048',
      '-keyout', pem, '-out', pem,
      '-subj', '/C=US/ST=VA/L=None/O=None/OU=DoFu/CN=kasm/emailAddress=none@none.none',
    ], { stdio: 'ignore' });
    const both = readFileSync(pem, 'utf8');
    CERT = { key: both, cert: both };
  } catch {
    CERT = null;           // openssl unavailable — the TLS tests skip, loudly
  }
});

after(() => { if (certDir) try { rmSync(certDir, { recursive: true, force: true }); } catch { /* gone */ } });

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

describe('the probe tells "untrusted certificate" apart from "down"', () => {
  test('a self-signed https server reads as UP but UNTRUSTED', async (t) => {
    if (!CERT) return t.skip('openssl unavailable — cannot generate a test certificate');
    const srv = createHttpsServer(CERT, (_q, s) => { s.statusCode = 401; s.end('auth'); });
    const port = await listen(srv);
    try {
      const p = await kasmProbe(`https://127.0.0.1:${port}/`);
      // Up: this is exactly what a healthy container looks like from outside.
      assert.equal(p.up, true, `probe said down: ${JSON.stringify(p)}`);
      assert.equal(p.status, 401, '401 is a healthy answer from a service that wants a login');
      assert.equal(p.tls, 'untrusted');
      assert.equal(p.certCN, 'kasm', 'the stock container certificate was not identified');
    } finally { srv.close(); }
  });

  test('that combination is reported as NOT embeddable, with an actionable note', async (t) => {
    if (!CERT) return t.skip('openssl unavailable — cannot generate a test certificate');
    const srv = createHttpsServer(CERT, (_q, s) => s.end('ok'));
    const port = await listen(srv);
    try {
      const exposure = kasmExposure({ PROXY_KASM_URL: `https://127.0.0.1:${port}/` });
      const probe = await kasmProbe(exposure.url);
      const entry = kasmEntry({ headers: { host: 'z.test', 'x-forwarded-proto': 'https' } }, exposure, probe);

      assert.equal(entry.up, true, 'it is running — hiding it would be wrong');
      assert.equal(entry.embeddable, false, 'an untrusted origin must not be put in the frame');
      // The note has to say what to DO. "Failed to load" is what we are replacing.
      assert.match(entry.notice, /self-signed certificate/i);
      assert.match(entry.notice, /new tab/i);
      assert.match(entry.notice, /generates at startup/i, 'the stock certificate was not recognised');
    } finally { srv.close(); }
  });

  test('a plain http server is up, with no TLS to judge', async () => {
    const srv = createHttpServer((_q, s) => s.end('ok'));
    const port = await listen(srv);
    try {
      const p = await kasmProbe(`http://127.0.0.1:${port}/`);
      assert.equal(p.up, true);
      assert.equal(p.tls, 'none');
      assert.equal(p.certCN, null, 'a plaintext connection has no certificate to report');
    } finally { srv.close(); }
  });

  test('nothing listening is DOWN, and says why', async () => {
    // Bind then close, so the port is real and definitely free.
    const tmp = createHttpServer(() => {});
    const port = await listen(tmp);
    await new Promise((r) => tmp.close(r));
    const p = await kasmProbe(`https://127.0.0.1:${port}/`, { timeoutMs: 1500 });
    assert.equal(p.up, false);
    assert.ok(p.reason, 'a down probe must carry a reason');
    assert.equal(p.tls, undefined, 'there is no TLS verdict when there was no connection');
  });

  test('a 5xx is NOT up — a crashed container must not be offered', async (t) => {
    if (!CERT) return t.skip('openssl unavailable — cannot generate a test certificate');
    const srv = createHttpsServer(CERT, (_q, s) => { s.statusCode = 502; s.end(); });
    const port = await listen(srv);
    try {
      assert.equal((await kasmProbe(`https://127.0.0.1:${port}/`)).up, false);
    } finally { srv.close(); }
  });

  test('a garbage URL resolves rather than hanging the engine list', async () => {
    const p = await kasmProbe('::::not a url');
    assert.equal(p.up, false);
    assert.equal(p.reason, 'invalid-url');
  });
});

describe('embedding advice matches what the browser will actually do', () => {
  const httpsKasm = kasmExposure({ PROXY_KASM_URL: 'https://kasm.example.com:6901/' });
  const httpKasm = kasmExposure({ PROXY_KASM_URL: 'http://kasm.example.com:6901/' });

  test('an https page cannot frame an http origin, and no header can fix that', () => {
    const a = kasmEmbedAdvice(httpKasm, { up: true, tls: 'none' }, { pageSecure: true });
    assert.equal(a.embeddable, false);
    assert.deepEqual(a.blockers, ['mixed-content']);
    assert.match(kasmNotice(httpKasm, { up: true }, a), /plain http/i);
  });

  test('the same origin IS framable from an http page (local development)', () => {
    const a = kasmEmbedAdvice(httpKasm, { up: true, tls: 'none' }, { pageSecure: false });
    assert.equal(a.embeddable, true, 'localhost development must not be blocked for no reason');
  });

  test('a trusted certificate embeds normally', () => {
    const a = kasmEmbedAdvice(httpsKasm, { up: true, tls: 'trusted' }, { pageSecure: true });
    assert.equal(a.embeddable, true);
    assert.deepEqual(a.blockers, []);
    assert.match(kasmNotice(httpsKasm, { up: true, tls: 'trusted' }, a), /Sign in/i);
  });

  test('a down service reports the outage ahead of any embedding advice', () => {
    const probe = { up: false, reason: 'ECONNREFUSED' };
    const note = kasmNotice(httpsKasm, probe, kasmEmbedAdvice(httpsKasm, probe, { pageSecure: true }));
    assert.match(note, /not answering/i);
    assert.match(note, /ECONNREFUSED/);
  });

  test('nothing configured is never embeddable', () => {
    assert.equal(kasmEmbedAdvice(kasmExposure({}), { up: true }, {}).embeddable, false);
    assert.equal(kasmNotice(kasmExposure({}), { up: true }, {}), '');
  });
});

describe('the engine entry is shaped the way the browser page consumes it', () => {
  const exposure = kasmExposure({ PROXY_KASM_URL: 'https://kasm.example.com/', KASM_LABEL: 'Kasm Desktop' });

  test('it carries the fields /api/proxies consumers switch on', () => {
    const e = kasmEntry(req('z.test'), exposure, { up: true, tls: 'trusted' });
    assert.equal(e.id, 'kasm');
    assert.equal(e.label, 'Kasm Desktop');
    assert.equal(e.kind, 'companion', 'the client branches on kind explicitly');
    assert.equal(e.url, 'https://kasm.example.com/');
    assert.equal(e.up, true);
    assert.equal(e.embeddable, true);
  });

  test('the setup hint is a command that names a real published image', () => {
    const e = kasmEntry(req('z.test'), exposure, { up: false });
    // Verified against the Docker Hub tag list rather than invented. An image
    // tag that does not exist turns the one instruction we give into a dead end.
    assert.match(e.setup, /^docker run /);
    assert.match(e.setup, /--shm-size=512m/, 'upstream documents this as required');
    assert.match(e.setup, /-p 6901:6901/);
    assert.match(e.setup, /kasmweb\/desktop:\d+\.\d+\.\d+/);
  });

  test('no password is ever published in the entry', () => {
    // /api/proxies is UNAUTHENTICATED and returns this URL verbatim, so a
    // password pasted into PROXY_KASM_URL would be handed to every visitor of
    // the site. Stripped, not rejected: the address is still correct, only the
    // secret half is wrong.
    const stripped = kasmExposure({ PROXY_KASM_URL: 'https://user:hunter2@kasm.example.com/' });
    assert.equal(stripped.credentialsStripped, true, 'the operator must be told this happened');
    assert.equal(stripped.url, 'https://kasm.example.com/');

    const json = JSON.stringify(kasmEntry(req('z.test'), stripped, { up: true, tls: 'trusted' }));
    assert.ok(!json.includes('hunter2'), `a credential reached the API response: ${json}`);
    assert.ok(!json.includes('user:'), 'userinfo survived into the published URL');
    // The boot line has to name the change, or auth silently stops being sent.
    assert.match(kasmStatusLine(stripped), /credentials removed/i);
    // And the host itself must survive the surgery.
    assert.equal(stripped.hostname, 'kasm.example.com');
  });

  test('the boot line states the configured URL, or that there is none', () => {
    assert.match(kasmStatusLine(exposure), /kasm\.example\.com/);
    assert.match(kasmStatusLine(kasmExposure({})), /not configured/);
    assert.match(kasmStatusLine(kasmExposure({ PROXY_KASM_URL: 'http://10.0.0.4:6901/' })), /private address/);
  });
});
