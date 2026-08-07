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

### Live objects this repository does not create

Verified against production on 2026-08-07 by reading PostgREST's OpenAPI
document with the secret key:

| Object | Status |
|---|---|
| `rls_auto_enable()` | **exists in production, in no file here.** Created outside the repo, most likely by pasting into the dashboard SQL editor. No migration creates or drops it, so deploys leave it untouched. It is not reachable by the publishable key. |

That is the only drift. To see what it does, run this in the SQL editor:

```sql
select prosecdef as security_definer, pg_get_functiondef(oid)
from pg_proc where proname = 'rls_auto_enable';
```

If it is worth keeping, add it to `db/` and to the `ORDER` array in
`tools/sync-supabase-migrations.mjs` so it stops being invisible. If it is not,
drop it. An object nobody can account for is the one nobody dares remove later.

## Data is not here, by design

The catalog (~16,800 games, ~14 MB of `INSERT`s) lives in `db/load-*.sql` and is
deliberately **not** wired into migrations. Schema changes should be provable
without replaying the entire catalog. Load data separately with
`npm run restore-games`.
