// Aggregate telemetry: vocabulary, bucketing, and the privacy invariants.
//
// The last suite is the important one. The claim this feature makes is "no
// identifier is collected", and a claim like that is worth exactly as much as
// the test that fails when someone breaks it.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAILURE_KINDS, BROWSERS, PLATFORMS, VITALS, BUCKETS, ROUTES,
  browserFamily, platformClass, normalizeFailure, normalizeMetric, vitalBucket,
  routeClass, failureKey, parseFailureKey, vitalKey, parseVitalKey,
  buildFailure, buildVital, summarizeFailures, summarizeVitals,
} from '../lib/telemetry.mjs';

const slugOk = (s) => s === 'basketball-random' || s === 'vex-10';

describe('browser families', () => {
  // Every Chromium browser also says "Chrome", and every one also says
  // "Safari". These are the cases a naive regex order gets wrong.
  const UA = {
    chrome:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    edge:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    opera:   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0',
    samsung: 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
    firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    fxios:   'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
    safari:  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    crios:   'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1',
  };

  test('the most specific claim wins, not the first one found', () => {
    assert.equal(browserFamily(UA.edge), 'edge');
    assert.equal(browserFamily(UA.opera), 'opera');
    assert.equal(browserFamily(UA.samsung), 'samsung');
    assert.equal(browserFamily(UA.chrome), 'chrome');
    assert.equal(browserFamily(UA.safari), 'safari');
    assert.equal(browserFamily(UA.firefox), 'firefox');
  });

  test('iOS wrappers are their own brand, not Safari', () => {
    assert.equal(browserFamily(UA.fxios), 'firefox');
    assert.equal(browserFamily(UA.crios), 'chrome');
  });

  test('junk, empty and missing all land in a real bucket', () => {
    for (const v of ['', null, undefined, 'wat', '🙂', {}, 123]) {
      assert.ok(BROWSERS.includes(browserFamily(v)), `${String(v)} -> must be a known family`);
    }
    assert.equal(browserFamily('definitely not a browser'), 'other');
  });

  test('every family returned is in the published vocabulary', () => {
    for (const ua of Object.values(UA)) assert.ok(BROWSERS.includes(browserFamily(ua)));
  });
});

describe('platform class', () => {
  test('phones and tablets are mobile, desktops are desktop', () => {
    assert.equal(platformClass('iPhone; CPU iPhone OS 17_5'), 'mobile');
    assert.equal(platformClass('Linux; Android 13; SM-S918B ... Mobile Safari'), 'mobile');
    assert.equal(platformClass('iPad; CPU OS 17_5 like Mac OS X'), 'mobile');
    assert.equal(platformClass('Macintosh; Intel Mac OS X 10_15_7'), 'desktop');
    assert.equal(platformClass('Windows NT 10.0; Win64; x64'), 'desktop');
  });

  test('there are exactly two buckets, and the default is safe', () => {
    assert.deepEqual([...PLATFORMS], ['desktop', 'mobile']);
    for (const v of ['', null, undefined, 'wat']) {
      assert.ok(PLATFORMS.includes(platformClass(v)));
    }
  });
});

describe('client input is refused, not coerced', () => {
  test('an unknown failure kind produces null so the caller drops it', () => {
    for (const k of FAILURE_KINDS) assert.equal(normalizeFailure(k), k);
    assert.equal(normalizeFailure('BLANK'), 'blank', 'case is normalised');
    for (const bad of ['', null, undefined, 'other', 'wat', 'DROP TABLE games', '<script>']) {
      assert.equal(normalizeFailure(bad), null, `${String(bad)} must be refused`);
    }
  });

  test('an unknown metric produces null', () => {
    assert.equal(normalizeMetric('lcp'), 'LCP');
    assert.equal(normalizeMetric('TTFB'), 'TTFB');
    for (const bad of ['', null, 'FID', 'wat', 'LCP; DROP']) {
      assert.equal(normalizeMetric(bad), null, `${String(bad)} must be refused`);
    }
  });

  test('free text can never become a row', () => {
    // The whole point of the closed vocabulary: a hostile body yields nothing.
    assert.equal(buildFailure({ slug: 'basketball-random', kind: "'; DROP TABLE games; --", ua: 'x' }, slugOk), null);
    assert.equal(buildVital({ metric: '<img onerror=1>', value: 10, path: '/', ua: 'x' }), null);
  });
});

describe('vitals bucketing', () => {
  test('the published thresholds, at their exact boundaries', () => {
    assert.equal(vitalBucket('LCP', 2500), 'good');
    assert.equal(vitalBucket('LCP', 2500.1), 'needs_improvement');
    assert.equal(vitalBucket('LCP', 4000), 'needs_improvement');
    assert.equal(vitalBucket('LCP', 4000.1), 'poor');
    assert.equal(vitalBucket('CLS', 0.1), 'good');
    assert.equal(vitalBucket('CLS', 0.25), 'needs_improvement');
    assert.equal(vitalBucket('CLS', 0.26), 'poor');
    assert.equal(vitalBucket('INP', 200), 'good');
    assert.equal(vitalBucket('TTFB', 801), 'needs_improvement');
  });

  test('a bucket is always one of three, or nothing', () => {
    assert.ok(BUCKETS.includes(vitalBucket('LCP', 1)));
    assert.equal(BUCKETS.length, 3);
  });

  test('garbage and impossible values yield no row', () => {
    for (const v of [NaN, Infinity, -1, -0.5, 'fast', null, undefined, {}]) {
      assert.equal(vitalBucket('LCP', v), null, `${String(v)} must be refused`);
    }
  });

  test('a negative value cannot buy a "good" rating', () => {
    assert.equal(vitalBucket('CLS', -1), null);
  });
});

describe('route class', () => {
  test('paths reduce to page classes', () => {
    assert.equal(routeClass('/'), 'home');
    assert.equal(routeClass('/index.html'), 'home');
    assert.equal(routeClass('/play/basketball-random'), 'play');
    assert.equal(routeClass('/category/sports'), 'category');
    assert.equal(routeClass('/ai'), 'ai');
    assert.equal(routeClass('/browser'), 'browser');
    assert.equal(routeClass('/community'), 'other');
  });

  test('a query string never survives — it can carry a search term', () => {
    assert.equal(routeClass('/?q=something+private'), 'home');
    assert.equal(routeClass('/category/sports?q=secret#frag'), 'category');
    for (const p of ['/?q=a', '/play/x?y=z', '/ai#chat']) {
      assert.ok(ROUTES.includes(routeClass(p)));
    }
  });
});

describe('counter keys round-trip', () => {
  test('failure keys survive a round trip', () => {
    const k = failureKey('vex-10', 'safari', 'mobile', 'blank');
    assert.deepEqual(parseFailureKey(k), {
      slug: 'vex-10', browser: 'safari', platform: 'mobile', kind: 'blank',
    });
  });

  test('vital keys survive a round trip', () => {
    const k = vitalKey('LCP', 'poor', 'play', 'mobile');
    assert.deepEqual(parseVitalKey(k), {
      metric: 'LCP', bucket: 'poor', route: 'play', platform: 'mobile',
    });
  });

  test('a malformed key parses to null rather than a half row', () => {
    for (const bad of ['', 'a|b', 'a|b|c', 'a|b|c|d|e', '|b|c|d', null]) {
      assert.equal(parseFailureKey(bad), null, `${String(bad)}`);
      assert.equal(parseVitalKey(bad), null, `${String(bad)}`);
    }
  });
});

describe('building a report', () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile Safari/605.1.15';

  test('a real failure becomes one counter key', () => {
    const r = buildFailure({ slug: 'basketball-random', kind: 'blank', ua }, slugOk);
    assert.deepEqual(r, {
      key: 'basketball-random|safari|mobile|blank',
      slug: 'basketball-random', browser: 'safari', platform: 'mobile', kind: 'blank',
    });
  });

  test('an unknown slug is refused, so the table cannot be grown at will', () => {
    assert.equal(buildFailure({ slug: 'not-a-game', kind: 'blank', ua }, slugOk), null);
    assert.equal(buildFailure({ slug: 'a'.repeat(500), kind: 'blank', ua }, slugOk), null);
    assert.equal(buildFailure({ slug: '', kind: 'blank', ua }, slugOk), null);
  });

  test('a missing slug checker refuses everything rather than trusting input', () => {
    assert.equal(buildFailure({ slug: 'basketball-random', kind: 'blank', ua }, undefined), null);
  });

  test('a vital becomes one counter key', () => {
    const r = buildVital({ metric: 'lcp', value: 5000, path: '/play/vex-10', ua });
    assert.deepEqual(r, {
      key: 'LCP|poor|play|mobile', metric: 'LCP', bucket: 'poor', route: 'play', platform: 'mobile',
    });
  });

  test('identical reports from different visitors collide into one key', () => {
    // This is the privacy property stated as a behaviour: two different people
    // on the same browser hitting the same bug are INDISTINGUISHABLE, because
    // they produce the same key and all that changes is a count.
    const a = buildFailure({ slug: 'vex-10', kind: 'timeout', ua }, slugOk);
    const b = buildFailure({ slug: 'vex-10', kind: 'timeout', ua: ua + ' Safari/605.1.15' }, slugOk);
    assert.equal(a.key, b.key);
  });
});

describe('summaries', () => {
  test('failures rank worst-first and total correctly', () => {
    const counts = new Map([
      ['vex-10|safari|mobile|blank', 12],
      ['basketball-random|chrome|desktop|timeout', 3],
      ['vex-10|chrome|desktop|blank', 5],
    ]);
    const s = summarizeFailures(counts);
    assert.equal(s.total, 20);
    assert.equal(s.combinations, 3);
    assert.equal(s.worst[0].slug, 'vex-10');
    assert.equal(s.worst[0].count, 12);
    assert.equal(s.byKind.blank, 17);
    assert.equal(s.byKind.timeout, 3);
    assert.equal(s.byBrowser.safari, 12);
  });

  test('a malformed key is skipped, never half-counted', () => {
    const s = summarizeFailures(new Map([['garbage', 9], ['vex-10|safari|mobile|blank', 1]]));
    assert.equal(s.total, 1);
    assert.equal(s.combinations, 1);
  });

  test('vitals report the good-rate Google actually publishes', () => {
    const counts = new Map([
      ['LCP|good|play|mobile', 75],
      ['LCP|poor|play|mobile', 25],
      ['CLS|good|home|desktop', 10],
    ]);
    const s = summarizeVitals(counts);
    assert.equal(s.total, 110);
    assert.equal(s.byMetric.LCP.goodRate, 0.75);
    assert.equal(s.byMetric.CLS.goodRate, 1);
    assert.equal(s.byRoute.play.goodRate, 0.75);
  });

  test('summaries of nothing are still well-formed', () => {
    assert.deepEqual(summarizeFailures(new Map()), {
      total: 0, combinations: 0, byKind: {}, byBrowser: {}, worst: [],
    });
    assert.deepEqual(summarizeVitals(new Map()), { total: 0, byMetric: {}, byRoute: {} });
  });
});

describe('PRIVACY INVARIANTS — these are the feature, not a detail', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';

  test('no function accepts or returns an identifier field', () => {
    const r = buildFailure({
      slug: 'vex-10', kind: 'blank', ua,
      // Everything a caller might try to smuggle through:
      ip: '203.0.113.9', sessionId: 'abc', visitorId: 'v1', userId: 7, cookie: 'x=y',
    }, slugOk);
    const keys = Object.keys(r);
    assert.deepEqual(keys.sort(), ['browser', 'key', 'kind', 'platform', 'slug']);
    for (const bad of ['ip', 'sessionId', 'visitorId', 'userId', 'cookie']) {
      assert.ok(!keys.includes(bad), `${bad} must not survive into the row`);
    }
  });

  test('the raw user-agent never appears in the stored key', () => {
    const r = buildFailure({ slug: 'vex-10', kind: 'blank', ua }, slugOk);
    assert.ok(!r.key.includes('Mozilla'));
    assert.ok(!r.key.includes('537.36'));
    assert.ok(!r.key.includes('Windows'));
    assert.equal(r.key, 'vex-10|chrome|desktop|blank');
  });

  test('the raw metric value never appears in the stored key', () => {
    const r = buildVital({ metric: 'LCP', value: 2473.8421, path: '/play/vex-10', ua });
    assert.ok(!r.key.includes('2473'));
    assert.ok(!r.key.includes('.84'));
    assert.equal(r.key, 'LCP|good|play|desktop');
  });

  test('the key space is small enough to be non-identifying', () => {
    // 7 browsers x 2 platforms x 5 kinds = 70 buckets per game. A combination
    // cannot narrow toward one person however many reports arrive.
    assert.equal(BROWSERS.length * PLATFORMS.length * FAILURE_KINDS.length, 70);
    // 5 metrics x 3 buckets x 6 routes x 2 platforms = 180 total vitals rows,
    // for the WHOLE site, forever.
    assert.equal(VITALS.length * BUCKETS.length * ROUTES.length * PLATFORMS.length, 180);
  });

  test('the module is pure — same input, same output, no clock, no randomness', () => {
    const input = { slug: 'vex-10', kind: 'blank', ua };
    const a = buildFailure(input, slugOk);
    const b = buildFailure(input, slugOk);
    assert.deepEqual(a, b);
    const v = { metric: 'LCP', value: 1234, path: '/play/x', ua };
    assert.deepEqual(buildVital(v), buildVital(v));
  });
});
