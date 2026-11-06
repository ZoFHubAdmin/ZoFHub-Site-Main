// Anything that boots server.js from a tool or a test must switch the cron jobs off.
//
// WHY. These children inherit the developer's real .env, Supabase admin key included.
// lib/cron-jobs.mjs runs a first link-check 30 s after boot whenever Supabase is configured,
// and lib/link-checker.mjs WRITES is_working=false to the live games table. A verification
// run that lives past 30 s therefore edits production data. On 2026-11-03 exactly that
// flipped twelve rows, and the cause was two spawners (tools/verify-ai.mjs and
// test/server.test.mjs) that had no CRON_DISABLED while the others did. CI is protected
// by a job-level variable; a developer's own `npm test` and `npm run verify-ai` were not.
//
// This is a source check on purpose: the failure only appears with real credentials, which
// no test environment has, so it can never be caught by running the thing.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = 'cron-isolation.test.mjs';

// spawn(process.execPath, ['server.js'] …) and its fork / execFile cousins.
const BOOTS_THE_SERVER = /\b(?:spawn|fork|execFile)\w*\(\s*process\.execPath\s*,\s*\[\s*['"]server\.js['"]/;

function scan(dir, suffix) {
  return readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(suffix) && f !== SELF)
    .map((f) => ({ file: `${dir}/${f}`, src: readFileSync(join(ROOT, dir, f), 'utf8') }));
}

const files = [...scan('tools', '.mjs'), ...scan('test', '.test.mjs')];
const spawners = files.filter(({ src }) => BOOTS_THE_SERVER.test(src));

describe('child servers started by tools and tests cannot run the live-database cron', () => {
  test('the scan finds the spawners it is meant to guard (so it cannot pass by matching nothing)', () => {
    assert.ok(spawners.length >= 8, `expected at least 8 server-booting files, found ${spawners.length}`);
    for (const must of ['tools/verify-ai.mjs', 'tools/gameflare-verify.mjs', 'test/server.test.mjs']) {
      assert.ok(spawners.some((s) => s.file === must), `${must} is no longer recognised as a spawner`);
    }
  });

  for (const { file, src } of spawners) {
    test(`${file} sets CRON_DISABLED`, () => {
      assert.match(src, /CRON_DISABLED\s*:\s*['"]1['"]/,
        `${file} boots server.js without CRON_DISABLED: '1'. Its child inherits the real .env and the `
        + 'first link-check, 30 s after boot, writes to the live games table.');
    });
  }
});
