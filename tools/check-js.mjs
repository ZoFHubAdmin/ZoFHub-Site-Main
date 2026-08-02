// tools/check-js.mjs — syntax-checks every front-end ES module.
// Run:  npm run check
//
// Catches: duplicate identifiers, missing imports, unterminated strings,
// any ES2024 parse error.  This is the cheapest way to avoid the white-
// screen-of-death we hit when a stale `function fmtCount(n) {}` was left
// in catalog.js after the same name was imported from presence.js.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Every directory of first-party browser ES modules.
//
// admin-ui/assets was missing here, which meant the administrator console — the
// one page in the site where a white screen locks you out of your own tooling —
// was the ONLY front-end code with no syntax gate at all. Nothing on the server
// imports it (it is served as a static asset), so `node --check server.js` and
// the test suite both sail past a parse error in it.
//
// Only module-mode directories belong in this list: everything here is loaded
// with <script type="module">, and --input-type=module implies strict mode, so
// adding a classic script or a vendored service worker would produce false
// failures rather than real ones.
const JS_DIRS = [
  join(ROOT, 'public', 'js'),
  join(ROOT, 'admin-ui', 'assets'),
];

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

const targets = JS_DIRS.filter(d => existsSync(d)).flatMap(walk);
if (targets.length === 0) {
  console.error('[check-js] found no modules to check — JS_DIRS is wrong, not the code.');
  process.exit(1);
}

let failures = 0;
for (const file of targets) {
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
