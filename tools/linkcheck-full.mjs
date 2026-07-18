// tools/linkcheck-full.mjs — sweep the ENTIRE catalog's links in one run.
//
// The hourly cron checks 200 games at a time (full catalog ≈ 3.5 days).
// This tool loops runLinkCheck() until every game has been probed — use it
// after a bulk import, or whenever you want dead games hidden RIGHT NOW
// instead of waiting for the cron to work through the backlog.
//
//   npm run link-check:full
import { readFileSync } from 'node:fs';
for (const l of readFileSync('.env','utf8').split(/\r?\n/)){const m=l.match(/^([A-Z_]+)=(.*)$/); if(m) process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}
const { runLinkCheck } = await import('../lib/link-checker.mjs');
let totalChecked=0, totalDead=0;
const t0=Date.now();
for (let iter=1; iter<=16; iter++){
  const r = await runLinkCheck({ batchSize: 1000 });   // Supabase caps at 1000/query; loop covers the whole catalog
  totalChecked += r.checked; totalDead += r.dead;
  console.log(`[sweep] iter ${iter}: checked=${r.checked} dead=${r.dead} | cumulative checked=${totalChecked} dead=${totalDead}`);
  if (r.checked < 1000) break;
}
console.log(`[sweep] COMPLETE in ${((Date.now()-t0)/1000|0)}s — total checked=${totalChecked}, newly hidden(dead)=${totalDead}`);
