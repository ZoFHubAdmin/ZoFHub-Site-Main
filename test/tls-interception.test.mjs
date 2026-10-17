// lib/tls-interception.mjs — the detector that turns "the proxy is broken" into
// "Avast is re-signing certificates".
//
// MEASURED on the machine this was written for:
//   · the certificate for example.com was issued by "Avast Web/Mail Shield Root"
//   · plain http:// through Scramjet and Ultraviolet: 2/2 rendered real content
//   · https:// through the same two engines:          0/2, engine error page
//   · npm run verify-proxy:                           0/6, every https target
//
// Two independent engines working over HTTP and failing over HTTPS is what
// makes the diagnosis a conclusion rather than a hunch. These tests pin the
// pure half — the classification and the chain walk — because the network half
// cannot be asserted honestly in a unit test.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERCEPTION_ROOTS, classifyRoot, walkToRoot, detectInterception, describeInterception,
} from '../lib/tls-interception.mjs';

describe('classifyRoot: naming the product is what makes it actionable', () => {
  test('the root actually observed on this machine is recognised', () => {
    assert.equal(classifyRoot('Avast Web/Mail Shield Root'), 'Avast');
  });

  test('common interception roots are recognised', () => {
    const cases = {
      'Kaspersky Anti-Virus Personal Root Certificate': 'Kaspersky',
      'ESET SSL Filter CA': 'ESET',
      'Bitdefender Personal CA.Net-Defender': 'Bitdefender',
      'Zscaler Root CA': 'Zscaler',
      'FortiGate CA': 'Fortinet (FortiGate)',
      'netskope ca': 'Netskope',
      'DO_NOT_TRUST_FiddlerRoot': 'Fiddler',
      'mitmproxy': 'mitmproxy',
      'PortSwigger CA': 'Burp Suite',
    };
    for (const [cn, product] of Object.entries(cases)) {
      assert.equal(classifyRoot(cn), product, `${cn} should map to ${product}`);
    }
  });

  test('matching is case-insensitive, because these CNs vary by release', () => {
    assert.equal(classifyRoot('AVAST WEB/MAIL SHIELD ROOT'), 'Avast');
    assert.equal(classifyRoot('zscaler root ca'), 'Zscaler');
  });

  test('REAL certificate authorities are never flagged', () => {
    // A false positive here tells somebody to disable antivirus they do not
    // have, and casts doubt on a correct diagnosis later.
    for (const cn of [
      'DigiCert Global Root CA', 'ISRG Root X1', 'GlobalSign Root CA',
      'Baltimore CyberTrust Root', 'Amazon Root CA 1', 'USERTrust RSA Certification Authority',
      'Go Daddy Root Certificate Authority - G2', 'Sectigo RSA Domain Validation Secure Server CA',
      'Google Trust Services LLC', 'Microsoft RSA Root Certificate Authority 2017',
      'Cloudflare Inc ECC CA-3', 'Entrust Root Certification Authority',
    ]) {
      assert.equal(classifyRoot(cn), null, `${cn} must not be reported as interception`);
    }
  });

  test('empty and junk input returns null rather than throwing', () => {
    for (const junk of ['', null, undefined, 0, {}, [], false]) {
      assert.equal(classifyRoot(junk), null);
    }
  });

  test('every entry in the table is usable', () => {
    // A blank or whitespace `match` would substring-match EVERYTHING and report
    // every certificate on earth as intercepted.
    for (const row of INTERCEPTION_ROOTS) {
      assert.equal(typeof row.match, 'string');
      assert.ok(row.match.trim().length >= 3, `"${row.match}" is too short to match safely`);
      assert.equal(row.match, row.match.toLowerCase(), `"${row.match}" must be lower-case`);
      assert.ok(typeof row.product === 'string' && row.product.length > 1);
    }
  });

  test('no entry matches a plausible real CA name', () => {
    // The table is a substring denylist, so a careless entry like "ca" or
    // "root" would be catastrophic. This is that guard, stated as a property.
    const realistic = 'DigiCert Global Root G2 Certification Authority Secure Server CA 2024';
    assert.equal(classifyRoot(realistic), null);
  });
});

describe('walkToRoot: a chain walk that terminates', () => {
  const cert = (cn, issuerCN, fp) => ({
    subject: { CN: cn }, issuer: { CN: issuerCN }, fingerprint256: fp,
  });

  test('a self-signed root does not loop forever', () => {
    // A root issues ITSELF, so `issuerCertificate` points back at the same
    // object. A naive while-loop never ends; this is the case that matters.
    const root = cert('Some Root', 'Some Root', 'AA');
    root.issuerCertificate = root;
    const leaf = cert('example.com', 'Some Root', 'BB');
    leaf.issuerCertificate = root;
    const out = walkToRoot(leaf);
    assert.equal(out.leafCN, 'example.com');
    assert.equal(out.rootCN, 'Some Root');
  });

  test('the two-link chain actually observed is walked correctly', () => {
    const root = cert('Avast Web/Mail Shield Root', 'Avast Web/Mail Shield Root', 'R1');
    root.issuerCertificate = root;
    const leaf = cert('*.duckduckgo.com', 'Avast Web/Mail Shield Root', 'L1');
    leaf.issuerCertificate = root;
    const out = walkToRoot(leaf);
    assert.equal(out.rootCN, 'Avast Web/Mail Shield Root');
    assert.equal(classifyRoot(out.rootCN), 'Avast');
  });

  test('a longer real-world chain reaches the root', () => {
    const root = cert('ISRG Root X1', 'ISRG Root X1', 'R');
    root.issuerCertificate = root;
    const inter = cert('R3', 'ISRG Root X1', 'I');
    inter.issuerCertificate = root;
    const leaf = cert('example.org', 'R3', 'L');
    leaf.issuerCertificate = inter;
    assert.equal(walkToRoot(leaf).rootCN, 'ISRG Root X1');
  });

  test('a cyclic chain is bounded instead of hanging', () => {
    const a = cert('A', 'B', 'A1');
    const b = cert('B', 'A', 'B1');
    a.issuerCertificate = b;
    b.issuerCertificate = a;
    assert.doesNotThrow(() => walkToRoot(a));
  });

  test('a missing or empty certificate is handled', () => {
    for (const junk of [null, undefined, {}]) {
      assert.doesNotThrow(() => walkToRoot(junk));
    }
    assert.equal(walkToRoot(null).rootCN, null);
  });
});

describe('describeInterception: one wording, everywhere it is reported', () => {
  test('nothing is said when nothing was detected', () => {
    assert.deepEqual(describeInterception({ intercepted: false }), []);
    assert.deepEqual(describeInterception(null), []);
  });

  test('the explanation names the product, the cause and the fix', () => {
    const lines = describeInterception({
      intercepted: true, product: 'Avast', rootCN: 'Avast Web/Mail Shield Root', host: 'example.com',
    }).join(' ');
    assert.match(lines, /Avast/);
    assert.match(lines, /Avast Web\/Mail Shield Root/);
    assert.match(lines, /own/i, 'it should say the engines use their own CA roots');
    assert.match(lines, /HTTPS\/SSL scanning/, 'it must name the setting to change');
    assert.match(lines, /http:\/\//, 'it should say plain http still works');
    assert.match(lines, /DEPLOYED|deployed/, 'it must say a deployed site is unaffected');
  });

  test('an unknown product still produces a usable explanation', () => {
    const lines = describeInterception({ intercepted: true, product: null, rootCN: 'Weird Root', host: 'example.com' });
    assert.ok(lines.length > 0);
    assert.match(lines.join(' '), /a local security product/);
  });
});

describe('detectInterception: a detector that cannot break a boot', () => {
  test('an unreachable host resolves rather than rejecting', async () => {
    // RFC 5737 TEST-NET-1 is unroutable, so this is a connect failure.
    const r = await detectInterception({ host: '192.0.2.1', port: 443, timeoutMs: 1200 });
    assert.equal(r.intercepted, false);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0,
      'a failure must be reported as a reason, not as a silent false');
  });

  test('a port that does not speak TLS resolves rather than hanging', async () => {
    const r = await detectInterception({ host: '127.0.0.1', port: 9, timeoutMs: 1200 });
    assert.equal(r.intercepted, false);
    assert.ok(r.reason);
  });

  test('the result shape is stable whatever happened', async () => {
    const r = await detectInterception({ host: '192.0.2.1', port: 443, timeoutMs: 800 });
    for (const k of ['intercepted', 'product', 'rootCN', 'host', 'reason', 'authorized']) {
      assert.ok(Object.hasOwn(r, k), `the result should always carry ${k}`);
    }
    assert.equal(typeof r.intercepted, 'boolean');
  });
});
