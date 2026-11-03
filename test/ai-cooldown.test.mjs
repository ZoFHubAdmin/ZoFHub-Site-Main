// The AI waits: 10 s after every text message, 45 s after every picture request.
//
// Two layers. The CLOCK (public/js/ai-cooldown.js) is exercised directly with an
// injected clock and storage, because it is plain logic. The WIRING — that both
// AI surfaces really use it, on the same module instance, at the right moments —
// can only be read from source here, since these tests run without a DOM; the
// behaviour itself is checked in a real browser by `npm run verify-ai`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCooldowns, formatWait, TEXT_COOLDOWN_MS, IMAGE_COOLDOWN_MS, MAX_COOLDOWN_MS,
  COOLDOWN_STORAGE_KEY,
} from '../public/js/ai-cooldown.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
function codeOnly(p) {
  let s = read(p);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  return s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, map: m };
}
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
}

describe('the required lengths', () => {
  test('a text message waits 10 seconds', () => assert.equal(TEXT_COOLDOWN_MS, 10_000));
  test('a picture request waits 45 seconds', () => assert.equal(IMAGE_COOLDOWN_MS, 45_000));
  test('no stored wait can exceed two minutes', () => assert.equal(MAX_COOLDOWN_MS, 120_000));
});

describe('the clock', () => {
  test('starts with nothing to wait for', () => {
    const c = createCooldowns({ storage: memoryStorage(), now: fakeClock().now });
    assert.equal(c.remainingSec('text'), 0);
    assert.equal(c.remainingSec('image'), 0);
  });

  test('a 10 second text wait counts down to exactly zero', () => {
    const clock = fakeClock();
    const c = createCooldowns({ storage: memoryStorage(), now: clock.now });
    assert.equal(c.start('text', TEXT_COOLDOWN_MS), 10);
    clock.advance(3000);
    assert.equal(c.remainingSec('text'), 7);
    clock.advance(6000);
    assert.equal(c.remainingSec('text'), 1);
    clock.advance(999);
    assert.equal(c.remainingSec('text'), 1, 'one millisecond early is still blocked');
    clock.advance(1);
    assert.equal(c.remainingSec('text'), 0);
    assert.equal(c.remainingMs('text'), 0);
  });

  test('a 45 second picture wait counts down to exactly zero', () => {
    const clock = fakeClock();
    const c = createCooldowns({ storage: memoryStorage(), now: clock.now });
    c.start('image', IMAGE_COOLDOWN_MS);
    clock.advance(44_999);
    assert.equal(c.remainingSec('image'), 1);
    clock.advance(1);
    assert.equal(c.remainingSec('image'), 0);
  });

  test('the seconds shown are rounded UP, so 0 never appears while still blocked', () => {
    const clock = fakeClock();
    const c = createCooldowns({ storage: memoryStorage(), now: clock.now });
    c.start('text', 10_000);
    clock.advance(9_900);
    assert.ok(c.remainingMs('text') > 0);
    assert.equal(c.remainingSec('text'), 1);
  });

  test('text and picture waits are independent of each other', () => {
    const clock = fakeClock();
    const c = createCooldowns({ storage: memoryStorage(), now: clock.now });
    c.start('image', IMAGE_COOLDOWN_MS);
    assert.equal(c.remainingSec('text'), 0, 'a picture request must not make a question wait');
    c.start('text', TEXT_COOLDOWN_MS);
    clock.advance(10_000);
    assert.equal(c.remainingSec('text'), 0);
    assert.equal(c.remainingSec('image'), 35, 'the text wait ending must not touch the picture wait');
  });

  test('a wait only ever lengthens', () => {
    const clock = fakeClock();
    const c = createCooldowns({ storage: memoryStorage(), now: clock.now });
    c.start('image', 45_000);
    c.start('image', 10_000);
    assert.equal(c.remainingSec('image'), 45, 'a shorter wait must not cut a longer one short');
    c.start('text', 10_000);
    c.start('text', 30_000);
    assert.equal(c.remainingSec('text'), 30, 'a provider asking for longer must be honoured');
  });

  test('a single request cannot ask for more than the ceiling', () => {
    const c = createCooldowns({ storage: memoryStorage(), now: fakeClock().now });
    assert.equal(c.start('text', 10 * 60 * 1000), 120);
  });

  test('clear() ends a wait at once', () => {
    const c = createCooldowns({ storage: memoryStorage(), now: fakeClock().now });
    c.start('text', 10_000);
    c.clear('text');
    assert.equal(c.remainingSec('text'), 0);
  });

  test('an unknown kind is refused loudly', () => {
    const c = createCooldowns({ storage: memoryStorage(), now: fakeClock().now });
    assert.throws(() => c.start('video', 1000), RangeError);
    assert.throws(() => c.remainingSec('audio'), RangeError);
  });
});

describe('it survives a reload and is shared between tabs', () => {
  test('a new instance on the same storage sees the running wait', () => {
    const storage = memoryStorage();
    const clock = fakeClock();
    createCooldowns({ storage, now: clock.now }).start('image', IMAGE_COOLDOWN_MS);
    clock.advance(20_000);
    // "Reload": a brand-new instance, nothing in memory.
    const reloaded = createCooldowns({ storage, now: clock.now });
    assert.equal(reloaded.remainingSec('image'), 25);
  });

  test('a wait started in one tab is seen by another', () => {
    const storage = memoryStorage();
    const clock = fakeClock();
    const a = createCooldowns({ storage, now: clock.now });
    const b = createCooldowns({ storage, now: clock.now });
    a.start('text', TEXT_COOLDOWN_MS);
    assert.equal(b.remainingSec('text'), 10);
  });

  test('it is stored under one documented key', () => {
    const storage = memoryStorage();
    createCooldowns({ storage, now: fakeClock().now }).start('text', 10_000);
    assert.ok(storage.map.has(COOLDOWN_STORAGE_KEY));
    assert.equal(COOLDOWN_STORAGE_KEY, 'zofhub:ai:cooldown:v1');
  });
});

describe('it cannot be turned into a lockout', () => {
  test('a stored timestamp far in the future is clamped to two minutes', () => {
    const storage = memoryStorage();
    const clock = fakeClock();
    storage.setItem(COOLDOWN_STORAGE_KEY, JSON.stringify({ text: clock.now() + 10 * 24 * 3600 * 1000, image: 0 }));
    const c = createCooldowns({ storage, now: clock.now });
    assert.equal(c.remainingSec('text'), 120);
  });

  for (const [label, raw] of [
    ['not JSON', '{oops'], ['a bare null', 'null'], ['an array', '[1,2]'],
    ['text strings', '{"text":"soon","image":"later"}'], ['NaN-ish numbers', '{"text":null,"image":{}}'],
    ['an empty string', ''],
  ]) {
    test(`garbage in storage (${label}) is treated as no wait, never a crash`, () => {
      const storage = memoryStorage();
      storage.setItem(COOLDOWN_STORAGE_KEY, raw);
      const c = createCooldowns({ storage, now: fakeClock().now });
      assert.equal(c.remainingSec('text'), 0);
      assert.equal(c.remainingSec('image'), 0);
      assert.doesNotThrow(() => c.start('text', 5000));
    });
  }

  test('storage that throws still gives a working in-memory wait', () => {
    const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
    const clock = fakeClock();
    const c = createCooldowns({ storage: broken, now: clock.now });
    c.start('text', 10_000);
    assert.equal(c.remainingSec('text'), 10);
    clock.advance(10_000);
    assert.equal(c.remainingSec('text'), 0);
  });

  test('no storage at all still works', () => {
    const c = createCooldowns({ storage: null, now: fakeClock().now });
    assert.equal(c.start('image', 45_000), 45);
  });
});

describe('formatWait', () => {
  for (const [input, out] of [[0, '0s'], [7, '7s'], [59, '59s'], [60, '1m'], [65, '1m 5s'], [120, '2m'], [-3, '0s'], [NaN, '0s']]) {
    test(`${input} -> ${out}`, () => assert.equal(formatWait(input), out));
  }
});

describe('both AI surfaces really use it', () => {
  const chat = codeOnly('public/js/pollichat.js');
  const orb = codeOnly('public/js/ai-helper.js');

  test('the /ai page and the floating assistant import the SAME specifier (one module instance, one clock)', () => {
    const spec = (src) => src.match(/from\s+'(\.\/ai-cooldown\.js[^']*)'/)?.[1];
    assert.ok(spec(chat), 'pollichat.js does not import ai-cooldown.js');
    assert.ok(spec(orb), 'ai-helper.js does not import ai-cooldown.js');
    assert.equal(spec(chat), spec(orb), 'two different ?v= values would load the module twice, and the clocks would diverge');
  });

  test('every text message starts the 10 second wait, when the turn ends', () => {
    const finish = chat.match(/function finishTurn\(\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
    assert.match(finish, /cooldowns\.start\('text', TEXT_COOLDOWN_MS\)/, 'finishTurn() does not start the text wait');
    assert.match(finish, /composing\s*=\s*false/);
  });

  test('every picture request starts the 45 second wait, when it is sent', () => {
    const make = chat.match(/async function makePicture[\s\S]*?\n\}\n/)?.[0] || '';
    assert.match(make, /cooldowns\.start\('image', IMAGE_COOLDOWN_MS\)/, 'makePicture() does not start the picture wait');
    const startAt = make.indexOf("cooldowns.start('image', IMAGE_COOLDOWN_MS)");
    const loadAt = make.indexOf('await loadImage(');
    assert.ok(startAt > -1 && loadAt > startAt, 'the wait must begin BEFORE the request is awaited, not after it finishes');
  });

  test('a rate-limit reply from the provider lengthens the wait rather than replacing it', () => {
    assert.match(chat, /cooldowns\.start\('image', \(\(Number\(failure\.retryAfter\) \|\| 0\) \+ 1\) \* 1000\)/);
    assert.match(chat, /cooldowns\.start\('text', total \* 1000\)/);
  });

  test('stopping an answer, or leaving the page, does not hand back a free request', () => {
    assert.match(chat, /function abortText\(\)[\s\S]*?cooldowns\.start\('text', TEXT_COOLDOWN_MS\)/);
    assert.match(chat, /addEventListener\('pagehide'[\s\S]*?cooldowns\.start\('text', TEXT_COOLDOWN_MS\)/);
    assert.match(orb, /addEventListener\('pagehide'[\s\S]*?cooldowns\.start\('text', TEXT_COOLDOWN_MS\)/);
  });

  test('the floating assistant waits the same 10 seconds after each answer', () => {
    assert.match(orb, /finally\s*\{[\s\S]*?cooldowns\.start\('text', TEXT_COOLDOWN_MS\)/);
    assert.doesNotMatch(orb, /\b4000\b/, 'the old 4 second throttle is still in ai-helper.js');
  });

  test('the old 2.5 second throttle is gone from the /ai page', () => {
    assert.doesNotMatch(chat, /\b2500\b/);
    assert.doesNotMatch(chat, /startSendCooldown|aiCooling/);
  });

  test('a send inside the wait is refused, and what was typed is kept', () => {
    const submit = chat.match(/form\.addEventListener\('submit'[\s\S]*?\n  \}\);/)?.[0] || '';
    assert.match(submit, /gate\.why === 'cooldown'/);
    const refused = submit.slice(submit.indexOf("gate.why === 'cooldown'"));
    assert.ok(refused.indexOf('return') > -1 && refused.indexOf('return') < refused.indexOf('sendImage'),
      'a refused send must return before anything is sent or cleared');
  });

  test('a retry is gated by the same wait as a new message', () => {
    assert.match(chat, /watchCooldown\(\{ kind: 'text', btn: retry/);
    assert.match(chat, /watchCooldown\(\{ kind: 'text', btn: retryBtn/);
    assert.match(chat, /watchCooldown\(\{ kind: 'image', btn: retry/);
  });
});
