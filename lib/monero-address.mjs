// ============================================================================
// monero-address.mjs — decode and verify a Monero address, fully.
//
// This replaces a check that looked at the first character, the length and
// the alphabet. That accepted any 95-character string starting with 4 — a
// single mistyped character in the middle of a real address still passed, and
// every donation to it would have been lost with no error anywhere.
//
// A Monero address is not plain base58. It is:
//
//   varint(network prefix) || public spend key (32) || public view key (32)
//     [|| payment id (8), integrated addresses only] || checksum (4)
//
// encoded with Monero's BLOCK base58: 8-byte blocks become exactly 11
// characters, and the final partial block has a fixed width per byte count.
// The checksum is the first 4 bytes of Keccak-256 (original Keccak — not
// SHA-3) over everything before it.
//
// What verify() establishes, in order:
//   1. every character is base58, and every block decodes and fits its width;
//   2. the network prefix is one we accept (MAINNET by default — a testnet or
//      stagenet address on a live donation page is always a mistake);
//   3. the decoded length is exactly right for that address type;
//   4. the Keccak-256 checksum matches — this is what catches the typo;
//   5. both public keys are real Ed25519 points (lib/ed25519-point.mjs), so
//      an address whose checksum was somehow recomputed over garbage keys is
//      still refused.
//
// What it cannot establish: that the address belongs to the person who pasted
// it. No offline check can. Send a small test transaction before publishing.
// ============================================================================

import { keccak256 } from './keccak256.mjs';
import { isEd25519Point } from './ed25519-point.mjs';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));
const FULL_BLOCK_BYTES = 8;
const FULL_BLOCK_CHARS = 11;
// Encoded width for a final block of 0..8 bytes.
const ENCODED_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];

// Network prefixes (cryptonote_config.h). Varint-encoded; all fit one byte.
export const NETWORKS = {
  mainnet:  { standard: 18, integrated: 19, subaddress: 42 },
  testnet:  { standard: 53, integrated: 54, subaddress: 63 },
  stagenet: { standard: 24, integrated: 25, subaddress: 36 },
};

function decodeBlock(chunk, byteLen) {
  let num = 0n;
  for (const ch of chunk) {
    const v = INDEX.get(ch);
    if (v === undefined) return null;
    num = num * 58n + v;
  }
  if (num >= 1n << BigInt(8 * byteLen)) return null;   // overflows its block
  const out = new Uint8Array(byteLen);
  for (let i = byteLen - 1; i >= 0; i--) { out[i] = Number(num & 0xffn); num >>= 8n; }
  return out;
}

function encodeBlock(bytes) {
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  const width = ENCODED_SIZES[bytes.length];
  let s = '';
  for (let i = 0; i < width; i++) { s = ALPHABET[Number(num % 58n)] + s; num /= 58n; }
  return s;
}

/** Monero block-base58 decode. Returns bytes, or null when malformed. */
export function moneroBase58Decode(str) {
  const s = String(str);
  const full = Math.floor(s.length / FULL_BLOCK_CHARS);
  const rest = s.length % FULL_BLOCK_CHARS;
  const lastBytes = ENCODED_SIZES.indexOf(rest);
  if (lastBytes === -1) return null;                    // impossible tail width
  const out = new Uint8Array(full * FULL_BLOCK_BYTES + lastBytes);
  for (let i = 0; i < full; i++) {
    const b = decodeBlock(s.slice(i * FULL_BLOCK_CHARS, (i + 1) * FULL_BLOCK_CHARS), FULL_BLOCK_BYTES);
    if (!b) return null;
    out.set(b, i * FULL_BLOCK_BYTES);
  }
  if (rest) {
    const b = decodeBlock(s.slice(full * FULL_BLOCK_CHARS), lastBytes);
    if (!b) return null;
    out.set(b, full * FULL_BLOCK_BYTES);
  }
  return out;
}

/** Monero block-base58 encode (used by tests to build known-good vectors). */
export function moneroBase58Encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += FULL_BLOCK_BYTES) {
    s += encodeBlock(bytes.subarray(i, Math.min(i + FULL_BLOCK_BYTES, bytes.length)));
  }
  return s;
}

function readVarint(bytes) {
  let value = 0, shift = 0;
  for (let i = 0; i < bytes.length && i < 9; i++) {
    value += (bytes[i] & 0x7f) * 2 ** shift;
    if (!(bytes[i] & 0x80)) return { value, length: i + 1 };
    shift += 7;
  }
  return null;
}

/**
 * Fully verify a Monero address.
 * @returns {{ ok: true, network: string, type: string } | { ok: false, why: string }}
 */
export function verifyMoneroAddress(addr, { networks = ['mainnet'] } = {}) {
  const s = String(addr ?? '').trim();
  if (s.length !== 95 && s.length !== 106) return { ok: false, why: 'wrong length (expected 95 or 106 characters)' };
  const raw = moneroBase58Decode(s);
  if (!raw) return { ok: false, why: 'not valid Monero base58' };

  const vi = readVarint(raw);
  if (!vi) return { ok: false, why: 'unreadable network prefix' };
  let network = null, type = null;
  for (const [net, types] of Object.entries(NETWORKS)) {
    for (const [t, prefix] of Object.entries(types)) {
      if (prefix === vi.value) { network = net; type = t; }
    }
  }
  if (!network) return { ok: false, why: `unknown network prefix ${vi.value}` };
  if (!networks.includes(network)) return { ok: false, why: `${network} address — only ${networks.join('/')} accepted here` };

  const bodyLen = vi.length + 64 + (type === 'integrated' ? 8 : 0);
  if (raw.length !== bodyLen + 4) return { ok: false, why: `wrong decoded length for a ${type} address` };

  const body = raw.subarray(0, bodyLen);
  const check = raw.subarray(bodyLen);
  const digest = keccak256(body);
  for (let i = 0; i < 4; i++) {
    if (digest[i] !== check[i]) return { ok: false, why: 'checksum mismatch — the address contains a typo' };
  }

  const spend = raw.subarray(vi.length, vi.length + 32);
  const view = raw.subarray(vi.length + 32, vi.length + 64);
  if (!isEd25519Point(spend)) return { ok: false, why: 'public spend key is not a valid curve point' };
  if (!isEd25519Point(view)) return { ok: false, why: 'public view key is not a valid curve point' };
  return { ok: true, network, type };
}

/** Build an address from its parts. Test helper — never used to serve anything. */
export function encodeMoneroAddress(prefix, spend, view, paymentId = null) {
  const body = new Uint8Array(1 + 64 + (paymentId ? 8 : 0));
  body[0] = prefix;
  body.set(spend, 1);
  body.set(view, 33);
  if (paymentId) body.set(paymentId, 65);
  const full = new Uint8Array(body.length + 4);
  full.set(body);
  full.set(keccak256(body).subarray(0, 4), body.length);
  return moneroBase58Encode(full);
}
