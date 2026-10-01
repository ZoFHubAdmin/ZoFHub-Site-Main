// test/tool-safety.test.mjs — importing a tool must never mutate production.
// ---------------------------------------------------------------------------
// An ES module runs its top level the moment anything imports it. Every script
// in tools/ used to call its main work unconditionally at the top level, so
// `import('./tools/migrate-to-supabase.mjs')` did not inspect the migrator — it
// RAN one. That is not a hypothetical: it happened, and wrote 12,107 rows to
// the live catalog. The write turned out to be a value-for-value no-op
// re-import, which was luck rather than design.
//
// Plenty of ordinary things import a module without intending to run it: a test
// asserting an exported helper, an IDE's auto-import, a type-checker, a future
// script reusing one function. None of them pass a flag saying "and please
// rewrite the database".
//
// So: any tool that mutates the live database must refuse to act on import.
// This test finds those tools by reading the source rather than from a list,
// because a list is exactly the thing that goes stale when someone adds tool
// number twelve.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from '../tools/_is-main.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOOLS = join(ROOT, 'tools');

/** Does this source perform a write against the `games`/Supabase tables? */
function mutatesDatabase(src) {
  // .update( also matches Python-ish dict/header updates and Map.update in JS
  // helpers, so require it to be attached to a PostgREST-style chain.
  return /\.from\(['"][a-z_]+['"]\)[\s\S]{0,200}?\.(upsert|insert|update|delete)\(/.test(src)
    || /\.(upsert|insert)\(\s*(rows|batch|records|payload)/.test(src);
}

/** Is it protected — either by an isMain() gate or an outright import refusal? */
function isGuarded(src) {
  return src.includes('_is-main.mjs') && /isMain\(import\.meta\.url\)/.test(src);
}

const toolFiles = readdirSync(TOOLS)
  .filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
  .map((f) => ({ name: f, src: readFileSync(join(TOOLS, f), 'utf8') }));

describe('tools that write to the database refuse to run on import', () => {
  test('there are tools to check at all', () => {
    // If the detector silently matched nothing, every assertion below would
    // pass vacuously and this file would be decoration.
    assert.ok(toolFiles.length > 10, `only found ${toolFiles.length} tools — is the path right?`);
    const writers = toolFiles.filter((t) => mutatesDatabase(t.src));
    assert.ok(writers.length > 0, 'no database-writing tools detected — the detector is broken');
  });

  test('every database-writing tool is guarded', () => {
    const unguarded = toolFiles
      .filter((t) => mutatesDatabase(t.src) && !isGuarded(t.src))
      .map((t) => t.name);
    assert.deepEqual(unguarded, [],
      `these mutate the database but act on import: ${unguarded.join(', ')}\n`
      + 'Add `import { isMain } from \'./_is-main.mjs\';` and either gate main() '
      + 'with isMain(import.meta.url) or throw when it is false.');
  });

  test('the migrator specifically is gated rather than merely refusing', () => {
    // It has a real main(), so it can be imported harmlessly — which is nicer
    // than throwing, and lets a test read its exports.
    const src = readFileSync(join(TOOLS, 'migrate-to-supabase.mjs'), 'utf8');
    assert.match(src, /if \(isMain\(import\.meta\.url\)\) \{/);
    assert.ok(!/^main\(\)\.catch/m.test(src), 'main() is still called unconditionally at the top level');
  });
});

describe('isMain() decides correctly, and fails safe when unsure', () => {
  test('it is false for a module that is NOT the entry point', () => {
    // Note: under `node --test`, each test file IS spawned as its own entry
    // point, so import.meta.url here legitimately IS main. The meaningful case
    // is a different module — which is exactly the situation a tool is in when
    // something imports it.
    assert.equal(isMain(new URL('../lib/wisp-policy.mjs', import.meta.url).href), false);
    assert.equal(isMain(new URL('../tools/_is-main.mjs', import.meta.url).href), false);
  });

  test('it is true for whatever node was actually told to run', () => {
    const entry = process.argv[1];
    if (!entry) return;                       // no entry point to compare against
    const url = pathToFileURL(entry).href;
    assert.equal(isMain(url), true, `argv[1] (${entry}) should identify as main`);
  });

  test('missing or malformed input is NOT main', () => {
    // Failing safe matters more than being clever: a tool that stays quiet when
    // it cannot tell is a minor annoyance, one that writes to production
    // because a path comparison was inconclusive is not.
    for (const bad of [undefined, null, '', 'not-a-url', 'http://example.com/x.mjs']) {
      assert.equal(isMain(bad), false, `treated ${bad} as main`);
    }
  });
});

describe('the stream-json upgrade kept the migrator importable', () => {
  test('it uses the v3 lowercase ESM paths, not the v1 CommonJS ones', () => {
    const src = readFileSync(join(TOOLS, 'migrate-to-supabase.mjs'), 'utf8');
    assert.match(src, /from 'stream-json'/);
    assert.match(src, /stream-json\/filters\/pick\.js/);
    assert.match(src, /stream-json\/streamers\/stream-array\.js/);
    // v1 spellings would resolve to nothing under v3 and fail at import time.
    // Matched against the IMPORT statement, not a bare substring: the comment
    // above those imports legitimately names the old v1 paths to explain the
    // change, and a substring check flagged that comment as a real import.
    const importLines = src.split('\n').filter((l) => /^import\s/.test(l)).join('\n');
    assert.ok(!/StreamArray\.js/.test(importLines), 'still importing the v1 capitalised path');
    assert.ok(!/stream-json\/Parser\.js/.test(importLines), 'still importing the v1 Parser.js path');
  });

  test('stream-json is a devDependency, so it never reaches production', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.ok(!pkg.dependencies['stream-json'],
      'stream-json is in dependencies — it is used by one operator CLI tool and should not deploy');
    assert.ok(pkg.devDependencies['stream-json'], 'stream-json should be a devDependency');
  });
});
