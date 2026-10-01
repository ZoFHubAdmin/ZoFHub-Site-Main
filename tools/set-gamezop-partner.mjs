// tools/set-gamezop-partner.mjs
// ---------------------------------------------------------------------------
//   npm run gamezop -- --id YOUR_PARTNER_ID --dry-run    # preview
//   npm run gamezop -- --id YOUR_PARTNER_ID              # apply
//
// Point every Gamezop game at YOUR partner account and un-hide them.
//
// WHY THIS IS NEEDED
// The catalog carries 228 Gamezop games whose embed URLs are
// https://<partnerId>.play.gamezop.com/g/<gameCode> — and the partner id baked
// into them is NOT yours. It is split across two ids (`zv1y2i8p` and `4665`)
// belonging to other publishers, which is why data/catalog-overrides.json hides
// the whole host: playing them would have earned ad revenue for someone else.
//
// The game CODE is portable across partner ids (verified: a code minted under
// zv1y2i8p loads fine under 4665), so switching accounts is purely a hostname
// rewrite. What is NOT portable is the id itself — an invented one redirects to
// Gamezop's /en/intro page instead of the game, so this validates your id
// against the live service before touching anything.
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the URLs live in the
// database, not in a file).
// ---------------------------------------------------------------------------
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

// This is a CLI script, not a module: its top level mutates the live catalog.
// ESM runs that top level on import, so importing it would perform the write.
// Refuse loudly instead. Running it normally is unaffected.
import { isMain } from './_is-main.mjs';
if (!isMain(import.meta.url)) {
  throw new Error(
    'tools/set-gamezop-partner.mjs is a command-line script and must not be imported — ' +
    'importing it would run it against the live database. Run it with node instead.'
  );
}


const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const f of ['.env', '.env.example']) {
  const p = join(root, f);
  if (existsSync(p) && typeof process.loadEnvFile === 'function') { try { process.loadEnvFile(p); break; } catch {} }
}

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const idIdx = argv.indexOf('--id');
const PARTNER = idIdx >= 0 ? String(argv[idIdx + 1] || '').trim() : '';

if (!PARTNER || PARTNER.startsWith('--')) {
  console.error('Usage: npm run gamezop -- --id YOUR_PARTNER_ID [--dry-run]\n');
  console.error('Find your id in the Gamezop Business dashboard — it is the subdomain of');
  console.error('the custom weblink they give you, e.g. https://ab12cd34.play.gamezop.com');
  process.exit(1);
}
if (!/^[a-z0-9]{3,32}$/i.test(PARTNER)) {
  console.error(`"${PARTNER}" doesn't look like a Gamezop partner id (expected 3-32 letters/digits).`);
  process.exit(1);
}

// adminKey() accepts the new `sb_secret_…` key as well as the legacy JWT.
const { adminKey } = await import('../lib/supabase-keys.mjs');
const SB_URL = process.env.SUPABASE_URL, SB_KEY = adminKey();
if (!SB_URL || !SB_KEY) { console.error('SUPABASE_URL / SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) not set.'); process.exit(1); }
const supa = createClient(SB_URL, SB_KEY);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---- 1. read every Gamezop row ------------------------------------------
console.log('Reading catalog…');
let rows = [], from = 0;
while (true) {
  const { data, error } = await supa.from('games').select('id, slug, game_url')
    .order('id', { ascending: true }).range(from, from + 999);
  if (error) { console.error('DB read failed:', error.message); process.exit(1); }
  if (!data?.length) break;
  rows = rows.concat(data); from += 1000;
  if (data.length < 1000) break;
}
const gz = rows.filter(g => /\.play\.gamezop\.com/i.test(String(g.game_url || '')));
console.log(`  ${rows.length} games | ${gz.length} Gamezop`);
if (!gz.length) { console.log('No Gamezop games found — nothing to do.'); process.exit(0); }

const currentIds = [...new Set(gz.map(g => { try { return new URL(g.game_url).hostname.split('.')[0]; } catch { return '?'; } }))];
console.log(`  current partner id(s): ${currentIds.join(', ')}`);
if (currentIds.length === 1 && currentIds[0] === PARTNER) {
  console.log(`\nAlready pointing at "${PARTNER}". Only the override rule may need clearing (see below).`);
}

// ---- 2. VALIDATE the id against the live service -------------------------
// An invalid id does not error — it quietly redirects to /en/intro, which would
// leave every tile opening a Gamezop landing page instead of a game. Check one
// real code under the new id before rewriting 228 rows.
const sampleCode = (() => { try { return new URL(gz[0].game_url).pathname.split('/g/')[1]; } catch { return null; } })();
if (!sampleCode) { console.error('Could not parse a game code to test with.'); process.exit(1); }
const testUrl = `https://${PARTNER}.play.gamezop.com/g/${sampleCode}`;
console.log(`\nValidating id against ${testUrl}`);
try {
  const r = await fetch(testUrl, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  const landed = new URL(r.url);
  const bounced = landed.hostname.split('.')[0] !== PARTNER || /\/intro/i.test(landed.pathname);
  if (!r.ok || bounced) {
    console.error(`  REJECTED — landed on ${r.url}`);
    console.error('  That is Gamezop bouncing an unrecognised partner id. Check the id in your');
    console.error('  dashboard; nothing has been changed.');
    process.exit(1);
  }
  console.log(`  OK — HTTP ${r.status}, served as ${PARTNER}. Id is live.`);
} catch (e) {
  console.error(`  Could not reach Gamezop (${e.message}). Nothing changed.`);
  process.exit(1);
}

// ---- 3. rewrite ----------------------------------------------------------
const updates = gz.map(g => {
  const u = new URL(g.game_url);
  u.hostname = `${PARTNER}.play.gamezop.com`;
  return { id: g.id, slug: g.slug, from: g.game_url, to: u.toString() };
}).filter(x => x.from !== x.to);

console.log(`\n${updates.length} row(s) to rewrite${DRY ? ' (DRY RUN)' : ''}`);
updates.slice(0, 3).forEach(u => console.log(`   ${u.slug}\n     ${u.from}\n  -> ${u.to}`));
if (updates.length > 3) console.log(`   … and ${updates.length - 3} more`);

if (!DRY) {
  let done = 0;
  for (const u of updates) {
    const { error } = await supa.from('games').update({ game_url: u.to }).eq('id', u.id);
    if (error) console.warn(`   ${u.slug}: ${error.message}`);
    else if (++done % 50 === 0) console.log(`   …${done}/${updates.length}`);
  }
  console.log(`  updated ${done}/${updates.length} rows`);
}

// ---- 4. un-hide ----------------------------------------------------------
// The rule is disabled by renaming the key rather than deleting the entry, so
// the decision (and the note explaining it) stays in version control and can be
// reverted by renaming it back.
const ovPath = join(root, 'data', 'catalog-overrides.json');
const doc = JSON.parse(readFileSync(ovPath, 'utf8'));
const before = (doc.remove || []).length;
let changed = 0;
doc.remove = (doc.remove || []).map(r => {
  if (r.hostIncludes === 'play.gamezop.com') {
    changed++;
    return { ...r, hostIncludes: undefined, 'hostIncludes.disabled': 'play.gamezop.com',
             _note: `DISABLED ${new Date().toISOString().slice(0,10)}: now using our own partner id "${PARTNER}", so these games earn for us. Re-enable by renaming the key back to hostIncludes.` };
  }
  return r;
}).map(r => { const o = { ...r }; if (o.hostIncludes === undefined) delete o.hostIncludes; return o; });

if (changed && !DRY) {
  writeFileSync(ovPath, JSON.stringify(doc, null, 2) + '\n');
}
console.log(`\nOverride rule: ${changed ? (DRY ? 'would be disabled' : 'disabled') : 'not found (already un-hidden?)'} (${before} remove rule(s) total)`);

console.log('\n' + '='.repeat(62));
if (DRY) {
  console.log('DRY RUN — nothing written. Re-run without --dry-run to apply.');
} else {
  console.log(`Done. ${updates.length} games now point at "${PARTNER}".`);
  console.log('Restart the server (npm start), then commit data/catalog-overrides.json.');
  console.log('The games appear within ~30 min, or immediately after a restart.');
}
