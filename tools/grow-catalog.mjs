// tools/grow-catalog.mjs
//
// Manually run ONE catalog-grow cycle. Every game it adds is render-verified
// (liveness + framing + soft-404 + trusted host + not-a-fake-hash) so it can't
// introduce a black screen.
//
// THE CATALOG IS FROZEN at its baseline, and this is the operator path past that
// freeze — so writing REQUIRES --confirm. There is no longer a cron behind this
// code: the 36-hour 'grow' job was removed, and growCatalogOnce() refuses any
// unconfirmed non-dry-run write at the point of the write (lib/cron-jobs.mjs).
//
// Usage:
//   node tools/grow-catalog.mjs --dry-run        # verify only, write nothing
//   npm run grow -- --confirm                    # actually add verified games
//   node tools/grow-catalog.mjs --confirm --target=10
//
// `npm run grow` with no --confirm is a no-op that explains itself.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load .env BEFORE importing cron-jobs (its Supabase client reads env lazily,
// but the import chain is cleaner with env already present).
for (const f of ['.env', '.env.example']) {
  const p = join(ROOT, f);
  if (existsSync(p) && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(p); console.log(`[grow] loaded env from ${f}`); break; } catch {}
  }
}

const DRY_RUN = process.argv.includes('--dry-run');
const CONFIRM = process.argv.includes('--confirm');
const targetArg = process.argv.find(a => a.startsWith('--target='));
const target = targetArg ? Math.max(1, parseInt(targetArg.split('=')[1]) || 0) : undefined;

const { growCatalogOnce } = await import('../lib/cron-jobs.mjs');

console.log(`[grow] starting ${DRY_RUN ? 'DRY RUN' : (CONFIRM ? 'LIVE (confirmed)' : 'LIVE')}${target ? ` (target=${target})` : ''}…`);
const stats = await growCatalogOnce({ dryRun: DRY_RUN, target, confirm: CONFIRM });

if (stats.refused) {
  console.log('\n[grow] REFUSED — the catalog is frozen at its baseline.');
  console.log('  Nothing was written. Re-run with --confirm to add games deliberately,');
  console.log('  or with --dry-run to inspect the candidate pool.');
  process.exit(0);
}

console.log('\n[grow] summary:');
console.log(`  candidate pool : ${stats.pool}`);
console.log(`  fresh (new)    : ${stats.fresh}`);
console.log(`  verified       : ${stats.tested} tested → ${stats.verified} passed`);
console.log(`  ${DRY_RUN ? 'would insert' : 'inserted'}    : ${DRY_RUN ? (stats.eligible ?? 0) : stats.inserted}`);
if (stats.rejects && Object.keys(stats.rejects).length) {
  console.log(`  reject reasons : ${JSON.stringify(stats.rejects)}`);
}
process.exit(0);
