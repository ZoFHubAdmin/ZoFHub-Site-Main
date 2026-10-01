# Loading ZoFHub's database into Supabase — run these IN ORDER

Each step: **Supabase → SQL Editor → New query → paste the whole file → Run.**

You'll see **"Success. No rows returned"** for the INSERTs — that's normal. The
last line of each loader runs a `count(*)`, so you also get a **number** — that
number is your real proof the data saved, and it should climb as you go.

> 💡 **Shortcut (no copy-pasting):** with your Supabase keys in `.env`, run
> `npm run restore-games` from the project root — it loads every game source in
> one command over PostgREST, so no database connection string is needed. This is
> how the live database (~16,900 games) was populated.

## 1. Structure first — one file, one paste

Paste **`SCHEMA-ONLY.sql`** and Run. That is the entire schema: all **16**
migrations concatenated in dependency order. It is idempotent, so re-running is
safe.

| File | What it is |
|------|------------|
| `SCHEMA-ONLY.sql` | **Use this one.** Every schema migration, in order. ~1,900 lines, which the web editor handles fine. |
| `ALL-IN-ONE.sql` | The same schema **plus the whole catalog** (~6.5 MB). Far too big for the web editor — `psql` restores only. |

### The 17 migrations, in order

Names and purposes come from the `ORDER` array; this table is a reading aid, not
a second source of truth.

| # | Migration | What it adds |
|--:|---|---|
| 1 | `core_schema` | `games` + the `games_public` view |
| 2 | `community` | `recommendations` + `scores`, with RLS |
| 3 | `scores_integrity` | `scores.status` so outliers are quarantined, not shown |
| 4 | `scores_review` | review lifecycle — unreviewed rows kept for review. **Superseded by 12**, see below |
| 5 | `scores_unique` | real UNIQUE index for one row per player per game |
| 6 | `keepalive` | the heartbeat table `/healthz` pokes |
| 7 | `game_stats` | per-game play counters |
| 8 | `game_fingerprints` | provider fingerprints + duplicate relations |
| 9 | `admin` | admin sessions, append-only audit trail, login attempts, security events |
| 10 | `scores_evidence` | why a score was quarantined, and the correlation handle review needs |
| 11 | `feedback` | the private `feedback` table + retention sweeps |
| 12 | `scores_restore` | **re-creates `public.scores`** after the retirement in 11 |
| 13 | `subscriber_emails` | mirror-update list: two columns, anon INSERT only |
| 14 | `ai_feedback` | AI answer feedback + `prune_ai_feedback()` / `forget_ai_feedback()` |
| 15 | `control_plane` | the admin control plane: staff accounts, the game lifecycle (**the public read path now requires `status = 'published'`**), providers, categories/tags, typed settings, proxy destinations and policy, a hash-chained audit trail. See [CONTROL-PLANE.md](../admin/CONTROL-PLANE.md) |
| 16 | `schema_hardening` | audit corrections; **must stay the last file that creates objects** |
| 17 | `grants` | role privileges. **MUST BE LAST** |

> **Why `scores_restore` is a separate file.** Migration 11 used to drop the
> leaderboard. That drop is now commented out — but Supabase tracks migrations
> **by filename**, so un-commenting a drop inside an already-applied file changes
> nothing on a live database. Only a *new forward migration* can bring the table
> back. Editing history is not a migration.

> **`prune_scores()` is defined four times** (migrations 2, 3, 4 and 12), and
> each `CREATE OR REPLACE` supersedes the last, so **only migration 12's version
> runs.** It purges quarantined (`flagged`) scores older than 7 days and keeps
> the top 200 visible scores per game. Migration 4's promise that unreviewed
> rows are never auto-deleted no longer holds. See
> [LEADERBOARD.md](../features/LEADERBOARD.md#5-retention).

> ### Do not run the individual schema files by hand
>
> The order is load-bearing and is **not** alphabetical. `feedback.sql` drops
> tables that `community.sql` creates, and `grants.sql` must run last because it
> assigns privileges over whatever survives the drops.
>
> The canonical order is the `ORDER` array in
> [`tools/sync-supabase-migrations.mjs`](../../tools/sync-supabase-migrations.mjs).
> Both `SCHEMA-ONLY.sql` and `supabase/migrations/` are generated from it, which
> is why they cannot disagree with each other — and why this page no longer
> restates the list.
>
> It used to. An earlier version named five files as "the structure"; the schema
> has sixteen. The ones it omitted included `grants.sql`, and a database built
> by following that list came up with every table answering
> `42501 permission denied for table games` — the tables existed, and nothing
> could read them.

## 1b. If the audit reports missing tables

`npm run audit:repo` compares the running database against these migrations. If
it reports errors naming `scores`, `subscriber_emails`, `ai_feedback` or any
control-plane table (`admin_users`, `game_providers`, `proxy_targets`, …), those
forward migrations have **not been applied to the live project yet**.

They apply automatically when merged to `main` through the Supabase GitHub
integration (see [`docs/database/SUPABASE-MIGRATIONS.md`](SUPABASE-MIGRATIONS.md)), or by hand:

| File | Creates |
|---|---|
| `db/scores-restore.sql` | `scores`, `prune_scores()` |
| `db/14_subscriber_emails.sql` | `subscriber_emails` |
| `db/15_ai_feedback.sql` | `ai_feedback`, `prune_ai_feedback()`, `forget_ai_feedback()` |
| `db/control-plane.sql` | `admin_users`, `game_providers`, `game_categories`, `game_tags`, `game_tag_links`, `site_settings`, `proxy_providers`, `proxy_targets`, `proxy_policies`; the `status`/`provider_id` columns on `games`; `cms_bulk_transition()`, `cms_set_game_tags()`, `cms_status_counts()`, `admin_audit_verify()` |

Re-running `SCHEMA-ONLY.sql` also covers them, since it includes all seventeen and
is idempotent. Afterwards, re-run `npm run db:verify`.

> **Check they are committed first.** The integration reads only what is on
> `main`. If `git status` lists these files as untracked (`??`), they have never
> been committed, so the integration has never seen them — that alone explains
> "pending". Commit and push both the `db/` source and its generated
> `supabase/migrations/` mirror, and they apply on merge.


## 2. Then the games — run every `load-*.sql`

Paste each `db/load-*.sql` file and Run. The big sources are split into numbered
parts (`load-<source>-partNN.sql`) so every file stays under Supabase's editor
save limit (~1000 lines) — **run the parts in numeric order** (part01, part02, …).

The largest loaders:

| Loader | Parts | Roughly |
|--------|:-----:|---------|
| `load-master_games-partNN.sql` | 19 | ~11,400 GameMonetize games |
| `load-games-export-partNN.sql` | 20 | a full catalog snapshot |
| `load-y8-games-partNN.sql` | 4 | ~2,415 Y8 games |
| `load-everygame-partNN.sql` | 4 | OnlineGames.io |
| `load-somethingrandom-partNN.sql` | 3 | Famobi |
| `load-api-games-partNN.sql` | 2 | OnlineGames.io / GameDistribution |

Plus the single-file loaders (`load-ai-games.sql`, thumbnail/override/audit
helpers, etc.). **Every loader is an idempotent `ON CONFLICT` upsert**, so
re-running one — or running them slightly out of order — is completely safe and
never creates duplicates.

## 3. Verify anytime

Run `db/y8-games-check.sql`, or just:

```sql
select count(*) from public.games;            -- total rows
select count(*) from public.games_public;     -- working games shown on the site
```

You should land around **16,900 rows, ~16,780 of them working**.

Better than either, from the project root:

```bash
npm run db:verify        # compares the RUNNING database against these migrations
```

`select count(*)` only proves rows exist. `db:verify` additionally proves the
schema matches the repository and that the tables are **reachable** — a table
whose privileges were never granted counts fine in the SQL editor (which runs as
the owner) and returns `42501` to the application.

---

### Notes

- **Why parts?** Supabase's SQL editor won't *save* a snippet past ~1000 lines.
  Keeping each file small means every one saves and runs cleanly.
- **Legacy files:** the older `y8-games-01.sql … y8-games-05.sql` are a small,
  superseded subset now covered by `load-y8-games-partNN.sql`. You can ignore
  them — the `load-*.sql` set is the current, complete catalog.
- **`ALL-IN-ONE.sql`:** everything above bundled into one file — but at ~6.5 MB
  it is far too big for the Supabase web editor. It's for direct `psql` restores
  only (`psql "$SUPABASE_DB_URL" -f db/ALL-IN-ONE.sql`); in the web editor, use
  the individual files listed here instead.
