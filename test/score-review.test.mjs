// Leaderboard review layer.
//
// The reason these are unit tests rather than dashboard clicking: parseScoreQuery
// and sanitizeTerm build a PostgREST filter out of whatever a reviewer types.
// A filter string is code. The tests below exist mostly to prove that a search
// box cannot become one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScoreQuery, sanitizeTerm, searchFilter, explainEvidence, summarizePlayer,
  STATUSES, SORTS, MAX_LIMIT, DEFAULT_LIMIT,
} from '../lib/score-review.mjs';

describe('search terms cannot rewrite the query', () => {
  test('PostgREST structural characters are stripped', () => {
    // Commas separate filters, dots separate column.operator.value, and
    // parentheses group. Any of them surviving would let the search box edit the
    // filter tree rather than search inside it.
    for (const attack of [
      'a,status.eq.ok',
      'x),or=(id.gt.0',
      'foo.bar.baz',
      '*',
      '%',
      "'; drop--",
      'name)&limit=9999',
    ]) {
      const out = sanitizeTerm(attack);
      for (const ch of [',', '.', '(', ')', '*', '%', "'", '&', '=', ';']) {
        assert.ok(!out.includes(ch), `${JSON.stringify(attack)} left a ${ch} in ${JSON.stringify(out)}`);
      }
    }
  });

  test('ordinary player names and slugs survive intact', () => {
    // A sanitizer that eats real input is a bug that shows up as "search is
    // broken", so the permitted set has to cover what actually gets typed.
    assert.equal(sanitizeTerm('Vex 9'), 'vex 9');
    assert.equal(sanitizeTerm('red-light-green-light'), 'red-light-green-light');
    assert.equal(sanitizeTerm('player_42'), 'player_42');
    assert.equal(sanitizeTerm('  Spaced   Out  '), 'spaced out');
  });

  test('non-strings and over-long input are handled', () => {
    for (const junk of [undefined, null, 42, {}, [], true]) assert.equal(sanitizeTerm(junk), '');
    assert.equal(sanitizeTerm('a'.repeat(500)).length, 60);
  });

  test('searchFilter targets both columns, and is null when empty', () => {
    assert.equal(searchFilter('  '), null);
    assert.equal(searchFilter('!!!'), null, 'a term that sanitizes away must not produce a filter');
    const f = searchFilter('vex');
    assert.equal(f, 'player_name.ilike.%vex%,slug.ilike.%vex%');
  });
});

describe('query parsing', () => {
  test('defaults land on the review queue', () => {
    const q = parseScoreQuery({});
    assert.equal(q.status, 'flagged', 'the queue is the point of the screen');
    assert.equal(q.sort, 'recent');
    assert.equal(q.column, 'created_at');
    assert.equal(q.ascending, false);
    assert.equal(q.limit, DEFAULT_LIMIT);
    assert.equal(q.offset, 0);
    assert.equal(q.q, '');
  });

  test('every advertised status and sort is accepted', () => {
    for (const status of [...STATUSES, 'all']) {
      assert.equal(parseScoreQuery({ status }).status, status);
    }
    for (const sort of Object.keys(SORTS)) {
      const q = parseScoreQuery({ sort });
      assert.equal(q.sort, sort);
      assert.equal(q.column, SORTS[sort].column);
      assert.equal(q.ascending, SORTS[sort].ascending);
    }
  });

  test('unknown status and sort fall back instead of reaching the database', () => {
    assert.equal(parseScoreQuery({ status: 'deleted' }).status, 'flagged');
    assert.equal(parseScoreQuery({ status: ['ok'] }).status, 'flagged');
    assert.equal(parseScoreQuery({ sort: 'score; drop' }).sort, 'recent');
    // Object.hasOwn, not `in` — otherwise 'constructor' and 'toString' resolve
    // off the prototype and index into SORTS as undefined.
    assert.equal(parseScoreQuery({ sort: 'constructor' }).sort, 'recent');
    assert.equal(parseScoreQuery({ sort: 'toString' }).sort, 'recent');
  });

  test('limit and offset are clamped, and exponent notation is rejected', () => {
    // REGRESSION: parseInt('1e20') is 1, but Number('1e20') is 1e20, and that
    // reached Postgres as a range bound once already.
    assert.equal(parseScoreQuery({ limit: '1e20' }).limit, DEFAULT_LIMIT);
    assert.equal(parseScoreQuery({ offset: '1e20' }).offset, 0);
    assert.equal(parseScoreQuery({ limit: '9999' }).limit, MAX_LIMIT);
    assert.equal(parseScoreQuery({ limit: '0' }).limit, 1);
    assert.equal(parseScoreQuery({ limit: '-5' }).limit, DEFAULT_LIMIT, 'a minus sign is not a digit');
    assert.equal(parseScoreQuery({ limit: '40abc' }).limit, DEFAULT_LIMIT);
    assert.equal(parseScoreQuery({ offset: '  12' }).offset, 0);
    assert.equal(parseScoreQuery({ limit: 25 }).limit, 25, 'a real number still works');
    assert.equal(parseScoreQuery({ offset: 200 }).offset, 200);
  });

  test('no argument at all does not throw', () => {
    assert.doesNotThrow(() => parseScoreQuery());
    assert.equal(parseScoreQuery().status, 'flagged');
  });
});

describe('explaining a quarantine to a human', () => {
  const evidence = {
    rules: { outlier: false, noBaseline: true, rate: true, duplicate: false },
    score: 5_000_000, boardBest: 0, ratioToBest: null,
    playedMs: 8_000, pointsPerSecond: 625_000, fractionOfCeiling: 1, duplicatesSeen: 0,
  };

  test('the headline names every rule that fired', () => {
    const x = explainEvidence(evidence);
    assert.deepEqual(x.fired, ['noBaseline', 'rate']);
    assert.match(x.headline, /empty board/);
    assert.match(x.headline, /faster than the game allows/);
    assert.equal(x.legacy, false);
  });

  test('agreement between rules is called out', () => {
    assert.match(explainEvidence(evidence).note, /2 independent checks/);
    const single = explainEvidence({ ...evidence, rules: { rate: true } });
    assert.equal(single.note, null, 'one rule is not corroboration');
  });

  test('the facts carry the numbers behind the decision', () => {
    const byLabel = Object.fromEntries(explainEvidence(evidence).facts.map((f) => [f.label, f]));
    assert.equal(byLabel['Score submitted'].value, '5,000,000');
    assert.equal(byLabel['Board best at the time'].value, '0 — nothing to compare against');
    assert.equal(byLabel['Measured play time'].value, '8.0s');
    assert.equal(byLabel['Implied scoring rate'].value, '625,000 pts/sec');
    assert.equal(byLabel['Share of the game ceiling'].value, '100%');
    assert.ok(!('Times the board best' in byLabel), 'a null ratio should be omitted, not shown as null');
  });

  test('the facts a rule fired on are marked, and the others are not', () => {
    const byLabel = Object.fromEntries(explainEvidence(evidence).facts.map((f) => [f.label, f]));
    assert.equal(byLabel['Implied scoring rate'].suspicious, true);
    assert.equal(byLabel['Score submitted'].suspicious, false);
  });

  test('number formatting does not depend on the host locale', () => {
    // toLocaleString would make this pass or fail based on the server's ICU
    // data, which is not a property a test should have.
    const x = explainEvidence({ rules: {}, score: 1234567.5, playedMs: 90_000 });
    const byLabel = Object.fromEntries(x.facts.map((f) => [f.label, f]));
    assert.equal(byLabel['Score submitted'].value, '1,234,567.5');
    assert.equal(byLabel['Measured play time'].value, '1m 30s');
  });

  test('rows quarantined before evidence capture say so', () => {
    // These exist in production right now. Rendering them as an empty fact table
    // would look like a broken screen rather than a missing column.
    for (const missing of [null, undefined, 'outlier', 42, []]) {
      const x = explainEvidence(missing, 'outlier');
      assert.equal(x.legacy, true);
      assert.equal(x.facts.length, 0);
      assert.match(x.headline, /outlier/);
      assert.match(x.note, /before evidence capture/);
    }
  });

  test('evidence with no rules recorded still explains itself', () => {
    const x = explainEvidence({ rules: {}, score: 10 }, 'manual review');
    assert.equal(x.legacy, false);
    assert.match(x.headline, /manual review/);
  });
});

describe('player history rolls up to an answer', () => {
  const rows = [
    { slug: 'vex-9', score: 100, status: 'ok' },
    { slug: 'vex-9', score: 900, status: 'flagged' },
    { slug: 'run-3d', score: 50, status: 'ok' },
    { slug: 'run-3d', score: 999, status: 'rejected' },
  ];

  test('the numbers a reviewer needs are all derived', () => {
    const s = summarizePlayer(rows);
    assert.equal(s.submissions, 4);
    assert.equal(s.games, 2);
    assert.equal(s.ok, 2);
    assert.equal(s.flagged, 1);
    assert.equal(s.rejected, 1);
    assert.equal(s.bestScore, 999);
    assert.equal(s.flagRate, 50);
  });

  test('one flag in forty reads differently from one in one', () => {
    // The whole point of the rollup: a rate, not a raw count, because the raw
    // count says the same thing for a prolific honest player and a cheat.
    const many = Array.from({ length: 39 }, () => ({ slug: 'a', score: 1, status: 'ok' }));
    assert.equal(summarizePlayer([...many, rows[1]]).flagRate, 3);
    assert.equal(summarizePlayer([rows[1]]).flagRate, 100);
  });

  test('empty and malformed history does not throw', () => {
    assert.doesNotThrow(() => summarizePlayer());
    assert.equal(summarizePlayer().submissions, 0);
    assert.equal(summarizePlayer([]).flagRate, 0);
    assert.equal(summarizePlayer([null, undefined, {}]).submissions, 3);
    assert.equal(summarizePlayer('nope').submissions, 0);
    assert.equal(summarizePlayer([{ score: 'abc' }]).bestScore, 0);
  });
});
