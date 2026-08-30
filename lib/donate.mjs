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
//   Monero   — prefix, length and alphabet ONLY. Monero's checksum is Keccak-256,
//            which is NOT the same as node:crypto's sha3-256 (different padding),
//            and pulling in a Keccak implementation for one check is not worth
//            the dependency. Stated plainly rather than implied: an XMR address
//            here is checked for shape, not proven correct. Send yourself a test
//            transaction before publishing one.
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

// ── Monero (shape only — see the header) ───────────────────────────────────
export function looksLikeMonero(addr) {
  const s = String(addr);
  if (!/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(s)) return false;
  // 4… standard (95), 8… sub-address (95), 4…/8… integrated (106).
  if (/^4[0-9AB]/.test(s) && (s.length === 95 || s.length === 106)) return true;
  if (/^8/.test(s) && s.length === 95) return true;
  return false;
}

/**
 * Which validator applies to which currency.
 *
 * `strict: false` means "shape-checked only" and the caller is told so, rather
 * than a weak check quietly passing for a strong one.
 */
export const VALIDATORS = {
  xmr:  { strict: false, test: looksLikeMonero, hint: '4… or 8…, 95 or 106 chars' },
  arrr: { strict: true,  test: (a) => /^zs1/.test(a) && isBech32(a), hint: 'shielded zs1… (Sapling)' },
  firo: { strict: true,  test: isBase58Check, hint: 'transparent a…/Z… (base58check)' },
  btc:  { strict: true,  test: (a) => (/^(bc1)/i.test(a) ? isBech32(a) : isBase58Check(a)), hint: 'bc1… or 1…/3…' },
  ltc:  { strict: true,  test: (a) => (/^(ltc1)/i.test(a) ? isBech32(a) : isBase58Check(a)), hint: 'ltc1… or L…/M…' },
  doge: { strict: true,  test: isBase58Check, hint: 'D…' },
  zec:  { strict: true,  test: (a) => (/^zs1/.test(a) ? isBech32(a) : isBase58Check(a)), hint: 'zs1… shielded or t1…' },
};

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
    if (!v.test(addr)) return { ok: false, why: `address fails ${v.strict ? 'checksum' : 'shape'} check (expected ${v.hint})` };
    return { ok: true, strict: v.strict };
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
          uri: m.uriScheme ? `${m.uriScheme}:${String(m.address).trim()}` : '',
          note: m.note ? String(m.note) : '',
          verified: r.strict ? 'checksum' : 'shape-only',
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
    const shape = cache.methods.filter(m => m.verified === 'shape-only').map(m => m.ticker);
    if (shape.length) console.warn(`[donate] shape-checked only (no checksum): ${shape.join(', ')} — send a test transaction before relying on these.`);
    console.log(`[donate] ${cache.methods.length} method(s) live: ${cache.methods.map(m => m.id).join(', ') || '(none)'}`);
  } catch (e) {
    console.warn('[donate] config load failed (donations disabled):', e.message);
    cache = { enabled: false, heading: '', blurb: '', methods: [], problems: [e.message] };
    mtime = -1;
  }
  return cache;
}
