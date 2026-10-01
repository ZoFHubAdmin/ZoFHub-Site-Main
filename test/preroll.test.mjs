// Clickadu's video pre-roll (public/js/preroll.js) and the game-page wiring.
// The player itself needs a browser; its parsing rules and its guarantees are
// pinned here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTimeOffset, pickMediaFile, expandMacros, SKIP_AFTER_S, NO_STACK_MS } from '../public/js/preroll.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(ROOT, 'public', 'js', 'preroll.js'), 'utf8');

describe('VAST parsing rules', () => {
  test('time offsets', () => {
    assert.equal(parseTimeOffset('00:00:05'), 5);
    assert.equal(parseTimeOffset('00:00:05.500'), 5.5);
    assert.equal(parseTimeOffset('01:02:03'), 3723);
    assert.equal(parseTimeOffset('10%', 30), 3);
    assert.equal(parseTimeOffset('10%', 0), null);
    for (const bad of ['', null, '5', 'soon', '00:05']) assert.equal(parseTimeOffset(bad), null, String(bad));
  });

  test('skip at five seconds unless the creative says otherwise — Clickadu\'s rule', () => {
    assert.equal(SKIP_AFTER_S, 5);
  });

  test('media selection: progressive, playable, the smallest that covers the frame', () => {
    const files = [
      { url: 'https://cdn.test/360.mp4', type: 'video/mp4', width: 640 },
      { url: 'https://cdn.test/720.mp4', type: 'video/mp4', width: 1280 },
      { url: 'https://cdn.test/1080.mp4', type: 'video/mp4', width: 1920 },
      { url: 'https://cdn.test/hls.m3u8', type: 'application/x-mpegURL', width: 1280 },
      { url: 'https://cdn.test/stream.mp4', type: 'video/mp4', width: 1280, delivery: 'streaming' },
      { url: 'http://cdn.test/insecure.mp4', type: 'video/mp4', width: 1280 },
      { url: 'https://cdn.test/vpaid.js', type: 'application/javascript', width: 1280 },
    ];
    const all = () => true;
    assert.equal(pickMediaFile(files, 1000, all).url, 'https://cdn.test/720.mp4');
    assert.equal(pickMediaFile(files, 3000, all).url, 'https://cdn.test/1080.mp4', 'nothing covers: take the largest');
    assert.equal(pickMediaFile(files, 1000, (t) => t !== 'video/mp4'), null, 'nothing playable');
    assert.equal(pickMediaFile([], 1000, all), null);
  });

  test('macros are filled, and nothing else is touched', () => {
    const out = expandMacros('https://v.test/t?cb=[CACHEBUSTING]&ts=[TIMESTAMP]&e=[ERRORCODE]&z=1', { errorCode: 303 });
    assert.match(out, /^https:\/\/v\.test\/t\?cb=\d{8}&ts=\d{4}-\d{2}-\d{2}T[^&]+&e=303&z=1$/);
  });
});

describe('the player cannot hold a game hostage', () => {
  test('every exit settles, and a failsafe settles regardless', () => {
    assert.match(src, /const FAILSAFE_MS = 45000;/);
    assert.match(src, /setTimeout\(\(\) => finish\('timeout'\), FAILSAFE_MS\)/);
    assert.match(src, /const START_TIMEOUT_MS = 6000;/);
    for (const outcome of ['unconfigured', 'stacked', 'unplayable', 'blocked', 'no-fill', 'error',
      'completed', 'skipped', 'autoplay-refused']) {
      assert.ok(src.includes(`'${outcome}'`), `no path settles as ${outcome}`);
    }
  });

  test('never directly behind the interstitial', () => {
    assert.equal(NO_STACK_MS, 2 * 60 * 1000);
    assert.match(src, /adFrequencyController\.lastFired\('interstitial'\)/);
  });

  test('the impression fires on the first frame shown, never on load', () => {
    const onPlaying = src.slice(src.indexOf('const onPlaying'), src.indexOf('const onTime'));
    assert.match(onPlaying, /for \(const u of ad\.acc\.impressions\) pixel\(u\);/);
    assert.equal((src.match(/ad\.acc\.impressions/g) || []).length, 1, 'impressions are fired somewhere else too');
  });

  test('Google is refused, and only https is fetched', () => {
    assert.match(src, /googlesyndication\|googleadservices\|adsbygoogle\|doubleclick/);
  });

  test('the game page binds its frame after the gate, with its own outer cap', () => {
    const gp = readFileSync(join(ROOT, 'public', 'js', 'game-page.js'), 'utf8');
    assert.match(gp, /const PREROLL_HARD_CAP_MS = 50000;/);
    const start = gp.slice(gp.indexOf('async function startGame()'));
    const race = start.indexOf('Promise.race([prerollGate(), wait(PREROLL_HARD_CAP_MS)])');
    const bind = start.indexOf('bindFrameOptimized();');
    assert.ok(race !== -1 && bind > race, 'the frame is bound before the pre-roll settles, or without a cap');
    assert.match(gp, /if \(window\.ZOFHUB_GAME\?\.preroll !== true\) return;/,
      'a game with no pre-roll configured waits on the network anyway');
    const html = readFileSync(join(ROOT, 'public', 'game.html'), 'utf8');
    assert.match(html, /preroll: \{\{HAS_PREROLL\}\}/);
  });
});
