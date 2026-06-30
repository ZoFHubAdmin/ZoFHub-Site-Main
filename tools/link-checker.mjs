// tools/link-checker.mjs
//
// Standalone CLI runner — checks 50 of the oldest-checked working games
// and marks any that 404 / time out as is_working=false.
//
// Hook this up to:
//   - cron-job.org    (free,  http://cron-job.org → trigger /api/admin/run-link-check)
//   - GitHub Actions  (free, schedule: '0 */6 * * *')
//   - Render free cron (15 min minimum, free)
//   - Just run it manually:  node tools/link-checker.mjs

import { runLinkCheck } from '../lib/link-checker.mjs';

(async () => {
  const counters = await runLinkCheck({ batchSize: 50 });
  // Non-zero exit if Supabase wasn't even reachable, so cron platforms
  // can flag the job as failed and email you.
  process.exit(counters.supabaseDown ? 2 : 0);
})().catch(e => {
  console.error('[link-check] fatal:', e);
  process.exit(1);
});
