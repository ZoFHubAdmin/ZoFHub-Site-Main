// ZoFHub · qr.js — a QR encoder, byte mode, versions 1–12.
// ---------------------------------------------------------------------------
// WHY THIS IS GENERATED AND NOT A SAVED IMAGE.
//
// A donation QR encodes a wallet address. If that image is a file checked into
// the repo, nothing ties it to the address the site actually serves: change
// DONATE_XMR_ADDRESS and the picture beside it keeps pointing at the old
// wallet, silently, with no error anywhere. Money goes to the wrong place and
// the page still looks correct.
//
// Generating the code from the same string that is printed underneath it makes
// that failure structurally impossible. The QR and the text cannot disagree,
// because they are the same value rendered twice.
//
// WHY NO DEPENDENCY. The site's CSP allows scripts from 'self' only, so a CDN
// build would be blocked; and this repo already prefers a small readable
// implementation to a transitive tree (see lib/keccak256.mjs, the base58 decoder
// in lib/donate.mjs, the cookie parser in lib/admin-auth.mjs).
//
// Pure: no DOM, no globals. It returns a matrix or an SVG string, so it is
// testable from node and renderable in a browser.
// ---------------------------------------------------------------------------

// ── Capacity tables (versions 1–12) ────────────────────────────────────────
// Per version+level: [eccPerBlock, blocksG1, dataCwG1, blocksG2, dataCwG2].
// A crypto URI is at most ~110 bytes (a Monero address is 95 characters plus
// the scheme), which version 12 covers several times over at every level.
const ECC = {
  L: [[7,1,19,0,0],[10,1,34,0,0],[15,1,55,0,0],[20,1,80,0,0],[26,1,108,0,0],[18,2,68,0,0],
      [20,2,78,0,0],[24,2,97,0,0],[30,2,116,0,0],[18,2,68,2,69],[20,4,81,0,0],[24,2,92,2,93]],
  M: [[10,1,16,0,0],[16,1,28,0,0],[26,1,44,0,0],[18,2,32,0,0],[24,2,43,0,0],[16,4,27,0,0],
      [18,4,31,0,0],[22,2,38,2,39],[22,3,36,2,37],[26,4,43,1,44],[30,1,50,4,51],[22,6,36,2,37]],
  Q: [[13,1,13,0,0],[22,1,22,0,0],[18,2,17,0,0],[26,2,24,0,0],[18,2,15,2,16],[24,4,19,0,0],
      [18,2,14,4,15],[22,4,18,2,19],[20,4,16,4,17],[24,6,19,2,20],[28,4,22,4,23],[26,4,20,6,21]],
  H: [[17,1,9,0,0],[28,1,16,0,0],[22,2,13,0,0],[16,4,9,0,0],[22,2,11,2,12],[28,4,15,0,0],
      [26,4,13,1,14],[26,4,14,2,15],[24,4,12,4,13],[28,6,15,2,16],[24,3,12,8,13],[28,7,14,4,15]],
};
const TOTAL_CW = [26,44,70,100,134,172,196,242,292,346,404,466];
const ALIGN = [[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58]];
const ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

// ── GF(256), primitive polynomial 0x11D ────────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/**
 * Generator polynomial of the given degree, LEADING COEFFICIENT FIRST.
 *
 * The loop below accumulates lowest-term-first (index j+1 is one power of x
 * above index j), so the result is reversed before returning. eccBlock() does
 * synthetic division and indexes gen[1..n] as the non-leading coefficients —
 * handed the array the other way round it divides by a mirrored polynomial and
 * produces ECC bytes that are wrong for every block, which no structural check
 * notices because the symbol still looks like a QR code.
 *
 * Sanity: degree 10 must come out as the published exponents
 * 0 251 67 46 61 118 70 64 94 32 45.
 */
function genPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= mul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.reverse();
}

/** Reed–Solomon remainder for one block. */
function eccBlock(data, ecLen) {
  const gen = genPoly(ecLen);
  const rem = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let j = 0; j < ecLen; j++) rem[j] ^= mul(gen[j + 1], factor);
  }
  return rem;
}

// ── Bit stream ─────────────────────────────────────────────────────────────
class Bits {
  constructor() { this.bits = []; }
  push(value, len) { for (let i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1); }
  get length() { return this.bits.length; }
}

/** UTF-8 bytes, so a URI with any character encodes the same way the page shows it. */
const utf8 = (s) => Array.from(new TextEncoder().encode(String(s)));

// ── Format and version information ─────────────────────────────────────────
function formatBits(ecl, mask) {
  const data = (ECL_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

// ── Matrix construction ────────────────────────────────────────────────────
function blankMatrix(size) {
  return { m: Array.from({ length: size }, () => new Array(size).fill(null)), size };
}

function placeFunction(g, version) {
  const { m, size } = g;
  const setBox = (r, c, n, fn) => {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const rr = r + i, cc = c + j;
      if (rr >= 0 && rr < size && cc >= 0 && cc < size) m[rr][cc] = fn(i, j);
    }
  };
  // Finder patterns plus their separators.
  for (const [r, c] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    setBox(r - 1, c - 1, 9, (i, j) => {
      const ri = i - 1, ci = j - 1;
      if (ri < 0 || ri > 6 || ci < 0 || ci > 6) return false;          // separator
      const d = Math.max(Math.abs(ri - 3), Math.abs(ci - 3));
      return d !== 2;
    });
  }
  // Timing patterns.
  for (let i = 0; i < size; i++) {
    if (m[6][i] === null) m[6][i] = i % 2 === 0;
    if (m[i][6] === null) m[i][6] = i % 2 === 0;
  }
  // Alignment patterns, skipping the three finder corners.
  const centers = ALIGN[version - 1];
  for (const r of centers) for (const c of centers) {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
    setBox(r - 2, c - 2, 5, (i, j) => Math.max(Math.abs(i - 2), Math.abs(j - 2)) !== 1);
  }
  // The dark module is always set, and is a function module.
  m[size - 8][8] = true;
  // Reserve the format areas so data never lands there.
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = false;
    if (m[i][8] === null) m[i][8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = false;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = false;
  }
  // Version information blocks (version 7 and up).
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const r = Math.floor(i / 3), c = i % 3;
      m[size - 11 + c][r] = bit;
      m[r][size - 11 + c] = bit;
    }
  }
}

function writeFormat(g, ecl, mask) {
  const { m, size } = g;
  const bits = formatBits(ecl, mask);
  // ORIENTATION MATTERS AND IS EASY TO GET BACKWARDS. The specification is
  // usually written in (x=column, y=row) order; this matrix is m[row][column].
  // Transposing the two makes the 15-bit word come back REVERSED when read by a
  // real decoder — and because the reversal is still a well-formed BCH word, it
  // decodes to a valid-looking error level and mask rather than failing loudly.
  // The symbol then scans as nothing at all.
  //
  // Copy 1: bits 0-5 run DOWN column 8, then across row 8 leftwards.
  for (let i = 0; i <= 5; i++) m[i][8] = ((bits >>> i) & 1) === 1;
  m[7][8] = ((bits >>> 6) & 1) === 1;
  m[8][8] = ((bits >>> 7) & 1) === 1;
  m[8][7] = ((bits >>> 8) & 1) === 1;
  for (let i = 9; i < 15; i++) m[8][14 - i] = ((bits >>> i) & 1) === 1;

  // Copy 2: bits 0-7 along row 8 from the right edge; bits 8-14 down column 8
  // from the bottom. The dark module at (size-8, 8) sits between the two runs
  // and belongs to neither.
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = ((bits >>> i) & 1) === 1;
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = ((bits >>> i) & 1) === 1;
  m[size - 8][8] = true;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** The four penalty rules from the specification. Lower is better. */
function penalty(m, size) {
  let score = 0;
  const run = (get) => {
    for (let a = 0; a < size; a++) {
      let last = null, len = 0;
      for (let b = 0; b < size; b++) {
        const v = get(a, b);
        if (v === last) { len++; } else { last = v; len = 1; }
        if (len === 5) score += 3; else if (len > 5) score += 1;
      }
    }
  };
  run((r, c) => m[r][c]);
  run((c, r) => m[r][c]);

  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }

  const PAT = [true, false, true, true, true, false, true];
  const hasAt = (get, a, b) => {
    for (let i = 0; i < 7; i++) if (get(a, b + i) !== PAT[i]) return false;
    const before = [b - 4, b - 3, b - 2, b - 1].every((x) => x < 0 || get(a, x) === false);
    const after = [b + 7, b + 8, b + 9, b + 10].every((x) => x >= size || get(a, x) === false);
    return before || after;
  };
  for (let a = 0; a < size; a++) for (let b = 0; b <= size - 7; b++) {
    if (hasAt((x, y) => m[x][y], a, b)) score += 40;
    if (hasAt((x, y) => m[y][x], a, b)) score += 40;
  }

  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/**
 * Encode `text` as a QR matrix.
 * @returns {{modules: boolean[][], size: number, version: number}}
 */
export function qrMatrix(text, ecl = 'M', forceMask = null) {
  if (!ECC[ecl]) throw new Error('unknown error-correction level: ' + ecl);
  const bytes = utf8(text);

  // Smallest version that fits, so the code stays as coarse (and as scannable
  // on a phone screen) as the payload allows.
  let version = 0, cfg = null;
  for (let v = 1; v <= 12; v++) {
    const t = ECC[ecl][v - 1];
    const dataCw = t[1] * t[2] + t[3] * t[4];
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCw * 8) { version = v; cfg = t; break; }
  }
  if (!version) throw new Error(`payload too long for QR versions 1-12 (${bytes.length} bytes)`);

  const dataCw = cfg[1] * cfg[2] + cfg[3] * cfg[4];
  const bs = new Bits();
  bs.push(0b0100, 4);                                   // byte mode
  bs.push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) bs.push(b, 8);
  for (let i = 0; i < 4 && bs.length < dataCw * 8; i++) bs.bits.push(0);   // terminator
  while (bs.length % 8 !== 0) bs.bits.push(0);
  const words = [];
  for (let i = 0; i < bs.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bs.bits[i + j];
    words.push(v);
  }
  for (let pad = 0xec; words.length < dataCw; pad ^= 0xec ^ 0x11) words.push(pad);

  // Split into blocks, compute ECC, then interleave both halves.
  const blocks = [], eccs = [];
  let at = 0;
  for (let i = 0; i < cfg[1] + cfg[3]; i++) {
    const len = i < cfg[1] ? cfg[2] : cfg[4];
    const block = words.slice(at, at + len);
    at += len;
    blocks.push(block);
    eccs.push(eccBlock(block, cfg[0]));
  }
  const out = [];
  const maxData = Math.max(cfg[2], cfg[4]);
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < cfg[0]; i++) for (const e of eccs) out.push(e[i]);
  if (out.length !== TOTAL_CW[version - 1]) {
    throw new Error(`codeword count ${out.length} != ${TOTAL_CW[version - 1]} for version ${version}`);
  }

  const size = version * 4 + 17;
  const g = blankMatrix(size);
  placeFunction(g, version);

  // Zigzag placement, two columns at a time, skipping the vertical timing column.
  const bitAt = (i) => ((out[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
  let idx = 0, upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (g.m[r][c] !== null) continue;
        g.m[r][c] = idx < out.length * 8 ? bitAt(idx) : false;
        idx++;
      }
    }
    upward = !upward;
  }

  // Pick the mask with the lowest penalty.
  let best = null, bestScore = Infinity;
  for (let mask = forceMask === null ? 0 : forceMask;
       mask < (forceMask === null ? 8 : forceMask + 1); mask++) {
    const trial = g.m.map((row) => row.slice());
    const fn = MASKS[mask];
    // Re-derive which cells are data by rebuilding the function pattern.
    const fnOnly = blankMatrix(size);
    placeFunction(fnOnly, version);
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (fnOnly.m[r][c] === null && fn(r, c)) trial[r][c] = !trial[r][c];
    }
    writeFormat({ m: trial, size }, ecl, mask);
    const s = penalty(trial, size);
    if (s < bestScore) { bestScore = s; best = trial; }
  }
  return { modules: best, size, version };
}

/**
 * Render `text` as an SVG string. Sized in module units with a viewBox, so it
 * scales to whatever CSS gives it without resampling blur.
 */
export function qrSvg(text, { ecl = 'M', margin = 4, label = '' } = {}) {
  const { modules, size } = qrMatrix(text, ecl);
  const dim = size + margin * 2;
  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  const title = label ? `<title>${String(label).replace(/[&<>"]/g, '')}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="${String(label || 'QR code').replace(/[&<>"]/g, '')}">` +
    `${title}<rect width="${dim}" height="${dim}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/></svg>`;
}
