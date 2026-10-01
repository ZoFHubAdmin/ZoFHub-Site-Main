# `supabase/` — what the GitHub integration reads

The [`supabase/`](../../supabase/) directory is the **contract** between this repository and the Supabase
project. The Supabase GitHub integration reads *only* that directory. Nothing
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
│   ├── 20260101000600_game_stats.sql
│   ├── 20260101000700_game_fingerprints.sql
│   ├── 20260101000800_admin.sql
│   ├── 20260101000900_scores_evidence.sql
│   ├── 20260101001000_feedback.sql
│   ├── 20260101001050_scores_restore.sql
│   ├── 20260101001060_subscriber_emails.sql
│   ├── 20260101001070_ai_feedback.sql
│   ├── 20260101001100_schema_hardening.sql
│   └── 20260101001200_grants.sql          ← MUST be last
└── seed.sql        preview branches ONLY — never runs on production
```

**17 migrations.** The filenames encode the order, and two positions are
load-bearing: `schema_hardening` must stay the last file that *creates* objects,
and `grants` must be last of all because it assigns privileges over whatever
exists at the end. Purposes for each are in
[`docs/database/RUN-IN-ORDER.md`](RUN-IN-ORDER.md#the-17-migrations-in-order).

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
integration therefore treats **all 17 migrations as unapplied and runs them, on
every merge.**

That is safe. Every migration is idempotent (`IF NOT EXISTS` / `OR REPLACE` /
guarded `DROP`), and re-running them against the populated production database
was analysed statement by statement:

- The `games` table (~16,900 rows) is **never** dropped, truncated, or deleted
  from. Only `ADD COLUMN IF NOT EXISTS` and index creation touch it. (An early
  version of `schema.sql` *did* `drop table games` and wiped the catalog — that
  is fixed, and the file carries a comment saying so.)
- The `DELETE`s in the scores migrations are a de-duplication pass that keeps
  each player's best row. It must run before the `UNIQUE` index can be created.
  Against the current data it removes **0 rows**.
- `seed.sql` inserts 2 rows with `ON CONFLICT DO NOTHING`, and runs on preview
  branches only — never production.
- **The four later migrations were checked for the same property on 2026-09-25**
  (`scores_restore`, `subscriber_emails`, `ai_feedback`, `schema_hardening`):
  every `CREATE POLICY` is preceded by `DROP POLICY IF EXISTS` (Postgres has no
  `CREATE POLICY IF NOT EXISTS`, so without the guard a re-run errors), and every
  `DELETE` sits inside a `CREATE OR REPLACE FUNCTION` body — it defines a prune
  routine, it does not run during the migration.

The standing proof is CI, not this list: the `migrations-apply` job applies all
sixteen to a real Postgres 15 **twice** and fails if the second pass errors.

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
- whether every relation is actually **readable with the secret key** — see the
  grants note below; a table can deploy perfectly and still answer `42501` to
  the application
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
5. **Ordered before `db/grants.sql`.** That file must stay the final entry: it
   assigns privileges over whatever relations exist once every drop has run. Give
   a new migration a timestamp between `schema_hardening` and `grants` —
   `20260101001150`, say. `test/schema-integrity.test.mjs` fails if `grants.sql`
   stops being last.

   A table created *after* it would still pick up privileges from the
   `ALTER DEFAULT PRIVILEGES` that `grants.sql` sets, so getting this wrong is
   not immediately fatal. But that is the same inherited-privilege mechanism
   whose absence caused the outage described below, and it is meant as a safety
   net, not the mechanism. Ordering ahead of `grants.sql` earns an explicit
   `GRANT`, which is the part that is actually guaranteed.

Corrections go in a **new** file, never as an edit to an existing one — see the
note below on why that discipline holds even without a ledger.

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
  real signature, and sorts after every file that creates it.

  The same trap caught `prune_admin_state(integer, integer, integer)`, the
  unfloored predecessor of `prune_admin_logs` — `prune_admin_state(0, 0, 0)`
  erases every login attempt and security event, where the replacement floors its
  arguments. It was found live on 2026-08-07 by `db:verify`, and cleared by
  replaying the schema. Neither was findable by reading the files.

### Why corrections still go in a NEW file

With no ledger, editing an earlier migration *does* take effect, since everything
re-runs. That makes "just fix the old file" look tempting, and it is a trap: the
moment a ledger appears — anyone running `supabase db push` once, or Supabase
changing the integration — already-recorded migrations stop being re-applied, and
every edit made to them silently stops being real. The database would then hold a
schema no file describes.

Appending a new file that sorts last is correct under **both** models, which is
why it is the rule regardless of which one is in force today.

### Privileges are part of the schema

`CREATE TABLE` grants nobody anything. Postgres hands a new table to its owner
and to no one else; every other role needs an explicit `GRANT`. Supabase normally
hides that by provisioning `ALTER DEFAULT PRIVILEGES` at project creation, so
tables made in the SQL editor arrive with `anon` / `authenticated` /
`service_role` grants already attached — and this schema was written against such
a project, so across twelve migrations it issued exactly one `GRANT`, and none
for `service_role`.

Moving to a new project removed the inheritance, and every table came up
existing-but-unreachable:

```
GET /rest/v1/games -> 403
{"code":"42501","message":"permission denied for table games",
 "hint":"Grant the required privileges to the current role with:
         GRANT SELECT ON public.games TO service_role;"}
```

`npm run restore-games` failed all 34 batches with 0 rows written — and
`db:verify` reported the schema **clean**, because it enumerated relations from
PostgREST's OpenAPI document, which describes the schema and not who may read it.
It now probes each relation with the secret key and reports
`live.relations_readable`; a mismatch is an error naming the table.

`db/grants.sql` states the privileges outright, so the schema no longer depends
on how a given project happened to be provisioned.

### Live objects this repository does not create

Verified against production on 2026-08-07 by reading PostgREST's OpenAPI
document with the secret key:

| Object | Status |
|---|---|
| `rls_auto_enable()` | **Supabase platform default — leave it alone.** Not drift, and nothing to adopt. |

It returns `event_trigger`: a DDL trigger that switches RLS on for newly created
tables. The reason we know it is Supabase's and not ours is direct evidence — a
**brand-new, completely empty project**, created on 2026-08-07 with zero tables
and zero migrations applied, already had it and nothing else. Supabase ships it.

So do **not** copy it into `db/`. Recreating a platform object in your own
migrations means owning something the platform also owns, and the two definitions
drift the first time Supabase changes theirs.

`npm run db:verify` reports it at **info**, not warn, for exactly this reason: it
is worth knowing the trigger is there — it is part of why every table here has
RLS on — without being something anyone needs to act on.

## Data is not here, by design

The catalog (~16,900 games, ~14 MB of `INSERT`s) lives in `db/load-*.sql` and is
deliberately **not** wired into migrations. Schema changes should be provable
without replaying the entire catalog. Load data separately with
`npm run restore-games`.
