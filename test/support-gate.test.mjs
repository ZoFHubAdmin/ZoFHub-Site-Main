// The ad-block premium gate (public/js/support-gate.js): its state machine is
// pure and exported, so it is driven here without a browser. The module has no
// DOM access at import time — that is what makes this import possible.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STRIKES_TO_GATE, VERDICT_TTL_MS, emptyState, normalizeState, nextState, isLocked,
} from '../public/js/support-gate.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const T0 = 1_800_000_000_000;
const blocked = (probes = []) => ({ blocked: true, signals: ['cosmetic'], probes });
const run = (verdicts, { gate = true, start = emptyState() } = {}) => {
  let s = start;
  verdicts.forEach((v, i) => { s = nextState(s, v, { now: T0 + i * 1000, gate }); });
  return s;
};

describe('strikes', () => {
  test('the gate closes on the third page with a blocker, not before', () => {
    assert.equal(STRIKES_TO_GATE, 3);
    const two = run([blocked(), blocked()]);
    assert.equal(two.strikes, 2);
    assert.equal(isLocked(two, T0 + 2000), false, 'locked after only two pages');
    const three = run([blocked(), blocked(), blocked()]);
    assert.equal(three.strikes, 3);
    assert.equal(isLocked(three, T0 + 3000), true);
  });

  test('one clear page — the blocker paused — unlocks immediately and resets the count', () => {
    const s = run([blocked(), blocked(), blocked(), { blocked: false }]);
    assert.deepEqual({ strikes: s.strikes, blocked: s.blocked, probes: s.probes }, { strikes: 0, blocked: false, probes: [] });
    assert.equal(isLocked(s, T0 + 4000), false);
  });

  test('never locks while the gate does not apply (no ads running, or switched off)', () => {
    const s = run([blocked(), blocked(), blocked(), blocked()], { gate: false });
    assert.equal(s.strikes, 4);
    assert.equal(isLocked(s, T0 + 5000), false);
  });

  test('a verdict older than a week no longer locks anyone', () => {
    const s = run([blocked(), blocked(), blocked()]);
    assert.equal(isLocked(s, s.at + VERDICT_TTL_MS - 1), true);
    assert.equal(isLocked(s, s.at + VERDICT_TTL_MS), false);
  });
});

describe('stored state is untrusted input', () => {
  test('garbage normalises to the empty, unlocked state', () => {
    for (const raw of [null, undefined, 'x', 42, [], { strikes: 'lots' }, { strikes: -3, blocked: 'yes', gate: 1 }]) {
      const s = normalizeState(raw);
      assert.equal(isLocked(s, T0), false, JSON.stringify(raw));
      assert.ok(s.strikes >= 0 && s.strikes <= 99);
    }
  });

  test('only https probe URLs are kept, and at most three', () => {
    const s = run([blocked(['https://a.test/1.js', 'javascript:alert(1)', 'http://b.test/2.js',
      'https://c.test/3.js', 'https://d.test/4.js', 'https://e.test/5.js'])]);
    assert.deepEqual(s.probes, ['https://a.test/1.js', 'https://c.test/3.js', 'https://d.test/4.js']);
  });
});

describe('the module keeps its promises', () => {
  const src = readFileSync(join(ROOT, 'public', 'js', 'support-gate.js'), 'utf8');

  test('the only network request is a HEAD with no cookies and no referrer', () => {
    const fetches = src.match(/fetch\(/g) || [];
    assert.equal(fetches.length, 1, 'support-gate.js makes more than one kind of request');
    assert.match(src, /method: 'HEAD', mode: 'no-cors', credentials: 'omit'/);
    assert.match(src, /referrerPolicy: 'no-referrer'/);
  });

  test('a timeout is "unknown", never "blocked"', () => {
    assert.match(src, /return e\?\.name === 'AbortError' \? null : false/);
  });

  test('the bait never uses a class our own stylesheets hide', () => {
    const bait = /const BAIT_CLASSES = '([^']+)'/.exec(src)[1].split(/\s+/);
    for (const f of ['main.css', 'catalog.css', 'browser.css', 'ai.css']) {
      const css = readFileSync(join(ROOT, 'public', 'css', f), 'utf8');
      for (const c of bait) assert.ok(!css.includes(`.${c}`), `${f} styles .${c} — the bait would be a false positive`);
    }
  });

  test('layout.js arms the watcher before the ad stack can load, and browser.js consults the lock', () => {
    const layout = readFileSync(join(ROOT, 'public', 'js', 'layout.js'), 'utf8');
    const armed = layout.indexOf('if (ADS_ALLOWED_HERE) armAdWatch();');
    assert.ok(armed > 0, 'layout.js never arms the ad watcher');
    // Searched by module name, not by the import expression: the repository
    // auditor scans source for import calls, and a literal one in this string
    // would be reported as an import that resolves from test/.
    for (const mod of ['proxy-ads.js', 'ad-slots.js']) {
      const at = layout.indexOf(`./${mod}?v=`);
      assert.ok(at > 0, `layout.js no longer loads ${mod}`);
      assert.ok(armed < at, `${mod} can load before the watcher is armed`);
    }
    const browser = readFileSync(join(ROOT, 'public', 'js', 'browser.js'), 'utf8');
    assert.match(browser, /if \(isPremium\(e\) && premiumLocked\(\)\)/, 'selectEngine does not consult the gate');
    // Same specifier everywhere, or the lock state lives in two module instances.
    for (const f of [layout, browser]) assert.match(f, /from '\.\/support-gate\.js';/);
  });
});
