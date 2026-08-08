// The advertising architecture: the five networks, and the boundary that keeps
// them off the proxy.
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
  PROVIDERS, PROVIDER_IDS, SLOTS,
  resolveAdConfig, adOrigins, publicAdConfig, adminAdConfig, isAdSurface,
} from '../lib/ad-providers.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// The authoritative list. If this changes, it must be a deliberate decision —
// which is exactly why the list is asserted rather than derived.
const EXPECTED = ['hilltopads', 'adsterra', 'monetag', 'admaven', 'popads'];

describe('the five supported networks', () => {
  test('exactly these five, no more and no fewer', () => {
    assert.deepEqual(PROVIDER_IDS, EXPECTED);
  });

  test('every provider declares what it needs to be auditable', () => {
    for (const p of PROVIDERS) {
      assert.ok(p.name, `${p.id} has no display name`);
      assert.ok(p.env, `${p.id} has no env prefix`);
      assert.ok(/^https:\/\//.test(p.docs), `${p.id} has no documentation URL`);
      assert.ok(Array.isArray(p.formats) && p.formats.length, `${p.id} declares no formats`);
      assert.ok(p.approval, `${p.id} has no approval status`);
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

  test('no scripts, no slot markup', () => {
    assert.deepEqual(cfg.scripts, []);
    for (const slot of SLOTS) assert.equal(cfg.slots[slot], '', `${slot} is not empty`);
  });

  test('no CSP origins are opened', () => {
    // An allowlist entry for a network that is not running is a permission
    // granted for nothing.
    assert.deepEqual(adOrigins(cfg, []), []);
  });

  test('the public payload is empty but well-formed', () => {
    const pub = publicAdConfig(cfg);
    assert.deepEqual(pub.adScripts, []);
    assert.equal(pub.proxyBannerTag, '');
    // Shape must survive so the client never reads undefined.
    for (const k of ['proxyHeaderTag', 'proxySidebarTag', 'proxyInContentTag']) {
      assert.equal(typeof pub[k], 'string');
    }
  });
});

describe('enabling a network', () => {
  const env = {
    ADSTERRA_ENABLED: '1',
    ADSTERRA_SCRIPT: 'https://cdn.example-adsterra.test/invoke.js',
    ADSTERRA_ZONE: 'zone-123',
    ADSTERRA_FOOTER_TAG: '<script src="https://banners.example-adsterra.test/b.js"></script>',
  };
  const cfg = resolveAdConfig(env);

  test('it becomes active and owns its slot', () => {
    assert.deepEqual(cfg.activeIds, ['adsterra']);
    assert.equal(cfg.slotOwner.footer, 'adsterra');
    assert.match(cfg.slots.footer, /banners\.example-adsterra\.test/);
  });

  test('the others stay completely inert', () => {
    for (const p of cfg.providers) {
      if (p.id === 'adsterra') continue;
      assert.equal(p.active, false, `${p.id} activated without being enabled`);
      assert.equal(p.scriptCount, 0);
    }
  });

  test('CSP covers both the loader and the banner host', () => {
    // The banner tag is raw HTML — its src must be extracted, or the browser
    // blocks it with only a console line, which looks exactly like the network
    // not paying out.
    const origins = adOrigins(cfg, []);
    assert.ok(origins.includes('https://cdn.example-adsterra.test'), 'loader origin missing');
    assert.ok(origins.includes('https://banners.example-adsterra.test'), 'banner origin missing');
  });

  test('enabled but unconfigured renders nothing', () => {
    const half = resolveAdConfig({ MONETAG_ENABLED: '1' });
    const monetag = half.providers.find(p => p.id === 'monetag');
    assert.equal(monetag.enabled, true);
    assert.equal(monetag.configured, false);
    assert.equal(monetag.active, false, 'a half-configured network must render nothing');
    assert.equal(half.anyActive, false);
  });

  test('configured but not enabled renders nothing', () => {
    const off = resolveAdConfig({ POPADS_SCRIPT: 'https://cdn.example-popads.test/p.js' });
    assert.equal(off.anyActive, false, 'a disabled network must not serve');
    assert.deepEqual(off.scripts, []);
  });
});

describe('one slot, one network', () => {
  test('two networks cannot fill the same slot', () => {
    // Duplicate scripts in one box break the layout and breach several
    // networks' terms.
    const cfg = resolveAdConfig({
      HILLTOPADS_ENABLED: '1', HILLTOPADS_HEADER_TAG: '<script src="https://a.test/x.js"></script>',
      ADSTERRA_ENABLED: '1', ADSTERRA_HEADER_TAG: '<script src="https://b.test/y.js"></script>',
    });
    assert.equal(cfg.slotOwner.header, 'hilltopads', 'registry order must decide deterministically');
    assert.doesNotMatch(cfg.slots.header, /b\.test/, 'the second network leaked into the same slot');
  });

  test('the same loader URL is never listed twice', () => {
    const dup = 'https://shared.test/loader.js';
    const cfg = resolveAdConfig({
      MONETAG_ENABLED: '1', MONETAG_SCRIPT: dup,
      ADMAVEN_ENABLED: '1', ADMAVEN_SCRIPT: dup,
    });
    assert.equal(cfg.scripts.filter(s => s === dup).length, 1,
      'the same script would be injected twice');
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
      const cfg = resolveAdConfig({ MONETAG_ENABLED: '1', MONETAG_SCRIPT: url });
      assert.deepEqual(cfg.scripts, []);
      assert.deepEqual(adOrigins(cfg, []), []);
    });
  }

  test('rejected inside a slot tag', () => {
    const cfg = resolveAdConfig({
      ADSTERRA_ENABLED: '1',
      ADSTERRA_HEADER_TAG: '<script src="https://pagead2.googlesyndication.com/x.js"></script>',
    });
    assert.equal(cfg.slots.header, '');
  });

  test('rejected in the manual CSP escape hatch', () => {
    const cfg = resolveAdConfig({});
    assert.deepEqual(adOrigins(cfg, ['https://*.doubleclick.net']), []);
  });

  test('non-https loaders are refused', () => {
    const cfg = resolveAdConfig({ POPADS_ENABLED: '1', POPADS_SCRIPT: 'http://insecure.test/p.js' });
    assert.deepEqual(cfg.scripts, []);
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
    const proxyPages = ['public/gust/index.html'];
    for (const rel of proxyPages) {
      let src;
      try { src = readFileSync(join(ROOT, rel), 'utf8'); } catch { continue; }
      for (const mod of ['ad-slots.js', 'footer-ad.js', 'proxy-ads.js']) {
        assert.ok(!src.includes(mod), `${rel} imports ${mod}`);
      }
    }
  });
});

describe('secrets never leave the server', () => {
  const cfg = resolveAdConfig({
    POPADS_ENABLED: '1',
    POPADS_SCRIPT: 'https://cdn.example-popads.test/p.js',
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
    const json = JSON.stringify(publicAdConfig(cfg));
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

  test('the legal pages list exactly the five supported networks', () => {
    // The disclosure has to match reality: naming a network we do not use is
    // wrong, and using one we do not name is worse.
    for (const rel of ['legal/privacy.html', 'legal/cookies.html']) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      for (const name of ['Adsterra', 'HilltopAds', 'Monetag', 'Ad-Maven', 'PopAds']) {
        assert.ok(src.includes(name), `${rel} does not disclose ${name}`);
      }
      for (const gone of ['PropellerAds', 'Clickadu', 'Adcash']) {
        assert.ok(!src.includes(gone), `${rel} still names ${gone}, which is not supported`);
      }
    }
  });
});
