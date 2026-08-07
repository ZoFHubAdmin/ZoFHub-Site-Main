# `supabase/` — what the GitHub integration reads

This directory is the **contract** between this repository and the Supabase
project. The Supabase GitHub integration reads *only* this directory. Nothing
else in the repo affects your database.

```
supabase/
├── config.toml     project_id + Postgres major version
├── migrations/     applied IN FILENAME ORDER to production on merge to `main`
│   ├── 20260101000000_core_schema.sql
│   ├── 20260101000100_community.sql
│   ├── 20260101000200_scores_integrity.sql
│   ├── 20260101000300_scores_review.sql
│   ├── 20260101000400_scores_unique.sql
│   ├── 20260101000500_keepalive.sql
│   └── 20260101000600_game_stats.sql
└── seed.sql        preview branches ONLY — never runs on production
```

---

## Dashboard settings that make this work

Project → **Integrations → GitHub**:

| Field | Value | Why |
|---|---|---|
| GitHub repository | the repo you actually `git push` to | must be the SAME repo — see below |
| **Working directory** | `.` | the path to the folder *containing* `supabase/`. Since `supabase/` sits at the repo root, that is the root: `.` — **not** `supabase`, **not** `/`, **not** `./supabase` |
| Deploy to production | **on** | applies migrations when you merge to the production branch |
| Production branch name | `main` | matches this repo's default branch |
| Automatic branching | **off** | requires the Pro plan; leave off on Free |

> ⚠️ **The single most common failure:** the connected repository is not the one
> you push to. If Supabase watches repo A and you push to repo B, migrations
> never run and there is **no error message anywhere** — the dashboard simply
> shows nothing happening. Verify the owner/name string character by character.

> ⚠️ **Working directory `.` vs `supabase`** — the field wants the directory that
> *contains* `supabase/`. Entering `supabase` makes the integration look for
> `supabase/supabase/migrations/`, find nothing, and apply nothing. Silently.

---

## The one rule for changing the schema

**Author SQL in `db/`. Never hand-edit `supabase/migrations/`.**

`supabase/migrations/` is a **generated mirror** of `db/`. Regenerate it with:

```bash
npm run sync-migrations           # write the mirror
npm run sync-migrations -- --check # verify only; non-zero exit if stale
```

CI runs `--check` on every push and pull request (`.github/workflows/ci.yml`,
job `migrations-in-sync`). A stale mirror **fails the build**, because the
failure mode is otherwise invisible: Supabase would apply the *old* schema to
production while `db/` shows the new one, and nothing would report an error.

### Adding a migration

1. Write the SQL in `db/your-change.sql`.
2. Register it in the `ORDER` array in `tools/sync-supabase-migrations.mjs`,
   with a timestamp **later** than every existing entry.
3. Run `npm run sync-migrations`.
4. Commit **both** `db/` and `supabase/migrations/`.
5. Merge to `main` → Supabase applies it.

### Filename format is load-bearing

Supabase applies migrations in **lexicographic filename order**, so the
timestamps encode the dependency graph rather than any real authoring date.
Names must match `YYYYMMDDHHMMSS_snake_case.sql` (14 digits). CI enforces this.

Order matters concretely here: `scores_integrity` adds the `scores.status`
column that `scores_review` and `scores_unique` both reference. Reorder them and
production breaks.

---

## Safe to re-run (verified)

The integration has no migration ledger for this project — the schema was
originally applied by pasting SQL into the dashboard editor, so
`supabase_migrations.schema_migrations` does not exist. On first connection the
integration therefore treats **all 12 migrations as unapplied and runs them, on
every merge.**

That is safe. Every migration is idempotent (`IF NOT EXISTS` / `OR REPLACE` /
guarded `DROP`), and re-running them against the populated production database
was analysed statement by statement:

- The `games` table (16,913 rows) is **never** dropped, truncated, or deleted
  from. Only `ADD COLUMN IF NOT EXISTS` and index creation touch it. (An early
  version of `schema.sql` *did* `drop table games` and wiped the catalog — that
  is fixed, and the file carries a comment saying so.)
- The `DELETE`s in the scores migrations are a de-duplication pass that keeps
  each player's best row. It must run before the `UNIQUE` index can be created.
  Against the current data it removes **0 rows**.
- `seed.sql` inserts 2 rows with `ON CONFLICT DO NOTHING`, and runs on preview
  branches only — never production.

## Free plan

Branching is a Pro feature. On Free you get the part that matters: **merge to
`main` → migrations apply to production.** Preview branches per PR stay off, and
`Branch limit: 0` is expected and correct.

## How to know a deploy actually landed

```bash
npm run db:verify          # compare the RUNNING database against these migrations
```

It reads the live schema through PostgREST with the secret key and reports:

- objects the migrations create that the database **does not have** → the deploy
  did not land (or the integration is pointed somewhere else)
- objects the database has that **no migration creates** → drift, added outside
  this repository
- columns that differ in either direction
- whether the **publishable key can read** `feedback` or any `admin_*` table —
  the one property that is only ever true or false of a running database, never
  of a file

Exit 0 means the deployed schema is the schema in this repository. It runs in CI
too (`migrations-in-sync`), and skips cleanly when no credentials are present, so
forks are never failed for keys they cannot have.

**Why this is not optional.** Every way this integration fails is silent. Connect
it to the wrong repository, set the working directory to `supabase` instead of
`.`, or leave `db.migrations.enabled` off, and it finds nothing, applies nothing,
and reports success. The files look right, the tests pass, and production quietly
keeps an older schema. Asking the database is the only check that can tell.

## The rules a new migration must follow

`test/migration-safety.test.mjs` enforces these, because the deploy model depends
on them and nothing else was checking:

1. **Idempotent.** `CREATE TABLE`/`INDEX` need `IF NOT EXISTS`; every `DROP` needs
   `IF EXISTS`; `CREATE POLICY` and `CREATE TRIGGER` (which have no `IF NOT
   EXISTS` in PG15) need a guarded `DROP` immediately before.
2. **Never destructive.** No `TRUNCATE`, no `DROP DATABASE`/`SCHEMA`, no `DELETE`
   without a `WHERE`. A full replay runs against populated production **on every
   merge**.
3. **Correctly named.** `<14-digit timestamp>_snake_case.sql`, or it is skipped
   or applied out of order.
4. **Registered.** Add the source to `ORDER` in
   `tools/sync-supabase-migrations.mjs` and run `npm run sync-migrations`. A file
   in `db/` that is not in `ORDER` is never applied anywhere.

Corrections go in a **new** file that sorts last, never as an edit to an existing
one — see the note below on why that discipline holds even without a ledger.

## What "no ledger" means in practice

Because every migration re-runs on every merge, the END STATE is what matters,
not any single file. Two consequences are worth knowing before reading the
migrations:

- `db/community.sql` re-creates the `scores` table on every deploy, and
  `db/feedback.sql` drops it again later in the same run. Both are correct; the
  table exists for a few hundred milliseconds per deploy and never survives one.
- A function is only really gone once **every** file that creates it stops doing
  so, or a later file drops the exact signature. `submit_score` was created as
  `(text, text, bigint)` and the teardown dropped `(text, text, integer)` — so it
  came back on every deploy and was still live in production on 2026-08-07,
  confirmed against the running database. `db/schema-hardening.sql` drops the
  real signature and runs last.

### Why corrections still go in a NEW file

With no ledger, editing an earlier migration *does* take effect, since everything
re-runs. That makes "just fix the old file" look tempting, and it is a trap: the
moment a ledger appears — anyone running `supabase db push` once, or Supabase
changing the integration — already-recorded migrations stop being re-applied, and
every edit made to them silently stops being real. The database would then hold a
schema no file describes.

Appending a new file that sorts last is correct under **both** models, which is
why it is the rule regardless of which one is in force today.

### Live objects this repository does not create

Verified against production on 2026-08-07 by reading PostgREST's OpenAPI
document with the secret key:

| Object | Status |
|---|---|
| `rls_auto_enable()` | **exists in production, in no file here.** Created outside the repo, most likely by pasting into the dashboard SQL editor. No migration creates or drops it, so deploys leave it untouched. |

**It returns `event_trigger`**, which settles what it is: not something anything
calls, but a DDL event trigger that fires when tables are created and switches
RLS on for them. That is a genuine safety net — it is very likely the reason
every table in this database has RLS enabled, including ones added by hand — and
it is the one piece of the security posture that **would not survive a rebuild
from this repository**.

So the recommendation is **adopt it, not drop it.** Dump the real definition
rather than writing a new one from the name, because the event trigger that
invokes it has to come across too:

```sql
select pg_get_functiondef(p.oid) as function_def,
       pg_get_triggerdef(t.oid)  as event_trigger_def
from pg_proc p
left join pg_event_trigger t on t.evtfoid = p.oid
where p.proname = 'rls_auto_enable';
```

Put the output in `db/rls-auto-enable.sql`, add it to the `ORDER` array in
`tools/sync-supabase-migrations.mjs`, and run `npm run sync-migrations`.
`npm run db:verify` will stop reporting it at that point — which is how you know
it is done.

Until then it is flagged on every run, deliberately. An object nobody can
account for is the one nobody dares remove later.

## Data is not here, by design

The catalog (~16,800 games, ~14 MB of `INSERT`s) lives in `db/load-*.sql` and is
deliberately **not** wired into migrations. Schema changes should be provable
without replaying the entire catalog. Load data separately with
`npm run restore-games`.
