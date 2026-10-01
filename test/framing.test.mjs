// Framing detection — the rule that decides whether a 200 OK is actually health.
//
// Every case here is a real header string seen in the wild. The old hourly link
// checker asked only "is the status 2xx/3xx?", so github.com (200 + CSP
// frame-ancestors 'none'), google.com (200 + X-Frame-Options: SAMEORIGIN) and
// developer.mozilla.org (200 + X-Frame-Options: DENY) all counted as healthy
// games. They render as a black rectangle in the player.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { framingVerdict, framingBlocked, FRAMING } from '../lib/framing.mjs';

const h = (obj) => new Headers(obj);

describe('X-Frame-Options', () => {
  test('DENY blocks', () => {
    const v = framingVerdict(h({ 'x-frame-options': 'DENY' }));
    assert.equal(v.blocked, true);
    assert.equal(v.reason, FRAMING.XFO_DENY);
    assert.equal(v.header, 'x-frame-options');
  });

  test('SAMEORIGIN blocks — their origin is never ours', () => {
    assert.equal(framingVerdict(h({ 'x-frame-options': 'SAMEORIGIN' })).reason, FRAMING.XFO_SAMEORIGIN);
  });

  test('case and whitespace do not smuggle a policy past the check', () => {
    for (const v of ['deny', '  DeNy  ', 'SameOrigin', 'sameorigin']) {
      assert.equal(framingBlocked(h({ 'x-frame-options': v })), true, v);
    }
  });

  test('ALLOW-FROM blocks unless it names us', () => {
    const hdr = h({ 'x-frame-options': 'ALLOW-FROM https://zofhub.com' });
    assert.equal(framingBlocked(hdr), true, 'no selfOrigin supplied → conservative block');
    assert.equal(framingBlocked(hdr, { selfOrigin: 'https://zofhub.com' }), false);
    assert.equal(framingBlocked(hdr, { selfOrigin: 'https://example.com' }), true);
  });
});

describe('CSP frame-ancestors', () => {
  test("'none' blocks", () => {
    const v = framingVerdict(h({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }));
    assert.equal(v.blocked, true);
    assert.equal(v.reason, FRAMING.CSP_NONE);
  });

  test('a list that excludes us blocks', () => {
    const v = framingVerdict(h({ 'content-security-policy': "frame-ancestors 'self' https://partner.example" }));
    assert.equal(v.blocked, true);
    assert.equal(v.reason, FRAMING.CSP_RESTRICTED);
  });

  test('a list that names us is allowed', () => {
    const csp = 'frame-ancestors https://zofhub.com https://partner.example';
    assert.equal(framingBlocked(h({ 'content-security-policy': csp }), { selfOrigin: 'https://zofhub.com' }), false);
  });

  test('wildcard and bare scheme sources are open to everyone', () => {
    for (const v of ['frame-ancestors *', 'frame-ancestors https:', "default-src 'self'; frame-ancestors *"]) {
      assert.equal(framingBlocked(h({ 'content-security-policy': v })), false, v);
    }
  });

  test('a CSP without frame-ancestors does not block', () => {
    // The old implementation keyed off the word appearing anywhere in the CSP.
    assert.equal(framingBlocked(h({ 'content-security-policy': "default-src 'self'; script-src 'none'" })), false);
  });

  test('frame-ancestors is not confused by a directive that merely contains it', () => {
    const csp = "report-uri /csp?d=frame-ancestors; default-src 'self'";
    assert.equal(framingBlocked(h({ 'content-security-policy': csp })), false);
  });

  test('CSP wins over X-Frame-Options when both are present', () => {
    // github.com sends exactly this pair. CSP supersedes XFO per spec, and an
    // open frame-ancestors must not be overridden by a stale XFO header.
    const open = h({ 'x-frame-options': 'DENY', 'content-security-policy': 'frame-ancestors *' });
    assert.equal(framingBlocked(open), false);
  });
});

describe('the safe direction', () => {
  test('no framing headers at all means alive', () => {
    // A CDN that omits these on HEAD must never cost us a working game.
    assert.equal(framingBlocked(h({})), false);
    assert.equal(framingBlocked(h({ 'content-type': 'text/html' })), false);
  });

  test('missing or malformed headers never throw', () => {
    for (const bad of [null, undefined, {}, h({ 'x-frame-options': '' })]) {
      assert.doesNotThrow(() => framingBlocked(bad));
    }
  });

  test('plain objects work as well as Headers, case-insensitively', () => {
    assert.equal(framingBlocked({ 'X-Frame-Options': 'DENY' }), true);
    assert.equal(framingBlocked({ 'Content-Security-Policy': "frame-ancestors 'none'" }), true);
  });
});

describe('real header strings seen in the wild', () => {
  const WILD = [
    ['github.com', { 'x-frame-options': 'deny', 'content-security-policy': "frame-ancestors 'none'" }, true],
    ['google.com', { 'x-frame-options': 'SAMEORIGIN' }, true],
    ['developer.mozilla.org', { 'x-frame-options': 'DENY' }, true],
    ['wikipedia.org', {}, false],
  ];
  for (const [name, headers, blocked] of WILD) {
    test(`${name} → ${blocked ? 'blocked' : 'alive'}`, () => {
      assert.equal(framingBlocked(h(headers)), blocked);
    });
  }
});
