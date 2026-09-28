// The GameDistribution importer, against REAL feed records
// (test/fixtures/gamedistribution-feed-sample.json, fetched 2026-09-26 from the
// official catalog feed). No network: the feed is injected.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore } from '../lib/cms-store-memory.mjs';
import { createCmsService } from '../lib/cms-service.mjs';
import { screenGdItem, mapGdItem, pickThumbnail, runGdImport, fetchGdFeed, IMPORT_ACTOR } from '../lib/gamedistribution-import.mjs';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/gamedistribution-feed-sample.json', import.meta.url), 'utf8')).items;
const byTitle = (t) => FIX.find((g) => g.Title === t);

// The six games the owner asked for, and what the screen must decide.
const REQUESTED = {
  '888abfd4058149059db1e1e778d6bfa6': { title: 'Cross the Road', decision: 'review', flag: 'roblox' },
  'd48120b598174ba48e3d35e2733fa575': { title: 'Flip Duel', decision: 'clean' },
  '1bd090f478884877be24fb1e1fea1f23': { title: 'Arena Strike Battle', decision: 'clean' },
  '7a4f5e733d4b4de8afba79c38f6ddb18': { title: 'Blockland Oneblock Skyblock', decision: 'review', flag: 'minecraft' },
  '6322e360cffc45f188d111985753b274': { title: 'Roller Coaster: Obby Race', decision: 'review', flag: 'roblox' },
  '9bde41f232834eff9ea81554ecee8279': { title: 'Moto Traffic Rider', decision: 'clean' },
};

const categories = ['arcade', 'casual', 'puzzle', 'adventure', 'racing', 'simulator', 'skill', 'girls', 'shooting', 'action', 'sports'];
const setup = () => {
  const store = createMemoryStore({ categories });
  const cms = createCmsService({ store });
  const fetchFeed = async () => ({ items: FIX, pages: 1, complete: true, error: null });
  return { store, cms, fetchFeed };
};

describe('screening real feed records', () => {
  test('the six requested games get the right decision, for the right reason', () => {
    for (const [md5, want] of Object.entries(REQUESTED)) {
      const item = FIX.find((g) => g.Md5 === md5);
      assert.ok(item, `${want.title} missing from the fixture`);
      const s = screenGdItem(item);
      assert.equal(s.decision, want.decision, `${want.title}: ${JSON.stringify(s.flags)}`);
      if (want.flag) assert.ok(s.flags.some((f) => f.code === 'trademark_tag' && f.detail.includes(want.flag)), `${want.title} not flagged for ${want.flag}`);
    }
  });

  test('not live, not https, or not GameDistribution\'s own embed: never imported', () => {
    assert.deepEqual(screenGdItem(byTitle('3D Supermarket Tycoon')).reasons.filter((r) => r.startsWith('provider_status')), ['provider_status_1']);
    assert.ok(screenGdItem(byTitle('Monster Vs Zombie')).reasons.includes('not_https'));
    assert.ok(screenGdItem(byTitle('Flappy Copter')).reasons.includes('embed_url_mismatch'));
  });

  test('a mark named only in the TAGS is still caught (the mario tag, the tetris compound)', () => {
    assert.equal(screenGdItem(byTitle('Fire Ball and Water Ball: Parkour Love Balls')).decision, 'review');
    assert.ok(screenGdItem(byTitle('Hextetris')).flags.some((f) => f.code === 'trademark_title'));
  });

  test('untrusted shapes are rejected, not thrown on', () => {
    for (const bad of [null, [], 'x', { Md5: 'x' }, { ...FIX[1], Md5: '../../etc' }, { ...FIX[1], Status: '2' }]) {
      assert.equal(screenGdItem(bad).decision, 'reject');
    }
  });
});

describe('URLs are taken exactly, never built', () => {
  test('the thumbnail is one of the feed\'s own asset URLs for that id, 4:3 preferred', () => {
    const cross = FIX.find((g) => g.Md5 === '888abfd4058149059db1e1e778d6bfa6');
    const t = pickThumbnail(cross.Md5, cross.Asset);
    assert.ok(cross.Asset.includes(t), 'thumbnail not taken from the feed');
    assert.match(t, /-512x384\.jpg$/);
  });

  test('an asset on another host, or for another id, is never used', () => {
    const id = 'd48120b598174ba48e3d35e2733fa575';
    assert.equal(pickThumbnail(id, [`https://evil.example.org/${id}-512x384.jpg`]), null);
    assert.equal(pickThumbnail(id, ['https://img.gamedistribution.com/ffffffffffffffffffffffffffffffff-512x384.jpg']), null);
    assert.equal(pickThumbnail(id, [`http://img.gamedistribution.com/${id}-512x384.jpg`]), null);
  });

  test('the stored embed is GameDistribution\'s base URL; the example.com referrer is never stored', () => {
    const m = mapGdItem(FIX.find((g) => g.Md5 === 'd48120b598174ba48e3d35e2733fa575'));
    assert.equal(m.input.game_url, 'https://html5.gamedistribution.com/d48120b598174ba48e3d35e2733fa575/');
    assert.ok(!JSON.stringify(m).includes('example.com'));
    assert.equal(m.input.embed_width, 960);
    assert.equal(m.input.embed_height, 600);
    assert.doesNotMatch(m.input.short_description || '', /\n/);
  });
});

describe('a full import run', () => {
  test('clean games publish, flagged games wait, rejects never arrive', async () => {
    const { store, cms, fetchFeed } = setup();
    const r = await runGdImport({ cms, store, fetchFeed, autoPublish: true });
    assert.equal(r.counts.failed, 0, JSON.stringify(r.failures));
    for (const [md5, want] of Object.entries(REQUESTED)) {
      const g = await store.findGameByExternal('gamedistribution', md5);
      assert.ok(g, `${want.title} not imported`);
      assert.equal(g.status, want.decision === 'clean' ? 'published' : 'pending_review', want.title);
      assert.equal(g.created_by, IMPORT_ACTOR.username);
      assert.match(g.thumbnail_url, /^https:\/\/img\.gamedistribution\.com\//);
      assert.equal(g.license_review.decision, want.decision);
    }
    assert.equal(await store.findGameByExternal('gamedistribution', byTitle('3D Supermarket Tycoon').Md5), null);
  });

  test('re-running imports nothing twice', async () => {
    const { store, cms, fetchFeed } = setup();
    const first = await runGdImport({ cms, store, fetchFeed });
    const second = await runGdImport({ cms, store, fetchFeed });
    assert.equal(second.counts.inserted, 0);
    assert.equal(second.counts.alreadyPresent, first.counts.inserted);
  });

  test('with auto-publish off, everything waits for a person', async () => {
    const { store, cms, fetchFeed } = setup();
    await runGdImport({ cms, store, fetchFeed, autoPublish: false });
    const g = await store.findGameByExternal('gamedistribution', 'd48120b598174ba48e3d35e2733fa575');
    assert.equal(g.status, 'pending_review');
  });

  test('a dry run writes nothing', async () => {
    const { store, cms, fetchFeed } = setup();
    const r = await runGdImport({ cms, store, fetchFeed, dryRun: true });
    assert.ok(r.counts.clean > 0);
    assert.equal(r.counts.inserted, 0);
    assert.equal((await store.listGames({})).rows.length, 0);
  });

  test('a title another provider already lists is held for review, not published twice', async () => {
    const { store, cms, fetchFeed } = setup();
    await store.insertGame({ slug: 'flip-duel', title: 'Flip Duel', game_url: 'https://html5.gamemonetize.co/abcdefgh12/', category: 'arcade', provider_id: 'gamemonetize', status: 'published' });
    await runGdImport({ cms, store, fetchFeed });
    const g = await store.findGameByExternal('gamedistribution', 'd48120b598174ba48e3d35e2733fa575');
    assert.equal(g.status, 'pending_review');
    assert.notEqual(g.slug, 'flip-duel', 'the existing slug was reused');
    assert.ok(g.license_review.flags.some((f) => f.code === 'duplicate_title'));
  });

  test('onlyIds restricts a run to the named games', async () => {
    const { store, cms, fetchFeed } = setup();
    const r = await runGdImport({ cms, store, fetchFeed, onlyIds: ['9bde41f232834eff9ea81554ecee8279'] });
    assert.equal(r.counts.inserted, 1);
  });
});

describe('walking the feed', () => {
  const page = (n) => Array.from({ length: n }, (_, i) => ({ Md5: String(i) }));

  test('a transient empty page mid-feed does not end the walk (it truncated a real crawl at 10,600 of 21,673)', async () => {
    const calls = {};
    const fetchPage = async (p) => {
      calls[p] = (calls[p] || 0) + 1;
      if (p === 2) return [];                 // the gap: empty every time it is asked
      if (p <= 3) return page(100);
      if (p === 4) return page(40);            // the genuine end
      return [];
    };
    const r = await fetchGdFeed({ fetchPage, delayMs: 0 });
    assert.equal(r.items.length, 240);
    assert.deepEqual(r.gaps, [{ page: 2, got: 0 }]);
    assert.equal(r.pages, 4);
    assert.ok(calls[2] >= 2, 'the short page was not re-checked');
  });

  test('a short final page ends it, and a dead feed reports its error', async () => {
    const done = await fetchGdFeed({ fetchPage: async (p) => (p === 1 ? page(100) : p === 2 ? page(7) : []), delayMs: 0 });
    assert.equal(done.items.length, 107);
    assert.equal(done.complete, true);
    const dead = await fetchGdFeed({ fetchPage: async () => { throw new Error('HTTP 503'); }, delayMs: 0, maxPages: 1 });
    assert.equal(dead.complete, false);
    assert.match(dead.error, /503/);
  });
});
