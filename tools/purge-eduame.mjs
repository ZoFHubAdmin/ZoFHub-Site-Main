// tools/purge-eduame.mjs — one-off: remove the old "eduame.com" project domain
// from any game_url still baked in the DB (it appears in a few gd_sdk_referrer_url
// query params). The server already REWRITES gd_sdk_referrer_url to the real
// origin at serve time, so this is cosmetic — but it purges the old name at the
// source so a fresh `npm run export-games` never reintroduces it.
//
//   npm run purge-eduame          (or: node tools/purge-eduame.mjs)
import '../lib/load-env.mjs';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase.mjs';

// This is a CLI script, not a module: its top level mutates the live catalog.
// ESM runs that top level on import, so importing it would perform the write.
// Refuse loudly instead. Running it normally is unaffected.
import { isMain } from './_is-main.mjs';
if (!isMain(import.meta.url)) {
  throw new Error(
    'tools/purge-eduame.mjs is a command-line script and must not be imported — ' +
    'importing it would run it against the live database. Run it with node instead.'
  );
}


if (!isSupabaseConfigured()) { console.error('Supabase not configured — check .env'); process.exit(1); }
const supa = getSupabase();

const { data, error } = await supa.from('games').select('slug, game_url').ilike('game_url', '%eduame%');
if (error) { console.error('query failed:', error.message); process.exit(1); }
console.log(`Found ${data.length} game(s) with "eduame" in game_url.`);

let fixed = 0;
for (const g of data) {
  const next = g.game_url.replaceAll('eduame.com', 'zofhub.app');
  const { error: e2 } = await supa.from('games').update({ game_url: next }).eq('slug', g.slug);
  if (e2) console.error(`  FAIL ${g.slug}: ${e2.message}`);
  else { fixed++; console.log(`  fixed ${g.slug}`); }
}
console.log(`\nDone — ${fixed}/${data.length} updated. Re-run \`npm run export-games\` to refresh the local export.`);
process.exit(0);
