// Keccak-256 and EIP-55 — the checksum that keeps a mistyped Ethereum address
// from silently swallowing donations.
//
// WHY THIS IS TESTED HARD
// lib/keccak256.mjs is hand-written because node:crypto does not ship Keccak-256
// and its `sha3-256` is a DIFFERENT function (SHA-3 padding is 0x06, original
// Keccak is 0x01). A hand-written hash that is subtly wrong is worse than none:
// it would reject every correct address, or worse, accept wrong ones. So it is
// pinned to the published vectors and to all four EIP-55 examples.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { keccak256, keccak256Hex } from '../lib/keccak256.mjs';
import { isEip55, VALIDATORS } from '../lib/donate.mjs';

describe('keccak256 — published vectors', () => {
  const VECTORS = [
    ['', 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
    ['abc', '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'],
    ['The quick brown fox jumps over the lazy dog',
     '4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15'],
  ];

  for (const [input, want] of VECTORS) {
    test(`keccak256(${JSON.stringify(input.slice(0, 24))}) matches`, () => {
      assert.equal(keccak256Hex(input), want);
    });
  }

  test('digest is 32 bytes', () => {
    assert.equal(keccak256('').length, 32);
    assert.ok(keccak256('abc') instanceof Uint8Array);
  });

  test('is NOT sha3-256 — the padding differs and so must the digest', async () => {
    const { createHash } = await import('node:crypto');
    const sha3 = createHash('sha3-256').update('abc').digest('hex');
    assert.notEqual(keccak256Hex('abc'), sha3,
      'if these match, the implementation is SHA-3 and every Ethereum checksum will be wrong');
  });

  test('accepts bytes as well as strings, identically', () => {
    assert.equal(keccak256Hex(new TextEncoder().encode('abc')), keccak256Hex('abc'));
  });

  test('spans a rate boundary correctly (136-byte blocks)', () => {
    // Inputs either side of the 136-byte rate exercise the multi-block path;
    // a padding bug shows up here and nowhere else.
    for (const n of [135, 136, 137, 272]) {
      const h = keccak256Hex('a'.repeat(n));
      assert.match(h, /^[0-9a-f]{64}$/);
    }
    assert.notEqual(keccak256Hex('a'.repeat(135)), keccak256Hex('a'.repeat(136)));
  });
});

describe('EIP-55 address checksum', () => {
  // The four examples from the EIP itself.
  const OFFICIAL = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ];

  for (const addr of OFFICIAL) {
    test(`accepts ${addr.slice(0, 12)}…`, () => assert.equal(isEip55(addr), true));
  }

  test('rejects a single flipped character — the whole point', () => {
    assert.equal(isEip55('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'), false);
  });

  test('rejects an all-lowercase address: no checksum is present to verify', () => {
    assert.equal(isEip55('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), false);
  });

  test('rejects an all-uppercase address for the same reason', () => {
    assert.equal(isEip55('0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED'), false);
  });

  test('rejects wrong lengths, missing 0x, and non-hex', () => {
    for (const bad of [
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe',      // 39
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAedd',    // 41
      '5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',       // no 0x
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeZ',     // non-hex
      '', null, undefined,
    ]) {
      assert.equal(isEip55(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('rejects addresses from other chains', () => {
    assert.equal(isEip55('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'), false);
    assert.equal(isEip55('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), false);
  });

  test('ETH is registered as a STRICT validator, not shape-only', () => {
    assert.equal(VALIDATORS.eth.strict, true);
    assert.equal(VALIDATORS.eth.test, isEip55);
  });

  test('an ETH address is not accepted in the USDC slot', () => {
    // USDC here is USDC-on-Solana. An 0x address in that slot would send every
    // USDC donation to an address on a chain nobody is watching.
    assert.equal(VALIDATORS.usdc.test('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), false);
  });
});
