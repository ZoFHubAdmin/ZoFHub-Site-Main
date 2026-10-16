// The community recommendation taxonomy.
//
// The point of this module is that ONE file is both the menu the form renders
// and the allow-list the server validates against. Several of these tests
// therefore read the real files to prove neither side has grown its own copy.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENRES, GENRE_IDS, OTHER_ID, MAX_GENRES, OTHER_TEXT_MAX,
  isGenre, labelFor, normalizeGenres, validateGenreSelection, cleanText, DISCLOSURE,
} from '../public/js/recommendation-taxonomy.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

describe('the list is well-formed and covers what was asked for', () => {
  test('every entry has a usable id and label, and ids are unique', () => {
    assert.ok(GENRES.length >= 24, `only ${GENRES.length} genres`);
    const seen = new Set();
    for (const g of GENRES) {
      assert.match(g.id, /^[a-z][a-z0-9_]*$/, `bad id: ${g.id}`);
      assert.ok(g.label && g.label.length <= 40, `bad label for ${g.id}`);
      assert.ok(!seen.has(g.id), `duplicate id ${g.id}`);
      seen.add(g.id);
    }
  });

  test('the taxonomy covers each requested category', () => {
    // Named explicitly so a future edit cannot quietly drop one.
    for (const id of ['action', 'adventure', 'arcade', 'platformer', 'puzzle', 'racing',
      'sports', 'strategy', 'simulation', 'rpg', 'shooter', 'fighting', 'survival',
      'horror', 'multiplayer', 'casual', 'idle', 'rhythm', 'card', 'educational',
      'creative', 'retro', 'io', 'other']) {
      assert.ok(isGenre(id), `missing genre: ${id}`);
    }
  });

  test('"Other" is last, because it is the escape hatch', () => {
    assert.equal(GENRES[GENRES.length - 1].id, OTHER_ID);
  });

  test('labelFor turns an id into the words a reader expects', () => {
    assert.equal(labelFor('rpg'), 'Role-playing / RPG');
    assert.equal(labelFor('io'), 'MMO / IO');
    assert.equal(labelFor('not-a-genre'), 'not-a-genre', 'an unknown id degrades to itself');
  });
});

describe('normalizeGenres accepts what a form or a stored row can send', () => {
  test('an array and a comma-separated string behave identically', () => {
    assert.deepEqual(normalizeGenres(['puzzle', 'arcade']), ['puzzle', 'arcade']);
    assert.deepEqual(normalizeGenres('puzzle,arcade'), ['puzzle', 'arcade']);
  });

  test('case and whitespace are tolerated', () => {
    assert.deepEqual(normalizeGenres(' PUZZLE , Arcade '), ['puzzle', 'arcade']);
  });

  test('duplicates collapse and the cap is enforced', () => {
    assert.deepEqual(normalizeGenres(['puzzle', 'puzzle']), ['puzzle']);
    assert.equal(normalizeGenres(['action', 'arcade', 'puzzle', 'racing', 'sports']).length, MAX_GENRES);
  });

  test('an unknown id is DROPPED, not fatal — a typo must not lose a contribution', () => {
    assert.deepEqual(normalizeGenres(['puzzle', 'platfromer', 'arcade']), ['puzzle', 'arcade']);
  });

  test('junk of every shape yields an empty list rather than throwing', () => {
    for (const bad of [null, undefined, 0, {}, true, [''], [null]]) {
      assert.deepEqual(normalizeGenres(bad), [], `${JSON.stringify(bad)}`);
    }
  });
});

describe('validateGenreSelection — and the one rule about "Other"', () => {
  test('a normal selection passes and carries no stray other-text', () => {
    const r = validateGenreSelection({ genres: ['puzzle'], otherText: 'ignored' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.genres, ['puzzle']);
    assert.equal(r.otherText, '', 'other-text must not ride along when Other was not chosen');
  });

  test('choosing nothing is refused, with a message aimed at the submitter', () => {
    const r = validateGenreSelection({ genres: [] });
    assert.equal(r.ok, false);
    assert.match(r.error, /at least one category/i);
  });

  test('"Other" with no explanation is refused — it carries no information', () => {
    for (const text of [undefined, '', '   ', 'ab']) {
      const r = validateGenreSelection({ genres: ['other'], otherText: text });
      assert.equal(r.ok, false, `accepted ${JSON.stringify(text)}`);
      assert.match(r.error, /which kind of game/i);
    }
  });

  test('"Other" WITH an explanation passes and keeps the text', () => {
    const r = validateGenreSelection({ genres: ['other'], otherText: '  a typing game  ' });
    assert.equal(r.ok, true);
    assert.equal(r.otherText, 'a typing game');
  });

  test('"Other" alongside a real genre still needs its explanation', () => {
    assert.equal(validateGenreSelection({ genres: ['puzzle', 'other'] }).ok, false);
    assert.equal(validateGenreSelection({ genres: ['puzzle', 'other'], otherText: 'a typing game' }).ok, true);
  });

  test('a selection of only unknown ids is refused like an empty one', () => {
    assert.equal(validateGenreSelection({ genres: ['nonsense', 'alsononsense'] }).ok, false);
  });
});

describe('cleanText — free text is never markup', () => {
  test('angle brackets cannot survive', () => {
    const out = cleanText('<img src=x onerror=alert(1)>');
    assert.doesNotMatch(out, /[<>]/);
  });

  test('control characters, zero-width and bidi overrides are stripped', () => {
    // Built from codepoints on purpose. Writing these as literals would put
    // genuinely invisible characters INTO this file, which the source-hygiene
    // check rejects — and rightly: an invisible character in source is a bug
    // waiting to happen, even in a test about invisible characters.
    const NUL = String.fromCodePoint(0x0000);        // C0 control
    const ZWSP = String.fromCodePoint(0x200b);       // zero-width space
    const RLO = String.fromCodePoint(0x202e);        // right-to-left override
    const LS = String.fromCodePoint(0x2028);         // line separator
    assert.equal(cleanText(`a${NUL}b${ZWSP}c${RLO}d${LS}e`), 'abcde');
  });

  test('whitespace is collapsed and the field is bounded', () => {
    assert.equal(cleanText('  a   b  '), 'a b');
    assert.equal(cleanText('x'.repeat(500)).length, OTHER_TEXT_MAX);
    assert.equal(cleanText('x'.repeat(500), 10).length, 10);
  });

  test('a non-string is empty, not "undefined"', () => {
    for (const bad of [null, undefined, 42, {}, []]) assert.equal(cleanText(bad), '');
  });
});

describe('the disclosure is one constant, used everywhere it is promised', () => {
  test('it says the things a submitter needs to know', () => {
    assert.match(DISCLOSURE, /suggestions, not guarantees/i);
    assert.match(DISCLOSURE, /licensing/i);
    assert.match(DISCLOSURE, /intentionally limited/i);
    assert.match(DISCLOSURE, /only authorized administrators can approve/i);
  });

  test('the form renders it from the constant rather than retyping it', () => {
    const js = read('public/js/community.js');
    assert.match(js, /DISCLOSURE/, 'community.js must render the shared constant');
    // The prose must NOT be duplicated into the markup, or the two can drift.
    const html = read('public/community.html');
    assert.doesNotMatch(html, /suggestions, not guarantees/i,
      'the disclosure text is hardcoded in the HTML as well — it can now drift');
    assert.match(html, /id="recDisclosure"/, 'the HTML needs the element to fill');
  });
});

describe('one taxonomy, both sides — the drift this file exists to prevent', () => {
  test('the server validates with the shared module', () => {
    const src = read('server.js');
    assert.match(src, /recommendation-taxonomy\.js/, 'server.js must import the shared taxonomy');
    assert.match(src, /validateGenreSelection/, 'server.js must call the shared validator');
  });

  test('the server no longer accepts an arbitrary category string', () => {
    const src = read('server.js');
    assert.doesNotMatch(src, /clean\(b\.category, 40\)\.toLowerCase\(\)/,
      'the old "any 40-character string is a category" path is back');
  });

  test('the form does not hardcode a genre menu any more', () => {
    const html = read('public/community.html');
    // The ten <option> values that used to live here.
    assert.doesNotMatch(html, /<option value="simulator">/, 'the hardcoded category menu is back');
    assert.match(html, /id="recGenres"/, 'the form needs the container the grid renders into');
  });

  test('the browser renders the menu from the shared list', () => {
    const js = read('public/js/community.js');
    assert.match(js, /from '\.\/recommendation-taxonomy\.js'/);
    assert.match(js, /for \(const g of GENRES\)/, 'the grid must be built from GENRES');
  });
});
