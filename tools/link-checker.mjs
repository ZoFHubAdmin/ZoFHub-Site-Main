// tools/link-checker.mjs
//
// Standalone CLI runner — checks 50 of the oldest-checked working games
// and marks any that 404 / time out as is_working=false.
//
// NOTE: link-checking already runs automatically IN-PROCESS — lib/cron-jobs.mjs
// schedules it hourly ('0 * * * *') whenever the server is up. This CLI is for
// running a pass on demand:  npm run link-check
//
// (The old comment here described wiring an external cron to
// "/api/admin/run-link-check". No such route exists in server.js — following it
// would have produced a scheduler hitting a 404 forever. If you ever DO want
// external triggering, that route has to be built first.)

import '../lib/load-env.mjs';   // MUST be first — loads .env so getSupabase() sees your creds
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
