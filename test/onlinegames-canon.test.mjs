// OnlineGames.io canonical reconciliation.
//
// The first suite is the important one. A text search for "onlinegames.io"
// matches 348 catalog rows, but 37 of them are GameDistribution games that only
// name the site in a gd_sdk_referrer_url parameter. Acting on a substring match
// would delete 37 legitimate games belonging to a different provider under a
// different licence.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOnlineGamesUrl, embedKey, slugify, categoryFromTags,
  toCatalogShape, indexCanonical, reconcile,
} from '../lib/onlinegames-canon.mjs';

const OG = 'https://cloud.onlinegames.io/games/2026/unity/steal-brainrots-multiplayer/game.html';
const GD_WITH_OG_REFERRER =
  'https://html5.gamedistribution.com/60a97d022db7432eb82dd30fa7938e03/?gd_sdk_referrer_url=https://www.onlinegames.io/gt-cars-city-racing/';

describe('ownership is decided by host, never by substring', () => {
  test('a GameDistribution game naming onlinegames.io is NOT ours', () => {
    // REGRESSION: this exact URL shape accounts for 37 catalog rows. Treating
    // them as OnlineGames.io games removes another provider's licensed content.
    assert.equal(/onlinegames\.io/i.test(GD_WITH_OG_REFERRER), true, 'the substring really is present');
    assert.equal(isOnlineGamesUrl(GD_WITH_OG_REFERRER), false, 'but the host is gamedistribution.com');
    assert.equal(embedKey(GD_WITH_OG_REFERRER), '', 'and it must produce no identity key');
  });

  test('genuine OnlineGames.io hosts are recognised', () => {
    for (const u of [
      'https://cloud.onlinegames.io/games/x/game.html',
      'https://www.onlinegames.io/games/2024/flash/y/index.html',
      'https://onlinegames.io/games/z/',
      'http://ONLINEGAMES.IO/games/z/',
    ]) assert.equal(isOnlineGamesUrl(u), true, u);
  });

  test('lookalike hosts are rejected', () => {
    // "onlinegames.io.evil.com" contains the string and ends with a different
    // registrable domain.
    for (const u of [
      'https://onlinegames.io.evil.com/games/x',
      'https://notonlinegames.io/games/x',
      'https://fakeonlinegames.io/x',
      'https://example.com/?u=onlinegames.io',
    ]) assert.equal(isOnlineGamesUrl(u), false, u);
  });

  test('junk input is not ours either', () => {
    for (const u of ['', '   ', null, undefined, 42, {}, 'not a url', '/games/local.html']) {
      assert.equal(isOnlineGamesUrl(u), false);
      assert.equal(embedKey(u), '');
    }
  });
});

describe('embed identity', () => {
  test('query strings and trailing slashes do not create a second game', () => {
    const base = embedKey(OG);
    for (const v of [OG + '?v=2', OG + '#start', OG.toUpperCase().replace('HTTPS','https'), OG + '?utm_source=x']) {
      assert.equal(embedKey(v), base, v);
    }
    assert.equal(embedKey('https://cloud.onlinegames.io/games/a/'), embedKey('https://cloud.onlinegames.io/games/a'));
  });

  test('different paths are different games', () => {
    assert.notEqual(
      embedKey('https://cloud.onlinegames.io/games/a/game.html'),
      embedKey('https://cloud.onlinegames.io/games/b/game.html'));
  });

  test('subdomains are distinct identities', () => {
    // cloud. and www. genuinely serve different builds; folding them together
    // would silently drop one.
    assert.notEqual(
      embedKey('https://cloud.onlinegames.io/games/a/x.html'),
      embedKey('https://www.onlinegames.io/games/a/x.html'));
  });
});

describe('slug derivation matches the repository convention', () => {
  test('apostrophes and punctuation become hyphens, as the live catalog already does', () => {
    // The DB holds papa-s-burgeria for "Papa's Burgeria"; a different rule here
    // would fail to match existing rows and duplicate every game.
    assert.equal(slugify("Papa's Burgeria"), 'papa-s-burgeria');
    assert.equal(slugify('Steal Brainrots Multiplayer'), 'steal-brainrots-multiplayer');
    assert.equal(slugify('  Sniper   Elite  '), 'sniper-elite');
    assert.equal(slugify('Sonic .EXE'), 'sonic-exe');
  });

  test('diacritics are folded, not dropped', () => {
    assert.equal(slugify('Cãozinho Laranja'), 'caozinho-laranja');
    assert.equal(slugify('Tireur isolé'), 'tireur-isole');
  });

  test('junk cannot produce a leading or trailing hyphen', () => {
    assert.equal(slugify('!!!Hello!!!'), 'hello');
    assert.equal(slugify('---'), '');
    assert.equal(slugify(null), '');
    assert.ok(slugify('x'.repeat(200)).length <= 80);
  });
});

describe('category from tags', () => {
  test('the most specific bucket wins', () => {
    // Ordered rules: without an order "3d,racing,arcade" lands wherever the
    // object happened to iterate first.
    assert.equal(categoryFromTags('3d,racing,arcade,fun'), 'racing');
    assert.equal(categoryFromTags('arcade,shooting'), 'shooting');
    assert.equal(categoryFromTags('io-games,multiplayer,strategy'), 'io-games');
    assert.equal(categoryFromTags('2-player,sports,football'), '2-player');
  });

  test('an unclassifiable tag string still yields a browsable category', () => {
    // Blank would hide the game from every filter, which is worse than a
    // slightly wrong bucket.
    for (const t of ['', null, undefined, 'free,fun,cool', 'zzz']) {
      assert.equal(categoryFromTags(t), 'arcade');
    }
  });
});

describe('indexing the canonical file', () => {
  const entry = {
    title: 'Steal Brainrots Multiplayer', embed: OG,
    image: 'https://www.onlinegames.io/media/x.webp',
    tags: 'io-games,multiplayer', description: 'A\n\nlong   description.',
  };

  test('an entry maps to the catalog shape', () => {
    const g = toCatalogShape(entry);
    assert.equal(g.slug, 'steal-brainrots-multiplayer');
    assert.equal(g.category, 'io-games');
    assert.equal(g.description, 'A long description.', 'whitespace is collapsed');
  });

  test('descriptions are bounded', () => {
    const g = toCatalogShape({ ...entry, description: 'x'.repeat(5000) });
    assert.ok(g.description.length <= 600);
  });

  test('duplicate embeds inside the file are reported, not silently merged', () => {
    const r = indexCanonical([entry, { ...entry, title: 'Different Name' }]);
    assert.equal(r.byEmbed.size, 1);
    assert.equal(r.duplicates.length, 1);
    assert.equal(r.duplicates[0].title, 'Different Name', 'the first occurrence wins');
  });

  test('an entry whose embed is not an OnlineGames.io URL is invalid, not canonical', () => {
    const r = indexCanonical([{ title: 'Impostor', embed: GD_WITH_OG_REFERRER }]);
    assert.equal(r.byEmbed.size, 0);
    assert.equal(r.invalid.length, 1);
  });

  test('malformed input does not throw', () => {
    assert.doesNotThrow(() => indexCanonical());
    assert.doesNotThrow(() => indexCanonical('nope'));
    assert.equal(indexCanonical([null, 3, {}]).total, 1);
  });
});

describe('reconciling the catalog', () => {
  const canon = [
    { title: 'Kept Game',   embed: 'https://cloud.onlinegames.io/games/keep/game.html', tags: 'racing', image: 'https://i/x.webp' },
    { title: 'Absent Game', embed: 'https://cloud.onlinegames.io/games/absent/game.html', tags: 'puzzle', image: 'https://i/y.webp' },
  ];
  const rows = [
    { id: 1, slug: 'kept-game',  title: 'Kept Game',  game_url: 'https://cloud.onlinegames.io/games/keep/game.html', thumbnail_url: 'https://i/x.webp', category: 'racing' },
    { id: 2, slug: 'kept-copy',  title: 'Kept Game',  game_url: 'https://cloud.onlinegames.io/games/keep/game.html?v=2', thumbnail_url: 'https://i/x.webp', category: 'racing' },
    { id: 3, slug: 'papa-s-x',   title: "Papa's X",   game_url: 'https://www.onlinegames.io/games/2024/flash/papas-x/index.html', category: 'simulator' },
    { id: 4, slug: 'gd-game',    title: 'GD Game',    game_url: GD_WITH_OG_REFERRER, category: 'racing' },
    { id: 5, slug: 'other',      title: 'Other',      game_url: 'https://html5.gamedistribution.com/abc/', category: 'arcade' },
  ];

  test('the four sets are disjoint and correct', () => {
    const r = reconcile(canon, rows);
    assert.equal(r.matched.length, 1, 'one canonical game present');
    assert.equal(r.duplicates.length, 1, 'the ?v=2 copy is the same game');
    assert.equal(r.nonCanonical.length, 1, "Papa's X is served by OG but absent from canon");
    assert.equal(r.missing.length, 1, 'Absent Game is in canon but not the catalog');
    assert.equal(r.nonCanonical[0].slug, 'papa-s-x');
    assert.equal(r.missing[0].slug, 'absent-game');
  });

  test('the GameDistribution referrer row is excluded from every set', () => {
    const r = reconcile(canon, rows);
    const all = [...r.matched.map(m => m.row), ...r.duplicates.map(d => d.row), ...r.nonCanonical];
    assert.ok(!all.some(x => x.slug === 'gd-game'), 'it must never be a removal candidate');
    assert.equal(r.ignoredMentions, 1, 'but it IS reported, so the exclusion is visible');
    assert.equal(r.owned, 3, 'only the three genuine OG rows are in scope');
  });

  test('a game with no drift is marked in sync', () => {
    const r = reconcile(canon, rows);
    assert.equal(r.matched[0].inSync, true);
    assert.deepEqual(r.matched[0].drift, {});
  });

  test('drift is reported field by field, so a patch changes only what differs', () => {
    const stale = [{ ...rows[0], title: 'Old Name', category: 'arcade', thumbnail_url: 'https://i/old.webp' }];
    const m = reconcile(canon, stale).matched[0];
    assert.equal(m.inSync, false);
    assert.deepEqual(m.drift, { title: 'Kept Game', thumbnail_url: 'https://i/x.webp', category: 'racing' });
  });

  test('the duplicate names which row is kept', () => {
    const r = reconcile(canon, rows);
    assert.equal(r.duplicates[0].row.slug, 'kept-copy');
    assert.equal(r.duplicates[0].keeping.slug, 'kept-game', 'the first occurrence is retained');
  });

  test('empty and malformed input does not throw', () => {
    assert.doesNotThrow(() => reconcile());
    assert.doesNotThrow(() => reconcile([], null));
    assert.equal(reconcile([], rows).nonCanonical.length, 3, 'with no canon, every owned row is non-canonical');
  });
});

describe('genre beats the generic multiplayer label', () => {
  test('a racing game tagged multiplayer is still racing', () => {
    // REGRESSION: 'multiplayer' was ranked above every genre, so
    // burnout-drift-hunter (3d,car,crash,drift,multiplayer) was reclassified
    // from racing to multiplayer — true, and useless next to "racing".
    assert.equal(categoryFromTags('3d,car,crash,drift,multiplayer'), 'racing');
    assert.equal(categoryFromTags('multiplayer,shooting,fps'), 'shooting');
    assert.equal(categoryFromTags('multiplayer,football,sports'), 'sports');
  });

  test('multiplayer still applies when nothing else does', () => {
    assert.equal(categoryFromTags('multiplayer,free,fun'), 'multiplayer');
    assert.equal(categoryFromTags('mmo'), 'multiplayer');
  });

  test('the browse-mode categories still outrank genre', () => {
    // Someone filtering for a two-player game wants that filter more than they
    // want the genre; same for .io.
    assert.equal(categoryFromTags('2-player,racing,car'), '2-player');
    assert.equal(categoryFromTags('io-games,shooting'), 'io-games');
  });
});
