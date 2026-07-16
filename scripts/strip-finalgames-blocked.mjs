// scripts/strip-finalgames-blocked.mjs
//
// One-shot hygiene pass for finalgames.json (the repo-root master catalog).
//
// finalgames.json ships ~1,450 games on distributor HOSTS that are permanently
// blocked at serve time by data/catalog-overrides.json for LICENSING reasons:
// HTMLGames (cdn.htmlgames.com — unlicensed, its ThirdParty.js frame-busts to
// "Internet allowance is over"), Gamezop (play.gamezop.com — removed), and an
// unlicensed S3 bucket. They are added by mergeFinalGames() then dropped again
// by applyCatalogOverrides() on every catalog build — pure bloat, and unlicensed
// content sitting in the repo source. This strips them from the file itself.
//
// SCOPE: HOST rules only. We deliberately do NOT bake in the override's slug/
// title `remove` rules, because those are reversible CURATION decisions (some of
// them currently hide games that now have WORKING copies in this file) and the
// games must stay in the file so the owner can un-hide them later. Host/licensing
// removes, by contrast, are permanent — even if a license is later obtained the
// embed URLs would be re-provisioned, so nothing of value is lost by stripping
// the current unlicensed URLs.
//
// It reads the SAME override JSON, so it stays in lockstep with the policy. The
// `.disabled` host rules (Famobi, OnlineGames, GameFlare — intentionally KEPT)
// naturally no-op here just as they do at serve time, because no real host
// contains the literal "...io.disabled". So this can never remove a game the
// live site still shows.
//
// Safe to re-run: idempotent. Backs up the original next to itself first.
//
// Usage:  node scripts/strip-finalgames-blocked.mjs [--dry]

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FINAL = join(ROOT, 'finalgames.json');
const OVERRIDES = join(ROOT, 'data', 'catalog-overrides.json');
const DRY = process.argv.includes('--dry');

// server.js slugify — identical, so a slug rule matches the same game the app sees.
const slugify = (t) => String(t).toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

// Build the HOST remove rules from the override JSON (only hostIncludes; slug/
// title/url curation rules are intentionally ignored — see SCOPE above). The
// `.disabled` hosts stay in the list and simply never match a real host.
function loadHostRules() {
  const raw = JSON.parse(readFileSync(OVERRIDES, 'utf8'));
  const rules = [];
  for (const r of (Array.isArray(raw?.remove) ? raw.remove : [])) {
    if (r && typeof r === 'object' && r.hostIncludes) rules.push(String(r.hostIncludes).toLowerCase());
  }
  return rules;
}

function hostOf(url) { try { return new URL(url).host.toLowerCase(); } catch { return ''; } }

function matchedRule(g, hostRules) {
  const url = g.embed_url || g.embedUrl || g.url || g.game_url || '';
  const hostL = hostOf(url);
  if (!hostL) return null;
  for (const needle of hostRules) if (hostL.includes(needle)) return `host:${needle}`;
  return null;
}

const games = JSON.parse(readFileSync(FINAL, 'utf8'));
const rules = loadHostRules();

const kept = [];
const byRule = {};
let removed = 0;
for (const g of games) {
  const hit = matchedRule(g, rules);
  if (hit) {
    removed++;
    const bucket = hit.startsWith('host:') ? hit : (hit.startsWith('slug:') ? 'slug rules' : hit.startsWith('title:') ? 'title rules' : hit);
    byRule[bucket] = (byRule[bucket] || 0) + 1;
  } else {
    kept.push(g);
  }
}

console.log(`finalgames.json: ${games.length} entries`);
console.log(`removed (matched serve-time remove policy): ${removed}`);
for (const [k, v] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(5)}  ${k}`);
console.log(`kept: ${kept.length}`);

if (DRY) { console.log('\n--dry: no file written.'); process.exit(0); }

copyFileSync(FINAL, FINAL + '.bak');
writeFileSync(FINAL, JSON.stringify(kept, null, 2) + '\n');
console.log(`\nwrote ${kept.length} entries. backup: finalgames.json.bak`);
