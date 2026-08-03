// tools/css-tokens.mjs — find colours that duplicate a design token.
//
// Run:  npm run css-tokens            report
//       npm run css-tokens -- --write rewrite exact duplicates to var(--token)
//
// WHY
// public/css/main.css defines a deliberate palette in :root, and then 156 hex
// literals across the stylesheets bypass it. Most are exact duplicates —
// #ffd426 written out 19 times when that IS --brand — so the palette is not
// actually one place any more, and changing the brand colour would leave 19
// stragglers behind.
//
// The near-misses matter more for how the site READS. Three yellows within a
// few percent of each other (#ffd426, #ffc400, #f5c518, #f8b34d) look like
// indecision rather than design: nobody chose four shades of the same yellow on
// purpose. Those are REPORTED, never rewritten — some are genuinely deliberate
// (a rating gold, a third party's brand colour) and collapsing them blindly
// would be a visual change disguised as a refactor.
//
// Only exact matches are rewritten, and only outside :root, so the output is a
// pure identity transform: the rendered pixels do not move.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CSS_DIR = join(ROOT, 'public', 'css');

const norm = (hex) => {
  let h = hex.toLowerCase().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 4) h = h.split('').map((c) => c + c).join('');
  return '#' + h;
};

/** Every --token: <colour> pair declared in a :root block. */
export function readTokens(css) {
  const tokens = new Map();               // normalised colour -> token name
  for (const block of css.matchAll(/:root\s*\{([\s\S]*?)\}/g)) {
    for (const m of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
      const key = norm(m[2]);
      // First declaration wins: later ones are usually theme overrides, and
      // pointing every use at the override would change what those uses mean.
      if (!tokens.has(key)) tokens.set(key, m[1]);
    }
  }
  return tokens;
}

/** Split a stylesheet into :root blocks (left alone) and everything else. */
function outsideRoot(css) {
  const spans = [];
  let last = 0;
  for (const block of css.matchAll(/:root\s*\{[\s\S]*?\}/g)) {
    spans.push([last, block.index]);
    last = block.index + block[0].length;
  }
  spans.push([last, css.length]);
  return spans;
}

/**
 * Character ranges holding the FALLBACK of a var() call: the literal in
 * `var(--brand, #ffd426)`.
 *
 * These must never be rewritten. The fallback exists precisely for the case
 * where custom properties are unavailable or the token is undefined, so
 * replacing it with another custom property — var(--brand, var(--brand)) —
 * removes the safety net while looking like a tidy-up. The first version of
 * this tool did exactly that across nine files.
 */
function varFallbackRanges(css) {
  const ranges = [];
  for (const m of css.matchAll(/var\(\s*--[a-z0-9-]+\s*,/gi)) {
    // Walk to the matching close paren so nested var() fallbacks are covered.
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < css.length && depth > 0) {
      if (css[i] === '(') depth++;
      else if (css[i] === ')') depth--;
      i++;
    }
    ranges.push([m.index, i]);
  }
  return ranges;
}

export function analyze(css, tokens) {
  const exact = [];
  const near = [];
  const dist = (a, b) => {
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  };
  const fallbacks = varFallbackRanges(css);
  const inFallback = (i) => fallbacks.some(([a, b]) => i >= a && i < b);

  for (const [from, to] of outsideRoot(css)) {
    const slice = css.slice(from, to);
    for (const m of slice.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const raw = m[0];
      if (raw.length === 9 || raw.length === 5) continue;   // has alpha; not a token
      if (inFallback(from + m.index)) continue;             // the var() safety net
      const key = norm(raw);
      if (tokens.has(key)) { exact.push({ raw, index: from + m.index, token: tokens.get(key) }); continue; }
      let best = null;
      for (const [tk, name] of tokens) {
        const d = dist(key, tk);
        if (d > 0 && d < 28 && (!best || d < best.d)) best = { d: Math.round(d), token: name, tokenHex: tk };
      }
      if (best) near.push({ raw, ...best });
    }
  }
  return { exact, near };
}

export function rewrite(css, tokens) {
  const { exact } = analyze(css, tokens);
  let out = css;
  // Back to front so earlier indices stay valid.
  for (const hit of [...exact].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, hit.index) + `var(${hit.token})` + out.slice(hit.index + hit.raw.length);
  }
  return { css: out, changed: exact.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const write = process.argv.includes('--write');
  const main = readFileSync(join(CSS_DIR, 'main.css'), 'utf8');
  const tokens = readTokens(main);
  console.log(`${tokens.size} colour token(s) declared in main.css :root\n`);

  let totalExact = 0;
  const nearAll = new Map();
  for (const file of readdirSync(CSS_DIR).filter((f) => f.endsWith('.css'))) {
    const p = join(CSS_DIR, file);
    const css = readFileSync(p, 'utf8');
    const { exact, near } = analyze(css, tokens);
    for (const n of near) {
      const k = `${n.raw} ≈ ${n.token} (${n.tokenHex}, Δ${n.d})`;
      nearAll.set(k, (nearAll.get(k) || 0) + 1);
    }
    if (!exact.length) continue;
    totalExact += exact.length;
    const byToken = exact.reduce((a, h) => (a[h.token] = (a[h.token] || 0) + 1, a), {});
    console.log(`${file.padEnd(20)} ${String(exact.length).padStart(3)} exact duplicate(s): ` +
      Object.entries(byToken).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join(', '));
    if (write) {
      const { css: next } = rewrite(css, tokens);
      if (next !== css) writeFileSync(p, next);
    }
  }

  console.log(`\n${totalExact} literal(s) duplicate a token exactly${write ? ' — rewritten to var()' : ''}.`);
  if (nearAll.size) {
    console.log(`\nNEAR-MISSES (reported only — collapsing these would change how the site looks):`);
    for (const [k, n] of [...nearAll.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
      console.log(`  ${String(n).padStart(3)}×  ${k}`);
    }
    console.log(`\n  Several shades of one colour read as indecision rather than design.`);
    console.log(`  Decide each one deliberately: fold it into the token, or keep it and say why.`);
  }
  if (!write && totalExact) console.log(`\nRe-run with --write to rewrite the exact duplicates.`);
}
