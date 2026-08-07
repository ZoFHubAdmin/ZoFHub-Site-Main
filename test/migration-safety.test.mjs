// The rules that make this project's deploy mechanism safe.
//
// READ THIS BEFORE ADDING A MIGRATION.
//
// The Supabase GitHub integration applies `supabase/migrations/` on merge to
// `main`. This project has NO migration ledger — `supabase_migrations.schema_migrations`
// does not exist, because the schema was originally applied by pasting SQL into
// the dashboard. The integration therefore has no record of what it has already
// run, and re-runs EVERY migration on EVERY merge.
//
// That works, and it is verified to work: a deploy on 2026-08-07 applied all 12
// in under a minute against 16,916 live rows and changed no data. But it works
// for exactly one reason — every migration is idempotent. The day one is not,
// every future deploy fails, or worse, half-applies.
//
// Nothing enforced that. This file does.
//
// The checks are deliberately about SHAPE, not about SQL semantics. A test that
// tried to decide idempotency in general would be wrong often enough to be
// switched off. These four rules are mechanical, and following them is
// sufficient for the statements this repository actually writes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Side-effect import: puts .env into process.env so the project_id check below
// has something to compare against. Without it that assertion silently skips —
// and it is the one that catches migrations being applied to the wrong project.
import '../lib/load-env.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

/** Blank comments and dollar-quoted bodies; both contain DDL keywords that are not DDL. */
function scrub(sql) {
  return String(sql)
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, ' $$BODY$$ ');
}

/** Top-level statements, whitespace-collapsed, lowercased, with their line numbers. */
function statements(sql) {
  const clean = scrub(sql);
  const out = [];
  let start = 0;
  for (const m of clean.matchAll(/;/g)) {
    const raw = clean.slice(start, m.index);
    if (raw.trim()) {
      out.push({
        text: raw.replace(/\s+/g, ' ').trim().toLowerCase(),
        line: clean.slice(0, start).split('\n').length,
      });
    }
    start = m.index + 1;
  }
  return out;
}

const FILES = existsSync(MIGRATIONS)
  ? readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  : [];

describe('every migration survives being re-run, because all of them are', () => {
  test('the migrations were found', () => {
    // Vacuity guard: every assertion below is "nothing matches", which an empty
    // list satisfies perfectly.
    assert.ok(FILES.length >= 11, `only ${FILES.length} migration(s) found — the loader broke`);
  });

  test('nothing creates an object without a guard', () => {
    // CREATE TABLE / INDEX must say IF NOT EXISTS; a second run would otherwise
    // raise `relation already exists` and abort the whole deploy.
    const offenders = [];
    for (const f of FILES) {
      for (const s of statements(readFileSync(join(MIGRATIONS, f), 'utf8'))) {
        // `.test(s.text)`, not `.test(s)` — the first version tested the object,
        // which stringifies to "[object Object]" and matches nothing, so the
        // check silently passed on everything. Caught only by deliberately
        // injecting an unguarded CREATE TABLE and noticing it stayed green.
        if (/^create\s+(table|(unique\s+)?index)\b/.test(s.text) && !/if\s+not\s+exists/.test(s.text)) {
          offenders.push(`${f}:${s.line}  ${s.text.slice(0, 72)}`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      'every migration re-runs on every merge — an unguarded CREATE fails the second time');
  });

  test('nothing drops an object without a guard', () => {
    const offenders = [];
    for (const f of FILES) {
      for (const s of statements(readFileSync(join(MIGRATIONS, f), 'utf8'))) {
        if (/^drop\s+/.test(s.text) && !/if\s+exists/.test(s.text)) {
          offenders.push(`${f}:${s.line}  ${s.text.slice(0, 72)}`);
        }
      }
    }
    assert.deepEqual(offenders, [], 'a DROP of something already gone aborts the deploy');
  });

  test('every CREATE POLICY and CREATE TRIGGER is preceded by a guarded DROP', () => {
    // Neither supports IF NOT EXISTS in Postgres 15, so the idiom is
    // `drop … if exists` immediately before. Without it the second run fails.
    const offenders = [];
    for (const f of FILES) {
      const body = scrub(readFileSync(join(MIGRATIONS, f), 'utf8')).toLowerCase();
      for (const kind of ['policy', 'trigger']) {
        const creates = [...body.matchAll(new RegExp(`create\\s+${kind}\\s+("[^"]+"|\\S+)`, 'g'))];
        const drops = new Set(
          [...body.matchAll(new RegExp(`drop\\s+${kind}\\s+if\\s+exists\\s+("[^"]+"|\\S+)`, 'g'))]
            .map((m) => m[1]));
        for (const c of creates) {
          if (!drops.has(c[1])) offenders.push(`${f}: create ${kind} ${c[1]} has no guarding drop`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('no migration can destroy data', () => {
    // A full replay runs against the POPULATED production database, every time.
    // TRUNCATE, DROP DATABASE/SCHEMA, or a DELETE with no WHERE would empty a
    // live table on the next merge, silently and irreversibly.
    const offenders = [];
    for (const f of FILES) {
      for (const s of statements(readFileSync(join(MIGRATIONS, f), 'utf8'))) {
        if (/^(truncate|drop\s+(database|schema))\b/.test(s.text)) {
          offenders.push(`${f}:${s.line}  ${s.text.slice(0, 72)}`);
        }
        if (/^delete\s+from\b/.test(s.text) && !/\swhere\s|\susing\s/.test(s.text)) {
          offenders.push(`${f}:${s.line}  unfiltered DELETE — ${s.text.slice(0, 60)}`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      'this runs against production data on every merge to main');
  });
});

describe('the integration can actually find and order these files', () => {
  // Each of these has the same failure mode: the integration applies nothing,
  // or applies things out of order, and reports success either way.
  test('filenames are <14-digit timestamp>_snake_case.sql', () => {
    const bad = FILES.filter((f) => !/^\d{14}_[a-z0-9_]+\.sql$/.test(f));
    assert.deepEqual(bad, [], 'Supabase orders lexicographically and requires this shape');
  });

  test('the order encodes the dependency chain, not the alphabet', () => {
    // scores_integrity adds the `status` column that scores_review and
    // scores_unique both filter on; feedback drops tables community creates;
    // schema_hardening corrects objects every earlier file may re-create.
    const idx = (name) => FILES.findIndex((f) => f.includes(name));
    assert.ok(idx('community') < idx('scores_integrity'), 'community must precede scores_integrity');
    assert.ok(idx('scores_integrity') < idx('scores_review'), 'status column must exist first');
    assert.ok(idx('scores_integrity') < idx('scores_unique'), 'status column must exist first');
    assert.equal(idx('feedback'), FILES.length - 2, 'feedback must run second-to-last');
    assert.equal(idx('schema_hardening'), FILES.length - 1,
      'schema_hardening must run LAST — it removes objects earlier files re-create on every replay');
  });

  test('config.toml points at the project the app actually uses', () => {
    // A project_id that does not match SUPABASE_URL means migrations land in a
    // different database than the one being served, with no error anywhere.
    const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
    const id = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
    assert.ok(id, 'config.toml has no project_id');
    assert.match(toml, /\[db\.migrations\][\s\S]*?enabled\s*=\s*true/,
      'db.migrations must be enabled or the integration applies nothing');

    const url = process.env.SUPABASE_URL;
    if (!url) return;              // no credentials in CI; the rest still ran
    const host = url.match(/https?:\/\/([^.]+)\./)?.[1];
    assert.equal(id, host,
      `config.toml project_id "${id}" is not the project SUPABASE_URL points at ("${host}")`);
  });
});
