// Anti-cheat quarantine rules.
//
// Two things matter equally here and the second one is easier to forget: the
// detector must catch the cheat, AND it must leave ordinary play alone. A rule
// that flags real players is worse than no rule, because someone has to review
// the noise and will eventually stop looking. So every "fires" test below has a
// "does not fire" counterpart drawn from plausible legitimate play.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessScore,
  OUTLIER_FACTOR, OUTLIER_BASELINE,
  FIRST_SCORE_CEILING_FRACTION, MAX_POINTS_PER_SECOND, DUPLICATE_THRESHOLD,
} from '../lib/score-integrity.mjs';

const CEILING = 5_000_000;
const play = (extra = {}) => ({ ceiling: CEILING, playedMs: 120_000, ...extra });

describe('the original outlier rule is unchanged', () => {
  test('a wild leap past an established best is quarantined', () => {
    const r = assessScore(play({ score: 10_000, best: 1_000 }));
    assert.equal(r.flagged, true);
    assert.match(r.reason, /outlier/);
    assert.equal(r.evidence.ratioToBest, 10);
  });

  test('beating the best by a normal margin is NOT quarantined', () => {
    // The single most important negative case: getting better at a game is the
    // point of a leaderboard.
    for (const score of [1_001, 1_500, 3_000, 5_999]) {
      const r = assessScore(play({ score, best: 1_000 }));
      assert.equal(r.flagged, false, `score ${score} (${score / 1000}x) should pass`);
    }
  });

  test('the boundary is exactly OUTLIER_FACTOR', () => {
    assert.equal(assessScore(play({ score: 6_000, best: 1_000 })).flagged, false, 'exactly 6x passes');
    assert.equal(assessScore(play({ score: 6_001, best: 1_000 })).flagged, true, 'just over 6x flags');
  });

  test('a low board best does not trigger the ratio rule', () => {
    // 40 -> 300 is 7.5x, but a board best of 40 is not a baseline worth
    // defending; treating it as one would flag the second player of every game.
    const r = assessScore(play({ score: 300, best: OUTLIER_BASELINE - 10 }));
    assert.equal(r.evidence.rules.outlier, false);
  });
});

describe('the empty-board hole is closed', () => {
  test('a huge first score on a fresh board is quarantined', () => {
    // REGRESSION: with best=0 the ratio rule cannot fire — there is nothing to
    // be 6x of — so the first score on every game was unchecked up to the hard
    // ceiling. It is also the score that BECOMES the baseline, so one bogus
    // submission moved the bar for every check afterwards.
    const r = assessScore(play({ score: CEILING * 0.9, best: 0 }));
    assert.equal(r.flagged, true);
    assert.match(r.reason, /noBaseline/);
    assert.equal(r.evidence.rules.outlier, false, 'the ratio rule still cannot fire; this is the new one');
  });

  test('an ordinary first score is NOT quarantined', () => {
    for (const score of [1, 250, 5_000, 100_000, CEILING * FIRST_SCORE_CEILING_FRACTION]) {
      const r = assessScore(play({ score, best: 0 }));
      assert.equal(r.flagged, false, `first score ${score} should pass`);
    }
  });

  test('the rule stops applying once a real baseline exists', () => {
    // With a baseline, the ratio rule is the better judge; the ceiling fraction
    // would otherwise permanently flag high-scoring games.
    const r = assessScore(play({ score: CEILING * 0.9, best: CEILING * 0.8 }));
    assert.equal(r.evidence.rules.noBaseline, false);
    assert.equal(r.flagged, false, '1.1x an established best is normal play');
  });
});

describe('implied points-per-second', () => {
  test('the maximum score in the minimum play time is quarantined', () => {
    // The shape this rule exists for: mint a session, wait out MIN_PLAY_MS,
    // submit near the ceiling.
    const r = assessScore({ score: CEILING, best: 1_000_000, ceiling: CEILING, playedMs: 8_000 });
    assert.equal(r.flagged, true);
    assert.match(r.reason, /rate/);
    assert.equal(r.evidence.pointsPerSecond, 625_000);
  });

  test('a fast but human clicker session is NOT quarantined', () => {
    // 10k points in 10s = 1000/s. Real for a clicker; nowhere near the bound.
    const r = assessScore({ score: 10_000, best: 9_000, ceiling: CEILING, playedMs: 10_000 });
    assert.equal(r.evidence.rules.rate, false);
    assert.equal(r.flagged, false);
  });

  test('a game can raise its own bound without raising everyone\'s', () => {
    const fast = { score: 2_000_000, best: 1_900_000, ceiling: CEILING, playedMs: 10_000 };
    assert.equal(assessScore(fast).evidence.rules.rate, true, 'flagged at the global bound');
    assert.equal(assessScore({ ...fast, maxPerSecond: 500_000 }).evidence.rules.rate, false,
      'a per-game override should let a genuinely fast game through');
  });

  test('the rule is skipped when play time was not measured', () => {
    // No measurement is not evidence of cheating. Inventing a rate from a
    // missing number would flag every submission that took an odd path.
    const r = assessScore({ score: CEILING, best: 1_000_000, ceiling: CEILING, playedMs: undefined });
    assert.equal(r.evidence.rules.rate, false);
    assert.equal(r.evidence.pointsPerSecond, null);
  });
});

describe('replay / duplicate submissions', () => {
  test('the same score from the same source, repeatedly, is quarantined', () => {
    const r = assessScore(play({ score: 5_000, best: 4_000, duplicates: DUPLICATE_THRESHOLD }));
    assert.equal(r.flagged, true);
    assert.match(r.reason, /duplicate/);
  });

  test('matching your own previous score once or twice is NOT quarantined', () => {
    // Genuinely common: a game with a fixed perfect score, or a player who
    // plateaus. Two identical results is a plateau, not an attack.
    for (const duplicates of [0, 1, DUPLICATE_THRESHOLD - 1]) {
      assert.equal(assessScore(play({ score: 5_000, best: 4_000, duplicates })).flagged, false);
    }
  });
});

describe('evidence is recorded for the reviewer', () => {
  test('the numbers behind the decision are all present', () => {
    const r = assessScore({ score: 60_000, best: 1_000, ceiling: CEILING, playedMs: 30_000, duplicates: 1 });
    assert.deepEqual(r.evidence.rules, { outlier: true, noBaseline: false, rate: false, duplicate: false });
    assert.equal(r.evidence.score, 60_000);
    assert.equal(r.evidence.boardBest, 1_000);
    assert.equal(r.evidence.ratioToBest, 60);
    assert.equal(r.evidence.playedMs, 30_000);
    assert.equal(r.evidence.pointsPerSecond, 2_000);
    assert.equal(r.evidence.duplicatesSeen, 1);
    assert.equal(r.evidence.fractionOfCeiling, 0.012);
  });

  test('evidence is recorded even when nothing fires', () => {
    // The scores that did NOT trip a rule are what you need in order to move a
    // threshold with any confidence.
    const r = assessScore(play({ score: 1_200, best: 1_000 }));
    assert.equal(r.flagged, false);
    assert.equal(r.reason, null);
    assert.equal(r.evidence.ratioToBest, 1.2);
    assert.ok(r.evidence.pointsPerSecond > 0);
  });

  test('every rule that fired is named, not just the first', () => {
    // Two independent rules agreeing is a much stronger signal than either
    // alone, and the reviewer should be able to see that at a glance.
    const r = assessScore({ score: CEILING, best: 0, ceiling: CEILING, playedMs: 8_000, duplicates: 5 });
    assert.match(r.reason, /noBaseline/);
    assert.match(r.reason, /rate/);
    assert.match(r.reason, /duplicate/);
    assert.equal(r.reason.split('+').length, 3);
  });
});

describe('junk input cannot flag or crash', () => {
  test('missing, zero, negative and non-numeric scores are handled', () => {
    for (const score of [undefined, null, 0, -5, NaN, 'abc', {}, []]) {
      const r = assessScore({ score, best: 100, ceiling: CEILING, playedMs: 10_000 });
      assert.equal(r.flagged, false, `score ${JSON.stringify(score)} should not flag`);
    }
    assert.doesNotThrow(() => assessScore());
    assert.doesNotThrow(() => assessScore({}));
    assert.equal(assessScore().flagged, false);
  });

  test('a missing ceiling disables only the rules that need one', () => {
    const r = assessScore({ score: 10_000, best: 1_000, ceiling: undefined, playedMs: 60_000 });
    assert.equal(r.evidence.rules.noBaseline, false, 'cannot judge against a ceiling that was not given');
    assert.equal(r.evidence.rules.outlier, true, 'the ratio rule needs no ceiling and must still work');
    assert.equal(r.evidence.fractionOfCeiling, null);
  });

  test('the exported thresholds are sane', () => {
    assert.ok(OUTLIER_FACTOR > 1);
    assert.ok(OUTLIER_BASELINE > 0);
    assert.ok(FIRST_SCORE_CEILING_FRACTION > 0 && FIRST_SCORE_CEILING_FRACTION <= 1);
    assert.ok(MAX_POINTS_PER_SECOND > 1000, 'a low bound here would flag every clicker game');
    assert.ok(DUPLICATE_THRESHOLD >= 2, 'flagging a single repeat would punish plateaus');
  });
});
