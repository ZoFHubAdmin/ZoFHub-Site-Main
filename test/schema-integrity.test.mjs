// The database as it exists AFTER the migrations are replayed, not as any one
// file describes it.
//
// WHY THIS FILE EXISTS
// Every defect it guards was invisible in review, because reviewing a migration
// means reading one file and each of these is a property of the SEQUENCE.
//
//   1. db/feedback.sql retires the leaderboard and states that it "removes two
//      SECURITY DEFINER functions". It drops submit_score(text, text, INTEGER).
//      The function db/community-scores-unique.sql creates is
//      submit_score(text, text, BIGINT). Postgres matches a DROP by name AND
//      argument types, so the drop hit nothing and a SECURITY DEFINER function
//      survived the teardown that claimed to have removed it — its body
//      inserting into a table the same file had just dropped.
//
//   2. prune_admin_state() was superseded by prune_admin_logs() and left in
//      place with no caller. The replacement floors its arguments so an operator
//      cannot erase the audit trail by passing 0; the predecessor has no floors
//      at all, so the safety was one function name away from being bypassed.
//
//   3. Two trigger functions did not pin search_path, which db/schema.sql sets
//      as the house standard and explains at length.
//
//   4. db/ALL-IN-ONE.sql — a documented `psql -f` restore path advertised as
//      "The ENTIRE ZoFHub database in one file" — was generated once and never
//      again. It had drifted to five of the twelve schema files: no admin
//      tables, no feedback table, none of the leaderboard teardown.
//
// The parsing here is deliberately small. It is not a Postgres parser; it knows
// the shapes this repository writes, and the assertions are written so that a
// parser that stops working reports zero objects and fails loudly rather than
// passing vacuously.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The canonical migration order, read from the tool that owns it. */
function migrationOrder() {
  const src = readFileSync(join(ROOT, 'tools', 'sync-supabase-migrations.mjs'), 'utf8');
  const start = src.indexOf('const ORDER');
  const end = src.indexOf('\n];', start);
  assert.ok(start !== -1 && end !== -1, 'could not find the ORDER array');
  return [...src.slice(start, end).matchAll(/\[\s*'\d{14}'\s*,\s*'[a-z0-9_]+'\s*,\s*'([^']+)'/g)]
    .map((m) => m[1]);
}

/**
 * Blank out comments and dollar-quoted bodies.
 *
 * Both are essential and for the same reason: every function body in this repo
 * is wrapped in $$…$$, and those bodies contain the words `create`, `delete`
 * and `drop`, plus semicolons. Scanning the raw text counts a function's
 * contents as top-level statements.
 */
function scrub(sql) {
  let out = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, ' $$BODY$$ ');
  return out;
}

/** Normalise a function argument list to its types: `p_score bigint` → bigint. */
const TYPE_WORDS = new Set(['text', 'integer', 'int', 'int4', 'int8', 'bigint', 'smallint',
  'boolean', 'bool', 'jsonb', 'json', 'uuid', 'numeric', 'timestamptz', 'timestamp',
  'character', 'varying', 'varchar', 'double', 'precision', 'real', 'date', 'interval']);
const ALIAS = { int: 'integer', int4: 'integer', int8: 'bigint', bool: 'boolean', varchar: 'character varying' };

function argTypes(list) {
  return (list || '').split(',').map((raw) => {
    let a = raw.trim().replace(/\s+default\s+[\s\S]*$/i, '').replace(/\(\s*\d+\s*\)/g, '');
    let words = a.split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    if (words.length > 1 && !TYPE_WORDS.has(words[0].toLowerCase())) words = words.slice(1);
    const t = words.join(' ').toLowerCase();
    return ALIAS[t] || t;
  }).filter(Boolean).join(', ');
}

/** Replay a list of SQL files and return the state a fresh database ends in. */
function replay(files) {
  const functions = new Map();          // signature -> { file, definer, searchPath }
  const tables = new Set();
  const everCreated = new Set();
  const emptyDrops = [];

  for (const rel of files) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) continue;
    const sql = scrub(readFileSync(path, 'utf8'));
    const raw = readFileSync(path, 'utf8');

    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)/gi)) {
      tables.add(m[1].toLowerCase());
    }
    for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?(\w+)/gi)) {
      tables.delete(m[1].toLowerCase());
    }
    for (const m of sql.matchAll(/drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?(\w+)\s*\(([^)]*)\)/gi)) {
      const sig = `${m[1].toLowerCase()}(${argTypes(m[2])})`;
      if (functions.has(sig)) functions.delete(sig);
      else if (!everCreated.has(sig)) emptyDrops.push({ sig, file: rel });
    }
    // The definition's tail (up to the body) carries `security definer` and
    // `set search_path`, so it is read from the UNSCRUBBED text.
    for (const m of raw.matchAll(
      /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\)\s*([\s\S]{0,400}?)\bas\s*\$/gi)) {
      const sig = `${m[1].toLowerCase()}(${argTypes(m[2])})`;
      functions.set(sig, {
        file: rel,
        definer: /security\s+definer/i.test(m[3]),
        searchPath: /set\s+search_path/i.test(m[3]),
      });
      everCreated.add(sig);
    }
  }
  return { functions, tables, emptyDrops, everCreated };
}

const ORDER = migrationOrder();
const DB = replay(ORDER);

describe('the schema the migrations actually produce', () => {
  test('the replay parsed something', () => {
    // Vacuity guard. Every assertion below is "X is absent"; a parser that
    // silently stopped working satisfies all of them.
    assert.ok(ORDER.length >= 11, `parsed ${ORDER.length} migrations`);
    assert.ok(DB.tables.size >= 10, `parsed ${DB.tables.size} tables`);
    assert.ok(DB.functions.size >= 5, `parsed ${DB.functions.size} functions`);
    assert.ok(DB.everCreated.has('submit_score(text, text, bigint)'),
      'the fixture this file is about was not found — the parser stopped working');
  });

  test('the restored leaderboard is coherent', () => {
    // The leaderboard was retired (db/feedback.sql) and is now restored
    // (db/scores-restore.sql). This test used to assert the teardown left
    // nothing behind; it now asserts the RESTORE leaves the right things behind,
    // which is the same guard pointed at the current intent.
    assert.ok(DB.tables.has('scores'),
      'scores is missing — db/scores-restore.sql must run AFTER db/feedback.sql');
    assert.ok([...DB.functions.keys()].some((s) => s.startsWith('prune_scores(')),
      'prune_scores is missing — the table has no sweep and would grow unbounded');

    for (const sig of DB.functions.keys()) {
      // submit_score stays dead on purpose. Scores are written by the Node
      // server, which is where the proof-of-play token, the ceiling and the
      // outlier quarantine live (lib/scores.mjs). A SECURITY DEFINER function
      // callable straight from the anon key would route around all three.
      assert.ok(!sig.startsWith('submit_score('),
        `${sig} survived — writes must go through the server, not a database function`);
    }
  });

  test('every DROP FUNCTION that misses is a drop of something that never existed', () => {
    // A drop that matches nothing is fine when nothing of that name is left —
    // it is belt and braces against an older hand-run spelling. It is a defect
    // when another overload SURVIVES, because then the author removed something
    // other than what they meant to and the object is still in the database.
    const alive = new Set([...DB.functions.keys()].map((s) => s.split('(')[0]));
    const dangerous = DB.emptyDrops.filter((d) => alive.has(d.sig.split('(')[0]));
    assert.deepEqual(dangerous.map((d) => `${d.file}: ${d.sig}`), []);
  });

  test('no SECURITY DEFINER function is left without a caller', () => {
    // Elevated-privilege code that nothing invokes can only ever run by accident.
    const callers = readFileSync(join(ROOT, 'lib', 'cron-jobs.mjs'), 'utf8')
      + readFileSync(join(ROOT, 'server.js'), 'utf8');
    const orphans = [];
    for (const [sig, fn] of DB.functions) {
      if (!fn.definer) continue;
      const name = sig.split('(')[0];
      if (!callers.includes(`'${name}'`)) orphans.push(`${sig} (${fn.file})`);
    }
    assert.deepEqual(orphans, []);
  });

  test('every function pins search_path', () => {
    // db/schema.sql: `security invoker` + `set search_path = ''` is what clears
    // Supabase's "Function Search Path Mutable" advisor. Two functions written
    // later did not follow it, so the schema passed the advisor in most places
    // rather than all of them.
    const unpinned = [...DB.functions].filter(([, fn]) => !fn.searchPath)
      .map(([sig, fn]) => `${sig} (${fn.file})`);
    assert.deepEqual(unpinned, []);
  });

  test('prune_admin_state is gone — prune_admin_logs replaced it', () => {
    // The replacement floors its arguments (`greatest(attempts_days, 7)`, and a
    // hard one-year floor on the audit trail) so a caller passing 0 cannot erase
    // the record. The predecessor has no floors. Keeping both means the floor is
    // one function name away from being bypassed.
    for (const sig of DB.functions.keys()) {
      assert.ok(!sig.startsWith('prune_admin_state('), `${sig} is still defined`);
    }
    assert.ok([...DB.functions.keys()].some((s) => s.startsWith('prune_admin_logs(')),
      'prune_admin_logs is missing — the cron calls it every night');
  });
});

describe('paginated reads are stable', () => {
  // REGRESSION, and this one was live.
  //
  // loadPlayStats() walked game_stats with `.range(from, from + 999)` and NO
  // `.order()` at all. A LIMIT/OFFSET with no ORDER BY has no defined row order
  // in Postgres — the planner may return rows in any sequence, and an UPDATE
  // that moves a row within the heap can push it into a page already read or
  // past one still to come. flushPlayStats() upserts that exact table every 60
  // seconds, so the window is not theoretical. The symptom would have been a few
  // games quietly ranking below what they had earned, with nothing logged.
  //
  // refreshCatalogFromSupabase() had the milder form: ordered, but paged by
  // OFFSET over `is_working = true` — a set the hourly link-check mutates while
  // the walk is in progress. A row leaving the set shifts the window and one
  // game vanishes from the catalog until the next refresh.
  //
  // Both are keyset now. This test holds the RUNTIME to that; the CLI tools in
  // tools/ are allowed ordered OFFSET, because nothing writes to the table while
  // an operator runs one by hand and the remedy is to run it again.
  const RUNTIME = ['server.js', 'lib/cron-jobs.mjs', 'lib/link-checker.mjs',
    'lib/supabase.mjs', 'lib/y8-ingest.mjs', 'lib/recommender.mjs'];

  test('no runtime query pages with .range()', () => {
    const offenders = [];
    for (const rel of RUNTIME) {
      const path = join(ROOT, rel);
      if (!existsSync(path)) continue;
      const src = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (line.includes('.range(')) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [],
      'OFFSET pagination in a request or cron path. Use keyset: order by a unique\n'
      + 'column and bound the next page with .gt()/.lt() on the last value seen.');
  });

  test('both keyset walks still carry their ordering and their cursor', () => {
    // The guard above only proves .range() is gone. If someone replaced it with
    // an unordered .limit() the walk would be just as broken and just as quiet,
    // so the two live walks are checked for the parts that make them correct.
    const src = readFileSync(join(ROOT, 'server.js'), 'utf8');

    const catalog = src.slice(src.indexOf('async function refreshCatalogFromSupabase'));
    const catalogBody = catalog.slice(0, catalog.indexOf('\n}\n'));
    assert.match(catalogBody, /\.order\('id'/, 'the catalog walk lost its ordering');
    assert.match(catalogBody, /\.lt\('id',\s*afterId\)/, 'the catalog walk lost its cursor');
    assert.match(catalogBody, /select\('id,/, 'the cursor column must be selected to be read back');

    const plays = src.slice(src.indexOf('async function loadPlayStats'));
    const playsBody = plays.slice(0, plays.indexOf('\n}\n'));
    assert.match(playsBody, /\.order\('slug'/, 'the play-count walk lost its ordering');
    assert.match(playsBody, /\.gt\('slug',\s*cursor\)/, 'the play-count walk lost its cursor');
  });

  test('every paged read anywhere orders by something', () => {
    // tools/ may use OFFSET, but never unordered: a page walk with no ORDER BY
    // can return one row twice and skip another even with nobody else writing,
    // and these tools decide what to rewrite from what they read.
    const offenders = [];
    for (const rel of ['tools/audit-catalog.mjs', 'tools/audit-licensing.mjs',
      'tools/audit-thumbnails.mjs', 'tools/catalog-quality.mjs', 'tools/export-games.mjs',
      'tools/fetch-y8-thumbs.mjs', 'tools/set-gamezop-partner.mjs',
      'tools/sync-onlinegames.mjs', 'tools/sweep-dead-games.mjs']) {
      const path = join(ROOT, rel);
      if (!existsSync(path)) continue;
      const src = readFileSync(path, 'utf8');
      // The .order() may sit a line or two above the .range() in a built query,
      // so the window is the surrounding statement rather than the same line.
      let at = src.indexOf('.range(');
      while (at !== -1) {
        const window = src.slice(Math.max(0, at - 500), at + 40);
        if (!window.includes('.order(')) {
          offenders.push(`${rel}:${src.slice(0, at).split('\n').length}`);
        }
        at = src.indexOf('.range(', at + 1);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

describe('the one-file bootstrap provisions the same database', () => {
  // db/ALL-IN-ONE.sql is a documented restore path. When it drifts, the failure
  // lands on whoever is restoring — which is to say, on the worst possible day.
  const AIO = join(ROOT, 'db', 'ALL-IN-ONE.sql');

  test('it exists and is generated from the same ORDER', () => {
    assert.ok(existsSync(AIO), 'db/ALL-IN-ONE.sql is missing');
    const marks = [...readFileSync(AIO, 'utf8').matchAll(/^-- >>> (.+\.sql)$/gm)].map((m) => m[1]);
    const schemaSections = marks.filter((n) => !n.startsWith('load-'));
    assert.deepEqual(schemaSections, ORDER.map((f) => f.replace(/^db\//, '')),
      'the schema half is not the ORDER array. Run: npm run build-all-in-one');
  });

  test('it creates every table and function the migrations do', () => {
    const boot = replay(['db/ALL-IN-ONE.sql']);
    assert.deepEqual([...DB.tables].sort().filter((t) => !boot.tables.has(t)), [],
      'tables the migrations create and the bootstrap does not');
    assert.deepEqual(
      [...DB.functions.keys()].sort().filter((s) => !boot.functions.has(s)), [],
      'functions the migrations create and the bootstrap does not');
    assert.deepEqual(
      [...boot.tables].sort().filter((t) => !DB.tables.has(t)), [],
      'tables the bootstrap leaves behind that the migrations drop');
  });
});

// ── Privileges ────────────────────────────────────────────────────────────
//
// CREATE TABLE grants nobody anything. Postgres gives the new table to its
// owner and to no one else, and for most of this schema's life that was
// invisible: the original Supabase project had been provisioned with ALTER
// DEFAULT PRIVILEGES, so tables created in the SQL editor arrived with
// anon / authenticated / service_role grants already attached and the schema
// never needed to issue one.
//
// Moving to a new project removed that inheritance. Twelve tables came up and
// every single read returned 42501 "permission denied for table games" — with
// Postgres itself supplying the hint, "GRANT SELECT ON public.games TO
// service_role". `npm run restore-games` failed all 34 batches, 0 rows written.
//
// Nothing caught it, because every check in this repo asked whether an object
// EXISTS. The tables did exist. They were simply unreadable, and existence and
// reachability had never been the same question.
describe('every table the migrations leave behind is reachable', () => {
  // NOT scrub(): db/grants.sql is one big DO $$…$$ block, and scrub() blanks
  // dollar-quoted bodies. Passing it through would leave an empty string, and
  // every assertion below is "X is absent" — the suite would go green while
  // reading nothing at all. Strip comments only, which is what actually matters
  // here: the file's header quotes `GRANT SELECT ON public.games TO
  // service_role;` verbatim from the Postgres error, and prose that reads like
  // a statement is exactly what a grant checker must not count.
  const grantsSql = readFileSync(join(ROOT, 'db', 'grants.sql'), 'utf8')
    .replace(/--[^\n]*/g, '');

  // A blanket `grant ... on all tables in schema public` covers everything at
  // once; anything else has to name each table.
  const BLANKET = /grant\s+all\s+privileges\s+on\s+all\s+tables\s+in\s+schema\s+public\s+to\s+service_role/i;

  test('the fixture parsed', () => {
    assert.ok(grantsSql.length > 200, 'db/grants.sql is empty or unreadable');
    assert.ok(DB.tables.size >= 10, `only ${DB.tables.size} tables survived the replay`);
  });

  test('service_role can reach every surviving table', () => {
    if (BLANKET.test(grantsSql)) return;                 // covered wholesale
    const unreachable = [...DB.tables].sort().filter(
      (t) => !new RegExp(`grant[^;]*\\bon\\b[^;]*\\b${t}\\b[^;]*to[^;]*service_role`, 'i').test(grantsSql),
    );
    assert.deepEqual(unreachable, [],
      'these tables exist but no role can read them — every query returns 42501:\n  '
      + unreachable.join('\n  '));
  });

  test('grants run last, so a later CREATE TABLE cannot slip through ungranted', () => {
    // The blanket grant is a snapshot of the moment it runs. It is only
    // sufficient because ALTER DEFAULT PRIVILEGES covers what comes after.
    assert.equal(ORDER[ORDER.length - 1], 'db/grants.sql',
      'db/grants.sql must be the final migration');
    assert.match(grantsSql, /alter\s+default\s+privileges\s+in\s+schema\s+public\s+grant[^;]*to\s+service_role/i,
      'without ALTER DEFAULT PRIVILEGES the next table added lands ungranted, '
      + 'and the failure appears at runtime rather than at deploy');
  });

  test('anon is granted only what a read policy already allows', () => {
    // The GRANT is the outer gate, RLS the inner one. Granting anon SELECT on
    // a table with no permissive policy is not immediately exploitable — RLS
    // still denies — but it leaves the two out of step, so the day a policy is
    // added or loosened the table is already exposed.
    const policySql = scrub(ORDER.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n'));
    const readable = new Set(
      [...policySql.matchAll(/create\s+policy\s+"[^"]*"\s+on\s+public\.(\w+)\s+for\s+select/gi)]
        .map((m) => m[1]),
    );
    // A view has no policies of its own. games_public is SECURITY INVOKER over
    // games, so it is governed by the policy on games.
    const VIEWS_OVER_POLICIED_TABLES = new Set(['games_public']);

    const listed = /public_read\s+constant\s+text\[\]\s*:=\s*array\[([^\]]*)\]/i.exec(grantsSql);
    assert.ok(listed, 'could not find the public_read list in db/grants.sql');
    const names = [...listed[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
    assert.ok(names.length >= 3, `parsed only ${names.length} public-read relations`);

    const overGranted = names.filter(
      (n) => !readable.has(n) && !VIEWS_OVER_POLICIED_TABLES.has(n),
    );
    assert.deepEqual(overGranted, [],
      'anon is granted SELECT on relations with no permissive read policy:\n  '
      + overGranted.join('\n  '));
  });

  test('the private tables are never granted to anon', () => {
    // The audit trail, the session store and the feedback inbox. feedback keeps
    // INSERT — that is the contact form — but must never become readable.
    for (const t of ['admin_sessions', 'admin_audit_logs', 'admin_login_attempts',
      'admin_security_events', 'feedback']) {
      if (!DB.tables.has(t)) continue;
      assert.match(grantsSql, new RegExp(`'${t}'`),
        `${t} is not named in db/grants.sql, so it is neither granted nor explicitly revoked`);
      const listed = /public_read\s+constant\s+text\[\]\s*:=\s*array\[([^\]]*)\]/i.exec(grantsSql);
      assert.ok(!new RegExp(`'${t}'`).test(listed[1]),
        `${t} appears in the public-read list`);
    }
  });
});
