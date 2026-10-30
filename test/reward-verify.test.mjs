// lib/reward-verify.mjs — pure HMAC postback verification. Mirrors
// test/wisp-policy.test.mjs's style: no database, no network, drives the
// exported functions directly.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyPostback } from '../lib/reward-verify.mjs';

const SECRET = 'test-secret-do-not-use-in-prod';
const VALID_PAYLOAD = {
  provider: 'mock',
  sessionId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  campaignId: 'boost-3x',
  eventId: 'ev-abc123',
  timestamp: new Date().toISOString(),
};

function sign(payload, secret = SECRET) {
  const rawBody = JSON.stringify(payload);
  const signatureHex = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signatureHex };
}

describe('a correctly signed, well-formed postback is accepted', () => {
  test('valid signature and payload', () => {
    const { rawBody, signatureHex } = sign(VALID_PAYLOAD);
    const r = verifyPostback({ rawBody, signatureHex, secret: SECRET });
    assert.equal(r.ok, true);
    assert.equal(r.payload.provider, 'mock');
    assert.equal(r.payload.sessionId, VALID_PAYLOAD.sessionId);
    assert.equal(r.payload.eventId, VALID_PAYLOAD.eventId);
  });
});

describe('no secret means no provider is configured — always refused', () => {
  test('empty secret refuses before anything else is even checked', () => {
    const { rawBody, signatureHex } = sign(VALID_PAYLOAD);
    const r = verifyPostback({ rawBody, signatureHex, secret: '' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_provider_configured');
  });
});

describe('signature forgery and tampering', () => {
  test('wrong secret is refused', () => {
    const { rawBody, signatureHex } = sign(VALID_PAYLOAD, 'wrong-secret');
    const r = verifyPostback({ rawBody, signatureHex, secret: SECRET });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_signature');
  });

  test('a body edited after signing is refused — the signature covers exact bytes', () => {
    const { signatureHex } = sign(VALID_PAYLOAD);
    const tampered = JSON.stringify({ ...VALID_PAYLOAD, campaignId: 'a-different-campaign' });
    const r = verifyPostback({ rawBody: tampered, signatureHex, secret: SECRET });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_signature');
  });

  test('a missing or malformed signature is refused, not thrown on', () => {
    const { rawBody } = sign(VALID_PAYLOAD);
    for (const bad of [undefined, null, '', 'not-hex!!', 123, {}]) {
      const r = verifyPostback({ rawBody, signatureHex: bad, secret: SECRET });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'bad_signature');
    }
  });

  test('a signature of the wrong length never reaches timingSafeEqual\'s length check path incorrectly', () => {
    const { rawBody } = sign(VALID_PAYLOAD);
    const r = verifyPostback({ rawBody, signatureHex: 'deadbeef', secret: SECRET });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_signature');
  });
});

describe('payload shape validation (only after the signature is verified)', () => {
  test('malformed JSON is refused', () => {
    const rawBody = 'not json{';
    const signatureHex = createHmac('sha256', SECRET).update(rawBody).digest('hex');
    const r = verifyPostback({ rawBody, signatureHex, secret: SECRET });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'malformed_json');
  });

  test('a non-object JSON value is refused', () => {
    const { rawBody, signatureHex } = sign(42);
    const r = verifyPostback({ rawBody: JSON.stringify(42), signatureHex: createHmac('sha256', SECRET).update(JSON.stringify(42)).digest('hex'), secret: SECRET });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'malformed_payload');
  });

  for (const [field, bad] of [
    ['provider', '../../etc'], ['provider', ''], ['provider', 123],
    ['sessionId', 'not-a-uuid'], ['sessionId', ''],
    ['campaignId', 'has spaces'], ['campaignId', null],
    ['eventId', ''], ['eventId', 'has spaces here'],
  ]) {
    test(`bad ${field} (${JSON.stringify(bad)}) is refused`, () => {
      const payload = { ...VALID_PAYLOAD, [field]: bad };
      const { rawBody, signatureHex } = sign(payload);
      const r = verifyPostback({ rawBody, signatureHex, secret: SECRET });
      assert.equal(r.ok, false);
      assert.match(r.reason, /^bad_/);
    });
  }

  test('an unparseable timestamp is refused', () => {
    const payload = { ...VALID_PAYLOAD, timestamp: 'not-a-date' };
    const { rawBody, signatureHex } = sign(payload);
    const r = verifyPostback({ rawBody, signatureHex, secret: SECRET });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_timestamp');
  });
});

describe('timestamp skew — replay-window protection', () => {
  test('a timestamp within the default window is accepted', () => {
    const payload = { ...VALID_PAYLOAD, timestamp: new Date(Date.now() - 60_000).toISOString() };
    const { rawBody, signatureHex } = sign(payload);
    const r = verifyPostback({ rawBody, signatureHex, secret: SECRET });
    assert.equal(r.ok, true);
  });

  test('a timestamp far in the past is refused — an old captured postback cannot be replayed later', () => {
    const payload = { ...VALID_PAYLOAD, timestamp: new Date(Date.now() - 3_600_000).toISOString() };
    const { rawBody, signatureHex } = sign(payload);
    const r = verifyPostback({ rawBody, signatureHex, secret: SECRET, maxSkewMs: 300_000 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timestamp_skew');
  });

  test('a timestamp far in the future is refused too', () => {
    const payload = { ...VALID_PAYLOAD, timestamp: new Date(Date.now() + 3_600_000).toISOString() };
    const { rawBody, signatureHex } = sign(payload);
    const r = verifyPostback({ rawBody, signatureHex, secret: SECRET, maxSkewMs: 300_000 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timestamp_skew');
  });

  test('a custom maxSkewMs widens or narrows the window', () => {
    const payload = { ...VALID_PAYLOAD, timestamp: new Date(Date.now() - 600_000).toISOString() };
    const { rawBody, signatureHex } = sign(payload);
    assert.equal(verifyPostback({ rawBody, signatureHex, secret: SECRET, maxSkewMs: 300_000 }).ok, false);
    assert.equal(verifyPostback({ rawBody, signatureHex, secret: SECRET, maxSkewMs: 900_000 }).ok, true);
  });
});

describe('empty or missing body', () => {
  test('an empty body is refused', () => {
    const r = verifyPostback({ rawBody: '', signatureHex: 'ab', secret: SECRET });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty_body');
  });
  test('a non-string body is refused', () => {
    const r = verifyPostback({ rawBody: null, signatureHex: 'ab', secret: SECRET });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty_body');
  });
});
