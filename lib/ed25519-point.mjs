// ============================================================================
// ed25519-point.mjs — is these 32 bytes a real Ed25519 public key?
//
// Solana addresses and Monero's spend/view keys are Ed25519 points, encoded as
// 32 bytes. Neither Solana's base58 nor a length check can tell a real public
// key from 32 arbitrary bytes: roughly half of all random 32-byte strings do
// not correspond to any point on the curve at all. A donation address that is
// not a point can have NO private key — funds sent there are unspendable
// forever. That is exactly the failure this repository's donation validator
// exists to catch at boot rather than after the money is gone.
//
// This is RFC 8032 §5.1.3 point decoding, in BigInt, with no dependencies:
//
//   y  = the low 255 bits (little-endian); sign = bit 255
//   reject y >= p                        (non-canonical encoding)
//   x² = (y² − 1) / (d·y² + 1)  (mod p)  → must be a quadratic residue
//   reject x = 0 with sign = 1           (non-canonical encoding of x = 0)
//
// It also rejects the eight SMALL-ORDER points (including the identity) by
// checking that 8·P is not the identity. Those points decode perfectly well —
// 32 zero bytes, Solana's System Program address, is one — but no wallet key
// is ever one of them.
//
// WHAT IT DOES NOT CHECK: full prime-order subgroup membership for points of
// mixed order. A wallet never produces one, and the claim this module supports
// is exactly "canonically encoded, on the curve, not of small order".
// ============================================================================

const P = (1n << 255n) - 19n;

function mod(a) { const r = a % P; return r >= 0n ? r : r + P; }

function pow(base, exp) {
  let result = 1n, b = mod(base), e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

const inv = (a) => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

/**
 * True when `bytes` (length 32) canonically encodes a point on the Ed25519
 * curve other than the identity.
 */
export function isEd25519Point(bytes) {
  if (!bytes || bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  const sign = (y >> 255n) & 1n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;

  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = (v * v % P) * v % P;
  const v7 = (v3 * v3 % P) * v % P;
  let x = (u * v3 % P) * pow(u * v7 % P, (P - 5n) / 8n) % P;
  const vx2 = v * (x * x % P) % P;
  if (vx2 === u) {
    // x is a square root
  } else if (vx2 === mod(-u)) {
    x = (x * SQRT_M1) % P;
  } else {
    return false;                         // x² has no square root: not a point
  }
  if (x === 0n && sign === 1n) return false;
  if ((x & 1n) !== sign) x = P - x;
  // SMALL ORDER. Eight points on the curve have order dividing 8 (the identity
  // among them). They decode perfectly well — Solana's System Program address,
  // 32 zero bytes, is one — but no wallet key is ever one of them, and value
  // sent to one is unspendable. 8·P is the identity exactly for those points.
  let Q = { X: x, Y: y, Z: 1n, T: (x * y) % P };
  for (let i = 0; i < 3; i++) Q = add(Q, Q);
  if (Q.X === 0n && Q.Y === Q.Z) return false;
  return true;
}

// Extended twisted-Edwards addition (a = −1), RFC 8032 §5.1.4. The formula is
// complete for Ed25519, so it also doubles.
function add(p1, p2) {
  const A = mod((p1.Y - p1.X) * (p2.Y - p2.X));
  const B = mod((p1.Y + p1.X) * (p2.Y + p2.X));
  const C = mod(p1.T * 2n * D * p2.T);
  const Dd = mod(p1.Z * 2n * p2.Z);
  const E = mod(B - A), F = mod(Dd - C), G = mod(Dd + C), H = mod(B + A);
  return { X: mod(E * F), Y: mod(G * H), T: mod(E * H), Z: mod(F * G) };
}
