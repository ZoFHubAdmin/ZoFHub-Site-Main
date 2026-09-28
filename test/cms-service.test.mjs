// The game CMS, driven through its service layer with a principal per role.
// The in-memory store enforces the constraints the migration puts in Postgres
// (unique slug, category/provider foreign keys, optimistic concurrency, atomic
// bulk), so these exercise the same rules a live database applies.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../lib/cms-store-memory.mjs';
import { createCmsService, ServiceError } from '../lib/cms-service.mjs';

const as = (role, username = role) => ({ username, via: 'session', role, userId: `u-${role}` });
const EDITOR = as('content_manager', 'edith');
const MOD = as('moderator', 'mo');
const ADMIN = as('admin', 'ada');
const SUPER = as('super_admin', 'sue');
const ANALYST = as('analyst', 'ann');

const GD = (hex) => `https://html5.gamedistribution.com/${hex.padEnd(32, '0')}/`;
const game = (over = {}) => ({ title: 'Flip Duel', provider_id: 'gamedistribution', category: 'arcade', game_url: GD('d48120b5'), ...over });

let store, audit, cms;
beforeEach(() => {
  store = createMemoryStore({ categories: ['arcade', 'puzzle'] });
  audit = [];
  cms = createCmsService({ store, audit: (e) => audit.push(e) });
});

const rejects = async (fn, status, re) => {
  await assert.rejects(fn, (e) => {
    assert.ok(e instanceof ServiceError, `not a ServiceError: ${e?.message}`);
    assert.equal(e.status, status, `${e.message}`);
    if (re) assert.match(`${e.message} ${(e.errors || []).join(' ')}`, re);
    return true;
  });
};

describe('who may do what', () => {
  test('a content manager creates a DRAFT — never a live game', async () => {
    const g = await cms.createGame(EDITOR, game());
    assert.equal(g.status, 'draft');
    assert.equal(g.created_by, 'edith');
  });

  test('the full path needs three different permissions', async () => {
    const g = await cms.createGame(EDITOR, game());
    await cms.transition(EDITOR, g.id, 'submit');
    await rejects(() => cms.transition(EDITOR, g.id, 'approve'), 403);
    await cms.transition(MOD, g.id, 'approve');
    await rejects(() => cms.transition(MOD, g.id, 'publish'), 403);
    const live = await cms.transition(ADMIN, g.id, 'publish');
    assert.equal(live.status, 'published');
    assert.ok(live.published_at);
  });

  test('an analyst can read and do nothing else', async () => {
    await cms.listGames(ANALYST, {});
    await rejects(() => cms.createGame(ANALYST, game()), 403);
    await rejects(() => cms.createCategory(ANALYST, { slug: 'x', label: 'X' }), 403);
  });

  test('a refusal writes nothing', async () => {
    const before = (await store.listGames({})).rows.length;
    await rejects(() => cms.createGame(ANALYST, game()), 403);
    assert.equal((await store.listGames({})).rows.length, before);
    assert.equal(audit.length, 0);
  });

  test('rejecting needs a reason', async () => {
    const g = await cms.createGame(EDITOR, game());
    await cms.transition(EDITOR, g.id, 'submit');
    await rejects(() => cms.transition(MOD, g.id, 'reject'), 400, /reason/);
    const r = await cms.transition(MOD, g.id, 'reject', { note: 'uses a trademarked character' });
    assert.equal(r.status, 'rejected');
    assert.equal(r.review_note, 'uses a trademarked character');
  });
});

describe('the provider chain is enforced, not advisory', () => {
  test('an embed from outside the provider\'s origins is refused', async () => {
    await rejects(() => cms.createGame(EDITOR, game({ game_url: 'https://evil.example.org/d48120b598174ba48e3d35e2733fa575/' })), 400, /approved origins/);
  });

  test('restricted and suspended providers take no new games', async () => {
    await rejects(() => cms.createGame(EDITOR, game({ provider_id: 'onlinegames', game_url: 'https://www.onlinegames.io/x/' })), 400, /restricted/);
    await rejects(() => cms.createGame(EDITOR, game({ provider_id: 'gamezop', game_url: 'https://a.play.gamezop.com/g/x' })), 400, /suspended/);
  });

  test('a provider suspended AFTER approval blocks publication', async () => {
    const g = await cms.createGame(EDITOR, game());
    await cms.transition(EDITOR, g.id, 'submit');
    await cms.transition(MOD, g.id, 'approve');
    await store.updateProvider('gamedistribution', { status: 'suspended' });
    await cms.refreshProviders();
    await rejects(() => cms.transition(ADMIN, g.id, 'publish'), 409, /suspended/);
  });

  test('a category must exist (foreign key)', async () => {
    await rejects(() => cms.createGame(EDITOR, game({ category: 'nope' })), 400, /does not exist/);
  });
});

describe('edits', () => {
  test('re-pointing a reviewed game sends it back to review unless you can publish', async () => {
    const g = await cms.createGame(EDITOR, game());
    await cms.transition(EDITOR, g.id, 'submit');
    await cms.transition(MOD, g.id, 'approve');
    const live = await cms.transition(ADMIN, g.id, 'publish');
    const r = await cms.updateGame(EDITOR, g.id, { game_url: GD('aaaa1111') }, { expectUpdatedAt: live.updated_at });
    assert.equal(r.sentBackToReview, true);
    assert.equal(r.game.status, 'pending_review');
    assert.ok(audit.some((a) => a.action === 'game.update.resubmitted'));

    const g2 = await cms.createGame(EDITOR, game({ title: 'Other', game_url: GD('bbbb2222') }));
    await cms.transition(EDITOR, g2.id, 'submit'); await cms.transition(MOD, g2.id, 'approve');
    const live2 = await cms.transition(ADMIN, g2.id, 'publish');
    const r2 = await cms.updateGame(ADMIN, g2.id, { game_url: GD('cccc3333') }, { expectUpdatedAt: live2.updated_at });
    assert.equal(r2.game.status, 'published');
  });

  test('a stale edit is refused instead of overwriting someone else\'s (optimistic concurrency)', async () => {
    const g = await cms.createGame(EDITOR, game());
    await cms.updateGame(EDITOR, g.id, { title: 'First' }, { expectUpdatedAt: g.updated_at });
    await rejects(() => cms.updateGame(EDITOR, g.id, { title: 'Second' }, { expectUpdatedAt: g.updated_at }), 409, /changed by someone else/);
    await rejects(() => cms.updateGame(EDITOR, g.id, { title: 'Third' }, {}), 400, /expectUpdatedAt/);
  });

  test('every change is audited with before and after', async () => {
    const g = await cms.createGame(EDITOR, game());
    await cms.updateGame(EDITOR, g.id, { title: 'Flip Duel Deluxe', tags: ['flip'] }, { expectUpdatedAt: g.updated_at });
    const e = audit.find((a) => a.action === 'game.update');
    assert.deepEqual(e.detail.changes.title, { from: 'Flip Duel', to: 'Flip Duel Deluxe' });
    assert.deepEqual(e.detail.tags, { from: [], to: ['flip'] });
    assert.equal(e.actor.username, 'edith');
    assert.equal(e.resourceType, 'game');
  });

  test('duplicate slugs are refused', async () => {
    await cms.createGame(EDITOR, game());
    await rejects(() => cms.createGame(EDITOR, game({ game_url: GD('dddd4444') })), 409, /slug/);
  });
});

describe('archive before delete', () => {
  test('deletion needs: archived + games.delete + fresh password + the slug typed back', async () => {
    const g = await cms.createGame(EDITOR, game());
    await rejects(() => cms.deleteGame(ADMIN, g.id, { confirm: g.slug, reauthenticated: true }), 403);   // admin lacks games.delete
    await rejects(() => cms.deleteGame(SUPER, g.id, { confirm: g.slug, reauthenticated: true }), 409, /archive/);
    await cms.transition(ADMIN, g.id, 'archive');
    await rejects(() => cms.deleteGame(SUPER, g.id, { confirm: g.slug, reauthenticated: false }), 401);
    await rejects(() => cms.deleteGame(SUPER, g.id, { confirm: 'wrong', reauthenticated: true }), 400);
    const r = await cms.deleteGame(SUPER, g.id, { confirm: g.slug, reauthenticated: true });
    assert.equal(r.deleted, true);
    const e = audit.find((a) => a.action === 'game.delete');
    assert.equal(e.detail.snapshot.game_url, g.game_url, 'the audit record keeps enough to rebuild the row');
  });

  test('archived games are frozen until restored', async () => {
    const g = await cms.createGame(EDITOR, game());
    const arch = await cms.transition(ADMIN, g.id, 'archive');
    await rejects(() => cms.updateGame(EDITOR, g.id, { title: 'x' }, { expectUpdatedAt: arch.updated_at }), 409, /restore/);
    const back = await cms.transition(ADMIN, g.id, 'restore');
    assert.equal(back.status, 'unpublished');
  });
});

describe('bulk operations', () => {
  const seed = async (n) => {
    const ids = [];
    for (let i = 0; i < n; i++) ids.push((await cms.createGame(EDITOR, game({ title: `G${i}`, game_url: GD(`${i}`.padStart(4, '0') + 'ab') }))).id);
    return ids;
  };

  test('all-or-nothing: one ineligible game means nothing changes', async () => {
    const ids = await seed(3);
    for (const id of ids.slice(0, 2)) await cms.transition(EDITOR, id, 'submit');
    await assert.rejects(() => cms.bulk(ADMIN, { ids, op: 'approve' }), (e) => e.status === 409 && e.failures.length === 1);
    for (const id of ids) assert.notEqual((await store.getGame(id)).status, 'approved');
  });

  test('preview reports without writing', async () => {
    const ids = await seed(2);
    const p = await cms.bulk(ADMIN, { ids, op: 'submit', preview: true });
    assert.equal(p.valid, 2);
    assert.equal((await store.getGame(ids[0])).status, 'draft');
  });

  test('destructive operations need the exact count typed back', async () => {
    const ids = await seed(2);
    await rejects(() => cms.bulk(ADMIN, { ids, op: 'archive' }), 400, /confirm/);
    const r = await cms.bulk(ADMIN, { ids, op: 'archive', confirm: 2 });
    assert.equal(r.applied, 2);
    assert.ok(audit.some((a) => a.action === 'game.bulk.archive' && a.detail.applied === 2));
  });

  test('limits: 200 ids, distinct integers, and a per-op permission', async () => {
    await rejects(() => cms.bulk(ADMIN, { ids: Array.from({ length: 201 }, (_, i) => i + 1), op: 'feature' }), 400, /200/);
    await rejects(() => cms.bulk(ADMIN, { ids: [1, 1], op: 'feature' }), 400, /distinct/);
    await rejects(() => cms.bulk(EDITOR, { ids: [1], op: 'feature' }), 403);          // editor lacks games.bulk
  });

  test('tag operations report per game rather than claiming a success they did not have', async () => {
    const ids = await seed(2);
    const r = await cms.bulk(ADMIN, { ids, op: 'add_tag', value: 'Racing Fun' });
    assert.equal(r.applied, 2);
    assert.deepEqual(await store.getGameTags(ids[0]), ['racing-fun']);
  });
});

describe('taxonomy', () => {
  test('a category that holds games cannot be deleted', async () => {
    await cms.createGame(EDITOR, game());
    await rejects(() => cms.deleteCategory(ADMIN, 'arcade'), 409, /still holds games/);
    await cms.deleteCategory(ADMIN, 'puzzle');
  });
});

describe('file import', () => {
  test('rows are validated like the editor, and land as drafts', async () => {
    const rows = [game({ title: 'Imported One', game_url: GD('eeee5555') }), { title: '<b>bad</b>' }, game({ title: 'Imported One', game_url: GD('ffff6666') })];
    const plan = await cms.importPreview(EDITOR, rows);
    assert.equal(plan.valid.length, 1);
    assert.equal(plan.invalid.length, 2);
    await rejects(() => cms.importApply(ADMIN, rows, { confirm: 3 }), 400, /confirm/);
    const r = await cms.importApply(ADMIN, rows, { confirm: 1 });
    assert.equal(r.created, 1);
    const [g] = (await store.listGames({ q: 'Imported' })).rows;
    assert.equal(g.status, 'draft');
  });
});
