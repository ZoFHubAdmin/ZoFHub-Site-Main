// tools/sync-supabase-migrations.mjs
// ---------------------------------------------------------------------------
// Regenerate supabase/migrations/ from the canonical SQL in db/.
//
//   npm run sync-migrations            # write
//   npm run sync-migrations -- --check # verify only; non-zero exit if stale
//
// WHY THIS EXISTS
// The Supabase GitHub integration applies everything in supabase/migrations/ to
// each preview branch, and to production on merge. That directory therefore has
// to mirror db/ exactly — but db/ is where the schema is actually authored and
// where every doc, comment and runbook points. Two hand-maintained copies of the
// same DDL drift silently, and the failure mode is ugly: a preview branch that
// provisions a schema production doesn't have, or vice versa.
//
// So db/ stays the single source of truth and this regenerates the mirror.
// --check makes the drift visible (wire it into CI if you ever add one).
//
// ORDER IS LOAD-BEARING. Supabase applies migrations in lexicographic filename
// order, so the timestamps below encode the dependency graph rather than any
// real authoring date. In particular scores_integrity MUST precede scores_review
// and scores_unique: it adds the `status` column both of them reference, and
// both files say exactly that in their own headers.
//
// DATA IS DELIBERATELY EXCLUDED. db/load-*.sql is ~14 MB of catalog INSERTs. A
// preview branch exists to prove a schema change is sound; it does not need
// 16,818 games to do that, and replaying that volume per branch would be slow
// for no benefit.
// ---------------------------------------------------------------------------
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'supabase', 'migrations');
const CHECK = process.argv.includes('--check');

const ORDER = [
  ['20260101000000', 'core_schema', 'db/schema.sql',
   'games table + games_public view — the catalog everything else reads.'],
  ['20260101000100', 'community', 'db/community.sql',
   'recommendations + scores tables, with RLS policies.'],
  ['20260101000200', 'scores_integrity', 'db/community-scores-integrity.sql',
   'Adds scores.status so outliers can be quarantined instead of shown. MUST run before the next two.'],
  ['20260101000300', 'scores_review', 'db/community-scores-review.sql',
   'Review lifecycle: unreviewed rows are never auto-deleted; only rejected ones are purged.'],
  ['20260101000400', 'scores_unique', 'db/community-scores-unique.sql',
   'Real UNIQUE index for one-row-per-player-per-game (was app-code only, so concurrent submits could duplicate).'],
  ['20260101000500', 'keepalive', 'db/keepalive.sql',
   'Table the /healthz probe pokes so a free-tier database never pauses.'],
  ['20260101000600', 'game_stats', 'db/stats.sql',
   'Per-game play counters.'],
  ['20260101000700', 'game_fingerprints', 'db/game-fingerprints.sql',
   'provider fingerprints + duplicate relations for the game discovery engine.'],
  ['20260101000800', 'admin', 'db/admin.sql',
   'admin console: sessions, append-only audit trail, login attempts, security events.'],
  ['20260101000900', 'scores_evidence', 'db/community-scores-evidence.sql',
   'scores.flag_evidence + ip_tag: why a score was quarantined, and the correlation handle review needs. Runs after scores_integrity, which creates status/flag_reason.'],
  ['20260101001000', 'feedback', 'db/feedback.sql',
   'Adds the private feedback table and the retention sweeps. It used to retire the leaderboard here; that drop is now commented out, and scores_restore below brings the table back on databases where it already ran.'],
  ['20260101001050', 'scores_restore', 'db/scores-restore.sql',
   'Re-creates public.scores after the retirement in feedback.sql. Supabase tracks migrations by filename, so un-commenting a drop in an already-applied file changes nothing on a live database — only a NEW forward migration can bring the table back. Must run before grants, which grants over whatever tables exist at the end.'],
  ['20260101001060', 'subscriber_emails', 'db/14_subscriber_emails.sql',
   'Mirror-update list: two columns, RLS deny-by-default, anon granted INSERT and nothing else. Runs BEFORE schema_hardening (which must stay the last file that creates objects) and before grants (the final privilege sweep).'],
  ['20260101001070', 'ai_feedback', 'db/15_ai_feedback.sql',
   'AI answer feedback: redacted before insert, consent recorded per row, RLS deny-by-default with anon INSERT only and training_eligible pinned false so a forged insert cannot self-promote into the training pool. Also creates prune_ai_feedback() and forget_ai_feedback(). Runs BEFORE schema_hardening and grants, for the same reason as 14.'],
  ['20260101001080', 'control_plane', 'db/control-plane.sql',
   'Admin control plane: staff accounts, a Draft→Published lifecycle for games (the public RLS policy and games_public view now require status = published), providers, categories and tags with foreign keys, typed site settings, the proxy approved-target model, a hash-chained audit trail, and atomic bulk-status / tag RPCs. Every new table is RLS deny-by-default and revoked from anon/authenticated inside this file, because on a live database it runs AFTER grants. Runs before schema_hardening and grants for the same reason as 14 and 15.'],
  ['20260101001100', 'schema_hardening', 'db/schema-hardening.sql',
   'Audit corrections: drops the submit_score overload the teardown missed and the superseded prune_admin_state, pins search_path on two trigger functions, and stops the orphan-counter sweep deleting counters for games that are served from JSON rather than the games table.'],
  ['20260101001200', 'grants', 'db/grants.sql',
   'Role privileges for service_role / anon / authenticated. MUST BE LAST: it grants over whatever tables exist at the end, so it has to run after feedback.sql drops the retired ones. Without it every table is 42501 "permission denied" on a project whose default privileges were not pre-provisioned.'],
];

function render(name, src, why, body) {
  return [
    '-- ' + '='.repeat(74),
    '-- ZoFHub migration: ' + name,
    '-- Source of truth: ' + src,
    '--',
    '-- ' + why,
    '--',
    '-- Applied by the Supabase GitHub integration to every preview branch and,',
    '-- on merge, to production. This file is a VERBATIM copy of ' + src + ' —',
    '-- edit that file and re-run `npm run sync-migrations`, so the two cannot',
    '-- drift.',
    '--',
    '-- Idempotent (IF NOT EXISTS / OR REPLACE / guarded DROPs), so applying it to',
    '-- a database that already has this schema is a no-op rather than an error.',
    '-- ' + '='.repeat(74),
    '',
    '',
  ].join('\n') + body;
}

mkdirSync(outDir, { recursive: true });

const expected = new Map();
let missing = 0;
for (const [ts, name, src, why] of ORDER) {
  const abs = join(root, src);
  if (!existsSync(abs)) { console.warn(`  ! missing source, skipped: ${src}`); missing++; continue; }
  expected.set(`${ts}_${name}.sql`, render(name, src, why, readFileSync(abs, 'utf8')));
}

if (CHECK) {
  const onDisk = new Set(existsSync(outDir) ? readdirSync(outDir).filter(f => f.endsWith('.sql')) : []);
  const problems = [];
  for (const [file, want] of expected) {
    if (!onDisk.has(file)) { problems.push(`missing: ${file}`); continue; }
    if (readFileSync(join(outDir, file), 'utf8') !== want) problems.push(`stale:   ${file}`);
    onDisk.delete(file);
  }
  for (const extra of onDisk) problems.push(`orphan:  ${extra}`);
  if (problems.length) {
    console.error('supabase/migrations is out of sync with db/:\n  ' + problems.join('\n  '));
    console.error('\nRun: npm run sync-migrations');
    process.exit(1);
  }
  console.log(`supabase/migrations is in sync (${expected.size} files).`);
  process.exit(0);
}

// Drop only files this tool owns, so a hand-written migration added later is
// never silently deleted.
for (const f of readdirSync(outDir).filter(f => f.endsWith('.sql'))) {
  if (!expected.has(f) && /^\d{14}_(core_schema|community|scores_integrity|scores_review|scores_unique|keepalive|game_stats)\.sql$/.test(f)) {
    rmSync(join(outDir, f));
  }
}
for (const [file, body] of expected) {
  writeFileSync(join(outDir, file), body);
  console.log(`  ${file}`);
}
console.log(`\n${expected.size} migration(s) written${missing ? `, ${missing} source(s) missing` : ''}.`);
