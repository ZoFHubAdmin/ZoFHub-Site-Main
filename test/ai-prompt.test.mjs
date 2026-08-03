// AI grounding and anti-fabrication prompt.
//
// The reported failure, verbatim:
//
//   "Snow Rider 3D was created by Sergey Kondrashov and Alexey Oleshkevich. The
//    game was developed for ZoFHub between 2013-2015. ... The game has since
//    become a ZoFHub classic."
//
// Every clause there is invented, and the ZoFHub ones were invited by the prompt
// itself, which told the model it IS ZoFHub and never told it not to guess.
// These tests pin the properties that make that output unreachable.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SYSTEM_PROMPT, AI_DISCLAIMER, buildSystemPrompt, groundingBlock,
  findMentionedGames, looksLikeProvenanceQuestion,
} from '../public/js/ai-prompt.js';

describe('the system prompt forbids what was actually fabricated', () => {
  test('it names the invented categories explicitly', () => {
    // A vague "be accurate" does not survive contact with "who made this game?".
    for (const term of ['developers', 'publishers', 'dates', 'studios', 'awards']) {
      assert.match(SYSTEM_PROMPT, new RegExp(term, 'i'), `prompt never mentions ${term}`);
    }
  });

  test('it states that ZoFHub authors nothing', () => {
    // The specific defect: told it IS ZoFHub, the model credited ZoFHub with
    // making a third party's game.
    assert.match(SYSTEM_PROMPT, /did not create, develop, publish or commission/i);
    assert.match(SYSTEM_PROMPT, /ZoFHub classic/i, 'the exact fabricated phrase should be named');
  });

  test('it gives the model a way to decline', () => {
    // Without a sanctioned refusal the model treats "answer" as mandatory.
    assert.match(SYSTEM_PROMPT, /do not have verified information/i);
  });

  test('it still permits ordinary helpfulness', () => {
    // Over-correcting into "I cannot help" is its own failure — this is a
    // homework assistant.
    assert.match(SYSTEM_PROMPT, /general knowledge|maths|homework/i);
  });
});

describe('provenance questions are recognised', () => {
  test('the shapes that trigger fabrication are caught', () => {
    for (const q of [
      'who made Snow Rider 3D',
      'Who created this game?',
      'who developed vex 9',
      'who is the developer of Slope',
      'what studio published it',
      'when was Snow Rider 3D released',
      'when did it come out',
      'what is the release date',
      'tell me the history of this game',
      'what are the origins of Tetris',
    ]) assert.equal(looksLikeProvenanceQuestion(q), true, q);
  });

  test('ordinary questions are not', () => {
    for (const q of [
      'how do I play Snow Rider 3D',
      'what is 12 x 8',
      'recommend a racing game',
      'is this game two player',
      'explain photosynthesis',
    ]) assert.equal(looksLikeProvenanceQuestion(q), false, q);
  });

  test('non-strings do not throw', () => {
    for (const junk of [null, undefined, 42, {}, []]) {
      assert.equal(looksLikeProvenanceQuestion(junk), false);
    }
  });
});

describe('finding the game a question is about', () => {
  const games = [
    { title: 'Snow Rider 3D', category: 'racing', provider: 'y8', game_url: 'https://y8.com/embed/snow' },
    { title: 'Snow', category: 'arcade', game_url: 'https://e.com/snow' },
    { title: 'Vex 9', category: 'arcade', game_url: 'https://e.com/vex9' },
    { title: 'io', category: 'arcade', game_url: 'https://e.com/io' },
  ];

  test('the longest matching title wins', () => {
    // "Snow" also matches; grounding on it would describe the wrong game.
    const found = findMentionedGames('who made Snow Rider 3D?', games);
    assert.equal(found.length, 1);
    assert.equal(found[0].title, 'Snow Rider 3D');
  });

  test('matching is case-insensitive', () => {
    assert.equal(findMentionedGames('tell me about VEX 9', games)[0].title, 'Vex 9');
  });

  test('very short titles cannot match everything', () => {
    // A two-character title would ground half the catalog on the word "io".
    assert.deepEqual(findMentionedGames('what are io games', games), []);
  });

  test('no match and bad input return empty', () => {
    assert.deepEqual(findMentionedGames('what is 2 + 2', games), []);
    assert.deepEqual(findMentionedGames('', games), []);
    assert.deepEqual(findMentionedGames('vex', null), []);
    assert.doesNotThrow(() => findMentionedGames(null, null));
  });
});

describe('the grounding block', () => {
  const game = {
    title: 'Snow Rider 3D', category: 'racing', provider: 'y8', plays: 42,
    game_url: 'https://www.y8.com/embed/snow_rider_3d',
  };

  test('it carries only fields the catalog actually holds', () => {
    const b = groundingBlock([game]);
    assert.match(b, /title: Snow Rider 3D/);
    assert.match(b, /category: racing/);
    assert.match(b, /provider: y8/);
  });

  test('it says the third party serves the game and ZoFHub did not make it', () => {
    const b = groundingBlock([game]);
    assert.match(b, /www\.y8\.com/);
    assert.match(b, /NOT made by ZoFHub/i);
  });

  test('it declares the absent fields absent', () => {
    // The whole failure mode: silence about authorship reads to the model as
    // permission to supply one.
    const b = groundingBlock([game]);
    assert.match(b, /NO author, developer, studio, release date/i);
    assert.match(b, /do NOT guess/i);
  });

  test('no games means no block, not an empty heading', () => {
    for (const v of [[], null, undefined, [null]]) assert.equal(groundingBlock(v), '');
  });

  test('a locally hosted game is not attributed to a third party', () => {
    const b = groundingBlock([{ title: 'Suroi', game_url: '/games/suroi/index.html' }]);
    assert.match(b, /served from: this site/);
    assert.ok(!/third party/.test(b));
  });
});

describe('assembling the final prompt', () => {
  test('grounding is appended to the rules, never replaces them', () => {
    const p = buildSystemPrompt(groundingBlock([{ title: 'Vex 9', category: 'arcade' }]));
    assert.match(p, /ACCURACY RULES/);
    assert.match(p, /VERIFIED FACTS/);
    assert.ok(p.indexOf('ACCURACY RULES') < p.indexOf('VERIFIED FACTS'));
  });

  test('no grounding still yields the full rules', () => {
    for (const v of ['', '   ', null, undefined]) {
      assert.equal(buildSystemPrompt(v), SYSTEM_PROMPT);
    }
  });
});

describe('the disclaimer', () => {
  test('it says the two things that matter', () => {
    assert.match(AI_DISCLAIMER, /mistake/i);
    assert.match(AI_DISCLAIMER, /verify/i);
  });

  test('it is short enough to sit under an input box', () => {
    assert.ok(AI_DISCLAIMER.length < 140, `${AI_DISCLAIMER.length} chars is too long for inline UI`);
  });
});
