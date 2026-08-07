// The per-IP budgets have to fit the traffic the client actually generates.
//
// WHY THIS FILE EXISTS
// /api/presence/beat was limited with writeAllow(ip, 10, 5000) under a comment
// reading "Sized well above the client's real cadence (BEAT_MS = 2s): 10 per 5s."
// It was not 10 per 5s. writeAllow's third argument is MILLISECONDS PER TOKEN,
// so that budget was one request per five seconds — 0.2/sec — against a client
// beating every 2s (0.5/sec). Every visitor outran their own bucket.
//
// Measured against the running server before the fix:
//     1 tab               40% of beats refused, 6.2s longest gap
//     2 visitors, one IP  75% refused, 10.2s gap
//     5 visitors, one IP  93% refused, 33s gap
// PRESENCE_TTL_MS is 8s, so from two visitors upward the server expired sessions
// that were still on the page and the live counter undercounted and flickered.
// Sharing one public IP is the normal case for this site's audience — a school
// or library NAT — not an edge case.
//
// Nothing threw, no test failed, and the symptom (a slightly wrong number in a
// pill) is one nobody would file a bug about. So the guard is arithmetic on the
// constants, checked at build time: the budget must sustain a realistic number
// of visitors behind one address without any of them exceeding the TTL.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = readFileSync(join(ROOT, 'server.js'), 'utf8');
const PRESENCE_JS = readFileSync(join(ROOT, 'public', 'js', 'presence.js'), 'utf8');

/** Read `const NAME = <number>` (underscores allowed) out of a source file. */
function constant(src, name) {
  const m = src.match(new RegExp(`\\b${name}\\s*=\\s*([0-9_]+)`));
  assert.ok(m, `could not find ${name} — this test stopped checking anything`);
  return Number(m[1].replace(/_/g, ''));
}

const BEAT_MS = constant(PRESENCE_JS, 'BEAT_MS');
const TTL_MS = constant(SERVER, 'PRESENCE_TTL_MS');
const BURST = constant(SERVER, 'PRESENCE_BURST');
const MS_PER_TOKEN = constant(SERVER, 'PRESENCE_MS_PER_TOKEN');

// A NAT'd classroom. Deliberately concrete: "some visitors share an IP" is not
// a number anyone can design against.
const VISITORS_PER_IP = 10;

describe('the presence budget fits the presence client', () => {
  test('the constants still parse', () => {
    assert.ok(BEAT_MS > 0 && TTL_MS > 0 && BURST > 0 && MS_PER_TOKEN > 0);
  });

  test('the sustained budget absorbs a NAT full of visitors', () => {
    const demandPerSec = (1000 / BEAT_MS) * VISITORS_PER_IP;
    const budgetPerSec = 1000 / MS_PER_TOKEN;
    assert.ok(
      budgetPerSec >= demandPerSec,
      `${VISITORS_PER_IP} visitors behind one IP beat ${demandPerSec}/s but the budget ` +
      `sustains only ${budgetPerSec}/s. writeAllow's third argument is ms PER TOKEN, ` +
      `not a window — (capacity 10, 5000) is 0.2/s, not 10 per 5s.`
    );
  });

  test('a throttled visitor still beats before the server expires them', () => {
    // Worst case once the burst is spent: each visitor's turn comes round only as
    // fast as the shared budget hands out tokens. Exceed the TTL and the server
    // deletes a session belonging to someone who never left.
    const worstGapMs = VISITORS_PER_IP * MS_PER_TOKEN;
    assert.ok(
      worstGapMs < TTL_MS,
      `worst gap between accepted beats is ${worstGapMs}ms but a session expires ` +
      `after ${TTL_MS}ms — visitors would drop out of the live count while still on the page`
    );
  });

  test('the budget is still a limit, not an open door', () => {
    // The cap exists so one IP cannot fabricate players or churn the session map.
    // Holding a fake session alive costs one beat per TTL, so this bounds how many
    // an attacker can sustain from a single address.
    const fakeSessionsHoldable = (1000 / MS_PER_TOKEN) * (TTL_MS / 1000);
    assert.ok(
      fakeSessionsHoldable <= 100,
      `one IP could hold ${fakeSessionsHoldable} fabricated sessions alive — too loose`
    );
    assert.ok(BURST <= 100, `a burst of ${BURST} is large enough to be an abuse tool on its own`);
  });

  test('leave uses the same budget as beat', () => {
    // A leave beacon that loses to the beat budget leaves a closed tab counted for
    // the full TTL — the "count takes ~11s to drop" bug the beacon exists to fix.
    const leaveCall = SERVER.match(/presence\/leave[\s\S]{0,1400}?writeAllow\(([^)]*)\)/);
    assert.ok(leaveCall, 'no writeAllow found in the /api/presence/leave handler');
    assert.match(leaveCall[1], /PRESENCE_BURST\s*,\s*PRESENCE_MS_PER_TOKEN/,
      'leave must share beat\'s named budget rather than repeat the numbers');
  });
});
