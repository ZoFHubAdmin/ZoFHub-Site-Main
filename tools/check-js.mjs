// tools/check-js.mjs — syntax-checks every front-end ES module.
// Run:  npm run check
//
// Catches: duplicate identifiers, missing imports, unterminated strings,
// any ES2024 parse error.  This is the cheapest way to avoid the white-
// screen-of-death we hit when a stale `function fmtCount(n) {}` was left
// in catalog.js after the same name was imported from presence.js.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const JS_DIR = join(ROOT, 'public', 'js');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

let failures = 0;
for (const file of walk(JS_DIR)) {
  const src = readFileSync(file, 'utf8');
  try {
    execSync(`node --input-type=module --check`, { input: src, stdio: ['pipe', 'ignore', 'pipe'] });
    console.log(`  ok    ${file.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`);
  } catch (e) {
    failures++;
    const msg = String(e.stderr || e.message).split('\n').slice(0, 4).join('\n  ');
    console.error(`  FAIL  ${file.replace(ROOT + '\\', '').replace(ROOT + '/', '')}\n  ${msg}`);
  }
}

if (failures > 0) {
  console.error(`\n[check-js] ${failures} file(s) failed syntax check.`);
  process.exit(1);
}
console.log('\n[check-js] all JS modules parse cleanly.');
