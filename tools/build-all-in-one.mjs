// tools/build-all-in-one.mjs
// ---------------------------------------------------------------------------
// Regenerate db/ALL-IN-ONE.sql — the whole database, schema then data, in one
// file for `psql "$SUPABASE_DB_URL" -f db/ALL-IN-ONE.sql`.
//
//   npm run build-all-in-one              # write
//   npm run build-all-in-one -- --check   # verify only; non-zero exit if stale
//
// WHY THIS EXISTS
// The file was generated once, on 2026-07-13, by something that is not in this
// repository — and then the schema moved on without it. By the time anyone
// looked it carried five of the twelve schema files: no admin tables, no
// feedback table, no fingerprints, and none of the leaderboard teardown. Running
// it produced a database where the admin console cannot log in (it fails closed
// on a missing admin_sessions), the feedback form 500s, the nightly retention
// job calls an RPC that does not exist, and the retired `scores` table is back
// and accruing rows. The header meanwhile said "The ENTIRE ZoFHub database in
// one file", and every doc pointed at it.
//
// A generated file with no generator in the tree cannot be kept honest, because
// nothing connects it to the thing it is generated FROM. So the generator lives
// here, it reads the same ORDER array the migrations do, and --check makes drift
// a failure rather than a discovery.
//
// SCHEMA ORDER IS NOT ALPHABETICAL and must not become so: db/feedback.sql drops
// tables that db/community.sql creates. ORDER encodes that dependency graph and
// is imported rather than restated, so there is exactly one copy of it.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'db', 'ALL-IN-ONE.sql');
const CHECK = process.argv.includes('--check');

const BANNER = '-- ' + '='.repeat(76) + '\n';

// The schema half, in dependency order. Parsed out of the sync tool rather than
// duplicated — two copies of an ordering drift, and this file exists because
// something drifted.
function schemaOrder() {
  const src = readFileSync(join(ROOT, 'tools', 'sync-supabase-migrations.mjs'), 'utf8');
  const start = src.indexOf('const ORDER');
  const end = src.indexOf('\n];', start);
  if (start === -1 || end === -1) {
    throw new Error('could not find the ORDER array in tools/sync-supabase-migrations.mjs');
  }
  const out = [];
  for (const m of src.slice(start, end).matchAll(/\[\s*'\d{14}'\s*,\s*'[a-z0-9_]+'\s*,\s*'([^']+)'/gi)) {
    out.push(m[1].replace(/^db\//, ''));
  }
  return out;
}

// The data half: every loader, in the order psql will apply them. Plain
// lexicographic sort, which is also what the numbered -partNN suffixes were
// named for. Superseded y8-games-0N.sql and the y8-games-check.sql helper are
// excluded — load-y8-games-part*.sql already covers them.
const loaderOrder = () =>
  readdirSync(join(ROOT, 'db')).filter((n) => n.startsWith('load-') && n.endsWith('.sql')).sort();

function header(schemaFiles, loaderFiles) {
  return BANNER
    + '-- ZoFHub · ALL-IN-ONE database bootstrap\n'
    + BANNER
    + '-- The ENTIRE ZoFHub database in one file: every schema file in dependency\n'
    + `-- order (${schemaFiles.length}), then every game loader (${loaderFiles.length}). Each loader is an\n`
    + '-- idempotent ON CONFLICT upsert, and every schema file is guarded with\n'
    + '-- IF NOT EXISTS / OR REPLACE, so the whole thing is safe to re-run.\n'
    + '--\n'
    + '-- GENERATED — do not edit. Regenerate with:  npm run build-all-in-one\n'
    + '-- The schema half comes from the ORDER array in\n'
    + '-- tools/sync-supabase-migrations.mjs, which is the same list that produces\n'
    + '-- supabase/migrations/. This file therefore cannot drift from the schema\n'
    + '-- that preview branches and production actually get.\n'
    + '--\n'
    + '-- SIZE: ~7 MB. The Supabase web SQL editor will NOT run something this\n'
    + '--    large (it caps around 1000 lines). Use psql:\n'
    + '--\n'
    + '--      psql "$SUPABASE_DB_URL" -f db/ALL-IN-ONE.sql\n'
    + '--\n'
    + '--    (Supabase → Project Settings → Database → Connection string → URI.\n'
    + '--     Or just run: npm run restore-games)\n'
    + '--\n'
    + '-- Superseded legacy files (y8-games-0N.sql) and the y8-games-check.sql\n'
    + '-- helper are intentionally excluded — load-y8-games-part*.sql covers them.\n'
    + BANNER;
}

// Source text is copied VERBATIM, not reformatted. That is what makes the output
// checkable: the loader half of this file regenerates byte-for-byte identical to
// the 2026-07-13 original, which is the evidence that this generator reproduces
// the format rather than merely resembling it.
function section(name) {
  const path = join(ROOT, 'db', name);
  if (!existsSync(path)) throw new Error(`missing source: db/${name}`);
  return BANNER + `-- >>> ${name}\n` + BANNER + readFileSync(path, 'utf8') + '\n\n';
}

function build() {
  const schemaFiles = schemaOrder();
  const loaderFiles = loaderOrder();
  if (!schemaFiles.length) throw new Error('ORDER parsed to zero schema files');
  const body = [...schemaFiles, ...loaderFiles].map(section).join('');
  return {
    // Exactly one newline at EOF. Each section ends with a blank line to
    // separate it from the next; the last one has no next, and a file that ends
    // in a blank line is a diff that never settles.
    text: (header(schemaFiles, loaderFiles) + '\n\n' + body).replace(/\n+$/, '\n'),
    schemaFiles,
    loaderFiles,
  };
}

const { text, schemaFiles, loaderFiles } = build();

if (CHECK) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== text) {
    console.error('db/ALL-IN-ONE.sql is stale.\n'
      + `  expected ${schemaFiles.length} schema file(s) + ${loaderFiles.length} loader(s), `
      + `${text.length} bytes; found ${current.length} bytes.\n`
      + '\nRun: npm run build-all-in-one');
    process.exit(1);
  }
  console.log(`db/ALL-IN-ONE.sql is current (${schemaFiles.length} schema + ${loaderFiles.length} loaders).`);
  process.exit(0);
}

writeFileSync(OUT, text);
console.log(`db/ALL-IN-ONE.sql written — ${schemaFiles.length} schema file(s), `
  + `${loaderFiles.length} loader(s), ${(text.length / 1e6).toFixed(1)} MB.`);
for (const f of schemaFiles) console.log(`  schema  ${f}`);
