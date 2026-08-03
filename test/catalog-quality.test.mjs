// Catalog quality detection.
//
// The risk here is not missing a broken game — it is hiding a working one. The
// catalogue is ~16,000 entries and this logic decides which of them disappear,
// so most of what follows checks that a healthy game survives every rule.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  auditGames, inspectGame, normalizeUrl, SEVERITY, REMOVABLE_SEVERITIES, ISSUE_LABELS,
} from '../lib/catalog-quality.mjs';
import { detectFormat, writeRemovals } from '../tools/catalog-quality.mjs';

const good = (over = {}) => ({
  id: 1, slug: 'vex-9', title: 'Vex 9', game_url: 'https://example.com/games/vex-9/',
  thumbnail_url: '/thumbs/vex-9.webp', category: 'arcade', ...over,
});
const kinds = (g) => inspectGame(g).map((i) => i.kind);

describe('a complete game produces no issues', () => {
  test('the happy path is silent', () => {
    assert.deepEqual(inspectGame(good()), []);
  });

  test('both catalog shapes are understood', () => {
    // In-memory catalog rows use embed_url/thumbnail; Supabase rows use
    // game_url/thumbnail_url. Reading only one shape would report every game in
    // the other as broken.
    assert.deepEqual(inspectGame({
      slug: 'a', title: 'A', embed_url: 'https://e.com/a', thumbnail: '/t/a.webp', category: 'arcade',
    }), []);
  });

  test('a site-relative embed is valid', () => {
    // Self-hosted games added through catalog-overrides "add" look like this.
    assert.deepEqual(inspectGame(good({ game_url: '/games/suroi/index.html' })), []);
  });
});

describe('unplayable entries are flagged as broken', () => {
  test('a missing URL has nothing to load', () => {
    for (const url of ['', '   ', null, undefined]) {
      assert.deepEqual(kinds(good({ game_url: url })), ['no-url']);
    }
  });

  test('a URL a browser will not put in an iframe is broken', () => {
    for (const url of ['not a url', 'javascript:alert(1)', 'data:text/html,x', 'ftp://x/y', '::::']) {
      assert.deepEqual(kinds(good({ game_url: url })), ['bad-url'], `${url} should be rejected`);
    }
  });

  test('broken is a removable severity', () => {
    assert.ok(REMOVABLE_SEVERITIES.has(SEVERITY.BROKEN));
    assert.equal(inspectGame(good({ game_url: '' }))[0].severity, SEVERITY.BROKEN);
  });
});

describe('incomplete entries', () => {
  test('an empty title is incomplete', () => {
    assert.deepEqual(kinds(good({ title: '   ' })), ['no-title']);
  });

  test('titles that exist but say nothing are caught', () => {
    for (const t of ['undefined', 'NULL', 'Untitled', 'game', 'test', 'n/a', '-']) {
      assert.deepEqual(kinds(good({ title: t })), ['placeholder-title'], `${t} should be a placeholder`);
    }
  });

  test('real titles that merely look odd are NOT placeholders', () => {
    // The expensive mistake: a title-matching rule that eats legitimate games.
    // REGRESSION: a numeric-only rule was written here and hides 2048 — a real,
    // famous game. 1010!, 99 Balls and 8 Ball Pool are the same shape. Only the
    // explicit placeholder list survives.
    for (const t of [
      'Vex 9', '2048', '1010', '99 Balls', 'Tetris', 'Game of Life',
      'Untitled Goose Game', '8 Ball Pool', 'Run 3', 'Test Drive Unlimited',
    ]) {
      assert.deepEqual(kinds(good({ title: t })), [], `${t} is a real game name`);
    }
  });
});

describe('cosmetic issues are reported but never hide a game', () => {
  test('a missing thumbnail is cosmetic, not removable', () => {
    // There is a styled fallback tile and the game plays perfectly. Thousands of
    // entries are in this state; hiding them would empty the site.
    const issues = inspectGame(good({ thumbnail_url: '' }));
    assert.deepEqual(issues.map((i) => i.kind), ['no-thumbnail']);
    assert.equal(issues[0].severity, SEVERITY.COSMETIC);
    assert.ok(!REMOVABLE_SEVERITIES.has(SEVERITY.COSMETIC));
  });

  test('the placeholder image counts as missing', () => {
    assert.deepEqual(kinds(good({ thumbnail_url: '/img/default-placeholder.png' })), ['no-thumbnail']);
  });

  test('a missing category is cosmetic', () => {
    assert.deepEqual(kinds(good({ category: '' })), ['no-category']);
  });

  test('a catalog of thumbnail-less games stays fully visible', () => {
    const r = auditGames(Array.from({ length: 50 }, (_, i) =>
      good({ id: i, slug: `g-${i}`, game_url: `https://e.com/${i}`, thumbnail_url: '' })));
    assert.equal(r.removable.length, 0, 'not one of them may be hidden');
    assert.equal(r.affected, 50, 'but every one is reported');
    assert.equal(r.score, 100);
  });
});

describe('URL normalization decides what counts as the same game', () => {
  test('referrer tracking is stripped', () => {
    // The reason duplicates went undetected: the same GameDistribution hash with
    // different referrer values never compared equal.
    const a = normalizeUrl('https://html5.gamedistribution.com/abc123/?gd_sdk_referrer_url=https%3A%2F%2Fa.com');
    const b = normalizeUrl('https://html5.gamedistribution.com/abc123/?gd_sdk_referrer_url=https%3A%2F%2Fb.com');
    assert.equal(a, b);
    assert.equal(a, 'html5.gamedistribution.com/abc123');
  });

  test('scheme, trailing slash, case and fragment do not make a new game', () => {
    const base = normalizeUrl('https://example.com/play/vex');
    for (const v of [
      'http://example.com/play/vex', 'https://EXAMPLE.com/play/vex/',
      'https://example.com/play/vex#start', 'https://example.com/play/vex?utm_source=x',
    ]) assert.equal(normalizeUrl(v), base, `${v} should normalize to the same game`);
  });

  test('a meaningful query parameter still separates two games', () => {
    // Some providers really do select the game with a query parameter. Stripping
    // every parameter would merge distinct games into one.
    assert.notEqual(
      normalizeUrl('https://portal.example/play?id=101'),
      normalizeUrl('https://portal.example/play?id=202'));
  });

  test('unusable URLs normalize to empty, not to each other', () => {
    for (const v of ['', '   ', 'javascript:x', 'data:x', 'ftp://a/b', 'nonsense', null]) {
      assert.equal(normalizeUrl(v), '', `${v}`);
    }
  });
});

describe('duplicates hide the copy, never the game', () => {
  const dupes = () => [
    good({ id: 1, slug: 'vex-9', title: 'Vex 9', thumbnail_url: '/t/a.webp' }),
    good({ id: 2, slug: 'vex-9-copy', title: 'Vex 9', thumbnail_url: '' }),
  ];

  test('exactly one of a duplicate pair is removable', () => {
    const r = auditGames(dupes());
    const dupeRemovals = r.removable.filter((x) => x.reason === 'duplicate-url');
    assert.equal(dupeRemovals.length, 1, 'hiding both would remove the game entirely');
    assert.equal(dupeRemovals[0].slug, 'vex-9-copy', 'the emptier row is the copy');
  });

  test('the more complete row wins regardless of order or id', () => {
    const [full, bare] = dupes();
    for (const order of [[full, bare], [bare, full]]) {
      const r = auditGames(order);
      const removed = r.removable.filter((x) => x.reason === 'duplicate-url');
      assert.equal(removed[0].slug, 'vex-9-copy');
    }
    // Even when the sparse row has the lower id, completeness decides.
    const r = auditGames([good({ id: 1, slug: 'bare', title: 'Vex 9', thumbnail_url: '' }),
                          good({ id: 9, slug: 'rich', title: 'Vex 9' })]);
    assert.equal(r.removable.find((x) => x.reason === 'duplicate-url').slug, 'bare');
  });

  test('a row that is both a duplicate and nameless reports the duplicate', () => {
    // "There is already a copy of this" tells the operator what happened; "no
    // title" only describes a symptom of the same bad import.
    const r = auditGames([
      good({ id: 1, slug: 'keep', title: 'Vex 9' }),
      good({ id: 2, slug: 'copy', title: '' }),
    ]);
    const copy = r.removable.find((x) => x.slug === 'copy');
    assert.equal(copy.reason, 'duplicate-url');
    assert.equal(copy.severity, SEVERITY.DUPLICATE);
  });

  test('broken outranks every other reason', () => {
    const r = auditGames([good({ id: 1, slug: 'x', title: '', game_url: '' })]);
    assert.equal(r.removable[0].reason, 'no-url');
    assert.equal(r.removable[0].severity, SEVERITY.BROKEN);
  });

  test('equally complete rows fall back to the lower id, stably', () => {
    const rows = [good({ id: 7, slug: 'b' }), good({ id: 3, slug: 'a' })];
    const first = auditGames(rows).removable.filter((x) => x.reason === 'duplicate-url');
    const again = auditGames(rows).removable.filter((x) => x.reason === 'duplicate-url');
    assert.equal(first[0].slug, 'b', 'id 3 is kept');
    assert.deepEqual(first, again, 'the choice must not churn between runs');
  });

  test('duplicate slugs are detected independently of URL', () => {
    const r = auditGames([
      good({ id: 1, slug: 'same', game_url: 'https://a.com/1' }),
      good({ id: 2, slug: 'same', game_url: 'https://b.com/2' }),
    ]);
    assert.equal(r.removable.filter((x) => x.reason === 'duplicate-slug').length, 1);
  });

  test('distinct games are never grouped', () => {
    const r = auditGames([
      good({ id: 1, slug: 'a', game_url: 'https://e.com/a' }),
      good({ id: 2, slug: 'b', game_url: 'https://e.com/b' }),
      good({ id: 3, slug: 'c', game_url: 'https://e.com/c' }),
    ]);
    assert.equal(r.removable.length, 0);
    assert.equal(r.healthy, 3);
  });
});

describe('the rollup', () => {
  const mixed = () => [
    good({ id: 1, slug: 'ok-1', game_url: 'https://e.com/1' }),
    good({ id: 2, slug: 'ok-2', game_url: 'https://e.com/2' }),
    good({ id: 3, slug: 'broken', game_url: '' }),
    good({ id: 4, slug: 'nameless', title: '', game_url: 'https://e.com/4' }),
    good({ id: 5, slug: 'plain', thumbnail_url: '', game_url: 'https://e.com/5' }),
  ];

  test('counts, examples and score line up', () => {
    const r = auditGames(mixed());
    assert.equal(r.total, 5);
    assert.equal(r.affected, 3);
    assert.equal(r.healthy, 2);
    assert.equal(r.removable.length, 2, 'only the unplayable and the nameless');
    assert.equal(r.byKind['no-url'], 1);
    assert.equal(r.byKind['no-thumbnail'], 1);
    assert.equal(r.bySeverity.cosmetic, 1);
    assert.equal(r.score, 60, '3 of 5 usable');
    assert.equal(r.examples['no-url'][0].slug, 'broken');
  });

  test('examples are capped so one bad import cannot produce a huge payload', () => {
    const many = Array.from({ length: 400 }, (_, i) => good({ id: i, slug: `x-${i}`, game_url: '' }));
    const r = auditGames(many, { maxExamples: 10 });
    assert.equal(r.examples['no-url'].length, 10);
    assert.equal(r.byKind['no-url'], 400, 'the count is still complete');
  });

  test('every issue kind has a human-readable label', () => {
    // The admin panel renders these; a missing key would show as blank.
    const r = auditGames([...mixed(), good({ id: 6, slug: 'ok-1', game_url: 'https://e.com/1' }),
      good({ id: 7, category: '', game_url: 'https://e.com/7', slug: 'nocat' }),
      good({ id: 8, game_url: 'javascript:x', slug: 'badurl' }),
      good({ id: 9, title: 'undefined', game_url: 'https://e.com/9', slug: 'ph' })]);
    for (const kind of Object.keys(r.byKind)) {
      assert.ok(ISSUE_LABELS[kind], `no label for ${kind}`);
    }
  });

  test('junk input cannot crash the audit', () => {
    assert.doesNotThrow(() => auditGames());
    assert.doesNotThrow(() => auditGames(null));
    assert.doesNotThrow(() => auditGames('nope'));
    assert.equal(auditGames([]).score, 100, 'an empty catalog is not 0% healthy');
    const r = auditGames([null, undefined, 42, {}, { slug: 'x' }]);
    assert.equal(r.total, 2, 'only the objects count');
    assert.ok(r.removable.length >= 1);
  });
});

describe('writing removals back to the override file', () => {
  const tmp = () => join(tmpdir(), `zof-overrides-${Math.random().toString(36).slice(2)}.json`);

  test('the file\'s own indentation and line endings are preserved', () => {
    // REGRESSION: re-serialising with a different indent rewrote all 16,000
    // lines to add 40 entries — 16,294 insertions and 16,134 deletions — which
    // destroys the reviewable diff that justifies writing to this file at all.
    assert.deepEqual(detectFormat('{\n  "a": 1\n}\n'), { indent: '  ', eol: '\n' });
    assert.deepEqual(detectFormat('{\r\n    "a": 1\r\n}\r\n'), { indent: '    ', eol: '\r\n' });
    assert.deepEqual(detectFormat('{\n\t"a": 1\n}\n'), { indent: '\t', eol: '\n' });
    assert.deepEqual(detectFormat('{}'), { indent: '  ', eol: '\n' }, 'a file with no body still needs a default');
  });

  test('only the new lines change', () => {
    const f = tmp();
    try {
      writeFileSync(f, JSON.stringify({ remove: [{ slug: 'old-one' }] }, null, 2) + '\n');
      const before = readFileSync(f, 'utf8').split('\n');
      writeRemovals([{ slug: 'new-one', reason: 'duplicate-url' }], { file: f });
      const after = readFileSync(f, 'utf8').split('\n');
      // Every original line must still be present, byte for byte.
      for (const line of before.filter(Boolean)) {
        assert.ok(after.includes(line), `original line vanished: ${JSON.stringify(line)}`);
      }
      assert.ok(after.length > before.length);
    } finally { rmSync(f, { force: true }); }
  });

  test('a slug already covered is not written twice', () => {
    const f = tmp();
    try {
      writeFileSync(f, JSON.stringify({ remove: [{ slug: 'dupe' }] }, null, 2) + '\n');
      const added = writeRemovals([
        { slug: 'dupe', reason: 'duplicate-url' },
        { slug: 'fresh', reason: 'no-url' },
        { slug: 'fresh', reason: 'duplicate-url' },   // twice in one run
      ], { file: f });
      assert.deepEqual(added.map((a) => a.slug), ['fresh']);
      assert.equal(JSON.parse(readFileSync(f, 'utf8')).remove.length, 2);
    } finally { rmSync(f, { force: true }); }
  });

  test('a removal with no slug cannot be expressed as a rule and is skipped', () => {
    // Guessing at a title match instead would risk taking working games with it.
    const f = tmp();
    try {
      writeFileSync(f, JSON.stringify({ remove: [] }, null, 2) + '\n');
      assert.deepEqual(writeRemovals([{ slug: null, reason: 'no-url' }], { file: f }), []);
      assert.equal(JSON.parse(readFileSync(f, 'utf8')).remove.length, 0);
    } finally { rmSync(f, { force: true }); }
  });

  test('a file with no remove array gets one', () => {
    const f = tmp();
    try {
      writeFileSync(f, JSON.stringify({ patch: [] }, null, 2) + '\n');
      writeRemovals([{ slug: 'x', reason: 'no-url' }], { file: f });
      assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')).remove.map((r) => r.slug), ['x']);
    } finally { rmSync(f, { force: true }); }
  });

  test('every written rule records why it was added', () => {
    const f = tmp();
    try {
      writeFileSync(f, JSON.stringify({ remove: [] }, null, 2) + '\n');
      writeRemovals([{ slug: 'x', reason: 'duplicate-url' }], { file: f });
      const rule = JSON.parse(readFileSync(f, 'utf8')).remove[0];
      assert.match(rule._note, /auto: duplicate-url/, 'a rule nobody can explain is a rule nobody will remove');
      assert.equal(rule.slug, 'x');
    } finally { rmSync(f, { force: true }); }
  });
});
