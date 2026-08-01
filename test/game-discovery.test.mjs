// Unit tests for lib/game-discovery.mjs — URL safety and cross-domain
// duplicate detection. No network: every case is pure logic.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkUrlSafety, normalizeUrl, providerFingerprint, normalizeTitle, findDuplicates,
} from '../lib/game-discovery.mjs';

describe('checkUrlSafety — only approved URLs may be embedded', () => {
  test('accepts a normal https game embed', () => {
    for (const u of [
      'https://html5.gamemonetize.co/abc123xyz/',
      'https://www.y8.com/embed/turn_and_hit',
      'https://play.famobi.com/kk-shadow-run',
    ]) {
      assert.equal(checkUrlSafety(u).ok, true, `should allow ${u}`);
    }
  });

  test('rejects non-https', () => {
    // An http:// frame in an https:// page is blocked by every modern browser,
    // so accepting it would only ever render a blank tile.
    assert.deepEqual(checkUrlSafety('http://y8.com/embed/x'), { ok: false, reason: 'not_https' });
  });

  test('rejects credentials in the URL', () => {
    // https://trusted.com@evil.example is the classic phishing shape.
    assert.equal(checkUrlSafety('https://user:pw@evil.example/g').reason, 'credentials_in_url');
  });

  test('rejects internal and cloud-metadata addresses', () => {
    for (const u of [
      'https://169.254.169.254/latest/meta-data/',   // AWS/GCP metadata
      'https://127.0.0.1/g', 'https://localhost/g',
      'https://10.0.0.5/g', 'https://192.168.1.1/g', 'https://172.16.0.1/g',
      'https://100.64.0.1/g',                        // CGNAT
    ]) {
      assert.equal(checkUrlSafety(u).reason, 'internal_address', `should block ${u}`);
    }
  });

  test('rejects encoded IPv4 forms that smuggle past a string check', () => {
    // 2130706433 === 127.0.0.1 and 0x7f000001 === 127.0.0.1 to most resolvers.
    assert.equal(checkUrlSafety('https://2130706433/g').reason, 'internal_address');
    assert.equal(checkUrlSafety('https://0x7f000001/g').reason, 'internal_address');
  });

  test('rejects link shorteners and IP loggers', () => {
    // A shortener hides the real destination, so validating it validates nothing.
    for (const u of ['https://bit.ly/xyz', 'https://tinyurl.com/xyz', 'https://grabify.link/xyz']) {
      assert.equal(checkUrlSafety(u).reason, 'blocked_host', `should block ${u}`);
    }
  });

  test('rejects malformed input without throwing', () => {
    for (const u of ['not a url', '', null, undefined, 'javascript:alert(1)', 'data:text/html,<script>']) {
      const r = checkUrlSafety(u);
      assert.equal(r.ok, false, `should reject ${JSON.stringify(u)}`);
    }
  });
});

describe('normalizeUrl', () => {
  test('collapses www, trailing slash, hash and tracking params', () => {
    const a = normalizeUrl('https://www.y8.com/embed/slope/?utm_source=x&fbclid=y#frag');
    const b = normalizeUrl('https://y8.com/embed/slope');
    assert.equal(a, b, 'these are the same game');
  });

  test('keeps meaningful query parameters', () => {
    assert.match(normalizeUrl('https://portal.example/play?id=42'), /id=42/);
  });

  test('returns null for junk instead of throwing', () => {
    assert.equal(normalizeUrl('nonsense'), null);
    assert.equal(normalizeUrl(null), null);
  });
});

describe('providerFingerprint — identity across hosts', () => {
  test('gamezop: the partner id is in the SUBDOMAIN and must be ignored', () => {
    // THE case this engine exists for. Measured in the live catalog: 129 games
    // on one gamezop subdomain and 99 on another.
    const a = providerFingerprint('https://4665.play.gamezop.com/g/xyz789');
    const b = providerFingerprint('https://zv1y2i8p.play.gamezop.com/g/xyz789');
    assert.deepEqual(a, b, 'same game under two partner subdomains must match');
    assert.equal(a.provider, 'gamezop');
  });

  test('y8: www and tracking params do not change identity', () => {
    assert.deepEqual(
      providerFingerprint('https://www.y8.com/embed/turn_and_hit'),
      providerFingerprint('https://y8.com/embed/turn_and_hit?utm_source=x'),
    );
  });

  test('gamedistribution: the uuid identifies the game, SDK plumbing does not', () => {
    const fp = providerFingerprint(
      'https://html5.gamedistribution.com/01a1c2c5d52e4b4f9c6f8c3a4f3a2b1c/?gd_sdk_referrer_url=https%3A%2F%2Fx');
    assert.equal(fp.provider, 'gamedistribution');
    assert.equal(fp.id, '01a1c2c5d52e4b4f9c6f8c3a4f3a2b1c');
  });

  test('recognises each major portal in the catalog', () => {
    const cases = [
      ['https://html5.gamemonetize.co/abc123/', 'gamemonetize'],
      ['https://cdn.htmlgames.com/Klaverjassen/index.html', 'htmlgames'],
      ['https://play.famobi.com/kk-shadow-run', 'famobi'],
      ['https://onlinegames.io/some-game/', 'onlinegames'],
    ];
    for (const [url, provider] of cases) {
      assert.equal(providerFingerprint(url).provider, provider, url);
    }
  });

  test('unknown portals still get a stable fingerprint', () => {
    const a = providerFingerprint('https://www.newportal.example/play/game-7?utm_source=x');
    const b = providerFingerprint('https://newportal.example/play/game-7');
    assert.deepEqual(a, b);
    assert.equal(a.provider, 'url');
  });
});

describe('normalizeTitle', () => {
  test('strips filler words that carry no identity', () => {
    assert.equal(normalizeTitle('Bubble Shooter Online Free Game'), normalizeTitle('Bubble Shooter'));
    assert.equal(normalizeTitle('Slope 3D Unblocked'), normalizeTitle('Slope'));
  });
});

describe('findDuplicates', () => {
  const catalog = [
    { slug: 'slope', title: 'Slope', game_url: 'https://y8.com/embed/slope' },
    { slug: 'zop-a', title: 'Bubble Pop', game_url: 'https://4665.play.gamezop.com/g/bub1' },
    { slug: 'other', title: 'Chess Master', game_url: 'https://html5.gamemonetize.co/chess1/' },
  ];

  test('exact when the URL already exists', () => {
    const r = findDuplicates({ url: 'https://www.y8.com/embed/slope/?utm_source=x', title: 'Slope' }, catalog);
    assert.equal(r.status, 'exact');
    assert.equal(r.matches[0].slug, 'slope');
  });

  test('exact when the SAME GAME is on a different domain', () => {
    // The whole point of the engine: a different partner subdomain is not a
    // different game, and a string comparison on game_url would miss it.
    const r = findDuplicates({ url: 'https://zv1y2i8p.play.gamezop.com/g/bub1', title: 'Bubble Pop' }, catalog);
    assert.equal(r.status, 'exact');
    assert.equal(r.matches[0].kind, 'same_provider_id');
    assert.equal(r.matches[0].slug, 'zop-a');
  });

  test('likely — not exact — when only the title matches', () => {
    // Two different games really are both called "Chess Master", so a
    // title-only agreement is evidence for a human, not grounds to reject.
    const r = findDuplicates({ url: 'https://newportal.example/g/chess', title: 'Chess Master' }, catalog);
    assert.equal(r.status, 'likely');
    assert.equal(r.matches[0].kind, 'same_title');
  });

  test('new when nothing matches', () => {
    const r = findDuplicates({ url: 'https://html5.gamemonetize.co/brand-new-999/', title: 'Brand New 999' }, catalog);
    assert.equal(r.status, 'new');
    assert.equal(r.matches.length, 0);
  });

  test('handles an empty catalog and junk input', () => {
    assert.equal(findDuplicates({ url: 'https://y8.com/embed/x', title: 'X' }, []).status, 'new');
    assert.equal(findDuplicates({ url: 'nonsense', title: '' }, catalog).status, 'new');
  });
});
