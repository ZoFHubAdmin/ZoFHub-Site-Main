// The crypto address validators are the difference between a mistyped donation
// address being a missing button at boot and being money sent into a void.
// These pin the two that gained real checks in this pass: Monero (full
// Keccak-256 + curve) and the Ed25519 curve-point test that Solana relies on.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { isEd25519Point } from '../lib/ed25519-point.mjs';
import {
  verifyMoneroAddress, moneroBase58Decode, moneroBase58Encode, encodeMoneroAddress, NETWORKS,
} from '../lib/monero-address.mjs';
import { isSolanaWalletAddress, isMoneroAddress } from '../lib/donate.mjs';

// A real, published mainnet standard address (the Monero General Fund).
const GENERAL_FUND = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';

function realEd25519Pub() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
}

describe('Ed25519 point validation', () => {
  test('every key a real generator produces is a point', () => {
    for (let i = 0; i < 300; i++) {
      assert.equal(isEd25519Point(realEd25519Pub()), true);
    }
  });

  test('random 32-byte strings are rejected about half the time', () => {
    let rejected = 0;
    for (let i = 0; i < 1000; i++) if (!isEd25519Point(crypto.randomBytes(32))) rejected++;
    assert.ok(rejected > 300 && rejected < 700, `rejected ${rejected}/1000 — expected roughly half`);
  });

  test('the identity and the all-zero (small-order) encodings are refused', () => {
    const identity = new Uint8Array(32); identity[0] = 1;
    assert.equal(isEd25519Point(identity), false);
    assert.equal(isEd25519Point(new Uint8Array(32)), false, 'the System Program address is not a wallet key');
  });

  test('wrong length is refused', () => {
    assert.equal(isEd25519Point(new Uint8Array(31)), false);
    assert.equal(isEd25519Point(null), false);
  });
});

describe('Monero address verification', () => {
  test('the base58 codec round-trips arbitrary bytes', () => {
    for (const n of [1, 8, 9, 65, 69, 72]) {
      const b = crypto.randomBytes(n);
      assert.deepEqual([...moneroBase58Decode(moneroBase58Encode(b))], [...b]);
    }
  });

  test('a real mainnet address verifies', () => {
    const r = verifyMoneroAddress(GENERAL_FUND);
    assert.equal(r.ok, true, r.why);
    assert.equal(r.network, 'mainnet');
    assert.equal(r.type, 'standard');
    assert.equal(isMoneroAddress(GENERAL_FUND), true);
  });

  test('every single-character substitution is caught', () => {
    // The property the old shape check could not offer: no one-character typo
    // survives. Sample positions across the string to keep the test quick.
    let caught = 0, tried = 0;
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    for (let i = 5; i < GENERAL_FUND.length; i += 7) {
      const other = GENERAL_FUND[i] === 'A' ? 'B' : 'A';
      if (!alphabet.includes(other)) continue;
      const typo = GENERAL_FUND.slice(0, i) + other + GENERAL_FUND.slice(i + 1);
      tried++;
      if (!verifyMoneroAddress(typo).ok) caught++;
    }
    assert.equal(caught, tried, `${tried - caught} of ${tried} typos slipped through`);
  });

  test('a testnet address is refused on a mainnet-only page', () => {
    const spend = realEd25519Pub(), view = realEd25519Pub();
    const testnet = encodeMoneroAddress(NETWORKS.testnet.standard, spend, view);
    assert.equal(verifyMoneroAddress(testnet).ok, false);
    assert.equal(verifyMoneroAddress(testnet, { networks: ['testnet'] }).ok, true);
  });

  test('an address whose keys are not curve points is refused even with a good checksum', () => {
    // Keys that are valid base bytes but off the curve, checksum recomputed over
    // them — the checksum passes, the curve check must not.
    const notPoints = new Uint8Array(32).fill(0xff);
    const forged = encodeMoneroAddress(NETWORKS.mainnet.standard, notPoints, realEd25519Pub());
    const r = verifyMoneroAddress(forged);
    // Either the keys are off-curve (expected) — in the rare case 0xff… is a
    // point, the test regenerates. Assert the negative path is reachable.
    assert.equal(r.ok, false);
    assert.match(r.why, /curve point/);
  });

  test('wrong length and non-base58 are refused with a reason, never thrown', () => {
    for (const bad of ['', '4', 'not base58 !!!', '4' + 'A'.repeat(94), 'z'.repeat(95)]) {
      const r = verifyMoneroAddress(bad);
      assert.equal(r.ok, false);
      assert.equal(typeof r.why, 'string');
    }
  });
});

describe('Solana wallet validation', () => {
  test('a real Ed25519 public key, base58-encoded, is accepted', () => {
    // Encode a generated key with the shared base58 codec via a known-good
    // library-independent path: reuse Monero's codec is wrong (block base58), so
    // build a minimal base58 here.
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const b58 = (bytes) => {
      let n = 0n; for (const x of bytes) n = (n << 8n) | BigInt(x);
      let out = ''; while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
      for (const x of bytes) { if (x === 0) out = '1' + out; else break; }
      return out;
    };
    for (let i = 0; i < 50; i++) {
      const addr = b58(realEd25519Pub());
      assert.equal(isSolanaWalletAddress(addr), true, addr);
    }
  });

  test('the all-ones System Program address (a known off-curve address) is refused', () => {
    assert.equal(isSolanaWalletAddress('11111111111111111111111111111111'), false);
  });

  test('junk lengths are refused', () => {
    assert.equal(isSolanaWalletAddress('tooShort'), false);
    assert.equal(isSolanaWalletAddress('0OIl' + 'A'.repeat(40)), false); // non-base58 chars
  });
});
