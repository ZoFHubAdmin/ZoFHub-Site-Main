// Rewarded proxy access ("Boost") — EXECUTED against a real Postgres engine,
// not inferred from the SQL text. Same tool and pattern as
// test/control-plane-db.test.mjs: PGlite (Postgres 17 compiled to WebAssembly)
// with the three Supabase roles stubbed, so RLS and the SECURITY DEFINER
// function's atomicity are verified the way Postgres actually enforces them.
//
// db/rewards.sql has no foreign key into any other migration's tables, so it
// is run standalone here rather than replaying the full migration chain —
// faster, and the isolation is itself a fact worth protecting: this feature
// must not gain an undeclared dependency on another file's schema.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { isValidPlayerId, isValidCampaignId, isValidSessionId } from '../lib/reward-sessions.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REWARDS_SQL = readFileSync(join(ROOT, 'db', 'rewards.sql'), 'utf8');

async function freshDb() {
  const db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;`);
  await db.exec(REWARDS_SQL);
  return db;
}
const code = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code || e.message; } };
const asRole = async (db, role, sql, params) => {
  await db.exec(`set role ${role}`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
};

describe('pure validation (no database)', () => {
  test('player ids: identity.js\'s crypto.randomUUID() and its fallback shape both pass', () => {
    assert.equal(isValidPlayerId('3fa85f64-5717-4562-b3fc-2c963f66afa6'), true);
    assert.equal(isValidPlayerId('p_1a2b3c4d5e6f7g8h'), true);
    assert.equal(isValidPlayerId(''), false);
    assert.equal(isValidPlayerId('short'), false);
    assert.equal(isValidPlayerId('a'.repeat(65)), false);
    assert.equal(isValidPlayerId(null), false);
    assert.equal(isValidPlayerId("'; drop table proxy_entitlements; --"), false);
  });
  test('campaign ids are slugs', () => {
    assert.equal(isValidCampaignId('proxy-boost-1'), true);
    assert.equal(isValidCampaignId('Proxy-Boost'), false);
    assert.equal(isValidCampaignId('-leading-hyphen'), false);
  });
  test('session ids are UUIDs', () => {
    assert.equal(isValidSessionId('3fa85f64-5717-4562-b3fc-2c963f66afa6'), true);
    assert.equal(isValidSessionId('not-a-uuid'), false);
  });
});

describe('row-level security: every table is server-only', () => {
  let db;
  before(async () => { db = await freshDb(); });
  after(async () => { await db.close(); });

  test('anon and authenticated can read nothing and write nothing', async () => {
    for (const t of ['reward_campaigns', 'reward_sessions', 'reward_events', 'proxy_entitlements']) {
      for (const role of ['anon', 'authenticated']) {
        assert.equal(await code(asRole(db, role, `select * from public.${t} limit 1`)), '42501', `${role} could read ${t}`);
      }
    }
  });

  test('the RPC is the server\'s, not the public\'s', async () => {
    const args = [`'00000000-0000-0000-0000-000000000000'::uuid`, `'mock'`, `'x'`, `now()`];
    for (const role of ['anon', 'authenticated']) {
      assert.equal(
        await code(asRole(db, role, `select * from public.grant_reward_entitlement(${args.join(',')})`)),
        '42501', `${role} could call grant_reward_entitlement`,
      );
    }
  });

  test('service_role can reach every table', async () => {
    const r = await asRole(db, 'service_role', `select count(*)::int n from public.reward_campaigns`);
    assert.equal(r.rows[0].n, 0);
  });
});

describe('check constraints the application relies on', () => {
  let db;
  before(async () => { db = await freshDb(); });
  after(async () => { await db.close(); });

  test('a campaign cannot claim a tier outside the known list', async () => {
    assert.equal(await code(db.exec(
      `insert into public.reward_campaigns (id, title, tier) values ('x', 'X', 'premium')`,
    )), '23514');
  });
  test('required_events and grant_minutes are bounded', async () => {
    assert.equal(await code(db.exec(
      `insert into public.reward_campaigns (id, title, required_events) values ('x', 'X', 0)`,
    )), '23514');
    assert.equal(await code(db.exec(
      `insert into public.reward_campaigns (id, title, grant_minutes) values ('x', 'X', 100000)`,
    )), '23514');
  });
});

describe('grant_reward_entitlement() — the only way an entitlement is written', () => {
  let db;
  const PLAYER = '11111111-1111-1111-1111-111111111111';

  before(async () => {
    db = await freshDb();
    await db.exec(`
      insert into public.reward_campaigns (id, title, required_events, grant_minutes, session_ttl_minutes)
      values ('boost-3x', 'Watch 3, get an hour', 3, 60, 15);
      insert into public.reward_campaigns (id, title, status) values ('paused-campaign', 'Paused', 'paused');
    `);
  });
  after(async () => { await db.close(); });

  async function newSession(campaignId = 'boost-3x', { expiresInMinutes = 15 } = {}) {
    const r = await db.query(
      `insert into public.reward_sessions (campaign_id, player_id, events_required, expires_at)
       values ($1, $2, 3, now() + ($3 || ' minutes')::interval) returning id`,
      [campaignId, PLAYER, expiresInMinutes],
    );
    return r.rows[0].id;
  }
  async function grant(sessionId, eventId, { provider = 'mock', timestamp = new Date().toISOString() } = {}) {
    const r = await db.query(
      `select * from public.grant_reward_entitlement($1, $2, $3, $4)`,
      [sessionId, provider, eventId, timestamp],
    );
    return r.rows[0];
  }

  test('three events complete the session and grant the entitlement', async () => {
    const sid = await newSession();
    const r1 = await grant(sid, 'ev-1');
    assert.equal(r1.ok, true); assert.equal(r1.reason, 'event_recorded');
    assert.equal(r1.out_events_completed, 1); assert.equal(r1.session_status, 'pending');

    const r2 = await grant(sid, 'ev-2');
    assert.equal(r2.out_events_completed, 2); assert.equal(r2.session_status, 'pending');

    const r3 = await grant(sid, 'ev-3');
    assert.equal(r3.ok, true);
    assert.equal(r3.reason, 'entitlement_granted');
    assert.equal(r3.out_tier, 'boost');
    assert.equal(r3.session_status, 'completed');
    assert.ok(new Date(r3.out_expires_at) > new Date(Date.now() + 59 * 60_000), 'grant should be ~60 minutes out');

    const row = (await db.query(`select tier, expires_at from public.proxy_entitlements where player_id = $1`, [PLAYER])).rows[0];
    assert.equal(row.tier, 'boost');
  });

  test('a replayed provider_event_id is rejected — even against a different session', async () => {
    const sid1 = await newSession();
    const sid2 = await newSession();
    const first = await grant(sid1, 'dupe-id');
    assert.equal(first.ok, true);
    const replay = await grant(sid2, 'dupe-id');
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, 'event_already_consumed');
    // The session the replay targeted must be untouched by the rejected attempt.
    const s2 = (await db.query(`select events_completed from public.reward_sessions where id = $1`, [sid2])).rows[0];
    assert.equal(s2.events_completed, 0);
  });

  test('two "concurrent" postbacks carrying the SAME event id: exactly one wins', async () => {
    const sid1 = await newSession();
    const sid2 = await newSession();
    const [a, b] = await Promise.all([grant(sid1, 'shared-race-id'), grant(sid2, 'shared-race-id')]);
    const outcomes = [a, b].map((r) => r.ok);
    assert.deepEqual(outcomes.sort(), [false, true], 'exactly one of the two identical-event-id attempts should succeed');
    const rejected = a.ok ? b : a;
    assert.equal(rejected.reason, 'event_already_consumed');
  });

  test('two genuinely different events landed close together both count', async () => {
    const sid = await newSession();
    const [a, b] = await Promise.all([grant(sid, 'real-event-a'), grant(sid, 'real-event-b')]);
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    const after2 = (await db.query(`select events_completed from public.reward_sessions where id = $1`, [sid])).rows[0];
    assert.equal(after2.events_completed, 2);
  });

  test('a session already completed cannot be granted again', async () => {
    const sid = await newSession();
    await grant(sid, 'c1'); await grant(sid, 'c2'); await grant(sid, 'c3');
    const again = await grant(sid, 'c4');
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'session_already_completed');
  });

  test('an expired session is refused and marked expired', async () => {
    const sid = await newSession('boost-3x', { expiresInMinutes: -1 });
    const r = await grant(sid, 'late-1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'session_expired');
    const row = (await db.query(`select status from public.reward_sessions where id = $1`, [sid])).rows[0];
    assert.equal(row.status, 'expired');
  });

  test('a paused campaign refuses a grant', async () => {
    const r = await db.query(
      `insert into public.reward_sessions (campaign_id, player_id, events_required, expires_at)
       values ('paused-campaign', $1, 1, now() + interval '15 minutes') returning id`,
      [PLAYER],
    );
    const result = await grant(r.rows[0].id, 'p1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'campaign_inactive');
  });

  test('a second completed campaign STACKS onto the remaining time, not onto "now"', async () => {
    const player = '22222222-2222-2222-2222-222222222222';
    const sidA = await db.query(
      `insert into public.reward_sessions (campaign_id, player_id, events_required, expires_at)
       values ('boost-3x', $1, 3, now() + interval '15 minutes') returning id`, [player],
    ).then((r) => r.rows[0].id);
    for (const id of ['s1', 's2', 's3']) await grant(sidA, id, {});
    const first = (await db.query(`select expires_at from public.proxy_entitlements where player_id = $1`, [player])).rows[0];

    const sidB = await db.query(
      `insert into public.reward_sessions (campaign_id, player_id, events_required, expires_at)
       values ('boost-3x', $1, 3, now() + interval '15 minutes') returning id`, [player],
    ).then((r) => r.rows[0].id);
    for (const id of ['s4', 's5', 's6']) await grant(sidB, id, {});
    const second = (await db.query(`select expires_at from public.proxy_entitlements where player_id = $1`, [player])).rows[0];

    // Stacked: the second grant's expiry is ~60 minutes AFTER the first's,
    // not 60 minutes after "now" (which would be only slightly after `first`
    // given how quickly these two grants run back to back in a test).
    const deltaMs = new Date(second.expires_at) - new Date(first.expires_at);
    assert.ok(deltaMs > 55 * 60_000, `expected roughly +60 minutes stacked, got ${deltaMs}ms`);
  });
});
