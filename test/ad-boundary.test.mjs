// test/ad-boundary.test.mjs — the monetization boundary, stated as tests.
// ---------------------------------------------------------------------------
// Two rules here are not preferences, they are the difference between earning
// and being banned:
//
//   1. GOOGLE'S AD STACK NEVER RUNS ON ZOFHUB'S OWN PAGES. AdSense and Ad
//      Manager forbid proxy/anonymizer traffic. A single adsbygoogle tag on a
//      page that also proxies is not a policy warning, it is an ACCOUNT-level
//      ban that takes every other site on that account with it.
//
//   2. NO AD EVER LOADS INSIDE A PROXY SURFACE. A visitor using /browser or
//      /gust is reading something on their own behalf; a third-party ad script
//      there sees that traffic. That is the user-safety line.
//
// Neither is self-enforcing, so both are asserted from the outside: what the
// registry emits, what the CSP permits, and what the server answers per surface.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROVIDERS, ROLES, SLOTS, roleOwner, isAdSurface, AD_SURFACES, resolveAdConfig,
} from '../lib/ad-providers.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const server = readFileSync(join(ROOT, 'server.js'), 'utf8');

// Every spelling of Google's ad stack that would end an account.
const GOOGLE_AD = ['googlesyndication', 'googleadservices', 'adsbygoogle', 'doubleclick'];

describe('Google ad code cannot initialise on a ZoFHub page', () => {
  test('the site-wide CSP names none of it', () => {
    // THE LAST LAYER, AND THE ONE THAT USED TO BE MISSING. Every other layer
    // refuses to EMIT Google ad code; the CSP is the only one that stops code
    // that got there some other way from EXECUTING. It previously listed
    // googlesyndication / googletagmanager explicitly, which meant the one
    // backstop was held open on every page of the site, /browser included.
    const start = server.indexOf('const CSP_DIRECTIVES');
    assert.ok(start > 0, 'CSP_DIRECTIVES not found — this test is pointed at nothing');
    const block = server.slice(start, server.indexOf('};', start));

    // Strip comments: this file explains at length WHY these names are absent,
    // and matching the explanation instead of the policy would be self-defeating.
    const code = block.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

    for (const name of [...GOOGLE_AD, 'googletagmanager']) {
      assert.ok(!code.includes(name),
        `CSP_DIRECTIVES permits ${name} — that is the account-ban surface`);
    }
  });

  test('the game sandbox keeps its own policy, so in-game revenue survives', () => {
    // Removing Google from the site CSP must not cost the 33-45% in-game share.
    // It does not: /embed/:slug sets a deliberately permissive policy for the
    // game frame. If that ever goes away, the CSP change above becomes a real
    // revenue regression and this test is the warning.
    assert.match(server, /res\.setHeader\(\s*'Content-Security-Policy',\s*\n?\s*"default-src \*/,
      '/embed no longer sets its own sandbox CSP — games now inherit the strict one');
    assert.match(server, /frame-ancestors 'self'/,
      'the embed sandbox must still refuse to be framed by anyone but us');
  });

  test('no configured value can smuggle Google ad code through the registry', () => {
    // resolveAdConfig is the only thing that turns env into servable tags.
    const hostile = {};
    for (const p of PROVIDERS) {
      const prefix = p.envPrefix || p.id.toUpperCase().replace(/[^A-Z0-9]/g, '');
      hostile[`${prefix}_ENABLED`] = '1';
      hostile[`${prefix}_SCRIPT`] = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
      hostile[`${prefix}_PUSH_SCRIPT`] = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js';
      hostile[`${prefix}_INTERSTITIAL_TAG`] = '<script src="https://googleadservices.com/x.js"></script>';
      hostile[`${prefix}_INTERSTITIAL_URL`] = 'https://googleadservices.com/click';
      hostile[`${prefix}_HEADER_TAG`] = '<ins class="adsbygoogle"></ins>';
      hostile[`${prefix}_SIDEBAR_TAG`] = '<ins class="adsbygoogle"></ins>';
      hostile[`${prefix}_NATIVE_TAG`] = '<script src="https://pagead2.googlesyndication.com/n.js"></script>';
      hostile[`${prefix}_POPUNDER_TAG`] = '<script src="https://securepubads.g.doubleclick.net/p.js"></script>';
      hostile[`${prefix}_PREROLL_VAST`] = 'https://pubads.g.doubleclick.net/gampad/ads?iu=x';
      hostile[`${prefix}_HEADER_TAG__SOUTH_ASIA`] = '<ins class="adsbygoogle"></ins>';
    }
    const json = JSON.stringify(resolveAdConfig(hostile, { regions: ['SOUTH_ASIA'] }));
    for (const name of GOOGLE_AD) {
      assert.ok(!json.includes(name),
        `an operator setting a Google tag got it served anyway (${name})`);
    }
  });

  test('every client injector refuses it again, independently', () => {
    // Defence in depth only counts if the layers are actually independent.
    for (const f of ['public/js/ad-slots.js', 'public/js/proxy-ads.js', 'public/js/preroll.js']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      assert.ok(/googlesyndication/.test(src) && /doubleclick/.test(src),
        `${f} does not screen for Google ad code before injecting`);
    }
  });
});

describe('roles are owned by exactly one network each', () => {
  const EXPECTED = {
    interstitial: 'admaven',
    display: 'exoclick',
    'in-page-push': 'hilltopads',
    preroll: 'clickadu',
    native: 'mondiad',
    popunder: 'popads',
  };

  for (const [role, owner] of Object.entries(EXPECTED)) {
    test(`${role} belongs to ${owner}`, () => {
      const got = roleOwner(role);
      assert.ok(got, `no network owns the ${role} role`);
      assert.equal(got.id, owner);
    });
  }

  test('the six roles are the whole set, with no overlap', () => {
    assert.deepEqual([...ROLES].sort(), Object.keys(EXPECTED).sort());
    // Two networks claiming one role is how you get two interstitials on one
    // page, each unaware of the other's throttle.
    for (const role of ROLES) {
      const owners = PROVIDERS.filter(p => (p.roles || []).includes(role));
      assert.equal(owners.length, 1, `${role} is claimed by ${owners.length} networks`);
    }
  });

  test('the fixed display boxes are exactly header and sidebar', () => {
    assert.deepEqual([...SLOTS].sort(), ['header', 'sidebar']);
  });
});

describe('display slots reserve their size so the page cannot jump', () => {
  const slots = readFileSync(join(ROOT, 'public/js/ad-slots.js'), 'utf8');

  test('header is 728x90 and sidebar is 300x250, as fixed boxes', () => {
    assert.match(slots, /HEADER\s*=\s*\{\s*w:\s*728,\s*h:\s*90/, 'header is not 728x90');
    assert.match(slots, /SIDEBAR\s*=\s*\{\s*w:\s*300,\s*h:\s*250/, 'sidebar is not 300x250');
    // min-height is what actually reserves the space before the network answers.
    // Matched as plain substrings: the rules interpolate `${HEADER.w}`, whose
    // own closing brace ends a `[^}]*` span long before min-height is reached.
    assert.ok(slots.includes('.zad-header{width:100%;max-width:${HEADER.w}px;min-height:${HEADER.h}px}'),
      'the header slot does not reserve 728x90 up front');
    assert.ok(slots.includes('.zad-side{width:${SIDEBAR.w}px;max-width:100%;min-height:${SIDEBAR.h}px}'),
      'the sidebar slot does not reserve 300x250 up front');
  });

  test('the native widget reserves a floor before it draws', () => {
    assert.ok(slots.includes('.zad-native{min-height:${NATIVE_MIN_H}px'), 'the native slot reserves no height');
  });

  test('an unfilled slot collapses instead of leaving a hole', () => {
    assert.match(slots, /data-zad-filled|zadFilled/,
      'nothing marks a slot as filled, so an empty one cannot be collapsed');
    const css = readFileSync(join(ROOT, 'public/css/main.css'), 'utf8');
    assert.match(css, /\.zad-native-slot\):not\(\[data-zad-filled\]\)/,
      'main.css does not hide an unfilled native slot');
  });
});

describe('the interstitial is throttled, and fails closed', () => {
  const freq = readFileSync(join(ROOT, 'public/js/ad-frequency.js'), 'utf8');
  const slots = readFileSync(join(ROOT, 'public/js/ad-slots.js'), 'utf8');

  test('the gap is 20 minutes, as a constant', () => {
    assert.match(freq, /export const INTERSTITIAL_COOLDOWN_MS\s*=\s*20\s*\*\s*60\s*\*\s*1000/,
      'the interstitial cooldown is not a 20-minute constant');
  });

  test('no localStorage means NO ad, not an unthrottled one', () => {
    // The dangerous failure is the friendly one: if the throttle cannot record
    // a timestamp, "allow it anyway" fires a full-screen ad on every launch.
    const fn = freq.slice(freq.indexOf('allow(slot'), freq.indexOf('cooldownRemaining'));
    assert.match(fn, /catch\s*\{\s*return false/,
      'allow() does not fail closed when storage is unavailable');
  });

  test('the fire path actually consults it', () => {
    // A throttle nothing calls is decoration.
    assert.match(slots, /if \(!adFrequencyController\.allow\('interstitial'/,
      'the interstitial fires without asking the frequency controller');
  });
});

describe('no ad may exist inside a proxy surface', () => {
  test('every proxy surface is refused, including AnuraOS', () => {
    for (const p of ['/browser', '/gust', '/proxy', '/uv', '/sj', '/scram', '/wisp', '/anura']) {
      assert.equal(isAdSurface(p), false, `${p} is treated as an ad surface`);
      assert.equal(isAdSurface(`${p}/deeper/path`), false, `${p}/… is treated as an ad surface`);
    }
  });

  test('a native page still is one, or there is no business', () => {
    for (const p of ['/', '/leaderboard', '/community', '/play/anything']) {
      assert.equal(isAdSurface(p), true, `${p} refuses ads — nothing would ever earn`);
    }
  });

  test('/donate is ad-free ON PURPOSE, and stays that way', () => {
    // Not an oversight in the classification — a decision. Asking for donations
    // beside paid advertising undercuts the ask. Pinned so that "why is this
    // page not earning?" is answered by a test instead of rediscovered.
    assert.equal(isAdSurface('/donate'), false);
  });

  test('an unclassified path defaults to NO ads', () => {
    // Deny-by-default: a route nobody classified is a route nobody thought
    // about, and guessing "ads are fine here" is how one leaks into a frame.
    assert.equal(isAdSurface('/something-invented-later'), false);
  });

  test('the proxy list and the native list never overlap', () => {
    const overlap = AD_SURFACES.proxy.filter(p => AD_SURFACES.native.includes(p));
    assert.deepEqual(overlap, [], 'a surface is classified as both proxy and native');
  });
});
