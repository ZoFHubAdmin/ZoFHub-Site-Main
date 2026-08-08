// tools/check-ads.mjs
// ---------------------------------------------------------------------------
//   npm run check-ads
//
// Answers one question before you deploy: WILL THE ADS ACTUALLY LOAD?
//
// Why this exists. Ad misconfiguration on this site is silent. The server
// accepts your tags, /api/site-config serves them, proxy-ads.js injects them —
// and then the browser's Content-Security-Policy can refuse every one. Nothing
// crashes, no endpoint 500s, the page looks perfect. The only trace is a console
// line nobody reads, so weeks pass and the obvious conclusion is "this network
// doesn't pay". Measured against the loader domains Adsterra, HilltopAds and
// Monetag actually hand out, all four were blocked before this was wired up.
//
// So this walks the same path a visitor's browser does, and reports on each hop:
//   1. env       — are the tags present, https, and free of Google ad code?
//   2. CSP       — is each origin allowlisted in the policy the server sends?
//   3. serving   — does /api/site-config really hand the tags to the page?
//   4. reachable — does the ad host answer at all (DNS/TLS/HTTP)?
//
// Exit code is non-zero if anything would stop an ad from rendering, so it can
// gate a deploy.
// ---------------------------------------------------------------------------
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const f of ['.env']) {
  const p = join(root, f);
  if (existsSync(p) && typeof process.loadEnvFile === 'function') { try { process.loadEnvFile(p); } catch {} }
}

const BASE = process.env.CHECK_ADS_BASE || `http://localhost:${process.env.PORT || 8080}`;
const BANNED = /googlesyndication|googleadservices|adsbygoogle|doubleclick/i;

const ok = s => `  ok    ${s}`;
const bad = s => `  FAIL  ${s}`;
const warn = s => `  warn  ${s}`;
let failures = 0, warnings = 0;
const fail = s => { failures++; console.log(bad(s)); };
const caution = s => { warnings++; console.log(warn(s)); };

// ---- 1. What is configured? -----------------------------------------------
// Read through lib/ad-providers.mjs — the SAME resolver the server uses — so
// this tool can never disagree with what actually ships. Reading the env vars
// directly (as this did before the provider layer existed) meant it only ever
// saw the two legacy variables and would cheerfully report "no ads configured"
// while five networks were live.
const { resolveAdConfig, SLOTS } = await import('../lib/ad-providers.mjs');
const cfg = resolveAdConfig(process.env);

console.log('\n1. Configuration');
for (const p of cfg.providers) {
  const state = p.active ? 'ACTIVE'
    : p.enabled ? 'enabled but NOT configured'
    : p.configured ? 'configured but DISABLED'
    : 'off';
  const detail = p.active
    ? `${p.scriptCount} script(s)${p.slotsProvided.length ? `, slots: ${p.slotsProvided.join('/')}` : ''}${p.zone ? ', zone set' : ''}`
    : '';
  console.log(`  ${p.name.padEnd(12)} ${state.padEnd(28)} ${detail}`);
  if (p.enabled && !p.configured) {
    caution(`${p.name}: ${p.env}_ENABLED is set but no script, zone or tag is configured — it renders nothing`);
  }
}
if (cfg.legacyInUse) {
  caution('legacy PROXY_* ad variables are in use — they work, but cannot be '
    + 'attributed to a network or toggled individually. See docs/ADVERTISING.md.');
}

const scripts = cfg.scripts;
const slotSrcs = [];
for (const slot of SLOTS) {
  for (const m of String(cfg.slots[slot] || '').matchAll(/src\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) {
    slotSrcs.push(m[1]);
  }
}
const extraOrigins = (process.env.PROXY_AD_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!cfg.anyActive) {
  console.log('\n' + ok('no network is active — the site runs ad-free, nothing to check'));
  console.log('\nTo enable one, set <NETWORK>_ENABLED=1 plus at least one of');
  console.log('<NETWORK>_SCRIPT / <NETWORK>_ZONE / <NETWORK>_<SLOT>_TAG, then run this');
  console.log('again. Networks: HILLTOPADS ADSTERRA MONETAG ADMAVEN POPADS');
  console.log('Approval requirements: docs/ADVERTISING.md\n');
  process.exit(0);
}
console.log(`\n  resolved: ${scripts.length} loader script(s), `
  + `${SLOTS.filter(s => cfg.slots[s]).length} filled slot(s)`);
if (extraOrigins.length) console.log(`  PROXY_AD_ORIGINS : ${extraOrigins.join(' ')}`);

const all = [...scripts, ...slotSrcs];
for (const u of all) {
  if (!/^https:\/\//i.test(u)) fail(`${u} — not https (the server drops non-https tags)`);
  else if (BANNED.test(u)) fail(`${u} — Google ad code. AdSense on a proxy domain is an account-level ban; the server strips this.`);
  else console.log(ok(u.slice(0, 78)));
}
// A slot claimed by two networks is impossible by construction (first wins),
// but a slot whose tag was rejected outright IS possible and looks identical to
// "not configured" from the outside.
for (const p of cfg.providers) {
  for (const slot of p.slotsProvided) {
    if (cfg.slotOwner[slot] !== p.id) {
      caution(`${p.name} supplies a ${slot} tag but ${cfg.slotOwner[slot] || 'nothing'} owns that slot — only one network per slot`);
    }
  }
}

// ---- 2. Will the CSP permit them? -----------------------------------------
console.log('\n2. Content-Security-Policy (the step that silently kills ads)');
let csp = '';
try {
  const r = await fetch(BASE + '/', { redirect: 'follow' });
  csp = r.headers.get('content-security-policy') || '';
} catch {
  caution(`server not reachable at ${BASE} — start it (npm start) to check the live CSP`);
}
if (csp) {
  const scriptSrc = (csp.split(';').find(d => d.trim().startsWith('script-src')) || '').trim();
  const allows = (origin) => {
    const host = new URL(origin).hostname;
    for (const tok of scriptSrc.split(/\s+/).slice(1)) {
      if (tok === origin || tok === `https://${host}`) return true;
      if (tok.startsWith('https://*.')) {
        const suffix = tok.slice('https://*.'.length);
        if (host === suffix || host.endsWith('.' + suffix)) return true;
      }
    }
    return false;
  };
  for (const u of all) {
    let o; try { o = new URL(u).origin; } catch { continue; }
    if (allows(o)) console.log(ok(`${new URL(u).hostname} is allowlisted in script-src`));
    else fail(`${new URL(u).hostname} is NOT in script-src — the browser will refuse this script. Add its host to PROXY_AD_ORIGINS.`);
  }
  // Wildcards do not cover their own apex, which is a genuinely surprising rule:
  // "https://*.foo.com" allows cdn.foo.com and still blocks foo.com. The server
  // now compensates automatically, so flag it only if something removed that.
  for (const e of extraOrigins) {
    if (!e.startsWith('https://*.')) continue;
    const apex = 'https://' + e.slice('https://*.'.length);
    if (!scriptSrc.split(/\s+/).includes(apex)) {
      caution(`${e} does not by itself permit ${apex} — a CSP wildcard never matches its own apex domain`);
    }
  }
  if (!all.length) caution('no script URLs to check against the CSP');
}

// ---- 3. Does the server actually serve the tags? --------------------------
console.log('\n3. Delivery to the page (/api/site-config)');
try {
  const cfg = await (await fetch(BASE + '/api/site-config')).json();
  const served = cfg.proxyAdScripts || [];
  if (scripts.length && !served.length) fail('tags are set in .env but /api/site-config returns none — restart the server so it re-reads .env');
  else console.log(ok(`serving ${served.length} script(s)${cfg.proxyBannerTag ? ' + a banner tag' : ''}`));
  for (const s of scripts) if (!served.includes(s)) caution(`dropped by the server filter: ${s.slice(0, 60)}`);
} catch {
  caution('could not read /api/site-config (server not running?)');
}

// ---- 4. Do the ad hosts answer at all? ------------------------------------
console.log('\n4. Ad host reachability');
for (const u of all) {
  let host; try { host = new URL(u).hostname; } catch { continue; }
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    const r = await fetch(u, { method: 'GET', signal: c.signal, redirect: 'follow' });
    clearTimeout(t);
    // A 403/404 is fine here: it proves DNS+TLS work and the host is live. Only
    // a placeholder id would 404, which is worth flagging but is not a config bug.
    if (r.ok) console.log(ok(`${host} → HTTP ${r.status}`));
    else caution(`${host} → HTTP ${r.status} (host is live; check the publisher id in the URL)`);
  } catch (e) {
    caution(`${host} → unreachable (${e.name}). Could be your network, or a wrong domain.`);
  }
}

console.log('\n' + '='.repeat(60));
if (failures) {
  console.log(`${failures} blocking problem(s), ${warnings} warning(s) — ads would NOT render.`);
  process.exit(1);
}
console.log(warnings ? `No blocking problems, ${warnings} warning(s).` : 'All checks passed — ads should render.');
