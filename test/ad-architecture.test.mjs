// The advertising architecture: the six networks, the one role each owns, and
// the boundary that keeps them off the proxy.
//
// None of this was tested before. The consequences of that were not theoretical:
// public/browser.html imports layout.js, which is the module that loads the ad
// stack, so configuring any network would have started serving ZoFHub's own
// advertising on the web-proxy page — third-party content, monetised by us. No
// code said that was wrong and nothing checked.
//
// Everything here is pure: resolveAdConfig() takes an env object and returns a
// value, so a test constructs a fake environment and asserts on the result. No
// server, no network, no live credentials.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROVIDERS, PROVIDER_IDS, SLOTS, ROLES, ROLE_FIELDS, roleOwner, INTERSTITIAL_COOLDOWN_MS,
  resolveAdConfig, adOrigins, publicAdConfig, adminAdConfig, isAdSurface, isGamePage, placementsFor,
} from '../lib/ad-providers.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// The authoritative list. If this changes, it must be a deliberate decision —
// which is exactly why the list is asserted rather than derived.
const EXPECTED = ['admaven', 'exoclick', 'hilltopads', 'clickadu', 'mondiad', 'popads'];

describe('the six supported networks', () => {
  test('exactly these six, no more and no fewer', () => {
    assert.deepEqual(PROVIDER_IDS, EXPECTED);
  });

  test('every provider declares what it needs to be auditable', () => {
    for (const p of PROVIDERS) {
      assert.ok(p.name, `${p.id} has no display name`);
      assert.ok(p.env, `${p.id} has no env prefix`);
      assert.ok(/^https:\/\//.test(p.docs), `${p.id} has no documentation URL`);
      assert.ok(/^https:\/\//.test(p.privacy), `${p.id} has no privacy-policy URL for the legal pages`);
      assert.ok(Array.isArray(p.formats) && p.formats.length, `${p.id} declares no formats`);
      assert.ok(p.approval, `${p.id} has no approval status`);
      assert.ok(ROLES.includes(p.role), `${p.id} has no valid role`);
    }
  });

  test('no provider claims to be pre-approved', () => {
    // A registry that says "confirmed" for a domain nobody submitted is how a
    // publisher account gets banned while the config insists all is well.
    for (const p of PROVIDERS) {
      assert.notEqual(p.approval, 'confirmed',
        `${p.id} claims confirmed approval — approval is per-domain and must be verified by a human`);
    }
  });

  test('env prefixes are unique and uppercase', () => {
    const seen = new Set();
    for (const p of PROVIDERS) {
      assert.match(p.env, /^[A-Z0-9]+$/, `${p.id} prefix is not uppercase`);
      assert.ok(!seen.has(p.env), `${p.env} is used by two providers`);
      seen.add(p.env);
    }
  });
});

describe('ads fully disabled', () => {
  // The state a fresh clone and every un-monetised deploy is in. It must be
  // completely inert, not merely visually empty.
  const cfg = resolveAdConfig({});

  test('nothing is active', () => {
    assert.equal(cfg.anyActive, false);
    assert.deepEqual(cfg.activeIds, []);
  });

  test('no scripts, no slot markup, no placements', () => {
    assert.deepEqual(cfg.scripts, []);
    for (const slot of SLOTS) assert.equal(cfg.slots[slot], '', `${slot} is not empty`);
    for (const [k, v] of Object.entries(cfg.global)) assert.equal(v, null, `${k} is set`);
  });

  test('no CSP origins are opened', () => {
    // An allowlist entry for a network that is not running is a permission
    // granted for nothing.
    assert.deepEqual(adOrigins(cfg, []), []);
  });

  test('the public payload is empty but well-formed', () => {
    const pub = publicAdConfig(cfg, { surface: '/' });
    assert.deepEqual(pub.adScripts, []);
    assert.deepEqual(pub.slots, { header: '', sidebar: '' });
    for (const k of ['push', 'interstitial', 'native', 'preroll', 'popunder']) assert.equal(pub[k], null, k);
    // Shape must survive so the client never reads undefined.
    for (const k of ['proxyHeaderTag', 'proxySidebarTag']) assert.equal(typeof pub[k], 'string');
  });
});

describe('enabling a network', () => {
  const env = {
    EXOCLICK_ENABLED: '1',
    EXOCLICK_ZONE: 'zone-123',
    EXOCLICK_HEADER_TAG: '<script async src="https://a.example-exo.test/ad-provider.js"></script><ins data-zoneid="1"></ins>',
  };
  const cfg = resolveAdConfig(env);

  test('it becomes active and owns its placement', () => {
    assert.deepEqual(cfg.activeIds, ['exoclick']);
    assert.equal(cfg.slotOwner.header, 'exoclick');
    assert.match(cfg.slots.header, /a\.example-exo\.test/);
  });

  test('the others stay completely inert', () => {
    for (const p of cfg.providers) {
      if (p.id === 'exoclick') continue;
      assert.equal(p.active, false, `${p.id} activated without being enabled`);
      assert.deepEqual(p.fieldsProvided, []);
    }
  });

  test('CSP covers the script inside the tag', () => {
    // The tag is raw HTML — its src must be extracted, or the browser blocks it
    // with only a console line, which looks exactly like the network not paying.
    assert.ok(adOrigins(cfg, []).includes('https://a.example-exo.test'), 'tag script origin missing');
  });

  test('enabled but unconfigured renders nothing', () => {
    const half = resolveAdConfig({ MONDIAD_ENABLED: '1' });
    const mondiad = half.providers.find(p => p.id === 'mondiad');
    assert.equal(mondiad.enabled, true);
    assert.equal(mondiad.configured, false);
    assert.equal(mondiad.active, false, 'a half-configured network must render nothing');
    assert.equal(half.anyActive, false);
  });

  test('configured but not enabled renders nothing', () => {
    const off = resolveAdConfig({ POPADS_POPUNDER_TAG: '<script>/* pop */</script>' });
    assert.equal(off.anyActive, false, 'a disabled network must not serve');
    assert.equal(off.global.popunder, null);
  });

  test('a zone id alone configures nothing', () => {
    // It is shown in the admin panel and renders nothing, so it cannot make a
    // network "active" and start an empty placement.
    assert.equal(resolveAdConfig({ CLICKADU_ENABLED: '1', CLICKADU_ZONE: 'z' }).anyActive, false);
  });
});

describe('strict roles: a network renders only in its own role', () => {
  test('every role has exactly one owner, and every network exactly one role', () => {
    const OWNERS = {
      interstitial: 'admaven', display: 'exoclick', 'in-page-push': 'hilltopads',
      preroll: 'clickadu', native: 'mondiad', popunder: 'popads',
    };
    assert.deepEqual([...ROLES].sort(), Object.keys(OWNERS).sort());
    for (const role of ROLES) {
      const owners = PROVIDERS.filter(p => p.role === role);
      assert.equal(owners.length, 1, `${role} has ${owners.length} owners`);
      assert.equal(owners[0].id, OWNERS[role]);
      assert.equal(roleOwner(role).id, OWNERS[role]);
    }
  });

  test('a variable outside a network\'s role is ignored and reported', () => {
    // The old registry let any network fill any slot. Now EXOCLICK_FOOTER_TAG,
    // HILLTOPADS_HEADER_TAG etc. are read by nothing — and named at boot.
    const cfg = resolveAdConfig({
      HILLTOPADS_ENABLED: '1',
      HILLTOPADS_HEADER_TAG: '<script src="https://hilltop.test/h.js"></script>',
      HILLTOPADS_SCRIPT: 'https://hilltop.test/loader.js',
      EXOCLICK_ENABLED: '1',
      EXOCLICK_FOOTER_TAG: '<script src="https://exo.test/f.js"></script>',
    });
    assert.equal(cfg.global.header, null, 'HilltopAds filled the display role it does not own');
    assert.equal(cfg.anyActive, false);
    assert.deepEqual(cfg.ignored, ['EXOCLICK_FOOTER_TAG', 'HILLTOPADS_HEADER_TAG', 'HILLTOPADS_SCRIPT']);
  });

  test('an idle owner leaves its role dark — nobody fills in', () => {
    const cfg = resolveAdConfig({
      EXOCLICK_ENABLED: '0',
      EXOCLICK_HEADER_TAG: '<script src="https://exo.test/h.js"></script>',
      MONDIAD_ENABLED: '1',
      MONDIAD_NATIVE_TAG: '<div data-mondiad></div>',
    });
    assert.equal(cfg.global.header, null);
    assert.equal(cfg.global.native.provider, 'mondiad');
  });

  test('retired networks and pre-provider slot variables are reported, never rendered', () => {
    const cfg = resolveAdConfig({
      MONETAG_ENABLED: '1', MONETAG_HEADER_TAG: '<script src="https://m.test/h.js"></script>',
      ADSTERRA_ENABLED: '1', PROXY_AD_SCRIPTS: 'https://old.test/a.js', PROXY_BANNER_TAG: '<b></b>',
      PROXY_AD_ORIGINS: 'https://*.still-read.test',
    });
    assert.equal(cfg.anyActive, false);
    assert.deepEqual(cfg.scripts, []);
    assert.deepEqual(cfg.ignored,
      ['ADSTERRA_ENABLED', 'MONETAG_ENABLED', 'MONETAG_HEADER_TAG', 'PROXY_AD_SCRIPTS', 'PROXY_BANNER_TAG']);
  });

  test('every role reads the variables ROLE_FIELDS says it does', () => {
    for (const p of PROVIDERS) {
      const env = { [`${p.env}_ENABLED`]: '1' };
      for (const [field, kind] of Object.entries(ROLE_FIELDS[p.role])) {
        env[`${p.env}_${field}`] = kind === 'tag' ? '<div>ok</div>' : 'https://x.test/a.js';
      }
      const cfg = resolveAdConfig(env);
      assert.deepEqual(cfg.activeIds, [p.id], `${p.id} did not activate from its own role fields`);
      assert.deepEqual(cfg.ignored, [], `${p.id}'s own fields were reported as unread`);
    }
  });
});

describe('where each placement may appear', () => {
  const cfg = resolveAdConfig({
    CLICKADU_ENABLED: '1', CLICKADU_PREROLL_VAST: 'https://vast.test/v?cb=[CACHEBUSTING]',
    POPADS_ENABLED: '1', POPADS_POPUNDER_TAG: '<script>var e="//c1.popads.test/pop.js";</script>',
    EXOCLICK_ENABLED: '1', EXOCLICK_HEADER_TAG: '<ins></ins>',
  });

  test('the pre-roll and the popunder travel only to game pages', () => {
    const hub = publicAdConfig(cfg, { surface: '/' });
    const cat = publicAdConfig(cfg, { surface: '/category/racing' });
    const game = publicAdConfig(cfg, { surface: '/play/moto-x3m' });
    for (const pub of [hub, cat]) {
      assert.equal(pub.preroll, null);
      assert.equal(pub.popunder, null);
      assert.ok(pub.slots.header, 'the header banner belongs on every native page');
    }
    assert.equal(game.preroll.vast, 'https://vast.test/v?cb=[CACHEBUSTING]');
    assert.equal(game.popunder.provider, 'popads');
  });

  test('a proxy page gets nothing at all', () => {
    for (const surface of ['/browser', '/gust/x', '/anura', '/play']) {
      const pub = publicAdConfig(cfg, { surface });
      assert.equal(pub.preroll, null, surface);
      assert.equal(pub.popunder, null, surface);
    }
    assert.equal(publicAdConfig(cfg, { surface: '/browser' }).slots.header, '');
    assert.equal(publicAdConfig(cfg, {}).slots.header, '', 'no surface must mean no ads');
  });

  test('isGamePage is a single game, never the bare /play or a proxy path', () => {
    assert.equal(isGamePage('/play/x'), true);
    assert.equal(isGamePage('/play/x?ref=1'), true);
    assert.equal(isGamePage('/play'), false);
    assert.equal(isGamePage('/browser/play/x'), false);
  });

  test('a protocol-relative loader built in inline code still reaches the CSP', () => {
    // PopAds builds its loader URL in JavaScript. An attribute-only scan never
    // saw it, and the browser refused the script with only a console line.
    assert.ok(adOrigins(cfg).includes('https://c1.popads.test'));
  });
});

describe('regional tags', () => {
  const env = {
    EXOCLICK_ENABLED: '1',
    EXOCLICK_HEADER_TAG: '<script src="https://global.exo.test/h.js"></script>',
    EXOCLICK_SIDEBAR_TAG: '<script src="https://global.exo.test/s.js"></script>',
    EXOCLICK_HEADER_TAG__SOUTH_ASIA: '<script src="https://in.exo.test/h.js"></script>',
    MONDIAD_ENABLED: '1',
    MONDIAD_NATIVE_TAG__SOUTH_ASIA: '<div>in only</div>',
  };
  const cfg = resolveAdConfig(env, { regions: ['SOUTH_ASIA', 'NORTH_AMERICA'] });

  test('a region gets its override, and keeps every field it did not override', () => {
    const sa = placementsFor(cfg, 'SOUTH_ASIA');
    assert.match(sa.header.tag, /in\.exo\.test/);
    assert.match(sa.sidebar.tag, /global\.exo\.test/, 'a partial override lost the sidebar');
  });

  test('a region without overrides uses the global set, and so does an unknown one', () => {
    assert.equal(placementsFor(cfg, 'NORTH_AMERICA'), cfg.global);
    assert.equal(placementsFor(cfg, 'NOWHERE'), cfg.global);
    assert.equal(placementsFor(cfg, null), cfg.global);
  });

  test('a network configured only for one region is active, and only there', () => {
    assert.ok(cfg.activeIds.includes('mondiad'));
    assert.equal(cfg.global.native, null);
    assert.equal(placementsFor(cfg, 'SOUTH_ASIA').native.provider, 'mondiad');
  });

  test('the CSP covers every region, not just the global tags', () => {
    const origins = adOrigins(cfg);
    assert.ok(origins.includes('https://global.exo.test'));
    assert.ok(origins.includes('https://in.exo.test'));
  });

  test('an override for a region that does not exist is reported, not read', () => {
    const c = resolveAdConfig({ ...env, EXOCLICK_HEADER_TAG__MARS: '<b></b>' }, { regions: ['SOUTH_ASIA'] });
    assert.ok(c.ignored.includes('EXOCLICK_HEADER_TAG__MARS'));
  });

  test('the public payload follows the visitor\'s region', () => {
    assert.match(publicAdConfig(cfg, { surface: '/', region: 'SOUTH_ASIA' }).slots.header, /in\.exo\.test/);
    assert.match(publicAdConfig(cfg, { surface: '/', region: null }).slots.header, /global\.exo\.test/);
  });
});

describe('Google ad code is refused everywhere', () => {
  // AdSense/AdX ban proxy and anonymizer domains at the ACCOUNT level, so a
  // single tag here could take down an unrelated account. Refused at every layer.
  const googly = [
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
    'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
    'https://www.googleadservices.com/pagead/conversion.js',
  ];

  for (const url of googly) {
    test(`rejected as a loader: ${new URL(url).hostname}`, () => {
      const cfg = resolveAdConfig({ HILLTOPADS_ENABLED: '1', HILLTOPADS_PUSH_SCRIPT: url });
      assert.deepEqual(cfg.scripts, []);
      assert.deepEqual(adOrigins(cfg, []), []);
    });
  }

  test('rejected inside a tag', () => {
    const cfg = resolveAdConfig({
      EXOCLICK_ENABLED: '1',
      EXOCLICK_HEADER_TAG: '<script src="https://pagead2.googlesyndication.com/x.js"></script>',
    });
    assert.equal(cfg.slots.header, '');
  });

  test('rejected as a VAST tag', () => {
    const cfg = resolveAdConfig({ CLICKADU_ENABLED: '1', CLICKADU_PREROLL_VAST: 'https://pubads.g.doubleclick.net/gampad/ads?x' });
    assert.equal(cfg.global.preroll, null);
  });

  test('rejected in the manual CSP escape hatch', () => {
    const cfg = resolveAdConfig({});
    assert.deepEqual(adOrigins(cfg, ['https://*.doubleclick.net']), []);
  });

  test('non-https loaders and VAST tags are refused', () => {
    assert.deepEqual(resolveAdConfig({ HILLTOPADS_ENABLED: '1', HILLTOPADS_PUSH_SCRIPT: 'http://insecure.test/p.js' }).scripts, []);
    assert.equal(resolveAdConfig({ CLICKADU_ENABLED: '1', CLICKADU_PREROLL_VAST: 'http://insecure.test/v' }).global.preroll, null);
  });
});

describe('the proxy / advertising boundary', () => {
  const NATIVE = ['/', '/category/racing', '/play/moto-x3m', '/ai', '/community', '/credits', '/privacy'];
  const PROXY = [
    '/browser', '/browser/', '/gust', '/gust/index.html', '/proxy',
    '/uv/uv.bundle.js', '/sj/scramjet.js', '/scram/scramjet.sw.js',
    '/epoxy/index.mjs', '/libcurl/x.js', '/baremux/y.js', '/wisp', '/bare/v3',
    '/service/abc', '/sw.js',
  ];

  for (const p of NATIVE) {
    test(`native surface may carry ads: ${p}`, () => {
      assert.equal(isAdSurface(p), true);
    });
  }

  for (const p of PROXY) {
    test(`proxy surface must NOT: ${p}`, () => {
      assert.equal(isAdSurface(p), false, `${p} would have been monetised`);
    });
  }

  test('an unclassified surface defaults to NO ads', () => {
    // A route nobody classified is a route nobody reasoned about. Failing
    // closed means a new proxy route is safe by default; failing open means it
    // is monetised until someone notices.
    assert.equal(isAdSurface('/some-new-route-nobody-classified'), false);
  });

  test('query strings and fragments cannot smuggle a surface past the check', () => {
    assert.equal(isAdSurface('/browser?url=https://example.com'), false);
    assert.equal(isAdSurface('/browser#/gust'), false);
    assert.equal(isAdSurface('/BROWSER'), false, 'the check must be case-insensitive');
  });

  test('layout.js refuses to load the ad stack on a proxy surface', () => {
    // browser.html imports layout.js for the site chrome. The guard must be in
    // the file, not just in the server, because layout.js is cached in visitors'
    // browsers long after a server-side fix ships.
    const src = readFileSync(join(ROOT, 'public', 'js', 'layout.js'), 'utf8');
    assert.match(src, /ADS_ALLOWED_HERE/, 'layout.js has no client-side surface guard');
    assert.match(src, /browser\|gust\|proxy/,
      'the client guard does not name the proxy surfaces');
  });

  test('no ad module is imported by a proxy page', () => {
    // The vendored proxy UIs must not reference the ad stack at all.
    const proxyPages = ['proxy-engine/assets/gust/index.html'];
    for (const rel of proxyPages) {
      let src;
      try { src = readFileSync(join(ROOT, rel), 'utf8'); } catch { continue; }
      for (const mod of ['ad-slots.js', 'proxy-ads.js', 'preroll.js', 'support-gate.js']) {
        assert.ok(!src.includes(mod), `${rel} imports ${mod}`);
      }
    }
  });
});

describe('secrets never leave the server', () => {
  const cfg = resolveAdConfig({
    POPADS_ENABLED: '1',
    POPADS_POPUNDER_TAG: '<script src="https://cdn.example-popads.test/p.js"></script>',
    POPADS_ZONE: 'SECRET-ZONE-9999',
  });

  test('the admin payload carries no zone, tag or credential', () => {
    const json = JSON.stringify(adminAdConfig(cfg));
    assert.ok(!json.includes('SECRET-ZONE-9999'), 'a zone identifier leaked to the admin panel');
    const popads = adminAdConfig(cfg).providers.find(p => p.id === 'popads');
    // It must still report the FACT of configuration, just not the value.
    assert.equal(popads.hasZone, true);
    assert.equal(popads.zone, undefined);
  });

  test('the admin payload is not a write surface', () => {
    assert.equal(adminAdConfig(cfg).providers.some(p => 'tag' in p), false);
  });

  test('the public payload carries no zone or provider internals', () => {
    // A game page, so the popunder tag IS in the payload — and still no zone.
    const pub = publicAdConfig(cfg, { surface: '/play/x' });
    assert.ok(pub.popunder, 'the fixture did not produce a payload to inspect');
    const json = JSON.stringify(pub);
    assert.ok(!json.includes('SECRET-ZONE-9999'), 'a zone identifier leaked to the browser');
    assert.ok(!json.includes('POPADS_'), 'an env var name leaked to the browser');
  });
});

describe('PropellerAds is gone', () => {
  // A full-tree sweep. The removal has to stay done — it is the kind of thing a
  // copy-pasted snippet quietly reintroduces.
  const SKIP_DIRS = new Set([
    'node_modules', '.git', '.venv', 'venv', 'Interstellar', 'DayDream',
    'NautilusOS', 'scramjet', 'suroi', 'thumbs', '__pycache__', '.cache',
    'uv', 'sj', 'gust', 'epoxy', 'libcurl', 'baremux', 'scram',
  ]);
  const EXT = new Set(['.js', '.mjs', '.json', '.html', '.css', '.md', '.yaml', '.yml', '.txt', '.sql', '.example', '.toml']);
  // "propeller planes" appears in a genuine game description. The ban is on the
  // ad network, not the English word, so the check is on the network spellings.
  const RE = /propellerads|propeller[-_\s]?ads/i;

  // This file necessarily contains the string it searches for — it is the
  // checker, not an offender.
  const SELF = fileURLToPath(import.meta.url);

  const offenders = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      if (full === SELF) continue;
      const dot = name.lastIndexOf('.');
      if (dot < 0 || !EXT.has(name.slice(dot))) continue;
      if (st.size > 4 * 1024 * 1024) continue;      // catalog dumps
      let src;
      try { src = readFileSync(full, 'utf8'); } catch { continue; }
      if (RE.test(src)) offenders.push(full.slice(ROOT.length + 1));
    }
  };
  walk(ROOT);

  test('no PropellerAds reference remains anywhere', () => {
    assert.deepEqual(offenders, [], `PropellerAds still referenced in:\n  ${offenders.join('\n  ')}`);
  });

  // ── No Google ad tag, not even a commented-out one ────────────────────────
  // public/game.html shipped a commented AdSense loader under a banner reading
  // "INSERT AD PROVIDER HEAD SCRIPT HERE (Google AdSense Auto-Ads …)". A
  // commented tag is one keystroke from a live one, and a live one here is an
  // ACCOUNT-level ban: AdSense and Ad Manager prohibit proxy/anonymizer domains,
  // so the penalty lands on the whole Google account, not just this site.
  //
  // Scoped to the files ZoFHub authors and serves as its own pages. It
  // deliberately does NOT cover:
  //   • the CSP scriptSrc allowlist in server.js, which permits Google ad hosts
  //     for PROXIED GAMES running same-origin through /embed — those are the
  //     game publisher's own units under their publisher id, not ours, and
  //     removing the entry breaks their games without reducing our ban risk;
  //   • the guard regexes that exist precisely to refuse this code;
  //   • GUST's ad-BLOCKING filter lists, which name these hosts to block them.
  const OWN_PAGES = ['public', 'legal', 'admin-ui'];
  const PUBLISHER_TAG = /adsbygoogle|pagead2\.googlesyndication|ca-pub-|googletag\.cmd|enable_page_level_ads/i;

  const adsenseOffenders = [];
  const sweepOwnPages = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { sweepOwnPages(full); continue; }
      if (!/\.(html|css)$/.test(name)) continue;   // the guards live in .js; pages must be clean
      let src;
      try { src = readFileSync(full, 'utf8'); } catch { continue; }
      // Strip HTML comments FIRST — a commented tag is exactly what this catches,
      // so it must be searched, not skipped. (Kept explicit so nobody "fixes"
      // this later by ignoring comments.)
      if (PUBLISHER_TAG.test(src)) adsenseOffenders.push(full.slice(ROOT.length + 1));
    }
  };
  for (const d of OWN_PAGES) sweepOwnPages(join(ROOT, d));

  test('no page carries a Google publisher tag, commented or live', () => {
    assert.deepEqual(adsenseOffenders, [],
      `Google ad publisher code found in:\n  ${adsenseOffenders.join('\n  ')}\n`
      + 'AdSense/Ad Manager ban proxy domains at the ACCOUNT level.');
  });

  test('the legal pages list exactly the six supported networks, with their own policies', () => {
    // The disclosure has to match reality: naming a network we do not use is
    // wrong, and using one we do not name is worse.
    for (const rel of ['legal/privacy.html', 'legal/cookies.html']) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      for (const p of PROVIDERS) {
        assert.ok(src.includes(p.name), `${rel} does not disclose ${p.name}`);
        assert.ok(src.includes(p.privacy), `${rel} does not link ${p.name}'s privacy policy (${p.privacy})`);
      }
      for (const gone of ['PropellerAds', 'Adsterra', 'Monetag', 'Adcash']) {
        assert.ok(!src.includes(gone), `${rel} still names ${gone}, which is not supported`);
      }
    }
  });
});

describe('the between-games interstitial', () => {
  const base = {
    ADMAVEN_ENABLED: '1',
    ADMAVEN_INTERSTITIAL_TAG: '<script src="https://admaven.test/i.js"></script>',
  };

  test('Ad-Maven owns it, at one per 20 minutes', () => {
    const cfg = resolveAdConfig(base);
    assert.equal(cfg.interstitial.provider, 'admaven');
    assert.equal(INTERSTITIAL_COOLDOWN_MS, 20 * 60 * 1000);
    assert.equal(cfg.interstitial.cooldownMs, INTERSTITIAL_COOLDOWN_MS);
  });

  test('the cooldown cannot be configured at all', () => {
    // Non-negotiable by decision: the variable that used to tune it is read by
    // nothing, and says so.
    for (const v of ['1', '45', '0', 'off']) {
      const cfg = resolveAdConfig({ ...base, ADMAVEN_INTERSTITIAL_COOLDOWN_MIN: v });
      assert.equal(cfg.interstitial.cooldownMs, 20 * 60 * 1000, `"${v}" changed the cooldown`);
      assert.ok(cfg.ignored.includes('ADMAVEN_INTERSTITIAL_COOLDOWN_MIN'));
    }
  });

  test('nothing configured means no interstitial at all', () => {
    assert.equal(resolveAdConfig({}).interstitial, null);
    // Enabled but with no tag and no URL is the common half-finished state.
    assert.equal(resolveAdConfig({ ADMAVEN_ENABLED: '1' }).interstitial, null);
  });

  test('a direct-link URL must be https, and Google is refused', () => {
    assert.equal(
      resolveAdConfig({ ADMAVEN_ENABLED: '1', ADMAVEN_INTERSTITIAL_URL: 'http://admaven.test/go' })
        .interstitial, null, 'an http:// direct-link was accepted');
    assert.equal(
      resolveAdConfig({
        ADMAVEN_ENABLED: '1',
        ADMAVEN_INTERSTITIAL_URL: 'https://pagead2.googlesyndication.com/x',
      }).interstitial, null, 'a Google URL survived into the interstitial');
  });

  test('its script origins reach the CSP', () => {
    // A tag whose origin is missing from the allowlist renders an empty overlay
    // and looks exactly like a network with no fill.
    assert.ok(adOrigins(resolveAdConfig(base)).includes('https://admaven.test'));
  });

  test('the client payload carries no credentials', () => {
    const pub = publicAdConfig(resolveAdConfig({ ...base, ADMAVEN_ZONE: 'SECRET-ZONE-1' }), { surface: '/' });
    assert.equal(pub.interstitial.provider, 'admaven');
    assert.ok(!JSON.stringify(pub).includes('SECRET-ZONE-1'), 'a zone leaked to the browser');
  });

  test('the client asks the throttle, with the fixed constant, before it opens anything', () => {
    // Checked INSIDE the click handler that fires it. A whole-file indexOf once
    // passed on the strength of a usage example in a comment, with the real
    // call nowhere near the overlay.
    const src = readFileSync(join(ROOT, 'public', 'js', 'ad-slots.js'), 'utf8');
    assert.match(src, /export function mountInterstitial/, 'ad-slots.js exports no interstitial mount');
    assert.match(src, /mountInterstitial\(\);/, 'mountAdSlots() does not call mountInterstitial()');
    const body = src.slice(src.indexOf('export function mountInterstitial'));
    const gate = body.indexOf("adFrequencyController.allow('interstitial', INTERSTITIAL_COOLDOWN_MS)");
    const show = body.indexOf('showInterstitial(cfg, dest.href)');
    assert.ok(gate !== -1, 'the fire path does not ask the throttle with INTERSTITIAL_COOLDOWN_MS');
    assert.ok(show !== -1 && gate < show, 'the overlay is opened before the throttle is consulted');
    assert.doesNotMatch(body, /cfg\.cooldownMs/, 'the client reads a cooldown from the server payload');
    // Rule 1: there must be a failsafe that navigates regardless.
    assert.match(src, /INTERSTITIAL_FAILSAFE_MS/, 'no failsafe — a hung creative could trap the player');
  });
});
