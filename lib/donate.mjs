// lib/donate.mjs — donation methods, and the checks that stop a typo costing money.
//
// THE PROBLEM THIS SOLVES
// A donation address is a long random string that a human pastes once. If a
// single character is wrong, the money is gone with no error, no refund and no
// way to tell — the donor sees a normal-looking address and their wallet
// either rejects it (best case) or sends to nowhere. So every address is
// checksum-verified at load time, and a method whose address fails is DROPPED
// rather than served. A missing donate button costs nothing; a wrong one costs
// every donation until somebody notices.
//
// WHAT IS AND IS NOT VALIDATED
//   bech32   (BTC segwit, Pirate Chain zs…) — full checksum. Catches any single
//            character error, and most multi-character ones.
//   base58check (BTC legacy, Litecoin, Firo transparent, Dogecoin) — full
//            double-SHA256 checksum. Same guarantee.
//   EIP-55   (Ethereum) — the mixed-case checksum, via lib/keccak256.mjs.
//   Monero   — FULL verification (lib/monero-address.mjs): block-base58 decode,
//            MAINNET network prefix, exact length for the address type, the
//            Keccak-256 checksum, and both public keys checked as real Ed25519
//            points. This used to be a prefix/length/alphabet check that passed
//            any 95-character string starting with 4.
//   Solana   — there is NO checksum in the format. Base58, exactly 32 decoded
//            bytes, and the key must be a real Ed25519 curve point. The curve
//            check catches roughly half of all typos — which is why Solana is
//            reported as 'curve-point', not 'checksum'. Send a test transaction.
//
// None of these proves the address is YOURS. They prove it is well-formed and
// was not mistyped; ownership can only be confirmed by a test transaction.
//
// WHERE ADDRESSES LIVE
// data/donate.json declares WHICH methods exist; `addressEnv` names the
// environment variable holding each address, and the deployment supplies it.
// A committed address is a permanent, searchable link between this repository
// and a wallet — clones, forks and git history all keep it, and rotating does
// not erase the old one. Be clear about what that buys, though: a receiving
// address is PUBLIC by design and appears on the live page as soon as it is
// configured. Keeping it out of git stops it being bound to this codebase and
// its author; it does not make the address secret.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { keccak256Hex } from './keccak256.mjs';
import { verifyMoneroAddress } from './monero-address.mjs';
import { isEd25519Point } from './ed25519-point.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, '..', 'data', 'donate.json');

// ── base58check ────────────────────────────────────────────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58MAP = new Map([...B58].map((c, i) => [c, i]));

export function base58Decode(s) {
  let num = 0n;
  for (const ch of String(s)) {
    const v = B58MAP.get(ch);
    if (v === undefined) return null;          // not base58 at all
    num = num * 58n + BigInt(v);
  }
  const bytes = [];
  while (num > 0n) { bytes.unshift(Number(num & 0xffn)); num >>= 8n; }
  // Leading '1's are leading zero bytes, and they are significant.
  for (const ch of String(s)) { if (ch === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}

export function isBase58Check(addr) {
  const raw = base58Decode(addr);
  if (!raw || raw.length < 5) return false;
  const body = raw.slice(0, -4), want = raw.slice(-4);
  const h1 = createHash('sha256').update(body).digest();
  const got = createHash('sha256').update(h1).digest().subarray(0, 4);
  return want.every((b, i) => b === got[i]);
}

// ── bech32 (BIP-173) ───────────────────────────────────────────────────────
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
const expand = (hrp) => [...[...hrp].map(c => c.charCodeAt(0) >> 5), 0, ...[...hrp].map(c => c.charCodeAt(0) & 31)];

export function isBech32(addr) {
  const s = String(addr);
  // Mixed case is invalid per BIP-173 — it makes the checksum ambiguous.
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return false;
  const low = s.toLowerCase();
  const pos = low.lastIndexOf('1');
  if (pos < 1 || pos + 7 > low.length) return false;
  const hrp = low.slice(0, pos);
  const data = [];
  for (const ch of low.slice(pos + 1)) {
    const v = B32.indexOf(ch);
    if (v === -1) return false;
    data.push(v);
  }
  const chk = polymod([...expand(hrp), ...data]);
  // bech32 == 1, bech32m == 0x2bc830a3. Accept either: taproot and Sapling
  // shielded addresses are not the same variant, and both are legitimate here.
  return chk === 1 || chk === 0x2bc830a3;
}

// ── Monero ─────────────────────────────────────────────────────────────────
// A cheap SHAPE pre-check, kept for callers that only want to know whether a
// string could be a Monero address at all. It is NOT the validator — see
// isMoneroAddress below, which is what VALIDATORS uses.
export function looksLikeMonero(addr) {
  const s = String(addr);
  if (!/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(s)) return false;
  // 4… standard (95), 8… sub-address (95), 4…/8… integrated (106).
  if (/^4[0-9AB]/.test(s) && (s.length === 95 || s.length === 106)) return true;
  if (/^8/.test(s) && s.length === 95) return true;
  return false;
}

/** Full Monero verification — mainnet only. See lib/monero-address.mjs. */
export function isMoneroAddress(addr) {
  return verifyMoneroAddress(addr).ok;
}

/**
 * Solana: base58, exactly 32 bytes. Structure only — kept for callers that
 * want the shape; the validator is isSolanaWalletAddress.
 */
export function looksLikeSolana(addr) {
  const s = String(addr).trim();
  if (s.length < 32 || s.length > 44) return false;
  const raw = base58Decode(s);
  return !!raw && raw.length === 32;
}

/**
 * A Solana WALLET address: the shape above, plus the 32 bytes must be a real
 * Ed25519 curve point.
 *
 * Two mistakes this catches that the shape check cannot:
 *   · about half of all typos — a changed character usually lands off the curve;
 *   · pasting the wrong KIND of address. A USDC "token account" address (an
 *     Associated Token Account) is a program-derived address, deliberately OFF
 *     the curve. A Solana Pay link with spl-token= must name the OWNER wallet,
 *     and a donation sent to a token-account address as if it were a wallet
 *     cannot be spent by anyone holding a private key.
 *
 * Still no checksum exists, so this is reported as 'curve-point', never as
 * 'checksum'. Send a test transaction.
 */
export function isSolanaWalletAddress(addr) {
  const s = String(addr).trim();
  if (s.length < 32 || s.length > 44) return false;
  const raw = base58Decode(s);
  return !!raw && raw.length === 32 && isEd25519Point(raw);
}

/**
 * Ethereum, EIP-55 checksummed.
 *
 * An 0x address is 20 raw bytes with no checksum of its own. EIP-55 hides one in
 * the LETTER CASE: hash the lowercase hex, and each hex letter is uppercase when
 * its corresponding nibble is >= 8. That is a real integrity check — it catches
 * transposed and mistyped characters, which a `^0x[0-9a-f]{40}$` regex cannot.
 *
 * An all-lowercase (or all-uppercase) address is therefore UNVERIFIABLE: the
 * checksum simply is not present. This REJECTS those rather than waving them
 * through, because the whole contract of this module is that a bad address is a
 * missing button at boot instead of donations sent into a void. Every wallet and
 * explorer will hand you the mixed-case form; paste that.
 */
export function isEip55(addr) {
  const s = String(addr).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return false;
  const body = s.slice(2);
  // No mixed case means no checksum to check, so there is nothing to trust.
  if (body === body.toLowerCase() || body === body.toUpperCase()) return false;
  const hash = keccak256Hex(body.toLowerCase());
  for (let i = 0; i < 40; i++) {
    const c = body[i];
    if (c >= '0' && c <= '9') continue;
    const upper = parseInt(hash[i], 16) >= 8;
    if (c !== (upper ? c.toUpperCase() : c.toLowerCase())) return false;
  }
  return true;
}

/**
 * Which validator applies to which currency.
 *
 * `level` is what is reported to the operator and the donor, so a weaker check
 * can never pass itself off as a stronger one:
 *   checksum     a typo cannot pass
 *   curve-point  structure + a real curve point; no checksum exists (Solana)
 * `strict` is kept for existing callers: true only for 'checksum'.
 */
export const VALIDATORS = {
  xmr:  { strict: true,  test: isMoneroAddress, hint: 'a MAINNET 4…/8… address (95 or 106 chars) with a valid checksum' },
  arrr: { strict: true,  test: (a) => /^zs1/.test(a) && isBech32(a), hint: 'shielded zs1… (Sapling)' },
  firo: { strict: true,  test: isBase58Check, hint: 'transparent a…/Z… (base58check)' },
  btc:  { strict: true,  test: (a) => (/^(bc1)/i.test(a) ? isBech32(a) : isBase58Check(a)), hint: 'bc1… or 1…/3…' },
  ltc:  { strict: true,  test: (a) => (/^(ltc1)/i.test(a) ? isBech32(a) : isBase58Check(a)), hint: 'ltc1… or L…/M…' },
  doge: { strict: true,  test: isBase58Check, hint: 'D…' },
  sol:  { strict: false, level: 'curve-point', test: isSolanaWalletAddress, hint: 'a Solana WALLET address — base58, 32 bytes, on the Ed25519 curve (also receives USDC)' },
  // USDC is not a chain. This entry is USDC *on Solana*, so it validates as a
  // Solana address because that is exactly what it is — the same address that
  // receives SOL. USDC sent on Ethereum, Base or Polygon to this address is
  // unrecoverable, which is why the method's note names the network.
  usdc: { strict: false, level: 'curve-point', test: isSolanaWalletAddress, hint: 'the Solana WALLET address, not a token-account address (USDC is SPL, on Solana only)' },
  eth:  { strict: true,  test: isEip55, hint: 'EIP-55 mixed-case 0x… (an all-lowercase address carries no checksum)' },
  zec:  { strict: true,  test: (a) => (/^zs1/.test(a) ? isBech32(a) : isBase58Check(a)), hint: 'zs1… shielded or t1…' },
};

// Wallet-handoff schemes a method may use, per ticker. The `uri` built from
// these becomes an <a href> on the donate page, so a free-text scheme from the
// config file — `javascript`, say — would be a script link on a payment page.
// Allowlisted, not escaped: escaping cannot make a hostile scheme safe.
export const URI_SCHEMES = {
  xmr: ['monero'], btc: ['bitcoin'], ltc: ['litecoin'], doge: ['dogecoin'],
  eth: ['ethereum'], sol: ['solana'], usdc: ['solana'], zec: ['zcash'],
  firo: ['firo'], arrr: ['pirate'],
};
// A query string of URL-safe characters, e.g. ?spl-token=<mint>.
const URI_SUFFIX_RE = /^\?[A-Za-z0-9=&._~%-]{1,200}$/;

/** Validate one configured method. Returns { ok, why }. */
export function checkMethod(m) {
  if (!m || typeof m !== 'object') return { ok: false, why: 'not an object' };
  const kind = String(m.kind || '').toLowerCase();
  if (!m.id || !m.label) return { ok: false, why: 'needs id and label' };

  if (kind === 'link') {
    // A hosted page (Ko-fi, Liberapay, GitHub Sponsors, a bank's request-money
    // link). Must be https so we never send a donor somewhere downgradeable.
    let u;
    try { u = new URL(String(m.url || '')); } catch { return { ok: false, why: 'url is not a URL' }; }
    if (u.protocol !== 'https:') return { ok: false, why: 'url must be https' };
    return { ok: true };
  }

  if (kind === 'crypto') {
    const addr = String(m.address || '').trim();
    if (!addr) return { ok: false, why: 'no address set' };
    const t = String(m.ticker || '').toLowerCase();
    const v = VALIDATORS[t];
    if (!v) return { ok: false, why: `no validator for ticker "${t}"` };
    const level = v.level || (v.strict ? 'checksum' : 'shape-only');
    if (!v.test(addr)) return { ok: false, why: `address fails ${level} check (expected ${v.hint})` };
    if (m.uriScheme !== undefined && m.uriScheme !== '') {
      const allowed = URI_SCHEMES[t] || [];
      if (!allowed.includes(String(m.uriScheme).toLowerCase())) {
        return { ok: false, why: `uriScheme "${m.uriScheme}" is not allowed for ${t} (allowed: ${allowed.join(', ') || 'none'})` };
      }
    }
    if (m.uriSuffix !== undefined && m.uriSuffix !== '' && !URI_SUFFIX_RE.test(String(m.uriSuffix))) {
      return { ok: false, why: 'uriSuffix must be a plain query string like ?spl-token=<mint>' };
    }
    return { ok: true, strict: v.strict, level };
  }

  return { ok: false, why: `unknown kind "${kind}"` };
}

let mtime = -1;
let cache = { enabled: false, methods: [], problems: [] };

function compile(raw) {
  const methods = [];
  const problems = [];
  for (const m0 of (Array.isArray(raw?.methods) ? raw.methods : [])) {
    // Environment wins over the file. A method with an addressEnv that is unset
    // simply has no address, so it fails validation and is dropped — which is
    // the correct default for an unconfigured deployment.
    const m = { ...m0 };
    if (m.addressEnv) {
      const v = process.env[String(m.addressEnv)];
      if (v && String(v).trim()) m.address = String(v).trim();
    }
    const r = checkMethod(m);
    // r.why states WHY it failed and never echoes the address itself, so a
    // misconfigured address cannot leak into logs or a shared terminal.
    if (!r.ok) { problems.push(`${m?.id || '(no id)'}: ${r.why}`); continue; }
    const kind = String(m.kind).toLowerCase();
    methods.push(kind === 'crypto'
      ? {
          id: String(m.id), kind, label: String(m.label),
          ticker: String(m.ticker).toUpperCase(),
          address: String(m.address).trim(),
          // Wallet handoff: monero:ADDRESS opens a wallet app that registered
          // the scheme. Harmless when nothing handles it.
          //
          // `uriSuffix` is appended verbatim, for schemes that need a parameter
          // to be unambiguous. Solana Pay needs one: `solana:ADDR` means SOL,
          // and `solana:ADDR?spl-token=MINT` means that token. Without it a
          // USDC button would open a wallet prefilled to send SOL instead.
          // It carries a token MINT (a public global constant), never a
          // receiving address, so it is safe in git.
          uri: m.uriScheme
            ? `${String(m.uriScheme).toLowerCase()}:${String(m.address).trim()}${m.uriSuffix ? String(m.uriSuffix) : ''}`
            : '',
          note: m.note ? String(m.note) : '',
          verified: r.level,
        }
      : { id: String(m.id), kind, label: String(m.label), url: String(m.url), note: m.note ? String(m.note) : '' });
  }
  return {
    enabled: raw?.enabled !== false && methods.length > 0,
    heading: String(raw?.heading || 'Support ZoFHub'),
    blurb: String(raw?.blurb || ''),
    methods,
    problems,
  };
}

/** Hot-reloads like catalog-overrides: edit the JSON, no restart needed. */
export function getDonateConfig() {
  try {
    if (!existsSync(FILE)) {
      if (mtime !== 0) { cache = compile({}); mtime = 0; }
      return cache;
    }
    const mt = statSync(FILE).mtimeMs;
    if (mt === mtime) return cache;
    cache = compile(JSON.parse(readFileSync(FILE, 'utf8')));
    mtime = mt;
    if (cache.problems.length) {
      // Loud, because a dropped method is silently no donations from it.
      console.warn(`[donate] ${cache.problems.length} method(s) DROPPED: ${cache.problems.join(' | ')}`);
    }
    const weak = cache.methods.filter(m => m.verified !== 'checksum').map(m => `${m.ticker} (${m.verified})`);
    if (weak.length) console.warn(`[donate] no checksum exists for: ${weak.join(', ')} — send a test transaction before relying on these.`);
    console.log(`[donate] ${cache.methods.length} method(s) live: ${cache.methods.map(m => m.id).join(', ') || '(none)'}`);
  } catch (e) {
    console.warn('[donate] config load failed (donations disabled):', e.message);
    cache = { enabled: false, heading: '', blurb: '', methods: [], problems: [e.message] };
    mtime = -1;
  }
  return cache;
}
