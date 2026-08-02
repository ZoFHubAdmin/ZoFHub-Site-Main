// Supply-chain / install-time regression tests.
//
// No dependency is allowed to execute code while it installs. These tests guard
// the settings that enforce that, and — just as importantly — guard the deploy,
// because one dependency's install script does not build anything: it ABORTS
// the install. Losing ignore-scripts is not a security nit here, it is a broken
// production build.
//
// Pure filesystem + require(). No server, no network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'noop.cjs'));
const NODE_MODULES = join(root, 'node_modules');
const haveModules = existsSync(NODE_MODULES);

// Packages whose install scripts have been read and deliberately left blocked.
// A package appearing here that is NOT in this list means a dependency gained
// the ability to run code at install time — review it before adding it.
const REVIEWED = new Set([
  '@mercuryworkshop/scramjet', // preinstall: `npx only-allow pnpm` — exits 1 under npm
  'bufferutil',                // install: node-gyp-build — prebuilt binaries ship in the package
]);

describe('install scripts are disabled everywhere npm runs', () => {
  test('.npmrc sets ignore-scripts=true', () => {
    // REGRESSION: @mercuryworkshop/scramjet declares `preinstall: npx only-allow
    // pnpm`, which exits 1 under an npm user agent. npm 11.6+ happens to gate
    // install scripts behind `npm approve-scripts`, so a current npm survives by
    // accident — but render.yaml pins NODE_VERSION=22, which ships npm 10 and
    // has no such gate. Without this setting `npm ci --omit=dev` dies at
    // preinstall on the deploy host while working fine on the developer's
    // machine, which is the worst shape a build failure can take.
    const npmrc = readFileSync(join(root, '.npmrc'), 'utf8');
    const lines = npmrc.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
    assert.ok(
      lines.some(l => /^\s*ignore-scripts\s*=\s*true\s*$/.test(l)),
      'ignore-scripts=true must stay in .npmrc — the deploy build depends on it',
    );
  });

  test('the Dockerfile has .npmrc in place before it installs', () => {
    // REGRESSION: the install layer was `COPY package*.json ./` followed by
    // `npm install`. That glob does not match .npmrc, so the setting above only
    // arrived with the later `COPY . .` — after the install had already run its
    // scripts and failed.
    const df = readFileSync(join(root, 'Dockerfile'), 'utf8').split(/\r?\n/);
    const installAt = df.findIndex(l => /^\s*RUN\s+.*\bnpm\s+(ci|install)\b/.test(l));
    assert.notEqual(installAt, -1, 'expected an npm install layer in the Dockerfile');
    const copiedBefore = df.slice(0, installAt).some(l => /^\s*COPY\b.*\.npmrc\b/.test(l));
    assert.ok(copiedBefore, '.npmrc must be COPYed before the npm install layer, not after');
  });
});

describe('nothing in the tree needs a compiler', () => {
  test('bufferutil resolves a prebuilt binary, so no node-gyp run is required', (t) => {
    // This is why blocking bufferutil's `install: node-gyp-build` is safe rather
    // than merely tolerable. node-gyp-build looks for prebuilds at REQUIRE time,
    // not install time, and bufferutil ships them for linux-x64 (the deploy),
    // win32-x64 and darwin-*. If this ever fails, `ws` still works — it falls
    // back to a JS implementation — but the deploy would then need Python and a
    // C++ toolchain, so it is worth knowing.
    if (!haveModules) return t.skip('node_modules not installed');

    // Resolved the way `ws` actually reaches it — from inside the Wisp package —
    // rather than by bare require() from here. bufferutil is a TRANSITIVE
    // dependency, so a bare require only works while npm happens to hoist it to
    // the top level; asserting on the hoisted copy would test npm's layout
    // rather than the tunnel's real dependency.
    const wispEntry = require.resolve('@mercuryworkshop/wisp-js/server');
    const fromWisp = createRequire(wispEntry);
    const bufferutilDir = dirname(fromWisp.resolve('bufferutil'));
    const bufferutil = fromWisp('bufferutil');
    assert.equal(typeof bufferutil.mask, 'function', 'native addon did not load');

    const out = Buffer.alloc(4);
    bufferutil.mask(Buffer.from([1, 2, 3, 4]), Buffer.from([9, 9, 9, 9]), out, 0, 4);
    assert.deepEqual([...out], [8, 11, 10, 13], 'addon loaded but does not compute');

    assert.ok(
      !existsSync(join(bufferutilDir, 'build')),
      'a build/ directory means something invoked node-gyp — the prebuilds stopped matching',
    );
  });
});

describe('copyleft compliance survives a dependency change', () => {
  // ZoFHub serves six AGPL-3.0 engines and one LGPL-3.0 library to visitors.
  // lib/licenses.mjs reads each license text and version straight out of
  // node_modules so the AGPL §13 source offer describes the code actually
  // running. That makes a dependency change a LEGAL regression risk, not just a
  // build one — and it fails silently, as a console.warn nobody reads.
  test('every served component resolves a license text and a version', async (t) => {
    if (!haveModules) return t.skip('node_modules not installed');
    const { getComponents } = await import('../lib/licenses.mjs');
    const components = getComponents();
    assert.ok(components.length >= 8, 'component list shrank unexpectedly');

    const noText = components.filter(c => !c.licenseAvailable).map(c => c.id);
    assert.deepEqual(noText, [], `served with NO license text: ${noText.join(', ')}`);

    // `pkg: null` means vendored in-repo (GUST) and legitimately has no npm
    // version. Everything else must report one, or the source offer names a
    // version that is not what is deployed.
    const noVersion = components.filter(c => c.pkg && !c.version).map(c => c.id);
    assert.deepEqual(noVersion, [], `no resolvable version for: ${noVersion.join(', ')}`);
  });

  test('the libcurl.js bundle served to browsers is the version we claim', (t) => {
    // REGRESSION GUARD: public/gust/vendor/libcurl_full.js is what visitors
    // execute, but /licenses.json reports the version of the libcurl.js NPM
    // package and asserts `modified: false`. Nothing linked those two facts, so
    // a routine bump of libcurl.js would have kept the vendored bytes at the old
    // build while the manifest started advertising the new version — an
    // inaccurate LGPL-3.0 §4 notice produced by an ordinary dependency update.
    // This is also why package.json pins libcurl.js exactly instead of ^-ranging
    // it: the pin and this test are the same decision.
    if (!haveModules) return t.skip('node_modules not installed');
    const vendored = join(root, 'public', 'gust', 'vendor', 'libcurl_full.js');
    const packaged = join(dirname(require.resolve('libcurl.js')), 'libcurl_full.js');
    if (!existsSync(vendored)) return t.skip('GUST vendor bundle not present');
    assert.ok(existsSync(packaged), 'libcurl.js package no longer ships libcurl_full.js');

    // Newline-normalised: the working copy is CRLF on Windows checkouts, and
    // that difference is not a difference in the code being served.
    const norm = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(
      norm(vendored), norm(packaged),
      'the vendored GUST bundle no longer matches the pinned libcurl.js package — '
      + 're-vendor it, or /licenses.json is advertising a version that is not being served',
    );
  });
});

describe('dependency install scripts stay under review', () => {
  test('no unreviewed package can run code at install time', (t) => {
    // The standard npm attack: a compromised transitive dependency publishes a
    // patch release that adds a postinstall. ignore-scripts already neuters it;
    // this test is what makes it VISIBLE instead of silent.
    if (!haveModules) return t.skip('node_modules not installed');

    const dirs = [];
    for (const name of readdirSync(NODE_MODULES)) {
      if (name.startsWith('.')) continue;
      if (name.startsWith('@')) {
        const scope = join(NODE_MODULES, name);
        for (const inner of readdirSync(scope)) dirs.push([`${name}/${inner}`, join(scope, inner)]);
      } else {
        dirs.push([name, join(NODE_MODULES, name)]);
      }
    }

    const found = [];
    for (const [name, dir] of dirs) {
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest)) continue;
      let scripts;
      try { scripts = JSON.parse(readFileSync(manifest, 'utf8')).scripts; } catch { continue; }
      if (!scripts) continue;
      if (['preinstall', 'install', 'postinstall'].some(k => scripts[k])) found.push(name);
    }

    assert.ok(found.length > 0, 'found no install scripts at all — the scan is probably broken');

    const unreviewed = found.filter(n => !REVIEWED.has(n)).sort();
    assert.deepEqual(unreviewed, [], `unreviewed install scripts: ${unreviewed.join(', ')}`);
  });
});
