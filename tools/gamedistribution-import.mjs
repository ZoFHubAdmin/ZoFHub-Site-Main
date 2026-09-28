#!/usr/bin/env node
// tools/gamedistribution-import.mjs — run the GameDistribution import by hand.
//
//   npm run gd:import                    # DRY RUN against the live feed (default)
//   npm run gd:import -- --apply         # write to the database
//   npm run gd:import -- --only <id,id>  # restrict to these 32-hex ids
//   npm run gd:import -- --report out.json
//   npm run gd:import -- --no-auto-publish   # everything waits for review
//
// Same code path as the weekly cron and the console's "Run import" button
// (lib/gamedistribution-import.mjs). A dry run is the default because the first
// run on a fresh database inserts thousands of rows; look before you leap.
//
// --apply needs the control-plane migration on the database and the Supabase
// secret key in .env. Without them this refuses to write, and a dry run uses an
// in-memory store — it screens and plans the whole feed but saves nothing.

import '../lib/load-env.mjs';
import { writeFileSync } from 'node:fs';
import { getSupabaseAdmin } from '../lib/supabase.mjs';
import { createSupabaseStore } from '../lib/cms-store-supabase.mjs';
import { createMemoryStore } from '../lib/cms-store-memory.mjs';
import { createCmsService } from '../lib/cms-service.mjs';
import { runGdImport } from '../lib/gamedistribution-import.mjs';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

const apply = flag('--apply');
const autoPublish = !flag('--no-auto-publish');
const onlyIds = opt('--only') ? opt('--only').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
const reportPath = opt('--report');

if (onlyIds && onlyIds.some((id) => !/^[0-9a-f]{32}$/.test(id))) {
  console.error('--only takes comma-separated 32-character GameDistribution ids');
  process.exit(2);
}

let store;
const supa = getSupabaseAdmin();
if (supa) {
  const { error } = await supa.from('game_providers').select('id').limit(1);
  if (!error) store = createSupabaseStore(supa);
  else if (apply) {
    console.error('The control-plane migration is not applied to this database (supabase/migrations/20260101001080_control_plane.sql). Nothing written.');
    process.exit(1);
  }
}
if (!store) {
  if (apply) { console.error('--apply needs the Supabase secret key and the control-plane migration. Nothing written.'); process.exit(1); }
  store = createMemoryStore({ categories: ['arcade', 'casual', 'puzzle', 'adventure', 'racing', 'simulator', 'skill', 'girls',
    'shooting', 'action', 'strategy', 'match 3 games', 'mahjong connect', 'multiplayer', '2048 & merge', 'card games',
    'sports', 'brain games', 'bubble shooter', 'board'] });
  console.log('[gd-import] no control-plane database — dry run against an in-memory store (nothing is saved)');
  // Without the database, the existing catalog comes from the bundled export so
  // duplicate titles, slug collisions and games already present are detected as
  // they would be for real — a dry run against an EMPTY catalog overstates what
  // would be published.
  try {
    const { readFileSync } = await import('node:fs');
    const { createProviderIndex } = await import('../lib/provider-registry.mjs');
    const idx = createProviderIndex();
    const rows = JSON.parse(readFileSync(new URL('../data/games-export.json', import.meta.url), 'utf8'));
    const existing = rows.filter((r) => r && r.slug && r.title).map((r) => {
      const p = idx.forEmbedUrl(r.game_url || '');
      const gd = /gamedistribution\.com\/([0-9a-f]{32})/i.exec(r.game_url || '');
      return { id: r.id, slug: r.slug, title: r.title, provider_id: p ? p.id : null, external_id: p?.id === 'gamedistribution' && gd ? gd[1].toLowerCase() : null };
    });
    const base = store.catalogIndex.bind(store);
    store.catalogIndex = async () => [...await base(), ...existing];
    console.log(`[gd-import] compared against ${existing.length} games from data/games-export.json`);
  } catch (e) { console.warn('[gd-import] catalog export unavailable — duplicates will not be detected:', e.message); }
}

const cms = createCmsService({ store });
console.log(`[gd-import] ${apply ? 'IMPORT' : 'DRY RUN'} · auto-publish clean: ${autoPublish ? 'yes' : 'no'}${onlyIds ? ` · only ${onlyIds.length} id(s)` : ''}`);
const report = await runGdImport({ cms, store, autoPublish, dryRun: !apply, onlyIds, log: (m) => console.log(`[gd-import] ${m}`) });

console.log('\nfeed     ', JSON.stringify(report.feed));
console.log('counts   ', JSON.stringify(report.counts));
console.log('rejected ', JSON.stringify(report.rejectReasons));
console.log('flagged  ', JSON.stringify(report.flagCounts));
if (onlyIds) for (const p of report.planned) console.log(`  ${p.md5}  ${p.status.padEnd(15)} ${p.slug}  ${p.flags.join(',') || 'clean'}`);
if (reportPath) { writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); console.log(`\nfull report → ${reportPath}`); }
process.exit(0);
