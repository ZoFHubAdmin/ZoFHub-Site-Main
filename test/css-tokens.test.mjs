// Design-token discipline.
//
// main.css declares a deliberate palette in :root. Every hex literal elsewhere
// that duplicates one exactly is a place the palette is no longer one place —
// change --brand and the stragglers stay the old colour. This test keeps the
// count at zero so the drift cannot come back one commit at a time.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTokens, analyze, rewrite } from '../tools/css-tokens.mjs';

const CSS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'public', 'css');
const tokens = readTokens(readFileSync(join(CSS, 'main.css'), 'utf8'));

describe('the palette stays in one place', () => {
  test('main.css declares a real palette', () => {
    assert.ok(tokens.size >= 15, `only ${tokens.size} colour tokens parsed — the parser broke, not the CSS`);
  });

  test('no stylesheet hard-codes a colour that is already a token', () => {
    const offenders = [];
    for (const f of readdirSync(CSS).filter((n) => n.endsWith('.css'))) {
      for (const hit of analyze(readFileSync(join(CSS, f), 'utf8'), tokens).exact) {
        offenders.push(`${f}: ${hit.raw} is ${hit.token}`);
      }
    }
    assert.deepEqual(offenders, [], 'run: npm run css-tokens -- --write');
  });
});

describe('the rewriter cannot damage a fallback', () => {
  // REGRESSION: the first version rewrote the literal inside var(--brand,
  // #ffd426) to var(--brand, var(--brand)) across nine files. The fallback
  // exists for the case where the custom property is unavailable, so replacing
  // it with another custom property removes the safety net entirely.
  test('a var() fallback literal is left alone', () => {
    const css = '.a{color:var(--brand,#ffd426)}';
    assert.equal(rewrite(css, tokens).changed, 0);
    assert.equal(rewrite(css, tokens).css, css);
  });

  test('nested var() fallbacks are also protected', () => {
    const css = '.a{color:var(--x,var(--brand,#ffd426))}';
    assert.equal(rewrite(css, tokens).css, css);
  });

  test('a bare literal outside any var() is still rewritten', () => {
    const out = rewrite('.a{color:#ffd426}', tokens);
    assert.equal(out.changed, 1);
    assert.match(out.css, /var\(--brand\)/);
  });

  test('one declaration can hold both a fallback and a bare literal', () => {
    const out = rewrite('.a{color:var(--x,#ffd426);background:#ffd426}', tokens);
    assert.equal(out.changed, 1, 'only the bare one');
    assert.match(out.css, /var\(--x,#ffd426\)/, 'the fallback survives verbatim');
    assert.match(out.css, /background:var\(--brand\)/);
  });

  test(':root itself is never rewritten', () => {
    // Rewriting a token to reference itself would be a circular definition.
    const css = ':root{--brand:#ffd426}\n.a{color:#ffd426}';
    const out = rewrite(css, tokens);
    assert.match(out.css, /--brand:#ffd426/);
    assert.equal(out.changed, 1);
  });

  test('colours with alpha are not treated as tokens', () => {
    const css = '.a{color:#ffd42680}';
    assert.equal(rewrite(css, tokens).changed, 0);
  });
});
