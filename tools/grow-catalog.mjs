// tools/grow-catalog.mjs
//
// Manually run ONE catalog-grow cycle — the same code the 3-day (72-hour) cron uses.
// Every game it adds is render-verified (liveness + framing + soft-404 +
// trusted host + not-a-fake-hash) so it can't introduce a black screen.
//
// Usage:
//   npm run grow                 # add up to 40 verified games to Supabase
//   node tools/grow-catalog.mjs --dry-run        # verify only, write nothing
//   node tools/grow-catalog.mjs --target=10      # add up to 10
//
// Unlike the cron, the CLI ignores the 3-day gate — it always runs now.

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
const targetArg = process.argv.find(a => a.startsWith('--target='));
const target = targetArg ? Math.max(1, parseInt(targetArg.split('=')[1]) || 0) : undefined;

const { growCatalogOnce } = await import('../lib/cron-jobs.mjs');

console.log(`[grow] starting ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${target ? ` (target=${target})` : ''}…`);
const stats = await growCatalogOnce({ dryRun: DRY_RUN, target });

console.log('\n[grow] summary:');
console.log(`  candidate pool : ${stats.pool}`);
console.log(`  fresh (new)    : ${stats.fresh}`);
console.log(`  verified       : ${stats.tested} tested → ${stats.verified} passed`);
console.log(`  ${DRY_RUN ? 'would insert' : 'inserted'}    : ${DRY_RUN ? (stats.eligible ?? 0) : stats.inserted}`);
if (stats.rejects && Object.keys(stats.rejects).length) {
  console.log(`  reject reasons : ${JSON.stringify(stats.rejects)}`);
}
process.exit(0);
