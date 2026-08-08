// Vibe intent parsing — the text half of the Vibe Finder.
//
// Every case in the first block is a sentence from the feature request that the
// OLD keyword-bucket matcher got wrong or could not represent at all. They are
// kept verbatim rather than paraphrased, because the paraphrase is where a
// parser quietly stops handling the thing it was built for.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseVibe, describeIntent, extractDuration, AXES } from '../lib/vibe-intent.mjs';

const target = (i, axis) => (i.targets[axis] ? i.targets[axis].value : null);

describe('the requests this feature was asked to handle', () => {
  test('"I want something relaxing" asks for calm, not just the word', () => {
    const i = parseVibe('I want something relaxing.');
    assert.ok(target(i, 'calm') >= 0.8, `calm was ${target(i, 'calm')}`);
    assert.ok(target(i, 'challenge') <= 0.4, 'relaxing should not be difficult');
  });

  test('"Give me something chaotic" is the opposite of relaxing', () => {
    const i = parseVibe('Give me something chaotic.');
    assert.ok(target(i, 'calm') <= 0.2, `calm was ${target(i, 'calm')}`);
    assert.ok(target(i, 'pace') >= 0.75, 'chaotic implies fast');
  });

  test('"I only have 10 minutes" produces a duration', () => {
    const i = parseVibe('I only have 10 minutes.');
    assert.equal(i.sessionMin, 10);
    // The old parser turned "minutes" into a title search term, which matches
    // nothing and dilutes the real signal.
    assert.ok(!i.keywords.includes('minutes'), 'time words must not become keywords');
  });

  test('"I want a competitive game" reads as social, not just difficult', () => {
    const i = parseVibe('I want a competitive game.');
    assert.ok(target(i, 'social') >= 0.8, `social was ${target(i, 'social')}`);
  });

  test('"Something like the game I just played" asks for a reference', () => {
    const i = parseVibe('Something like the game I just played.');
    assert.equal(i.wantsReference, true);
    assert.ok(!i.keywords.includes('played'), 'the phrase must be consumed');
  });

  test('"challenging but not frustrating" is a BAND, not an average', () => {
    // The bug this pins: reversing "frustrating" (0.96) into a target of 0.04
    // and averaging with "challenging" (0.82) gave 0.52 — a request for
    // perfectly average difficulty, which is neither thing the sentence says.
    const i = parseVibe('I want something challenging but not frustrating.');
    const c = target(i, 'challenge');
    assert.ok(c >= 0.7, `challenge collapsed to ${c} — the negation over-corrected`);
    assert.ok(i.bounds.challenge && i.bounds.challenge.max !== undefined,
      '"not frustrating" must impose a ceiling');
    assert.ok(c <= i.bounds.challenge.max + 1e-9, 'target must respect its own ceiling');
  });

  test('"I can play casually" means low difficulty', () => {
    const i = parseVibe('I want something I can play casually.');
    assert.ok(target(i, 'challenge') <= 0.3, `challenge was ${target(i, 'challenge')}`);
  });
});

describe('negation', () => {
  test('"not scary" does NOT ask for scary', () => {
    // The live bug this replaces: /api/vibe returned Zombie Road Drive, Zombie
    // Shooting 2D and Pixel Zombie Survival for the query "not scary", because
    // the word fired the horror bucket and nothing consumed the negator.
    const i = parseVibe('not scary');
    assert.ok(target(i, 'cozy') > 0.5, 'should lean AWAY from horror');
    assert.ok(i.negatedKeywords.includes('scary'), 'scary must be recorded as negated');
    assert.ok(!i.keywords.includes('scary'), 'scary must not be a positive keyword');
  });

  test('a negation does not leak across a clause boundary', () => {
    // "not scary but challenging" must not negate "challenging" too.
    const i = parseVibe('not scary but challenging');
    assert.ok(target(i, 'challenge') >= 0.7,
      `challenge was ${target(i, 'challenge')} — the negation crossed "but"`);
  });

  test('"not too hard" softens rather than reverses', () => {
    const plain = parseVibe('not hard');
    const damped = parseVibe('not too hard');
    assert.ok(damped.targets.challenge.value > plain.targets.challenge.value,
      '"not too hard" should sit above "not hard"');
  });

  test('negation alone still yields a rankable request', () => {
    // With no positive clause there must still be something to rank by,
    // otherwise the query returns the catalog in arbitrary order.
    const i = parseVibe('nothing violent');
    assert.ok(Object.keys(i.targets).length > 0, 'must produce at least one target');
  });
});

describe('duration', () => {
  const cases = [
    ['I only have 10 minutes', 10],
    ['got 5 mins', 5],
    ['half an hour', 30],
    ['a couple of minutes', 2],
    ['ten minutes please', 10],
    ['2 hours', 45],          // clamped to the longest session we model
    ['quick game', 5],
  ];
  for (const [text, want] of cases) {
    test(`"${text}" -> ${want} min`, () => {
      assert.equal(extractDuration(' ' + text.toLowerCase() + ' '), want);
    });
  }

  test('a sentence with no time reference yields null', () => {
    assert.equal(extractDuration(' something relaxing '), null);
  });

  test('"quick reflexes" is about pace, not session length', () => {
    // "quick" is a time word AND a pace word; only the time SENSE should set a
    // duration, or every fast-paced request silently becomes a 5-minute one.
    assert.equal(extractDuration(' i want quick reflexes '), null);
  });
});

describe('parser contracts', () => {
  test('every target names a real axis and is in range', () => {
    for (const q of ['relaxing', 'chaotic competitive', 'cute but challenging', 'not scary']) {
      const i = parseVibe(q);
      for (const [axis, t] of Object.entries(i.targets)) {
        assert.ok(AXES.includes(axis), `${axis} is not a real axis`);
        assert.ok(t.value >= 0 && t.value <= 1, `${axis} value ${t.value} out of range`);
        assert.ok(t.weight > 0 && t.weight <= 3, `${axis} weight ${t.weight} out of range`);
      }
    }
  });

  test('junk input never throws and never invents targets', () => {
    for (const q of ['', '   ', '!!!', 'asdkjhasd', '🎮🎮🎮', 'a'.repeat(500), null, undefined]) {
      const i = parseVibe(q);
      assert.ok(i && typeof i === 'object');
      assert.ok(Array.isArray(i.keywords));
      assert.ok(i.confidence >= 0 && i.confidence <= 1);
    }
  });

  test('parsing is deterministic', () => {
    const a = JSON.stringify(parseVibe('something chill but not too easy'));
    const b = JSON.stringify(parseVibe('something chill but not too easy'));
    assert.equal(a, b, 'the same text must always parse the same way');
  });

  test('a concrete noun stays a literal keyword AND moves the axes', () => {
    const i = parseVibe('zombie');
    assert.ok(i.keywords.includes('zombie'), 'must still search titles for it');
    assert.ok(target(i, 'cozy') < 0.3, 'must also read as dark');
  });

  test('describeIntent speaks the player\'s language, not the ranker\'s', () => {
    const s = describeIntent(parseVibe('I want something relaxing for 10 minutes'));
    assert.match(s, /relaxing/);
    assert.match(s, /10 min/);
    assert.doesNotMatch(s, /calm=|0\.\d|weight/, 'must not leak internals');
  });

  test('confidence separates understood requests from guesses', () => {
    const good = parseVibe('something relaxing for 10 minutes');
    const junk = parseVibe('asdkjhasd');
    assert.ok(good.confidence > junk.confidence,
      'a parsed request must outrank an unparseable one');
  });
});
