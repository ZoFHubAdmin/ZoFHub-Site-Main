// No invisible control characters in source.
//
// REGRESSION. The /api/frame-check rewrite shipped two regular expressions whose
// `\b` word boundaries had been turned into literal BACKSPACE characters (U+0008)
// by the tool that wrote the file:
//
//     /␈(deny|sameorigin)␈/i        instead of   /\b(deny|sameorigin)\b/i
//
// Neither ever matched, so the check reported sites that send
// `X-Frame-Options: DENY` or a restrictive `frame-ancestors` as embeddable. The
// characters are invisible in an editor and in a diff, the file parsed, and every
// test passed. An earlier edit hit the same class of fault with U+2028 inside a
// regex literal (a line terminator, so that one at least failed to parse).
//
// Nothing a person writes on purpose puts these code points in source, so their
// presence anywhere is a defect.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIRS = ['lib', 'test', 'tools', 'public/js', 'admin-ui', 'db', 'supabase/migrations', 'proxy-engine'];
const FILES = ['server.js'];
const EXT = /\.(m?js|cjs|sql|html|css)$/;

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'fixtures' || e.name === 'vendor' || e.name === 'assets' && dir.endsWith('proxy-engine')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.test(e.name)) out.push(p);
  }
  return out;
}

const BAD = (c) => (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f || c === 0x2028 || c === 0x2029;

describe('source files carry no invisible control characters', () => {
  const files = [...FILES.map((f) => join(ROOT, f)), ...DIRS.flatMap((d) => walk(join(ROOT, d)))];

  test('the scan covers the code that matters', () => {
    assert.ok(files.length > 100, `only ${files.length} files scanned`);
  });

  test('none contains C0 controls (other than tab/newline), DEL, U+2028 or U+2029', () => {
    const hits = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      let line = 1;
      for (const ch of src) {
        const c = ch.codePointAt(0);
        if (c === 0x0a) line++;
        else if (BAD(c)) { hits.push(`${relative(ROOT, f)}:${line} U+${c.toString(16).padStart(4, '0').toUpperCase()}`); break; }
      }
    }
    assert.deepEqual(hits, [], `invisible characters in source:\n  ${hits.join('\n  ')}`);
  });

  test('the frame check really tests for DENY / SAMEORIGIN and frame-ancestors', () => {
    const server = readFileSync(join(ROOT, 'server.js'), 'utf8');
    assert.ok(server.includes('/\\b(deny|sameorigin)\\b/i.test(xfo)'), 'the X-Frame-Options regex is not the word-bounded one');
    assert.ok(server.includes('/frame-ancestors\\b/i.test(csp)'), 'the frame-ancestors regex is not the word-bounded one');
    assert.equal(/\b(deny|sameorigin)\b/i.test('DENY'), true);
    assert.equal(/\b(deny|sameorigin)\b/i.test('SAMEORIGIN'), true);
  });
});
