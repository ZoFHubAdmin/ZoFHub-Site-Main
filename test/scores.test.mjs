// Leaderboard rules. Every case here is a decision about whether to trust a
// number a stranger typed, so the interesting tests are the rejections.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanName, cleanScore, validateSubmission, classifyScore, rank, publicRow,
  issueSession, consumeSession, _resetSessions, _sessionCount,
  STATUS, REASON, NAME_MAX, MIN_PLAY_MS, OUTLIER_FACTOR,
} from '../lib/scores.mjs';

describe('name handling', () => {
  test('non-strings become the default instead of coercing', () => {
    // String(['Bob']) is 'Bob' — an array must not slip through as a name.
    for (const v of [['Bob'], { $ne: null }, 42, null, undefined, true]) {
      assert.equal(cleanName(v), 'Player');
    }
  });

  test('whitespace is collapsed and the field is bounded', () => {
    assert.equal(cleanName('  Bob   the   Builder '), 'Bob the Builder');
    assert.equal(cleanName('x'.repeat(200)).length, NAME_MAX);
  });

  test('an all-whitespace name does not become an invisible row', () => {
    assert.equal(cleanName('     '), 'Player');
  });

  test('zero-width and bidi characters are removed', () => {
    // A right-to-left override can reorder the rows rendered after it.
    const sneaky = 'Bob' + String.fromCodePoint(0x202e) + String.fromCodePoint(0x200b) + 'x';
    assert.equal(cleanName(sneaky), 'Bobx');
  });
});

describe('score coercion', () => {
  test('accepts plain whole numbers', () => {
    assert.equal(cleanScore(0), 0);
    assert.equal(cleanScore(12500), 12500);
    assert.equal(cleanScore('12500'), 12500);
  });

  test('rejects the shapes Number() is too generous about', () => {
    for (const v of ['1e9', '0x10', '12abc', '', '-5', '1.5', Infinity, NaN, -1, 2.5]) {
      assert.equal(cleanScore(v), null, `${String(v)} must be rejected`);
    }
  });

  test('surrounding whitespace is a typo, not a different number', () => {
    assert.equal(cleanScore(' 12 '), 12);
  });

  test('rejects non-primitives', () => {
    for (const v of [{}, [], null, undefined, { valueOf: () => 5 }]) {
      assert.equal(cleanScore(v), null);
    }
  });
});

describe('submission validation', () => {
  const exists = (s) => s === 'tetris';

  test('accepts a well-formed submission', () => {
    const r = validateSubmission({ slug: 'Tetris', score: '900', player_name: 'Ann' }, exists);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { slug: 'tetris', score: 900, playerName: 'Ann' });
  });

  test('rejects an unknown game rather than creating a board for it', () => {
    const r = validateSubmission({ slug: 'not-a-game', score: 1 }, exists);
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown game/);
  });

  test('rejects slugs that are not slugs', () => {
    for (const slug of ['../etc/passwd', 'a b', '', 'UPPER CASE!', '-lead', 'x'.repeat(200)]) {
      assert.equal(validateSubmission({ slug, score: 1 }, () => true).ok, false, slug);
    }
  });

  test('a client-supplied status is never read', () => {
    const r = validateSubmission({ slug: 'tetris', score: 5, status: 'ok', id: 1 }, exists);
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.value).sort(), ['playerName', 'score', 'slug']);
  });
});

describe('classification', () => {
  test('an honest score on an established board is visible', () => {
    assert.deepEqual(classifyScore(120, [100, 110, 90], { playedMs: 60_000 }),
      { status: STATUS.OK, reason: null });
  });

  test('a score far above the board is quarantined, not published', () => {
    const r = classifyScore(100 * OUTLIER_FACTOR + 1, [100, 90, 80], { playedMs: 60_000 });
    assert.equal(r.status, STATUS.FLAGGED);
    assert.equal(r.reason, REASON.OUTLIER);
  });

  test('the first score on an empty board is not an outlier', () => {
    // Nothing to be an outlier relative to — quarantining here would mean the
    // first honest player on every game gets held for review.
    assert.equal(classifyScore(9999, [], { playedMs: 60_000 }).status, STATUS.OK);
  });

  test('a board with too few scores cannot establish an outlier', () => {
    assert.equal(classifyScore(9_000_000, [1, 2], { playedMs: 60_000 }).status, STATUS.OK);
  });

  test('a score submitted faster than the game can be played is quarantined', () => {
    const r = classifyScore(50, [100, 90, 80], { playedMs: MIN_PLAY_MS - 1 });
    assert.equal(r.status, STATUS.FLAGGED);
    assert.equal(r.reason, REASON.FAST);
  });
});

describe('ranking', () => {
  test('sorts by score descending', () => {
    const r = rank([{ score: 5 }, { score: 50 }, { score: 15 }]);
    assert.deepEqual(r.map((x) => x.score), [50, 15, 5]);
  });

  test('ties share a rank and the next rank skips', () => {
    const r = rank([{ score: 10 }, { score: 10 }, { score: 5 }]);
    assert.deepEqual(r.map((x) => x.rank), [1, 1, 3]);
  });

  test('a tie is broken for display by who got there first', () => {
    const r = rank([
      { score: 10, player_name: 'late', created_at: '2026-02-01T00:00:00Z' },
      { score: 10, player_name: 'early', created_at: '2026-01-01T00:00:00Z' },
    ]);
    assert.equal(r[0].player_name, 'early');
  });
});

describe('public projection', () => {
  test('the row id and exact timestamp never reach the client', () => {
    const out = publicRow({
      rank: 1, id: 4212, player_name: 'Ann', score: 10, slug: 'tetris',
      created_at: '2026-01-02T03:04:05Z', status: 'ok', flag_reason: null,
    });
    assert.deepEqual(Object.keys(out).sort(), ['at', 'player_name', 'rank', 'score', 'slug']);
    assert.equal(out.id, undefined);
    assert.equal(out.status, undefined);      // moderation state is not public
    assert.equal(out.at, '2026-01-02');       // date only, not a precise time
  });
});

describe('proof-of-play sessions', () => {
  beforeEach(() => _resetSessions());

  test('a token works exactly once', () => {
    const t = issueSession('tetris');
    assert.equal(consumeSession(t, 'tetris').ok, true);
    assert.equal(consumeSession(t, 'tetris').ok, false);
  });

  test('a token is bound to the game it was issued for', () => {
    const t = issueSession('tetris');
    const r = consumeSession(t, 'pacman');
    assert.equal(r.ok, false);
    assert.match(r.error, /different game/);
  });

  test('an invented token is refused', () => {
    assert.equal(consumeSession('made-up', 'tetris').ok, false);
    assert.equal(consumeSession('', 'tetris').ok, false);
    assert.equal(consumeSession(null, 'tetris').ok, false);
  });

  test('it reports how long the game was open, which is what detects a script', () => {
    const t = issueSession('tetris', 1_000_000);
    const r = consumeSession(t, 'tetris', 1_000_000 + 30_000);
    assert.equal(r.ok, true);
    assert.equal(r.playedMs, 30_000);
  });

  test('a consumed token is not retained', () => {
    const t = issueSession('tetris');
    consumeSession(t, 'tetris');
    assert.equal(_sessionCount(), 0);
  });
});
