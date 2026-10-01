// The control-plane migration, EXECUTED — not parsed. Every migration in
// supabase/migrations/ runs in PGlite (Postgres 17 compiled to WebAssembly) with
// the three Supabase roles stubbed, and the assertions switch to those roles
// with SET ROLE, so row-level security and grants are tested the way Postgres
// enforces them rather than inferred from the SQL text.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, 'supabase', 'migrations');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const CONTROL = FILES.find((f) => f.includes('control_plane'));

async function freshDb() {
  const db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;`);
  return db;
}
const run = (db, f) => db.exec(readFileSync(join(DIR, f), 'utf8'));
const code = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code || e.message; } };

describe('the migration applies in both orders a real database sees', () => {
  test('a fresh project: every file, in filename order', async () => {
    assert.ok(CONTROL, 'control_plane migration missing from supabase/migrations');
    const db = await freshDb();
    for (const f of FILES) await run(db, f);
    const { rows } = await db.query(`select count(*)::int n from pg_tables where schemaname='public' and not rowsecurity`);
    assert.equal(rows[0].n, 0, 'a public table was left without row-level security');
    await db.close();
  });

  test('the LIVE database: control_plane arrives after grants, over existing rows, and twice', async () => {
    const db = await freshDb();
    for (const f of FILES) if (f !== CONTROL) await run(db, f);
    await db.exec(`
      insert into public.games (slug, title, game_url, category) values
        ('flip-duel', 'Flip Duel', 'https://html5.gamedistribution.com/d48120b598174ba48e3d35e2733fa575/?gd_sdk_referrer_url=x', 'arcade'),
        ('mm', 'Monster Match', 'https://html5.gamemonetize.co/abcdefgh12/', 'puzzle games'),
        ('odd', 'Odd One', 'https://example.org/game', '2048 & merge');`);
    await run(db, CONTROL);
    await run(db, CONTROL);                                   // idempotent: re-applying is a no-op
    const { rows } = await db.query(`select slug, status, provider_id, external_id from public.games order by slug`);
    assert.deepEqual(rows.map((r) => [r.slug, r.status, r.provider_id, r.external_id]), [
      ['flip-duel', 'published', 'gamedistribution', 'd48120b598174ba48e3d35e2733fa575'],
      ['mm', 'published', 'gamemonetize', null],
      ['odd', 'published', null, null],
    ]);
    const fk = await db.query(`select convalidated from pg_constraint where conname = 'games_category_fk'`);
    assert.equal(fk.rows[0].convalidated, true, 'legacy categories were not all seeded, so the foreign key stayed unvalidated');
    await db.close();
  });
});

describe('who can see and change what (enforced by Postgres)', () => {
  let db;
  before(async () => {
    db = await freshDb();
    for (const f of FILES) await run(db, f);
    await db.exec(`
      insert into public.games (slug, title, game_url, category, status) values
        ('live', 'Live', 'https://html5.gamedistribution.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/', 'arcade', 'published'),
        ('draft', 'Draft', 'https://html5.gamedistribution.com/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/', 'arcade', 'draft'),
        ('held', 'Held', 'https://html5.gamedistribution.com/cccccccccccccccccccccccccccccccc/', 'arcade', 'pending_review');
      insert into public.admin_users (username, role, created_by, password_hash) values ('edith', 'content_manager', 'test', 'scrypt$1$1$1$x$y');
      insert into public.proxy_targets (pattern, purpose, created_by) values ('example.org', 'reference', 'test');`);
  });
  after(async () => { await db.close(); });

  const asRole = async (role, sql) => {
    await db.exec(`set role ${role}`);
    try { return await db.query(sql); } finally { await db.exec('reset role'); }
  };

  test('the public key sees published games only — drafts and held games are invisible', async () => {
    const t = await asRole('anon', `select slug from public.games order by slug`);
    assert.deepEqual(t.rows.map((r) => r.slug), ['live']);
    const v = await asRole('anon', `select slug from public.games_public order by slug`);
    assert.deepEqual(v.rows.map((r) => r.slug), ['live']);
  });

  test('the public key cannot write games', async () => {
    const r = await code(asRole('anon', `insert into public.games (slug, title, game_url) values ('x', 'x', 'https://x.org/')`));
    assert.equal(r, '42501');
  });

  test('every control-plane table is closed to the public keys', async () => {
    for (const t of ['admin_users', 'game_providers', 'game_categories', 'game_tags', 'game_tag_links', 'site_settings', 'proxy_providers', 'proxy_targets', 'proxy_policies']) {
      for (const role of ['anon', 'authenticated']) {
        assert.equal(await code(asRole(role, `select * from public.${t} limit 1`)), '42501', `${role} could read ${t}`);
      }
    }
  });

  test('the server role reads everything', async () => {
    const r = await asRole('service_role', `select count(*)::int n from public.games`);
    assert.equal(r.rows[0].n, 3);
    const u = await asRole('service_role', `select username from public.admin_users`);
    assert.equal(u.rows[0].username, 'edith');
  });

  test('the RPCs are the server\'s, not the public\'s', async () => {
    assert.equal(await code(asRole('anon', `select public.cms_status_counts()`)), '42501');
    assert.equal(await code(asRole('anon', `select public.cms_bulk_transition(array[1]::bigint[], 'published', array['draft'], 'x')`)), '42501');
  });
});

describe('integrity the database enforces on its own', () => {
  let db;
  before(async () => { db = await freshDb(); for (const f of FILES) await run(db, f); });
  after(async () => { await db.close(); });

  test('a bulk transition is all-or-nothing', async () => {
    await db.exec(`insert into public.games (slug, title, game_url, category, status) values
      ('b1','B1','https://x.org/1','arcade','draft'), ('b2','B2','https://x.org/2','arcade','draft'), ('b3','B3','https://x.org/3','arcade','published')`);
    const ids = (await db.query(`select id from public.games where slug in ('b1','b2','b3') order by slug`)).rows.map((r) => Number(r.id));
    assert.equal(await code(db.query(`select public.cms_bulk_transition($1::bigint[], 'pending_review', array['draft'], 'x')`, [ids])), 'P0001');
    const still = await db.query(`select count(*)::int n from public.games where slug in ('b1','b2') and status='draft'`);
    assert.equal(still.rows[0].n, 2, 'a partial bulk change was committed');
    const ok = await db.query(`select public.cms_bulk_transition($1::bigint[], 'pending_review', array['draft'], 'x') n`, [ids.slice(0, 2)]);
    assert.equal(ok.rows[0].n, 2);
  });

  test('statuses, categories and providers are constrained', async () => {
    assert.equal(await code(db.exec(`insert into public.games (slug,title,game_url,category,status) values ('s','S','https://x.org/s','arcade','live')`)), '23514');
    assert.equal(await code(db.exec(`insert into public.games (slug,title,game_url,category) values ('c','C','https://x.org/c','no-such-category')`)), '23503');
    assert.equal(await code(db.exec(`insert into public.games (slug,title,game_url,category,provider_id) values ('p','P','https://x.org/p','arcade','nope')`)), '23503');
    // ON DELETE RESTRICT raises 23001 (restrict_violation), not 23503 — the
    // store maps both to a 409 (lib/cms-store-errors.mjs).
    assert.equal(await code(db.exec(`delete from public.game_categories where slug = 'arcade'`)), '23001');
    assert.equal(await code(db.exec(`delete from public.game_providers where id = 'gamedistribution'`)), 'ok', 'an unused provider row should be removable');
  });

  test('proxy destinations: no whole-internet patterns, web ports only', async () => {
    for (const p of ['*', '*.com', 'com', '127.0.0.1', '169.254.169.254', '*.10.0.0', '*.*.org']) {
      assert.equal(await code(db.exec(`insert into public.proxy_targets (pattern, purpose, created_by) values ('${p}', 'test', 't')`)), '23514', p);
    }
    assert.equal(await code(db.exec(`insert into public.proxy_targets (pattern, ports, purpose, created_by) values ('a.example.org', '{22}', 'test', 't')`)), '23514');
    assert.equal(await code(db.exec(`insert into public.proxy_targets (pattern, purpose, created_by) values ('a.example.org', 'test', 't')`)), 'ok');
  });

  test('staff: known roles only, usernames unique case-insensitively', async () => {
    assert.equal(await code(db.exec(`insert into public.admin_users (username, role, created_by) values ('bob', 'root', 't')`)), '23514');
    await db.exec(`insert into public.admin_users (username, role, created_by) values ('bob', 'support', 't')`);
    assert.equal(await code(db.exec(`insert into public.admin_users (username, role, created_by) values ('BOB', 'support', 't')`)), '23514');
    assert.equal(await code(db.exec(`insert into public.admin_users (username, role, created_by) values ('bob', 'support', 't')`)), '23505');
  });
});

describe('the audit trail is append-only AND tamper-evident', () => {
  let db;
  before(async () => { db = await freshDb(); for (const f of FILES) await run(db, f); });
  after(async () => { await db.close(); });

  test('rows chain, verify clean, and a tampered row is found', async () => {
    for (let i = 1; i <= 4; i++) {
      await db.query(`insert into public.admin_audit_logs (username, action, target, outcome, detail) values ($1, $2, $3, 'success', $4)`,
        ['ada', `game.update`, `game:${i}`, JSON.stringify({ n: i })]);
    }
    const chain = await db.query(`select id, prev_hash, row_hash from public.admin_audit_logs order by id`);
    for (let i = 1; i < chain.rows.length; i++) assert.equal(chain.rows[i].prev_hash, chain.rows[i - 1].row_hash);
    const clean = await db.query(`select * from public.admin_audit_verify(100)`);
    assert.equal(clean.rows[0].first_bad_id, null);
    assert.equal(clean.rows[0].checked, 4);

    // Ordinary UPDATE is refused outright…
    assert.notEqual(await code(db.exec(`update public.admin_audit_logs set outcome = 'failure' where target = 'game:2'`)), 'ok');
    // …so an attacker with owner rights disables the trigger first. The chain
    // still catches it.
    await db.exec(`alter table public.admin_audit_logs disable trigger trg_admin_audit_no_update;
      update public.admin_audit_logs set detail = '{"n": 99}' where target = 'game:3';
      alter table public.admin_audit_logs enable trigger trg_admin_audit_no_update;`);
    const tampered = await db.query(`select * from public.admin_audit_verify(100)`);
    const bad = (await db.query(`select id from public.admin_audit_logs where target = 'game:3'`)).rows[0].id;
    assert.equal(Number(tampered.rows[0].first_bad_id), Number(bad));
  });
});
