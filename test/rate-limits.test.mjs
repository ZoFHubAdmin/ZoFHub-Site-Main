// The per-client budgets have to fit the traffic the client actually generates
// — including a school or library NAT, where hundreds of real devices share
// ONE public address. That is not an edge case here; it is the audience.
//
// HISTORY, because each version of this file encoded a different mistake:
//
//   1. /api/presence/beat was limited with writeAllow(ip, 10, 5000) under a
//      comment reading "10 per 5s". The third argument is MILLISECONDS PER
//      TOKEN, so it was 0.2/s against a client beating at 0.5/s — every visitor
//      outran their own bucket. Measured: 1 tab lost 40% of beats; 5 visitors
//      behind one IP lost 93%, with 33s gaps against an 8s TTL.
//   2. The fix raised the per-IP budget to 5/s and pinned "one IP may hold at
//      most 100 fabricated sessions". That still modelled ONE address as a
//      handful of people: ten tabs saturated it, so a classroom of 30 lost two
//      thirds of its beats and the live count flickered for everyone behind
//      the school's NAT. And every write endpoint shared that same per-IP
//      bucket, so presence beats silently topped up — or drained — the
//      feedback, score and subscribe limits.
//
// THE MODEL NOW (declared in server.js, explained in lib/presence-store.mjs):
//   per SESSION   precise, keyed on the tab's random id — ≥ its real cadence
//   per ADDRESS   coarse flood control, sized for a large NAT
//   SESSIONS per ADDRESS  a separate cap on how many tabs one address can
//                 have COUNTED, so the large address budget cannot be spent
//                 inventing players
//
// These are checked as arithmetic on the real constants (so an edit cannot
// quietly reintroduce either old mistake) and as behaviour on the real modules.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLimiterSet } from '../lib/rate-limit.mjs';
import { createPresenceStore } from '../lib/presence-store.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = readFileSync(join(ROOT, 'server.js'), 'utf8');
const PRESENCE_JS = readFileSync(join(ROOT, 'public', 'js', 'presence.js'), 'utf8');

/** Read `const NAME = <number>` (underscores allowed) out of a source file. */
function constant(src, name) {
  const m = src.match(new RegExp(`\\b${name}\\s*=\\s*([0-9_]+)`));
  assert.ok(m, `could not find ${name} — this test stopped checking anything`);
  return Number(m[1].replace(/_/g, ''));
}
/** Read the DEFAULT of `const NAME = envNumber('NAME', <number>)`. */
function envDefault(src, name) {
  const m = src.match(new RegExp(`\\b${name}\\s*=\\s*envNumber\\(\\s*'${name}'\\s*,\\s*([0-9_]+)\\s*\\)`));
  assert.ok(m, `could not find the envNumber default for ${name}`);
  return Number(m[1].replace(/_/g, ''));
}

const BEAT_MS = constant(PRESENCE_JS, 'BEAT_MS');
const TTL_MS = constant(SERVER, 'PRESENCE_TTL_MS');
const SESSION_BURST = constant(SERVER, 'PRESENCE_SESSION_BURST');
const SESSION_MS = constant(SERVER, 'PRESENCE_SESSION_MS_PER_TOKEN');
const IP_BURST = envDefault(SERVER, 'PRESENCE_IP_BURST');
const IP_MS = envDefault(SERVER, 'PRESENCE_IP_MS_PER_TOKEN');
const PER_IP_SESSIONS = envDefault(SERVER, 'PRESENCE_MAX_SESSIONS_PER_IP');

// A concrete school, because "some visitors share an IP" is not a number
// anyone can design against: 300 tabs open behind one address.
const NAT_TABS = 300;

describe('the presence traffic model is coherent', () => {
  test('the constants still parse', () => {
    for (const v of [BEAT_MS, TTL_MS, SESSION_BURST, SESSION_MS, IP_BURST, IP_MS, PER_IP_SESSIONS]) {
      assert.ok(v > 0);
    }
  });

  test('one tab never outruns its own per-session budget', () => {
    const demand = 1000 / BEAT_MS;            // beats per second from one tab
    const budget = 1000 / SESSION_MS;
    assert.ok(budget >= demand * 1.5,
      `a tab beats ${demand}/s but its session budget is ${budget}/s — too tight to absorb focus-beats`);
  });

  test('the per-address budget serves a whole school NAT', () => {
    const demand = (1000 / BEAT_MS) * NAT_TABS;
    const budget = 1000 / IP_MS;
    assert.ok(budget >= demand,
      `${NAT_TABS} tabs behind one address beat ${demand}/s but the address budget is ${budget}/s`);
  });

  test('a single missed beat never expires a live session', () => {
    assert.ok(TTL_MS > 2 * BEAT_MS, 'TTL must cover at least one lost beat');
  });

  test('one address can still not invent unbounded players', () => {
    // The address budget alone would let one address hold (rate × TTL) fake
    // sessions alive; the sessions-per-address cap is what actually bounds it.
    assert.ok(PER_IP_SESSIONS >= NAT_TABS, 'the cap must not under-count an ordinary school');
    assert.ok(PER_IP_SESSIONS <= 1000, `one address may hold ${PER_IP_SESSIONS} sessions — too loose`);
    assert.ok(SESSION_BURST <= 20, 'a single tab\'s burst is large enough to be an abuse tool');
  });

  test('beat and leave draw from the named presence budgets, not a shared one', () => {
    const beat = SERVER.slice(SERVER.indexOf("app.post('/api/presence/beat'"));
    const leave = SERVER.slice(SERVER.indexOf("app.post('/api/presence/leave'"));
    assert.match(beat.slice(0, 1500), /writeAllow\('presenceIp', req\.ip\)/);
    assert.match(beat.slice(0, 1500), /LIMITS\.allow\('presenceSession', sessionId, \{ rawKey: true \}\)/);
    assert.match(leave.slice(0, 900), /writeAllow\('presenceIp', req\.ip\)/,
      'leave must share beat\'s address budget, or a closed tab stays counted for the full TTL');
  });

  test('no write endpoint uses the old positional (ip, capacity, refill) form', () => {
    // That form was the shared-bucket bug: every caller spent the same tokens.
    assert.doesNotMatch(SERVER, /writeAllow\(\s*req\.ip\s*\|\|/, 'a caller still passes an IP as the first argument');
    assert.doesNotMatch(SERVER, /const _writeBuckets\s*=/, 'the shared per-IP bucket map is back');
  });
});

describe('the traffic model, as behaviour', () => {
  test('a 300-tab classroom behind one address is never throttled', () => {
    let t = 0;
    const limits = createLimiterSet({
      presenceIp: { capacity: IP_BURST, refillMs: IP_MS },
      presenceSession: { capacity: SESSION_BURST, refillMs: SESSION_MS },
    }, { now: () => t });
    let refused = 0;
    // One minute of real traffic: each tab beats every BEAT_MS, staggered.
    for (let ms = 0; ms < 60_000; ms += 100) {
      t = ms;
      for (let tab = 0; tab < NAT_TABS; tab++) {
        if ((tab * 7) % (BEAT_MS / 100) !== (ms / 100) % (BEAT_MS / 100)) continue;
        const okIp = limits.allow('presenceIp', '198.51.100.20');
        const okSession = limits.allow('presenceSession', `tab-${tab}`, { rawKey: true });
        if (!okIp || !okSession) refused++;
      }
    }
    assert.equal(refused, 0, `${refused} legitimate beats refused behind one NAT`);
  });

  test('a single tab hammering is stopped by its own budget, not the school\'s', () => {
    let t = 0;
    const limits = createLimiterSet({
      presenceIp: { capacity: IP_BURST, refillMs: IP_MS },
      presenceSession: { capacity: SESSION_BURST, refillMs: SESSION_MS },
    }, { now: () => t });
    let accepted = 0;
    for (let i = 0; i < 1000; i++) {                 // 1,000 beats in one second
      t = i;
      if (limits.allow('presenceSession', 'runaway-tab', { rawKey: true })) accepted++;
    }
    assert.ok(accepted <= SESSION_BURST + 1, `a runaway tab got ${accepted} beats in a second`);
    // …and its neighbours behind the same address are untouched.
    assert.equal(limits.allow('presenceSession', 'quiet-tab', { rawKey: true }), true);
    assert.equal(limits.allow('presenceIp', '198.51.100.20'), true);
  });

  test('fabricated sessions from one address stop at the per-address cap', () => {
    const store = createPresenceStore({ maxSessionsPerKey: PER_IP_SESSIONS });
    let counted = 0;
    for (let i = 0; i < PER_IP_SESSIONS + 250; i++) {
      if (store.beat(`fake-session-${i}`, null, 'one-address').accepted) counted++;
    }
    assert.equal(counted, PER_IP_SESSIONS);
    assert.equal(store.snapshot().total, PER_IP_SESSIONS);
    // A different address is unaffected.
    assert.equal(store.beat('real-visitor-1', null, 'another-address').accepted, true);
  });

  test('spending one scope never spends another', () => {
    const limits = createLimiterSet({
      presenceIp: { capacity: IP_BURST, refillMs: IP_MS },
      feedback: { capacity: 4, refillMs: 15_000 },
    }, { now: () => 0 });
    for (let i = 0; i < IP_BURST; i++) limits.allow('presenceIp', '203.0.113.5');
    assert.equal(limits.allow('presenceIp', '203.0.113.5'), false, 'presence budget spent');
    assert.equal(limits.allow('feedback', '203.0.113.5'), true,
      'a spent presence budget must not block feedback — they used to share one bucket');
  });
});
