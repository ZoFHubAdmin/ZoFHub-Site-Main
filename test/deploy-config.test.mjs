// Deploy-configuration parity tests.
//
// render.yaml states, in a comment, that "every secret the app reads is declared
// here, even the optional ones" — because .env is COMMITTED in this repo and
// server.js loads it at boot, so any variable production does not declare is
// silently sourced from git. That was documentation asking to be believed.
// These tests make it true by construction.
//
// Pure filesystem. No server, no network, no credentials.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.cache', '.y8-cache', 'logs', 'data',
  'DayDream', 'Interstellar', 'NautilusOS', 'scramjet', 'licenses', 'legal', 'public',
]);

function sourceFiles(dir = root, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) sourceFiles(join(dir, e.name), out); }
    else if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

/** Every process.env key the code reads, mapped to the files that read it. */
function envReads() {
  const used = new Map();
  for (const f of sourceFiles()) {
    const rel = relative(root, f).split(sep).join('/');
    // Drop comment LINES only. Without this, prose like "downstream `if
    // (process.env.X)` checks" in lib/supabase-keys.mjs registers as a variable
    // named X and the whole audit becomes untrustworthy.
    //
    // Deliberately NOT a /* … */ regex: server.js contains 32 `/*` sequences and
    // only 16 `*/` (they appear inside strings, regexes and URLs), so a
    // non-greedy block strip silently deletes 62% of the file — and an audit
    // that skips most of the biggest source file reports "all clear" for
    // everything it never looked at. Line-anchored stripping cannot run away.
    const src = readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    for (const re of [/process\.env\.([A-Z_][A-Z0-9_]*)/g,
                      /process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        if (!used.has(m[1])) used.set(m[1], new Set());
        used.get(m[1]).add(rel);
      }
    }
  }
  return used;
}

// Provided by the platform (Render injects PORT; Node sets NODE_ENV), or read
// only by the test suite and local CLI tools that never run on the deploy host.
//
// The RENDER_* group is injected by Render into every service automatically and
// carries no secret — service name, region, git branch and commit. Declaring
// them in render.yaml would be wrong twice over: they are not ours to set, and
// a `sync: false` entry would make the deploy prompt for a value the platform
// already supplies. The admin System panel reads them to show where the running
// process came from, and they are simply absent off-Render.
const PLATFORM = new Set([
  'NODE_ENV', 'PORT', 'CI', 'HOME', 'USERPROFILE', 'PATH',
  'RENDER_SERVICE_NAME', 'RENDER_REGION', 'RENDER_GIT_COMMIT',
  'RENDER_GIT_BRANCH', 'RENDER_INSTANCE_ID',
]);
const isDeployCode = (files) => [...files].some(f => !f.startsWith('test/') && !f.startsWith('tools/'));

/**
 * Credential-bearing by NAME, not by curation — a hand-maintained allowlist is
 * exactly what fails to notice the next secret somebody adds.
 */
const looksLikeCredential = (name) =>
  /(^|_)(SECRET|TOKEN|PASSWORD|HASH|CREDENTIALS?)(_|$)/.test(name)
  || /_KEY(_|$)|^KEY$/.test(name)
  || /^(REDIS|UPSTASH_REDIS|DATABASE)_URL$/.test(name);

describe('render.yaml declares every credential the server reads', () => {
  test('no server-side secret can fall back to the committed .env', () => {
    const renderYaml = readFileSync(join(root, 'render.yaml'), 'utf8');
    const declared = new Set(
      [...renderYaml.matchAll(/^\s*-\s*key:\s*([A-Z_][A-Z0-9_]*)\s*$/gm)].map(m => m[1]),
    );
    assert.ok(declared.size > 10, 'parsed almost nothing out of render.yaml — the parser broke, not the config');

    const missing = [];
    for (const [name, files] of envReads()) {
      if (PLATFORM.has(name)) continue;
      if (!looksLikeCredential(name)) continue;
      if (!isDeployCode(files)) continue;
      if (declared.has(name)) continue;
      missing.push(`${name} (read by ${[...files].slice(0, 2).join(', ')})`);
    }
    assert.deepEqual(
      missing.sort(), [],
      'these credentials are read in production but not declared in render.yaml, '
      + 'so their values would come from the committed .env:\n  ' + missing.join('\n  '),
    );
  });

  test('render.yaml declares nothing the code never reads', () => {
    // A stale declaration is a smaller problem than a missing one, but it is
    // still a lie about what the service needs, and it invites someone to set a
    // value that does nothing.
    const renderYaml = readFileSync(join(root, 'render.yaml'), 'utf8');
    const declared = [...renderYaml.matchAll(/^\s*-\s*key:\s*([A-Z_][A-Z0-9_]*)\s*$/gm)].map(m => m[1]);
    const reads = envReads();
    const orphans = declared.filter(k => !reads.has(k) && !PLATFORM.has(k) && k !== 'NODE_VERSION');
    assert.deepEqual(orphans.sort(), [], `declared in render.yaml but never read: ${orphans.join(', ')}`);
  });
});

describe('.env.example documents what the code reads', () => {
  test('every variable the deploy reads appears in the template', () => {
    const example = readFileSync(join(root, '.env.example'), 'utf8');
    // Commented-out optional entries (`# FOO=`) count as documented — that is
    // the file's own convention for "optional, default in the code".
    const documented = new Set(
      [...example.matchAll(/^\s*#?\s*([A-Z_][A-Z0-9_]*)\s*=/gm)].map(m => m[1]),
    );

    // Accepted alternate spellings, explained in prose in the Supabase section
    // rather than given their own assignment lines.
    const PROSE_DOCUMENTED = new Set([
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
      'PROXY_NAUTILUS_PORT', 'PROXY_INTERSTELLAR_PORT',
      'PROXY_DAYDREAM_PORT', 'PROXY_NEBULA_PORT',
    ]);

    const undocumented = [];
    for (const [name, files] of envReads()) {
      if (PLATFORM.has(name) || PROSE_DOCUMENTED.has(name)) continue;
      if (!isDeployCode(files)) continue;
      if (!documented.has(name)) undocumented.push(name);
    }
    assert.deepEqual(undocumented.sort(), [],
      `read by the app but absent from .env.example: ${undocumented.join(', ')}`);
  });

  test('the template still contains no real-looking secret', () => {
    // A placeholder that drifts into a real value is the classic way a template
    // leaks. Check the shapes this project actually uses.
    const example = readFileSync(join(root, '.env.example'), 'utf8');
    for (const [label, re] of [
      ['Supabase secret key', /sb_secret_(?!your-)[A-Za-z0-9_-]{12,}/],
      ['Supabase publishable key', /sb_publishable_(?!your-)[A-Za-z0-9_-]{12,}/],
      ['a JWT', /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
      ['a scrypt password hash', /scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]{10,}/],
    ]) assert.ok(!re.test(example), `.env.example appears to contain ${label}`);
  });
});

describe('the Node version is the same everywhere', () => {
  test('engines, render.yaml, Dockerfile and CI agree', () => {
    // A deploy host on a different major than CI means CI is not testing what
    // ships. It is also how the scramjet preinstall problem stayed invisible:
    // npm 11 locally gates install scripts, npm 10 on Node 22 does not.
    const engines = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines?.node;
    assert.ok(engines, 'package.json must pin an engines.node range');
    const floor = /(\d+)/.exec(engines)[1];

    const render = /NODE_VERSION[\s\S]{0,40}?value:\s*"?(\d+)/.exec(readFileSync(join(root, 'render.yaml'), 'utf8'));
    assert.ok(render, 'render.yaml must set NODE_VERSION');
    assert.equal(render[1], floor, 'render.yaml NODE_VERSION differs from engines.node');

    const docker = /^FROM node:(\d+)/m.exec(readFileSync(join(root, 'Dockerfile'), 'utf8'));
    assert.ok(docker, 'Dockerfile must pin a node base image major');
    assert.equal(docker[1], floor, 'Dockerfile base image differs from engines.node');

    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const versions = [...ci.matchAll(/node-version:\s*"?(\d+)/g)].map(m => m[1]);
    assert.ok(versions.length >= 1, 'CI must pin a node-version');
    for (const v of versions) assert.equal(v, floor, 'a CI job runs a different Node major than the deploy');
  });
});
