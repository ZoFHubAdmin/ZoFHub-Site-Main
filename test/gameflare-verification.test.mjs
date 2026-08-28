// GameFlare verification — the ad/game discrimination, and the pass gate.
//
// WHAT THESE TESTS ARE ACTUALLY GUARDING
// A previous detector asked "are these pixels varied?" and answered yes for
// LinkedIn and Popeyes pre-roll video advertisements, reporting 7 of 9
// candidates as verified working. A video ad is the richest possible frame, so
// richness was measuring exactly the wrong thing.
//
// The tests below are therefore mostly about what must NOT be called a game:
//
//   • a playing ad video, however busy the frame
//   • a countdown reading 00:02 / 00:30
//   • a canvas that was already there before the ad ran
//   • a Ruffle element with no rendered canvas behind it
//   • anything at all when the frame's DOM could not be read
//
// Pure module tests. No server, no network, no browser.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE, classifyObservation, summariseTimeline, parseCountdown, identifyAdProvider,
} from '../lib/gameflare-state.mjs';
import { STATUS, TRANSIENT, DEFAULTS } from '../lib/gameflare-verify.mjs';
import {
  EMBED_STATUS, EMBED_REASON, classifyPage, srcsFromEmbedCode, summarise,
} from '../lib/gameflare-embed-extract.mjs';
import { imageDelta, isBlankImage } from '../lib/png-stats.mjs';
import { deflateSync } from 'node:zlib';

// A frame showing a live pre-roll: the exact shape that produced the false
// positives. Every game-ish signal a naive detector would latch onto is here.
const AD_SAMPLE = {
  domReadable: true,
  adContainerPresent: true,
  adContainerVisible: true,
  adElementIds: ['adinplay-container', 'adinplay-progress-text'],
  adProgressText: '00:02 / 00:30',
  adVideo: { playing: true, currentTime: 2.1, duration: 30.03, host: 'cdn.flashtalking.com' },
  adFrameCount: 2,
  visibleCanvases: [],
  ruffleElement: false,
  ruffleCanvas: false,
  playControlVisible: false,
  frameText: 'Monopoly Online Controls: MOUSE INTERACTION 00:02 / 00:30',
  pixels: { ok: true, dominantShare: 0.08, meaningfulTones: 140, meanLuma: 96 },
  motion: 0.42,
};

const GAME_SAMPLE = {
  domReadable: true,
  adContainerPresent: true,
  adContainerVisible: false,
  adElementIds: ['adinplay-container'],
  adProgressText: null,
  adVideo: null,
  adFrameCount: 0,
  visibleCanvases: [{ w: 933, h: 700 }],
  ruffleElement: false,
  ruffleCanvas: false,
  playControlVisible: false,
  frameText: 'Sprunki Phase 6 Toggle navigation',
  pixels: { ok: true, dominantShare: 0.11, meaningfulTones: 120, meanLuma: 70 },
  motion: 0.06,
};

describe('ad vs game discrimination', () => {
  test('a playing pre-roll is AD_PLAYING, never a game — the original false positive', () => {
    const r = classifyObservation(AD_SAMPLE);
    assert.equal(r.state, STATE.AD_PLAYING);
    assert.equal(r.adDetected, true);
    assert.notEqual(r.state, STATE.GAME_PLAYABLE);
  });

  test('rich pixels alone never reach a game state', () => {
    // Everything a "not blank" detector would have seen, and nothing else.
    const r = classifyObservation({
      domReadable: false,
      pixels: { ok: true, dominantShare: 0.02, meaningfulTones: 210, meanLuma: 130 },
      motion: 0.9,
    });
    assert.notEqual(r.state, STATE.GAME_PLAYABLE);
  });

  test('a live canvas after the ad is GAME_PLAYABLE', () => {
    assert.equal(classifyObservation(GAME_SAMPLE).state, STATE.GAME_PLAYABLE);
  });

  test('motion alone is NEVER a game — the sprunki-phase-4 false positive', () => {
    // Taken verbatim from the run that wrongly passed: no canvas anywhere, a
    // frame that was solid black with Chrome's broken-content icon, flickering
    // between load states at 0.78 measured motion. Any state in the GAME_*
    // family here is the banned "rich pixels = game" heuristic returning.
    const flicker = {
      domReadable: true,
      adContainerPresent: false, adContainerVisible: false, adElementIds: [],
      adProgressText: null, adVideo: null, adFrameCount: 0,
      visibleCanvases: [],
      ruffleElement: false, ruffleCanvas: false, playControlVisible: false,
      frameText: '',
      pixels: { ok: true, dominantShare: 0.9964, meaningfulTones: 3, meanLuma: 4 },
      motion: 0.7799,
    };
    const r = classifyObservation(flicker);
    assert.notEqual(r.state, STATE.GAME_PLAYABLE);
    assert.notEqual(r.state, STATE.GAME_INITIALIZED);
    assert.ok(!r.reasons.includes('game_canvas_present'));
  });

  test('a canvas with no motion is initialized but not yet playable', () => {
    const still = { ...GAME_SAMPLE, motion: 0 };
    assert.equal(classifyObservation(still).state, STATE.GAME_INITIALIZED);
  });

  test('the loading splash is not a game — the sprunki-phase-5 false positive', () => {
    // GameFlare's splash is drawn on a full-size canvas and animates a progress
    // bar, with a display banner on it. Canvas + motion describes it perfectly,
    // which is how a screenshot of a progress bar and a War Thunder advert was
    // recorded as verified_working. The visible #loading element is what tells
    // them apart.
    const splash = { ...GAME_SAMPLE, loadingIndicatorVisible: true, motion: 0.2 };
    const r = classifyObservation(splash);
    assert.equal(r.state, STATE.GAME_LOADING);
    assert.notEqual(r.state, STATE.GAME_PLAYABLE);
    assert.ok(r.reasons.includes('loading_indicator_visible'));
  });

  test('the same frame WITHOUT the splash is playable', () => {
    const live = { ...GAME_SAMPLE, loadingIndicatorVisible: false, motion: 0.2 };
    assert.equal(classifyObservation(live).state, STATE.GAME_PLAYABLE);
  });

  test('an ad wins even when a game canvas is already in the DOM behind it', () => {
    // The canvas is created behind the ad overlay, so both are present at once.
    // Reporting "game" here is exactly the mistake being guarded against.
    const both = { ...AD_SAMPLE, visibleCanvases: [{ w: 933, h: 700 }] };
    assert.equal(classifyObservation(both).state, STATE.AD_PLAYING);
  });

  test('an unreadable DOM cannot produce GAME_PLAYABLE, only a weaker claim', () => {
    const blind = { ...GAME_SAMPLE, domReadable: false };
    const r = classifyObservation(blind);
    assert.notEqual(r.state, STATE.GAME_PLAYABLE);
    assert.equal(r.state, STATE.GAME_INITIALIZED);
  });

  test('a Ruffle element with no canvas is loading, not playable', () => {
    const r = classifyObservation({
      domReadable: true, adContainerPresent: true, adContainerVisible: false,
      visibleCanvases: [], ruffleElement: true, ruffleCanvas: false,
      frameText: 'Monopoly Online', adFrameCount: 0,
    });
    assert.equal(r.state, STATE.GAME_LOADING);
  });

  test('the in-frame Play control means the landing page, not a game', () => {
    const r = classifyObservation({
      domReadable: true, playControlVisible: true, visibleCanvases: [],
      frameText: 'Monopoly Online PLAY GAME', adFrameCount: 0,
    });
    assert.equal(r.state, STATE.GAMEFLARE_PAGE);
  });

  test('a sub-200px canvas is not a game surface', () => {
    const tiny = { ...GAME_SAMPLE, visibleCanvases: [{ w: 40, h: 30 }], motion: 0 };
    assert.notEqual(classifyObservation(tiny).state, STATE.GAME_PLAYABLE);
  });
});

describe('countdown parsing', () => {
  test('reads elapsed and total', () => {
    assert.deepEqual(parseCountdown('00:02 / 00:30'), { elapsedSec: 2, totalSec: 30 });
    assert.deepEqual(parseCountdown('1:05 / 2:00'), { elapsedSec: 65, totalSec: 120 });
  });

  test('rejects anything that is not a countdown', () => {
    for (const bad of ['', null, undefined, 'Loading advertisement', '00:30', 'a/b', '00:00 / 00:00']) {
      assert.equal(parseCountdown(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('is anchored — a timestamp inside other text does not match', () => {
    assert.equal(parseCountdown('published 10:00 / 12:00 yesterday'), null);
  });
});

describe('ad provider identification', () => {
  test('names AdInPlay only from evidence that identifies it', () => {
    assert.equal(identifyAdProvider({ adElementIds: ['adinplay-container'] }), 'AdInPlay');
  });

  test('a generic ad container yields null rather than a guess', () => {
    assert.equal(identifyAdProvider({ adElementIds: ['video-ad-wrap', 'ad-container'] }), null);
    assert.equal(identifyAdProvider({}), null);
  });
});

describe('timeline: the ad -> game transition must be real', () => {
  const at = (ms, state, extra = {}) => ({ atMs: ms, state, reasons: [], adProvider: null, countdown: null, ...extra });

  test('a game seen only BEFORE the ad does not count as appearing after it', () => {
    const tl = summariseTimeline([
      at(0, STATE.GAME_PLAYABLE),
      at(2000, STATE.AD_PLAYING),
      at(30000, STATE.AD_PLAYING),
      at(32000, STATE.AD_FINISHED),
    ]);
    assert.equal(tl.adDetected, true);
    assert.equal(tl.gameAppearedAfterAd, false);
  });

  test('a game after the last ad sample counts', () => {
    const tl = summariseTimeline([
      at(0, STATE.GAMEFLARE_PAGE),
      at(4000, STATE.AD_PLAYING, { adProvider: 'AdInPlay', countdown: { elapsedSec: 0, totalSec: 30 } }),
      at(34000, STATE.AD_PLAYING),
      at(44000, STATE.GAME_PLAYABLE),
    ]);
    assert.equal(tl.gameAppearedAfterAd, true);
    assert.equal(tl.adProvider, 'AdInPlay');
    assert.equal(tl.adDeclaredSec, 30);
    assert.equal(tl.adObservedMs, 30000);
    assert.equal(tl.playableAtMs, 44000);
  });

  test('an ad that never ends reports no game and a final ad state', () => {
    const tl = summariseTimeline([at(0, STATE.AD_PLAYING), at(60000, STATE.AD_PLAYING)]);
    assert.equal(tl.gameAppearedAfterAd, false);
    assert.equal(tl.finalState, STATE.AD_PLAYING);
  });

  test('an empty timeline is unknown, not fine', () => {
    assert.equal(summariseTimeline([]).finalState, STATE.UNKNOWN);
    assert.equal(summariseTimeline([]).gameAppearedAfterAd, false);
  });
});

describe('verification statuses', () => {
  test('failures are not collapsed into one bucket', () => {
    const failures = Object.values(STATUS).filter(s => s.startsWith('failed_'));
    assert.ok(failures.length >= 8, `expected distinct failure states, got ${failures.length}`);
    assert.equal(new Set(Object.values(STATUS)).size, Object.values(STATUS).length);
  });

  test('verified_working is the single pass value and matches the catalog policy', async () => {
    const { ELIGIBLE_STATUS } = await import('../lib/gameflare-catalog.mjs');
    assert.equal(STATUS.VERIFIED, ELIGIBLE_STATUS);
  });

  test('only conditions are retryable — a new tab is a property, not a condition', () => {
    assert.ok(TRANSIENT.has(STATUS.AD_TIMEOUT));
    assert.ok(TRANSIENT.has(STATUS.NETWORK));
    assert.ok(!TRANSIENT.has(STATUS.NEW_TAB));
    assert.ok(!TRANSIENT.has(STATUS.PARENT_NAV));
    assert.ok(!TRANSIENT.has(STATUS.VERIFIED));
  });

  test('the ad budget is long enough for a 30s pre-roll plus loading', () => {
    assert.ok(DEFAULTS.adMaxWaitMs >= 45000, 'a 30s ad plus its loading gate needs >=45s');
  });
});

describe('embed URL extraction', () => {
  test('pulls the src out of an official embed snippet', () => {
    const code = '<iframe src="https://www.gameflare.com/embed/monopoly-online/" frameborder="0" '
      + 'scrolling="no" width="800" height="635" allowfullscreen></iframe>';
    assert.deepEqual(srcsFromEmbedCode(code), ['https://www.gameflare.com/embed/monopoly-online/']);
  });

  test('a page publishing embed code resolves to embed_url_found', () => {
    const r = classifyPage({
      title: 'Monopoly Online | Gameflare.com',
      bodyText: 'Monopoly Online Embed code Overview',
      textareas: ['<iframe src="https://www.gameflare.com/embed/monopoly-online/"></iframe>'],
      inGameSrc: 'https://www.gameflare.com/embed/monopoly-online/',
    });
    assert.equal(r.status, EMBED_STATUS.FOUND);
    assert.equal(r.embedUrl, 'https://www.gameflare.com/embed/monopoly-online/');
  });

  test('a soft 404 is unavailable, not "no embed code"', () => {
    // GameFlare serves missing games as HTTP 200 with a 404 body.
    const r = classifyPage({
      title: 'Free Online Games | Gameflare.com',
      bodyText: 'ERROR 404 SORRY, BUT THE PAGE DOES NOT EXIST. Popular Games',
      textareas: ['<iframe src="https://www.gameflare.com/embed/whatever/"></iframe>'],
      inGameSrc: null,
    });
    assert.equal(r.status, EMBED_STATUS.UNAVAILABLE);
    assert.equal(r.reason, EMBED_REASON.PAGE_NOT_FOUND);
    assert.equal(r.embedUrl, null);
  });

  test('an off-allowlist host is rejected, including a lookalike domain', () => {
    const r = classifyPage({
      title: 'x', bodyText: 'x',
      textareas: ['<iframe src="https://www.gameflare.com.evil.test/embed/x/"></iframe>'],
      inGameSrc: null,
    });
    assert.equal(r.status, EMBED_STATUS.INVALID);
    assert.equal(r.reason, EMBED_REASON.OFF_ALLOWLIST);
    assert.equal(r.embedUrl, null);
  });

  test('embed code disagreeing with the rendered player is reported, not resolved', () => {
    const r = classifyPage({
      title: 'x', bodyText: 'x',
      textareas: ['<iframe src="https://www.gameflare.com/embed/a/"></iframe>'],
      inGameSrc: 'https://www.gameflare.com/embed/b/',
    });
    assert.equal(r.status, EMBED_STATUS.INVALID);
    assert.equal(r.reason, EMBED_REASON.DISAGREEMENT);
  });

  test('a bot challenge is unavailable and never parsed as a game page', () => {
    const r = classifyPage({ title: 'Just a moment...', bodyText: 'Enable JavaScript', textareas: [] });
    assert.equal(r.status, EMBED_STATUS.UNAVAILABLE);
    assert.equal(r.reason, EMBED_REASON.CHALLENGED);
  });

  test('no URL is invented when the page publishes none', () => {
    const r = classifyPage({ title: 'Some Game', bodyText: 'Some Game Overview', textareas: [''], inGameSrc: null });
    assert.equal(r.status, EMBED_STATUS.UNAVAILABLE);
    assert.equal(r.reason, EMBED_REASON.NO_EMBED_CODE);
    assert.equal(r.embedUrl, null);
  });

  test('summarise counts duplicates across slugs', () => {
    const s = summarise([
      { slug: 'a', status: EMBED_STATUS.FOUND, embedUrl: 'https://www.gameflare.com/embed/x/', reason: 'r' },
      { slug: 'b', status: EMBED_STATUS.FOUND, embedUrl: 'https://www.gameflare.com/embed/x/', reason: 'r' },
      { slug: 'c', status: EMBED_STATUS.FOUND, embedUrl: 'https://www.gameflare.com/embed/y/', reason: 'r' },
    ]);
    assert.equal(s.found, 3);
    assert.equal(s.distinctEmbedUrls, 2);
    assert.equal(s.duplicates.length, 1);
    assert.deepEqual(s.duplicates[0].slugs, ['a', 'b']);
  });
});

describe('pixel measurement', () => {
  // A minimal real PNG, built here so the test needs no fixture file.
  const png = (w, h, fill) => {
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (w * 3 + 1)] = 0;
      for (let x = 0; x < w; x++) {
        const i = y * (w * 3 + 1) + 1 + x * 3;
        const [r, g, b] = fill(x, y);
        raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
      }
    }
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crcTable = [];
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
      let crc = 0xffffffff;
      for (const b of td) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
      const c = Buffer.alloc(4); c.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
      return Buffer.concat([len, td, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
  };
  test('a solid frame reads as blank', () => {
    const black = png(64, 64, () => [0, 0, 0]);
    assert.equal(isBlankImage(black).blank, true);
  });

  test('a varied frame does not read as blank', () => {
    const noise = png(64, 64, (x, y) => [(x * 7 + y * 13) % 256, (x * 31) % 256, (y * 17) % 256]);
    assert.equal(isBlankImage(noise).blank, false);
  });

  test('identical images have zero delta', () => {
    const a = png(64, 64, (x, y) => [(x * 7) % 256, (y * 5) % 256, 40]);
    const d = imageDelta(a, a);
    assert.equal(d.ok, true);
    assert.equal(d.changed, 0);
  });

  test('a changed image reports a large delta', () => {
    const a = png(64, 64, () => [0, 0, 0]);
    const b = png(64, 64, () => [255, 255, 255]);
    const d = imageDelta(a, b);
    assert.equal(d.ok, true);
    assert.ok(d.changed > 0.9, `expected a near-total change, got ${d.changed}`);
  });

  test('differently sized images refuse to compare rather than rescale', () => {
    const d = imageDelta(png(64, 64, () => [0, 0, 0]), png(32, 32, () => [0, 0, 0]));
    assert.equal(d.ok, false);
    assert.equal(d.reason, 'size_changed');
  });

  test('an undecodable buffer is inconclusive, never "fine"', () => {
    assert.equal(isBlankImage(Buffer.from('not a png')).blank, null);
    assert.equal(imageDelta(Buffer.from('x'), Buffer.from('y')).ok, false);
  });
});
