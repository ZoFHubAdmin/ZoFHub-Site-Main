// Donation address validation.
//
// This suite matters more than most. A donation address is pasted once by a
// human and then sits on a public page; if one character is wrong the money is
// gone silently, with no error and no refund. The checksum tests below use
// REAL, WELL-KNOWN addresses (Satoshi's genesis address, the BIP-173 test
// vectors) precisely so the validators are proved against reference data rather
// than against something I generated with the same code being tested.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isBase58Check, isBech32, looksLikeMonero, checkMethod, base58Decode,
} from '../lib/donate.mjs';

describe('base58check catches a mistyped address', () => {
  // The genesis coinbase address. Public, famous, and its checksum is real.
  const GENESIS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';

  test('a genuine address passes', () => {
    assert.equal(isBase58Check(GENESIS), true);
  });

  test('changing ONE character fails', () => {
    // The whole point. Every single-character substitution must be caught.
    for (let i = 1; i < GENESIS.length; i++) {
      const ch = GENESIS[i];
      const other = ch === 'a' ? 'b' : 'a';
      const typo = GENESIS.slice(0, i) + other + GENESIS.slice(i + 1);
      if (typo === GENESIS) continue;
      assert.equal(isBase58Check(typo), false, `typo at index ${i} slipped through: ${typo}`);
    }
  });

  test('transposing two characters fails', () => {
    const t = GENESIS.slice(0, 5) + GENESIS[6] + GENESIS[5] + GENESIS.slice(7);
    assert.notEqual(t, GENESIS);
    assert.equal(isBase58Check(t), false);
  });

  test('truncation and padding fail', () => {
    assert.equal(isBase58Check(GENESIS.slice(0, -1)), false);
    assert.equal(isBase58Check(GENESIS + '1'), false);
  });

  test('characters base58 deliberately excludes are rejected', () => {
    // 0, O, I and l are omitted from the alphabet because they are the ones
    // humans confuse. An address containing them is not base58 at all.
    for (const bad of ['0', 'O', 'I', 'l']) {
      assert.equal(base58Decode(bad + GENESIS.slice(1)), null, bad);
      assert.equal(isBase58Check(bad + GENESIS.slice(1)), false, bad);
    }
  });

  test('junk does not throw', () => {
    for (const j of ['', '   ', null, undefined, 42, {}, 'not an address']) {
      assert.doesNotThrow(() => isBase58Check(j));
      assert.equal(isBase58Check(j), false);
    }
  });
});

describe('bech32 checksum', () => {
  // BIP-173 / BIP-350 reference vectors.
  const VALID = [
    'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4',
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y',
  ];

  test('reference vectors pass', () => {
    for (const a of VALID) assert.equal(isBech32(a), true, a);
  });

  test('one wrong character fails', () => {
    const a = VALID[1];
    for (let i = 4; i < a.length; i++) {
      const other = a[i] === 'q' ? 'p' : 'q';
      const typo = a.slice(0, i) + other + a.slice(i + 1);
      if (typo === a) continue;
      assert.equal(isBech32(typo), false, `index ${i}`);
    }
  });

  test('mixed case is rejected, because it makes the checksum ambiguous', () => {
    // BIP-173 is explicit about this, and a wallet that accepted it could
    // disagree with ours about what the address is.
    assert.equal(isBech32('bc1QW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), false);
  });

  test('no separator, or nothing before it, fails', () => {
    for (const a of ['bcqw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', '1qw508d6qejxtdg', 'bc1', '']) {
      assert.equal(isBech32(a), false, JSON.stringify(a));
    }
  });
});

describe('Monero shape pre-check (looksLikeMonero) — a filter, not the validator', () => {
  const XMR = '4' + 'A'.repeat(94);

  test('a standard-shaped string passes the SHAPE check', () => {
    assert.equal(looksLikeMonero(XMR), true);
    assert.equal(looksLikeMonero('8' + 'B'.repeat(94)), true, 'sub-address');
  });

  test('wrong length or wrong prefix fails', () => {
    assert.equal(looksLikeMonero('4' + 'A'.repeat(90)), false, 'too short');
    assert.equal(looksLikeMonero('9' + 'A'.repeat(94)), false, 'wrong prefix');
    assert.equal(looksLikeMonero('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), false);
  });
});

describe('Monero is now FULLY verified — the old limitation is closed', () => {
  // This block used to be titled "DOCUMENTED LIMITATION: a shape-valid typo is
  // NOT caught", and asserted that it passed. The limitation was a missing
  // Keccak-256; lib/keccak256.mjs supplies it and lib/monero-address.mjs uses
  // it. The assertion is inverted deliberately: a typo MUST now fail.
  //
  // The Monero Project's published General Fund address — a real, public,
  // mainnet standard address, so a pass here is checked against the network's
  // own format rather than against this module's own encoder.
  const GENERAL_FUND = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';

  test('a real mainnet address passes, and is reported as checksum-verified', () => {
    const r = checkMethod({ id: 'm', label: 'XMR', kind: 'crypto', ticker: 'xmr', address: GENERAL_FUND });
    assert.equal(r.ok, true, r.why);
    assert.equal(r.strict, true);
    assert.equal(r.level, 'checksum');
  });

  test('a one-character typo that keeps the shape is REJECTED', () => {
    const i = 50;
    const typo = GENERAL_FUND.slice(0, i) + (GENERAL_FUND[i] === 'a' ? 'b' : 'a') + GENERAL_FUND.slice(i + 1);
    assert.equal(looksLikeMonero(typo), true, 'precondition: the shape check alone would pass it');
    const r = checkMethod({ id: 'm', label: 'XMR', kind: 'crypto', ticker: 'xmr', address: typo });
    assert.equal(r.ok, false);
    assert.match(r.why, /checksum/);
  });

  test('a shape-only fake is rejected', () => {
    const r = checkMethod({ id: 'm', label: 'XMR', kind: 'crypto', ticker: 'xmr', address: '4' + 'A'.repeat(94) });
    assert.equal(r.ok, false);
  });
});

describe('checkMethod gates what reaches the page', () => {
  test('a crypto method with no address is dropped, not shown empty', () => {
    const r = checkMethod({ id: 'x', label: 'X', kind: 'crypto', ticker: 'btc', address: '' });
    assert.equal(r.ok, false);
    assert.match(r.why, /no address/);
  });

  test('a bad address is dropped with the reason', () => {
    const r = checkMethod({ id: 'x', label: 'X', kind: 'crypto', ticker: 'btc', address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7Divfaa' });
    assert.equal(r.ok, false);
    assert.match(r.why, /checksum/);
  });

  test('a good address passes and reports how strongly it was verified', () => {
    const btc = checkMethod({ id: 'b', label: 'BTC', kind: 'crypto', ticker: 'btc', address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' });
    assert.equal(btc.ok, true);
    assert.equal(btc.strict, true);
    // A Solana wallet: structurally valid and a real curve point, but no
    // checksum exists in the format — so it must NOT report as 'checksum'.
    const sol = checkMethod({ id: 's', label: 'SOL', kind: 'crypto', ticker: 'sol', address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' });
    assert.equal(sol.ok, true, sol.why);
    assert.equal(sol.strict, false, 'the caller must be able to tell these apart');
    assert.equal(sol.level, 'curve-point');
  });

  test('an unknown ticker is refused rather than waved through', () => {
    const r = checkMethod({ id: 'x', label: 'X', kind: 'crypto', ticker: 'nope', address: 'whatever' });
    assert.equal(r.ok, false);
    assert.match(r.why, /no validator/);
  });

  test('a link method must be https', () => {
    assert.equal(checkMethod({ id: 'k', label: 'K', kind: 'link', url: 'https://ko-fi.com/x' }).ok, true);
    assert.equal(checkMethod({ id: 'k', label: 'K', kind: 'link', url: 'http://ko-fi.com/x' }).ok, false);
    assert.equal(checkMethod({ id: 'k', label: 'K', kind: 'link', url: 'javascript:alert(1)' }).ok, false);
    assert.equal(checkMethod({ id: 'k', label: 'K', kind: 'link', url: 'not a url' }).ok, false);
  });

  test('malformed input never throws', () => {
    for (const m of [null, undefined, 42, 'x', {}, { id: 'a' }, { kind: 'crypto' }]) {
      assert.doesNotThrow(() => checkMethod(m));
      assert.equal(checkMethod(m).ok, false);
    }
  });
});

describe('the shipped config is safe by default', () => {
  test('no address is pre-filled, so nobody can donate to a stranger', () => {
    // A placeholder address that happened to be valid would send real money to
    // whoever owns it. Every address ships empty and the method stays hidden.
    const cfg = JSON.parse(readFileSync(new URL('../data/donate.json', import.meta.url), 'utf8'));
    for (const m of cfg.methods) {
      if (m.kind !== 'crypto') continue;
      assert.equal(String(m.address || ''), '', `${m.id} ships with an address filled in`);
    }
  });
});
