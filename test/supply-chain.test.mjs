// Supply-chain / install-time regression tests.
//
// No dependency is allowed to execute code while it installs. These tests guard
// the settings that enforce that, and — just as importantly — guard the deploy,
// because one dependency's install script does not build anything: it ABORTS
// the install. Losing ignore-scripts is not a security nit here, it is a broken
// production build.
//
// Pure filesystem. No server, no network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE_MODULES = join(root, 'node_modules');
const haveModules = existsSync(NODE_MODULES);

// Packages whose install scripts have been read and deliberately left blocked.
// A package appearing here that is NOT in this list means a dependency gained
// the ability to run code at install time — review it before adding it.
// (Empty today: the two entries that used to be here, scramjet's `preinstall: npx only-allow pnpm`
// and bufferutil's `install: node-gyp-build`, left the tree with the proxy browser.)
const REVIEWED = new Set([]);

describe('install scripts are disabled everywhere npm runs', () => {
  test('.npmrc sets ignore-scripts=true', () => {
    // HISTORY: this was added for @mercuryworkshop/scramjet, whose `preinstall: npx only-allow
    // pnpm` exits 1 under an npm user agent. npm 11.6+ gates install scripts behind
    // `npm approve-scripts`, but render.yaml pins NODE_VERSION=22, which ships npm 10 and has no
    // such gate. The package is gone; the setting stays as policy, because a dependency that runs
    // code while it installs is the standard supply-chain attack and a failing install on the
    // deploy host (while working on a developer's machine) is the worst shape a build failure takes.
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
  test('no installed package has been built from source (no node-gyp output anywhere)', (t) => {
    // The deploy image has no Python or C++ toolchain. A package that needs one would fail there while
    // working on a developer's machine. node-gyp leaves a build/ directory with a Makefile or
    // binding.gyp next to it; prebuilt-binary packages ship a prebuilds/ directory instead.
    if (!haveModules) return t.skip('node_modules not installed');
    const built = [];
    const scan = (dir, label) => {
      if (existsSync(join(dir, 'binding.gyp')) && existsSync(join(dir, 'build'))) built.push(label);
    };
    for (const name of readdirSync(NODE_MODULES)) {
      if (name.startsWith('.')) continue;
      if (name.startsWith('@')) {
        for (const inner of readdirSync(join(NODE_MODULES, name))) scan(join(NODE_MODULES, name, inner), `${name}/${inner}`);
      } else scan(join(NODE_MODULES, name), name);
    }
    assert.deepEqual(built, [], `packages built from source: ${built.join(', ')}`);
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

    // With no reviewed exceptions, "nothing found" is the healthy answer, so prove the scan itself works
    // by counting what it looked at instead.
    assert.ok(dirs.length > 50, `only ${dirs.length} packages scanned — the scan is probably broken`);

    const unreviewed = found.filter(n => !REVIEWED.has(n)).sort();
    assert.deepEqual(unreviewed, [], `unreviewed install scripts: ${unreviewed.join(', ')}`);
  });
});
