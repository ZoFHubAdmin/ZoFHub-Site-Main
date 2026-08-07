// tools/audit-licensing.mjs
// ---------------------------------------------------------------------------
// Copyright / licensing audit for the whole catalog. Classifies every game by
// (1) the DISTRIBUTOR that hosts it — the thing that actually determines whether
// you're licensed to embed it — and (2) a trademark/IP name check.
//
// NOT legal advice. It's a sourcing audit: embedded HTML5 games are legal to
// show when the host distributor licenses them for third-party embedding.
//
// TIERS
//   SAFE        GameMonetize / GameDistribution / Y8 embed — built to be embedded
//               on any site (their business model). Keep.
//   ACCOUNT     HTMLGames / Famobi / GameFlare — free to embed, but THROUGH their
//               official program / a free publisher account, not raw CDN hotlinks.
//               Action: register (free) & re-embed, OR remove.
//   PARTNER-ID  Gamezop — requires YOUR partner ID; current embeds use someone
//               else's. Action: sign up & re-embed under your ID, OR remove.
//   GRAY        OnlineGames.io — permits embedding via their codes but hotlink-
//               protects assets. Action: official embed, OR remove.
//   REMOVE      Unknown buckets / third-party affiliate links — no license chain.
//   TRADEMARK   Title hits a protected mark (any tier) — highest legal risk.
//
// USAGE
//   node tools/audit-licensing.mjs                 # classify + write report
//   node tools/audit-licensing.mjs --from-export   # use bundled export (offline)
//   node tools/audit-licensing.mjs --remove gamezop,onlinegames   # hide those
//                                                  hosts via catalog-overrides.json
//   (removal is reversible — it adds a urlIncludes rule, never touches the DB.)
// ---------------------------------------------------------------------------
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
for (const f of ['.env', '.env.example']) {
  const p = join(ROOT, f);
  if (existsSync(p) && typeof process.loadEnvFile === 'function') { try { process.loadEnvFile(p); } catch {} break; }
}

const argv = process.argv.slice(2);
const FROM_EXPORT = argv.includes('--from-export');
const removeArg = (() => { const i = argv.indexOf('--remove'); return i >= 0 ? (argv[i + 1] || '') : ''; })();

const OVERRIDES_PATH = join(ROOT, 'data', 'catalog-overrides.json');
const REPORT_PATH = join(ROOT, 'data', 'licensing-audit.json');

const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return '(none)'; } };

// host substring → { tier, distributor }
const DISTRIBUTORS = [
  { m: 'gamemonetize',     tier: 'SAFE',       name: 'GameMonetize',      note: 'Licensed for third-party embedding.' },
  { m: 'gamedistribution', tier: 'SAFE',       name: 'GameDistribution',  note: 'Licensed for third-party embedding.' },
  { m: 'y8.com',           tier: 'SAFE',       name: 'Y8 (embed)',        note: 'Y8 embed endpoint — embedding permitted.' },
  { m: 'htmlgames',        tier: 'ACCOUNT',    name: 'HTMLGames',         note: 'Use HTMLGames’ official free embed program; raw CDN hotlinks are blocked.', removeKey: 'htmlgames.com' },
  { m: 'famobi',           tier: 'ACCOUNT',    name: 'Famobi',            note: 'Needs a free Famobi publisher account + their feed.', removeKey: 'play.famobi.com' },
  { m: 'gameflare',        tier: 'ACCOUNT',    name: 'GameFlare',         note: 'Needs GameFlare’s distribution program.', removeKey: 'gameflare.com' },
  { m: 'gamezop',          tier: 'PARTNER-ID', name: 'Gamezop',           note: 'Embeds use ANOTHER publisher’s partner ID. Get your own or remove.', removeKey: 'play.gamezop.com' },
  { m: 'onlinegames.io',   tier: 'GRAY',       name: 'OnlineGames.io',    note: 'Permits embedding via their codes; hotlink-protected. Verify or remove.', removeKey: 'onlinegames.io' },
  { m: 'amazonaws',        tier: 'REMOVE',     name: 'Unknown S3 bucket', note: 'No license chain.', removeKey: 'amazonaws.com' },
];
function classify(url) {
  const h = hostOf(url);
  for (const d of DISTRIBUTORS) if (h.includes(d.m)) return d;
  return { tier: 'REVIEW', name: h, note: 'Unrecognized host — verify the source manually.' };
}

async function loadGames() {
  if (!FROM_EXPORT) {
    try {
      const { getSupabase } = await import('../lib/supabase.mjs');
      const supa = getSupabase();
      if (supa) {
        const rows = [];
        for (let from = 0; ; from += 1000) {
          const { data, error } = await supa.from('games').select('id, slug, title, game_url')
            .order('id', { ascending: true }).range(from, from + 999);
          if (error) throw error;
          rows.push(...(data || []));
          if (!data || data.length < 1000) break;
        }
        if (rows.length) { console.log(`[license] loaded ${rows.length} games from Supabase.`); return rows; }
      }
    } catch (e) { console.warn('[license] Supabase read failed, using bundled export:', e.message); }
  }
  const arr = JSON.parse(readFileSync(join(ROOT, 'data', 'games-export.json'), 'utf8'));
  console.log(`[license] loaded ${arr.length} games from data/games-export.json.`);
  return arr;
}

const { isTrademarkTitle } = await import('../lib/cron-jobs.mjs');
const games = await loadGames();

const byTier = {}, byDist = {}, lists = {}, trademark = [];
for (const g of games) {
  const d = classify(g.game_url);
  byTier[d.tier] = (byTier[d.tier] || 0) + 1;
  byDist[d.name] = (byDist[d.name] || 0) + 1;
  (lists[d.tier] = lists[d.tier] || []).push({ slug: g.slug, title: g.title, distributor: d.name, host: hostOf(g.game_url) });
  if (isTrademarkTitle(g.title)) trademark.push({ slug: g.slug, title: g.title, tier: d.tier });
}

const order = ['SAFE', 'ACCOUNT', 'PARTNER-ID', 'GRAY', 'REVIEW', 'REMOVE'];
console.log('\n===== LICENSING AUDIT =====');
for (const t of order) if (byTier[t]) console.log(`  ${t.padEnd(12)} ${byTier[t]}`);
console.log(`  TRADEMARK    ${trademark.length}   (title hits a protected mark)`);
console.log('\nby distributor:');
Object.entries(byDist).sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`  ${n.padEnd(22)} ${c}`));

const report = { generatedAt: new Date().toISOString(), disclaimer: 'Source-based audit, not legal advice.', byTier, byDistributor: byDist, trademark, lists };
writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
console.log(`\n[license] full per-tier lists → data/licensing-audit.json`);

if (removeArg) {
  const keys = removeArg.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const cfg = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
  cfg.remove = cfg.remove || [];
  // Match on HOST only (hostIncludes) so we don't false-match a distributor name
  // that appears in a query param like gd_sdk_referrer_url=https://onlinegames.io/.
  const have = new Set(cfg.remove.map(r => r.hostIncludes).filter(Boolean));
  let added = 0;
  for (const k of keys) {
    const d = DISTRIBUTORS.find(x => x.name.toLowerCase().includes(k) || x.m.includes(k));
    const inc = d?.removeKey || k;
    if (!have.has(inc)) { cfg.remove.push({ _note: `licensing: removed ${d?.name || k}`, hostIncludes: inc }); have.add(inc); added++; console.log(`[license] + remove rule: hostIncludes "${inc}"`); }
  }
  writeFileSync(OVERRIDES_PATH, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`[license] added ${added} removal rule(s) → catalog-overrides.json. Restart to apply: npm run restart`);
} else {
  console.log('\n[license] To hide a distributor you can’t license: node tools/audit-licensing.mjs --remove gamezop,onlinegames');
}
process.exit(0);
