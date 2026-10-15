// "No automatic game additions" — asserted against the actual wiring.
//
// WHY THESE TESTS LOOK LIKE THIS. The requirement is a NEGATIVE one: a thing
// must not happen. A unit test of a function cannot show that, because the risk
// is not that growCatalogOnce() is wrong — it is that something CALLS it on a
// timer. So these tests read the registration sites and the write paths:
//
//   1. startCronJobs() registers no game-adding job (and a changed schedule list
//      is caught, not silently accepted).
//   2. The write paths refuse unconfirmed writes even when called directly, so
//      re-adding a schedule would still not add a game.
//   3. The roster cannot grow across repeated catalog builds.
//
// Together they mean: to add a game, somebody has to mean it.
import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCmsService } from '../lib/cms-service.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

describe('no scheduled job can add a game', () => {
  afterEach(async () => {
    const { stopCronJobs } = await import('../lib/cron-jobs.mjs');
    stopCronJobs();
  });

  test('startCronJobs registers only maintenance jobs — none that insert games', async () => {
    const prev = process.env.CRON_DISABLED;
    process.env.CRON_DISABLED = '';            // actually register, so we see the real list
    try {
      const { startCronJobs, cronStatus, stopCronJobs } = await import('../lib/cron-jobs.mjs');
      stopCronJobs();
      startCronJobs();
      const labels = cronStatus().jobs.map((j) => j.label);
      // The three retired game-addition jobs, by the labels they were registered
      // under. Any of them reappearing fails here.
      for (const forbidden of ['grow', 'y8-sync', 'gd-import']) {
        assert.ok(!labels.includes(forbidden), `the "${forbidden}" job is scheduled again — it adds games`);
      }
      // And the jobs that DO remain are all maintenance.
      assert.deepEqual(
        [...labels].sort(),
        ['ai-feedback-prune', 'health', 'keepalive', 'link-check', 'orphan-stats', 'rec-cleanup', 'retention', 'score-prune'].sort(),
        'the scheduled job list changed — confirm the new job cannot add games, then update this test',
      );
    } finally {
      if (prev === undefined) delete process.env.CRON_DISABLED; else process.env.CRON_DISABLED = prev;
    }
  });

  test('the retired cron wrappers no longer exist as exports', async () => {
    const mod = await import('../lib/cron-jobs.mjs');
    // jobGrowGated / jobY8Sync were module-private, so assert on the source:
    // a re-added wrapper would have to be referenced by safeSchedule to matter,
    // and that is what the registration test above catches. Here we check the
    // schedule expressions themselves are gone from the file.
    const src = read('lib/cron-jobs.mjs');
    assert.doesNotMatch(src, /safeSchedule\(\s*'grow'/, "a 'grow' schedule is back");
    assert.doesNotMatch(src, /safeSchedule\(\s*'y8-sync'/, "a 'y8-sync' schedule is back");
    assert.equal(typeof mod.growCatalogOnce, 'function', 'the operator path must still exist');
  });

  test('server.js registers no extra game-adding cron job', () => {
    const src = read('server.js');
    assert.doesNotMatch(src, /startCronJobs\(\{\s*extra:/, 'an extra cron job is registered again — check it cannot add games');
    assert.match(src, /startCronJobs\(\)/, 'cron jobs should still start (the maintenance ones)');
  });
});

describe('the write paths refuse unless a human confirms', () => {
  test('growCatalogOnce writes nothing without an explicit confirm', async () => {
    const { growCatalogOnce } = await import('../lib/cron-jobs.mjs');
    const stats = await growCatalogOnce({});
    assert.equal(stats.refused, 'catalog_frozen');
    assert.equal(stats.inserted, 0);
    assert.equal(stats.tested, 0, 'it should refuse BEFORE doing any network work');
  });

  test('growCatalogOnce still allows a dry run, because that writes nothing', async () => {
    const { growCatalogOnce } = await import('../lib/cron-jobs.mjs');
    const stats = await growCatalogOnce({ dryRun: true, sampleSize: 1, maxProbes: 0, target: 1 });
    assert.notEqual(stats.refused, 'catalog_frozen', 'a dry run is discovery, not an addition');
  });

  test('ingestY8 writes nothing without an explicit confirm', async () => {
    const { ingestY8 } = await import('../lib/y8-ingest.mjs');
    const stats = await ingestY8({});
    assert.equal(stats.refused, 'catalog_frozen');
    assert.equal(stats.upserted, 0);
  });
});

describe('the displayed roster cannot grow on its own', () => {
  test('server.js no longer runs a roster-growth interval', () => {
    const src = read('server.js');
    assert.doesNotMatch(src, /function growActiveRoster\s*\(/, 'the roster grow function is back');
    assert.doesNotMatch(src, /growActiveRosterSlugs/, 'the roster grow helper is imported again');
  });

  test('repeated catalog builds hold the served count at the cap', async () => {
    const { selectActive } = await import('../lib/active-roster.mjs');
    const pool = Array.from({ length: 3000 }, (_, i) => ({ slug: `g-${i}` }));
    let r = selectActive(pool, { slugs: [] }, 100);
    assert.equal(r.games.length, 100);
    for (let i = 0; i < 50; i++) {
      r = selectActive(pool, r.roster, 100);
      assert.equal(r.games.length, 100, `the served count moved on build ${i}`);
    }
  });
});

describe('the CMS refuses additions while the catalog is locked', () => {
  // The gate is injected, so it can be exercised without a database.
  const owner = { username: 'owner', via: 'session' };

  const GD = 'https://html5.gamedistribution.com/d48120b5aaaa4444bbbb5555cccc6666/';
  const stubStore = {
    listProviders: async () => [{ id: 'gamedistribution', name: 'GameDistribution', status: 'approved', embed_mode: 'iframe' }],
    getCategory: async () => ({ slug: 'arcade' }),
    insertGame: async (row) => ({ id: 1, ...row }),
    setGameTags: async () => {},
    insertGamesBatch: async (rows) => rows.length,
    // 'approved' is the state publish() accepts (approved | unpublished).
    getGame: async () => ({
      id: 1, slug: 'x', title: 'X', status: 'approved', updated_at: 'now',
      provider_id: 'gamedistribution', game_url: GD, thumbnail_url: null,
    }),
    updateGame: async (id, patch) => ({ id, ...patch }),
  };

  // THE BOUNDARY IS PUBLICATION, not creation. A draft is not in the approved
  // catalog — visitors cannot see it — so creating one is ordinary editorial
  // work and stays ungated; the freeze bites where a game becomes public.
  test('publishing is refused with 409 and a needsUnlock hint while locked', async () => {
    const svc = createCmsService({
      store: stubStore,
      catalogGate: () => ({ ok: false, reason: 'the catalog is locked at its 100-game baseline', code: 'catalog_at_baseline', baseline: 100, publishedCount: 100 }),
    });
    await assert.rejects(
      () => svc.transition(owner, 1, 'publish', { expectUpdatedAt: 'now' }),
      (e) => {
        assert.equal(e.status, 409);
        assert.equal(e.needsUnlock, true);
        assert.equal(e.baseline, 100);
        // Refused by the LOCK, not by validation — a 400 here would mean the
        // gate never ran and the test was passing for the wrong reason.
        assert.match(e.message, /locked/);
        return true;
      },
    );
  });

  test('publishing succeeds once the catalog is unlocked', async () => {
    const svc = createCmsService({ store: stubStore, catalogGate: () => ({ ok: true, unlocked: true }) });
    const next = await svc.transition(owner, 1, 'publish', { expectUpdatedAt: 'now' });
    assert.equal(next.status, 'published');
  });

  test('creating a DRAFT is not gated — a draft is not in the catalog', async () => {
    let gateCalls = 0;
    const svc = createCmsService({
      store: stubStore,
      catalogGate: () => { gateCalls += 1; return { ok: false, reason: 'locked', code: 'catalog_at_baseline' }; },
    });
    const created = await svc.createGame(owner, { title: 'New', slug: 'new', category: 'arcade', provider_id: 'gamedistribution', game_url: GD });
    assert.equal(created.status, 'draft');
    assert.equal(gateCalls, 0, 'the freeze must not be consulted for a draft');
  });

  test('50 drafts cannot be laundered into the catalog — each publish is judged', async () => {
    // The reason the gate sits on publish rather than create: staging work is
    // free, but every attempt to make it public is checked against the live
    // count, so a batch of drafts is not a way around the baseline.
    let published = 100;
    const svc = createCmsService({
      store: stubStore,
      catalogGate: () => published >= 100
        ? { ok: false, reason: 'locked at baseline', code: 'catalog_at_baseline' }
        : { ok: true },
    });
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => svc.transition(owner, 1, 'publish', { expectUpdatedAt: 'now' }), (e) => e.status === 409);
    }
    published = 99;                       // a slot opens up (a game was archived)
    const next = await svc.transition(owner, 1, 'publish', { expectUpdatedAt: 'now' });
    assert.equal(next.status, 'published', 'headroom should allow exactly one refill');
  });

  test('importFromProvider is refused too, and is judged on the batch size', async () => {
    const seen = [];
    const svc = createCmsService({
      store: stubStore,
      catalogGate: ({ adding }) => { seen.push(adding); return { ok: false, reason: 'locked', code: 'catalog_at_baseline' }; },
    });
    await assert.rejects(() => svc.importFromProvider(owner, [{}, {}, {}]), (e) => e.status === 409);
    assert.deepEqual(seen, [3], 'the whole batch size must reach the gate, not 1');
  });

  test('with no gate injected the service is unchanged (default allow)', async () => {
    const svc = createCmsService({ store: stubStore });
    const next = await svc.transition(owner, 1, 'publish', { expectUpdatedAt: 'now' });
    assert.equal(next.status, 'published', 'an un-gated service must not refuse on the lock');
  });

  test('a gate that throws fails CLOSED with 503, not open', async () => {
    // The gate reads live settings; if that read fails, the safe answer is "no".
    const svc = createCmsService({
      store: stubStore,
      catalogGate: () => { throw new Error('settings unreachable'); },
    });
    await assert.rejects(
      () => svc.transition(owner, 1, 'publish', { expectUpdatedAt: 'now' }),
      (e) => e.status === 503 && /catalog lock could not be read/.test(e.message),
    );
  });
});
