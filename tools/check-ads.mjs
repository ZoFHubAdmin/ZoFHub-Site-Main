// tools/check-ads.mjs
// ---------------------------------------------------------------------------
//   npm run check-ads
//
// Answers one question before you deploy: WILL THE ADS ACTUALLY LOAD?
//
// Why this exists. Ad misconfiguration on this site is silent. The server
// accepts your tags, /api/site-config serves them, the page injects them —
// and then the browser's Content-Security-Policy can refuse every one. Nothing
// crashes, no endpoint 500s, the page looks perfect. The only trace is a console
// line nobody reads, so weeks pass and the obvious conclusion is "this network
// doesn't pay". Measured against real network loader domains, all four were
// blocked before the CSP was derived from configuration.
//
// So this walks the same path a visitor's browser does, and reports on each hop:
//   1. env       — which of the six networks is active, in which role, with
//                  which regional overrides; which variables are set but unread
//   2. CSP       — is each script origin allowlisted in the policy the server sends?
//   3. serving   — does /api/site-config really hand each placement to the pages
//                  it belongs on (hub page, game page) and nothing to /browser?
//   4. reachable — does each ad host answer at all (DNS/TLS/HTTP)?
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

const { resolveAdConfig, adminAdConfig, ROLES, ROLE_FIELDS, roleOwner, INTERSTITIAL_COOLDOWN_MS } =
  await import('../lib/ad-providers.mjs');
const { geoConfig } = await import('../lib/geo.mjs');
const geo = geoConfig(process.env);
const cfg = resolveAdConfig(process.env, { regions: geo.regionIds });
const admin = adminAdConfig(cfg);

// ---- 1. Configuration -----------------------------------------------------
console.log('\n1. Configuration (six networks, one role each)');
for (const p of cfg.providers) {
  const state = p.active ? 'ACTIVE'
    : p.enabled ? 'enabled but NOT configured'
    : p.configured ? 'configured but DISABLED'
    : 'off';
  const detail = [
    p.fieldsProvided.length ? p.fieldsProvided.join(', ') : '',
    p.regionsOverridden.length ? `regions: ${p.regionsOverridden.join('/')}` : '',
    p.zone ? 'zone set' : '',
  ].filter(Boolean).join(' · ');
  console.log(`  ${p.name.padEnd(11)} ${p.role.padEnd(13)} ${state.padEnd(28)} ${detail}`);
  if (p.enabled && !p.configured) {
    const fields = Object.keys(ROLE_FIELDS[p.role]).map((f) => `${p.env}_${f}`).join(' / ');
    caution(`${p.name}: ${p.env}_ENABLED is set but ${fields} is not — it renders nothing`);
  }
}
for (const name of cfg.ignored) {
  caution(`${name} is set but read by nothing (retired network, legacy slot, or outside the network's role)`);
}
for (const w of geo.warnings) caution(`[regions] ${w}`);

// ---- 1b. Roles --------------------------------------------------------------
// Strict roles: a placement renders only its owner's code, so the only way a
// placement is dark is that its owner is off or unconfigured. Said out loud.
console.log('\n1b. Roles');
for (const role of ROLES) {
  const owner = roleOwner(role);
  const serving = admin.roleOwner[role];
  const note = role === 'interstitial' && serving
    ? `1 per ${Math.round(INTERSTITIAL_COOLDOWN_MS / 60000)} min (fixed)` : '';
  console.log(`  ${role.padEnd(13)} ${(serving || 'dark').padEnd(12)} owner: ${owner?.name || '—'} ${note}`);
}
if (geo.regionIds.length) {
  console.log(`  regions: ${geo.regionIds.join(', ')} — localised: ${admin.regionsLocalised.join(', ') || 'none (all use global tags)'}`);
}

// Every script URL a browser would load, across the global and regional sets.
const placementSets = [cfg.global, ...Object.values(cfg.regional)];
const all = new Set();
for (const p of placementSets) {
  for (const u of p.push?.scripts || []) all.add(u);
  for (const key of ['header', 'sidebar', 'interstitial', 'native', 'popunder']) {
    const tag = String(p[key]?.tag || '');
    for (const m of tag.matchAll(/src\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi)) all.add(m[1].startsWith('//') ? 'https:' + m[1] : m[1]);
    for (const m of tag.matchAll(/["'`]((?:https:)?\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\/[^"'`\s]*?\.js)(?:[?#][^"'`\s]*)?["'`]/gi)) {
      all.add(m[1].startsWith('//') ? 'https:' + m[1] : m[1]);
    }
  }
}
const vastUrls = [...new Set(placementSets.map((p) => p.preroll?.vast).filter(Boolean))];
const extraOrigins = (process.env.PROXY_AD_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!cfg.anyActive) {
  console.log('\n' + ok('no network is active — the site runs ad-free, nothing to check'));
  console.log('\nTo enable one, set <NETWORK>_ENABLED=1 plus its role variable:');
  for (const p of cfg.providers) {
    console.log(`  ${p.env.padEnd(11)} ${Object.keys(ROLE_FIELDS[p.role]).map((f) => `${p.env}_${f}`).join(' / ')}`);
  }
  console.log('Approval requirements: docs/features/ADVERTISING.md\n');
  process.exit(0);
}
console.log(`\n  resolved: ${all.size} script URL(s), ${vastUrls.length} VAST tag(s)`);
if (extraOrigins.length) console.log(`  PROXY_AD_ORIGINS : ${extraOrigins.join(' ')}`);

for (const u of all) {
  if (!/^https:\/\//i.test(u)) fail(`${u} — not https (the browser would refuse it on an https page)`);
  else if (BANNED.test(u)) fail(`${u} — Google ad code. AdSense on a proxy domain is an account-level ban; the server strips this.`);
  else console.log(ok(u.slice(0, 78)));
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
  // compensates automatically, so flag it only if something removed that.
  for (const e of extraOrigins) {
    if (!e.startsWith('https://*.')) continue;
    const apex = 'https://' + e.slice('https://*.'.length);
    if (!scriptSrc.split(/\s+/).includes(apex)) {
      caution(`${e} does not by itself permit ${apex} — a CSP wildcard never matches its own apex domain`);
    }
  }
  if (!all.size) console.log(ok('no script URLs to check against the CSP (VAST and direct-link need none)'));
}

// ---- 3. Does the server actually serve each placement where it belongs? ----
console.log('\n3. Delivery to the page (/api/site-config, per surface)');
const surfaceCfg = async (surface) => (await fetch(`${BASE}/api/site-config?surface=${encodeURIComponent(surface)}`)).json();
try {
  const hub = await surfaceCfg('/');
  const game = await surfaceCfg('/play/check-ads');
  const proxy = await surfaceCfg('/browser');
  const g = cfg.global;
  const expect = [
    ['header banner', Boolean(g.header), Boolean(hub.slots?.header)],
    ['sidebar banner', Boolean(g.sidebar), Boolean(hub.slots?.sidebar)],
    ['in-page push', Boolean(g.push), Boolean(hub.adScripts?.length)],
    ['interstitial', Boolean(g.interstitial), Boolean(hub.interstitial)],
    ['native widget', Boolean(g.native), Boolean(hub.native)],
    ['video pre-roll (game page)', Boolean(g.preroll), Boolean(game.preroll)],
    ['popunder (game page)', Boolean(g.popunder), Boolean(game.popunder)],
  ];
  for (const [what, want, got] of expect) {
    if (want && !got) fail(`${what}: configured but /api/site-config does not serve it — restart the server so it re-reads the environment`);
    else if (want) console.log(ok(`${what}: served`));
  }
  if (hub.preroll || hub.popunder) fail('a hub page was handed the pre-roll or popunder — those belong to game pages only');
  const proxyLeak = proxy.adsAllowed || proxy.adScripts?.length || proxy.slots?.header || proxy.interstitial
    || proxy.native || proxy.preroll || proxy.popunder;
  if (proxyLeak) fail('/browser was handed advertising — the proxy boundary is broken');
  else console.log(ok('/browser receives no advertising'));
  console.log(ok(`ad-block premium gate: ${hub.supportGate ? 'ON' : 'off'}`));
} catch {
  caution('could not read /api/site-config (server not running?)');
}

// ---- 4. Do the ad hosts answer at all? ------------------------------------
console.log('\n4. Ad host reachability');
for (const u of [...all, ...vastUrls]) {
  let host; try { host = new URL(u.replace(/\[[A-Z_]+\]/g, '0')).hostname; } catch { continue; }
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    const r = await fetch(u.replace(/\[[A-Z_]+\]/g, '0'), { method: 'GET', signal: c.signal, redirect: 'follow' });
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
