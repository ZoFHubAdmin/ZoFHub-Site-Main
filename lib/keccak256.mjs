// lib/keccak256.mjs — Keccak-256, dependency-free.
//
// WHY THIS FILE EXISTS
// node:crypto has no Keccak-256. Its `sha3-256` is NOT the same function:
// SHA-3 was standardised with a different padding byte (0x06) than the original
// Keccak submission (0x01), so the two produce completely different digests for
// the same input. Ethereum and Monero both use the ORIGINAL Keccak, which is why
// `createHash('sha3-256')` cannot be substituted here and why address checksums
// for those two chains were previously unverifiable in this repo.
//
// The whole point of lib/donate.mjs is that a mistyped receiving address becomes
// a missing button at boot instead of donations falling into a void. Two of the
// five methods could not deliver that. This closes it for Ethereum (EIP-55).
//
// SCOPE: address checksums only — short inputs, run a handful of times at boot.
// It is written for obvious correctness rather than throughput, using BigInt
// lanes instead of hand-split 32-bit halves. Do not reach for it in a hot path.
//
// Verified against the published Keccak-256 vectors for "", "abc" and the
// pangram, plus all four EIP-55 example addresses. See test/keccak256.test.mjs.

const MASK = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets and the lane permutation, in the order the combined rho+pi
// step walks them.
const R  = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

const rotl = (x, n) => ((x << n) | (x >> (64n - n))) & MASK;

/** The Keccak-f[1600] permutation, in place on 25 BigInt lanes. */
function permute(A) {
  const C = new Array(5);
  for (let round = 0; round < 24; round++) {
    // theta
    for (let i = 0; i < 5; i++) C[i] = A[i] ^ A[i + 5] ^ A[i + 10] ^ A[i + 15] ^ A[i + 20];
    for (let i = 0; i < 5; i++) {
      const D = C[(i + 4) % 5] ^ rotl(C[(i + 1) % 5], 1n);
      for (let j = 0; j < 25; j += 5) A[i + j] ^= D;
    }
    // rho + pi
    let last = A[1];
    for (let i = 0; i < 24; i++) {
      const j = PI[i];
      const tmp = A[j];
      A[j] = rotl(last, BigInt(R[i]));
      last = tmp;
    }
    // chi
    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i++) C[i] = A[j + i];
      for (let i = 0; i < 5; i++) A[j + i] = C[i] ^ ((~C[(i + 1) % 5] & MASK) & C[(i + 2) % 5]);
    }
    // iota
    A[0] ^= RC[round];
  }
}

/**
 * Keccak-256 of a byte sequence.
 *
 * @param {Uint8Array|Buffer|string} input  a string is read as UTF-8
 * @returns {Uint8Array} 32 bytes
 */
export function keccak256(input) {
  const msg = typeof input === 'string'
    ? new TextEncoder().encode(input)
    : Uint8Array.from(input);

  const RATE = 136;                       // 1088 bits, the Keccak-256 rate
  const padded = new Uint8Array(Math.ceil((msg.length + 1) / RATE) * RATE);
  padded.set(msg);
  padded[msg.length] = 0x01;              // ORIGINAL Keccak padding, not SHA-3's 0x06
  padded[padded.length - 1] |= 0x80;

  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    permute(A);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let b = 0; b < 8; b++) { out[i * 8 + b] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return out;
}

/** Keccak-256 as lowercase hex. */
export const keccak256Hex = (input) =>
  [...keccak256(input)].map(b => b.toString(16).padStart(2, '0')).join('');
