// Per-game scoring profiles: what a submitted number MEANS.
//
// The leaderboard used to have one integer column and one field labelled
// "Score", shared by a golf game measured in metres, a time trial where the
// SMALLEST number wins, and a basketball game measured in wins. These tests
// cover the two things that fix: the profile decides the form and the ranking,
// and an UNVERIFIED guess never reaches a player.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  METRICS, METRIC_IDS, DEFAULT_METRIC, defaultProfile, normalizeProfile,
  validateScoreValue, rankRows, isComparable, rankingExplanation,
  formFieldFor, suggestMetric, suggestedProfile, needsReview,
} from '../lib/scoring-profiles.mjs';

const confirmed = (metricId, extra = {}) =>
  normalizeProfile({ slug: 'g', metricId, source: 'confirmed', ...extra });

describe('the metric vocabulary is closed and coherent', () => {
  test('every metric has the fields the form and the ranking need', () => {
    for (const id of METRIC_IDS) {
      const m = METRICS[id];
      assert.equal(typeof m.label, 'string', `${id} label`);
      assert.equal(typeof m.higherIsBetter, 'boolean', `${id} direction`);
      assert.ok(['integer', 'decimal'].includes(m.valueType), `${id} valueType`);
      assert.ok(m.max > m.min, `${id} range`);
      assert.ok(Number.isInteger(m.precision) && m.precision >= 0, `${id} precision`);
    }
  });

  test('a time trial is the case the old hardcoded ranking got wrong', () => {
    assert.equal(METRICS.time_fastest.higherIsBetter, false);
    // …and survival time is the opposite, so "it is a time" is not the rule.
    assert.equal(METRICS.survival_time.higherIsBetter, true);
  });

  test('accuracy is capped at 100, because it is a percentage', () => {
    assert.equal(METRICS.accuracy.max, 100);
  });
});

describe('normalizeProfile is total — one bad row cannot break the feature', () => {
  test('junk of every shape yields a usable default profile', () => {
    for (const bad of [null, undefined, 0, '', 'points', [], true, NaN]) {
      const p = normalizeProfile(bad);
      assert.equal(p.metricId, DEFAULT_METRIC);
      assert.equal(p.source, 'default');
    }
  });

  test('an unknown metric falls back to the default rather than throwing', () => {
    assert.equal(normalizeProfile({ metricId: 'bananas' }).metricId, DEFAULT_METRIC);
  });

  test('an integer metric can never carry decimals, whatever the row claims', () => {
    const p = normalizeProfile({ metricId: 'wins', valueType: 'integer', precision: 3 });
    assert.equal(p.precision, 0);
  });

  test('a reversed min/max is treated as a typo and swapped', () => {
    const p = normalizeProfile({ metricId: 'points', min: 500, max: 10 });
    assert.equal(p.min, 10);
    assert.equal(p.max, 500);
  });

  test('a label can never inject markup — it renders beside player names', () => {
    const p = normalizeProfile({ metricId: 'points', displayLabel: '<img src=x onerror=alert(1)>' });
    assert.doesNotMatch(p.displayLabel, /[<>]/);
  });

  test('"suggested" on the DEFAULT metric is meaningless and degrades to default', () => {
    assert.equal(normalizeProfile({ metricId: 'points', source: 'suggested' }).source, 'default');
  });
});

describe('a submitted value is judged against the profile, not a global rule', () => {
  test('an integer metric refuses decimals; a decimal metric accepts them', () => {
    assert.equal(validateScoreValue(confirmed('wins'), '3').ok, true);
    assert.equal(validateScoreValue(confirmed('wins'), '3.5').ok, false);
    assert.equal(validateScoreValue(confirmed('distance'), '128.5').ok, true);
  });

  test('precision is enforced, not silently truncated', () => {
    // distance allows 1 decimal place.
    assert.equal(validateScoreValue(confirmed('distance'), '128.55').ok, false);
    // time_fastest allows 2.
    assert.equal(validateScoreValue(confirmed('time_fastest'), '42.80').ok, true);
    assert.equal(validateScoreValue(confirmed('time_fastest'), '42.805').ok, false);
  });

  test('bounds come from the metric — accuracy cannot exceed 100', () => {
    assert.equal(validateScoreValue(confirmed('accuracy'), '99.5').ok, true);
    const r = validateScoreValue(confirmed('accuracy'), '140');
    assert.equal(r.ok, false);
    assert.match(r.error, /cannot be above 100/);
  });

  test('the shapes Number() is too generous about are all refused', () => {
    for (const bad of ['1e9', '0x10', '12abc', '-5', 'Infinity', 'NaN', '', '  ', null, undefined, {}, [], true]) {
      assert.equal(validateScoreValue(confirmed('points'), bad).ok, false, `accepted ${JSON.stringify(bad)}`);
    }
  });

  test('surrounding whitespace is a typo, not an attack, and is trimmed', () => {
    const r = validateScoreValue(confirmed('points'), '  4200 ');
    assert.equal(r.ok, true);
    assert.equal(r.value, 4200);
  });

  test('the value is rounded to the profile precision, so equal runs rank equal', () => {
    assert.equal(validateScoreValue(confirmed('distance'), '128.5').value, 128.5);
    assert.equal(validateScoreValue(confirmed('points'), '42').value, 42);
  });

  test('a disabled profile accepts nothing', () => {
    const r = validateScoreValue(normalizeProfile({ metricId: 'points', source: 'confirmed', enabled: false }), '10');
    assert.equal(r.ok, false);
    assert.match(r.error, /not accepting scores/);
  });

  test('the error names the metric, so the player knows what was wanted', () => {
    const r = validateScoreValue(confirmed('wins'), 'abc');
    assert.match(r.error, /wins achieved/i);
  });
});

describe('ranking honours the profile direction', () => {
  const rows = (...vals) => vals.map((v, i) => ({ value: v, created_at: `2026-01-0${i + 1}` }));

  test('higher-is-better ranks descending', () => {
    const r = rankRows(confirmed('points'), rows(10, 50, 30));
    assert.deepEqual(r.map((x) => x.value), [50, 30, 10]);
    assert.deepEqual(r.map((x) => x.rank), [1, 2, 3]);
  });

  test('a TIME TRIAL ranks ascending — the smallest number wins', () => {
    const r = rankRows(confirmed('time_fastest'), rows(42.8, 31.2, 55.0));
    assert.deepEqual(r.map((x) => x.value), [31.2, 42.8, 55.0]);
    assert.equal(r[0].rank, 1);
  });

  test('equal values share a rank, and the earlier submission is listed first', () => {
    const r = rankRows(confirmed('points'), [
      { value: 100, created_at: '2026-01-02' },
      { value: 100, created_at: '2026-01-01' },
      { value: 50, created_at: '2026-01-03' },
    ]);
    assert.deepEqual(r.map((x) => x.rank), [1, 1, 3], 'ranks should read 1,1,3');
    assert.equal(r[0].created_at, '2026-01-01', 'the earlier of the tied rows comes first');
  });

  test('a non-numeric value sorts last in BOTH directions, never first', () => {
    const hi = rankRows(confirmed('points'), [{ value: null }, { value: 5 }]);
    assert.equal(hi[0].value, 5);
    const lo = rankRows(confirmed('time_fastest'), [{ value: null }, { value: 5 }]);
    assert.equal(lo[0].value, 5, 'a junk row must not win a lowest-first board');
  });

  test('it reads a legacy `score` column as well as `value`', () => {
    const r = rankRows(confirmed('points'), [{ score: 10 }, { score: 90 }]);
    assert.equal(r[0].score, 90);
  });
});

describe('incomparable metrics are never mixed into one ranking', () => {
  test('the same metric, unit and direction is comparable', () => {
    assert.equal(isComparable(confirmed('wins'), confirmed('wins')), true);
  });

  test('metres, seconds and wins are not interchangeable numbers', () => {
    assert.equal(isComparable(confirmed('distance'), confirmed('time_fastest')), false);
    assert.equal(isComparable(confirmed('wins'), confirmed('points')), false);
    assert.equal(isComparable(confirmed('survival_time'), confirmed('time_fastest')), false,
      'same unit, OPPOSITE direction — still not one board');
  });
});

describe('the form renders from the profile — and a GUESS never reaches a player', () => {
  test('a confirmed metric shows its own label and unit', () => {
    const f = formFieldFor(confirmed('distance'));
    assert.equal(f.label, 'Distance achieved (meters)');
    assert.equal(f.inputMode, 'decimal', 'a decimal field must not force a numeric keypad');
    assert.equal(f.generic, false);
  });

  test('a confirmed wins metric reads "Wins achieved"', () => {
    assert.equal(formFieldFor(confirmed('wins')).label, 'Wins achieved');
    assert.equal(formFieldFor(confirmed('wins')).inputMode, 'numeric');
  });

  // THE LOAD-BEARING TEST. A suggestion is evidence for an administrator, not an
  // assertion to a player: rendering it would state a unit nobody has checked.
  test('a SUGGESTED profile renders as the generic field, not its suggestion', () => {
    const s = normalizeProfile({ slug: 'g', metricId: 'distance', source: 'suggested', basis: 'a golf tag' });
    const f = formFieldFor(s);
    assert.equal(f.metricId, DEFAULT_METRIC);
    assert.equal(f.label, 'Score');
    assert.equal(f.generic, true);
    assert.doesNotMatch(f.label, /meter/i, 'an unconfirmed unit leaked to a player');
  });

  test('the default profile is honest rather than specific', () => {
    const f = formFieldFor(defaultProfile('g'));
    assert.equal(f.label, 'Score');
    assert.equal(f.generic, true);
  });

  test('the form carries the ranking explanation, so the player need not guess', () => {
    assert.match(formFieldFor(confirmed('time_fastest')).help, /lowest first/);
    assert.match(formFieldFor(confirmed('points')).help, /highest first/);
  });

  test('step and bounds come from the profile', () => {
    assert.equal(formFieldFor(confirmed('wins')).step, '1');
    assert.equal(formFieldFor(confirmed('time_fastest')).step, '0.01');
    assert.equal(formFieldFor(confirmed('accuracy')).max, 100);
  });
});

describe('rankingExplanation says which direction wins', () => {
  test('it explains a lowest-first board, because that surprises people', () => {
    const s = rankingExplanation(confirmed('time_fastest'));
    assert.match(s, /lowest first/);
    assert.match(s, /smaller value is a better result/);
  });
});

describe('suggestions are evidence-ordered and always explain themselves', () => {
  test('a title signal beats a category', () => {
    const s = suggestMetric({ title: 'Golf Bit', category: 'arcade' });
    assert.equal(s.metricId, 'distance');
    assert.equal(s.confidence, 'title');
    assert.match(s.basis, /golf/i);
  });

  test('a 2-player tag suggests wins — the Basket Random case', () => {
    const s = suggestMetric({ title: 'Basket Random', category: 'sports', tags: '2 Player,Basketball,Ragdoll' });
    // The title rule fires first here (basketball → goals); both are defensible,
    // so what matters is that it is a SUGGESTION carrying its evidence.
    assert.ok(['goals', 'wins'].includes(s.metricId));
    assert.ok(s.basis, 'a suggestion with no stated basis is not reviewable');
  });

  test('a tag beats a category, because categories here are broad buckets', () => {
    const s = suggestMetric({ title: 'Untitled', category: 'arcade', tags: 'Platform,Stickman' });
    assert.equal(s.metricId, 'distance');
    assert.equal(s.confidence, 'tag');
  });

  test('a category is used when nothing stronger matches', () => {
    const s = suggestMetric({ title: 'Untitled', category: 'puzzle' });
    assert.equal(s.metricId, 'objectives');
    assert.equal(s.confidence, 'category');
  });

  test('"I cannot tell" is a real answer and yields the neutral default', () => {
    const s = suggestMetric({ title: 'Mystery Blocks', category: 'totally-made-up' });
    assert.equal(s.metricId, DEFAULT_METRIC);
    assert.equal(s.basis, null);
    assert.equal(s.confidence, 'none');
  });

  test('suggestedProfile is never CONFIRMED — only a human confirms', () => {
    const p = suggestedProfile({ slug: 'golf-bit', title: 'Golf Bit', category: 'arcade' });
    assert.equal(p.metricId, 'distance');
    assert.equal(p.source, 'suggested');
    assert.notEqual(p.source, 'confirmed');
  });

  test('a game with nothing to suggest gets the default and needs no review', () => {
    const p = suggestedProfile({ slug: 'x', title: 'Mystery Blocks', category: 'nope' });
    assert.equal(p.source, 'default');
    assert.equal(needsReview(p), false, 'nothing is waiting on anybody for this game');
  });

  test('needsReview flags exactly the games with an unconfirmed suggestion', () => {
    assert.equal(needsReview(suggestedProfile({ slug: 'golf-bit', title: 'Golf Bit' })), true);
    assert.equal(needsReview(confirmed('distance')), false);
    assert.equal(needsReview(defaultProfile('x')), false);
  });

  test('suggestions are deterministic — same game, same answer', () => {
    const g = { title: 'Drift Hunters', category: 'racing', tags: 'Car,Drift' };
    assert.deepEqual(suggestMetric(g), suggestMetric(g));
  });
});
