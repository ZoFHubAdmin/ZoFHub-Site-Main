# Loading the game catalog into Supabase

How to take this repository from an empty database to a working catalog of
~16,900 games. It is the long-form companion to
[docs/database/RUN-IN-ORDER.md](RUN-IN-ORDER.md) (the exact SQL order) and
[docs/database/COMPLETE-SETUP-GUIDE.md](COMPLETE-SETUP-GUIDE.md) (the short version).

> **If you only want it working:** set your Supabase keys, paste
> `db/SCHEMA-ONLY.sql` into the SQL editor, run `npm run restore-games`, then
> `npm run db:verify`. The rest of this page is what those steps do and how to
> fix them when they don't.

---

## 1. The numbers, and why there are three of them

The catalog has **three different counts**, and confusing them is the single most
common source of "games are missing" reports. All three are measured, not
estimated — reproduce them with `npm run audit-served`:

| Layer | Count | What it means |
|---|---:|---|
| Catalogued | **16,916** | every row ever ingested |
| Visible to the public key (`games_public`) | **16,783** | the RLS policy is exactly `is_working = true` |
| **Actually served to visitors** | **12,289** | after provider exclusions and curation overrides |

The ~4,600-game gap is **deliberate**. Games are excluded because they do not
render, because they frame an entire website rather than a licensed embed URL, or
because a curation override removes them. The README's catalog section explains
each reason. A game missing from the site is far more likely to be excluded on
purpose than to have failed to load.

Of the 12,289 served, the split by embed strategy is:

| Strategy | Games | Why |
|---|---:|---|
| **direct** (SDK-sensitive) | 9,942 | GameMonetize / GameDistribution — these **black-screen if proxied** |
| **proxy** (`/embed`) | 2,347 | everything else, chiefly Y8 |

That split is not a preference; it is load-bearing. See
[IFRAME-OPTIMIZATION-GUIDE.md §3](../features/IFRAME-OPTIMIZATION-GUIDE.md).

---

## 2. Where the games come from

Sources overlap, and duplicates collapse by `slug` on load.

| Source | File | Rows | Platform |
|---|---|---:|---|
| API Games | `api/games.json` | 784 | OnlineGames.io, GameDistribution |
| GameMonetize | `master_games.json` | ~11,400 | GameMonetize |
| Y8.com | `y8-games.json` | ~2,415 | Y8.com |
| Famobi | `somethingrandom.json` | ~300 | Famobi |
| OnlineGames.io | `everygame.json` | ~300 | OnlineGames.io |
| Snapshot + misc | assorted `load-*.sql` | ~1,500 | mixed |

Every **served** game comes from a distributor that licenses third-party
embedding. No single-title hosts, no site roots.

---

## 3. Prerequisites

A Supabase project, and these in `.env`:

```bash
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_…        # Settings → API Keys → secret
```

> **Use `SUPABASE_SECRET_KEY`, not the legacy `SUPABASE_SERVICE_ROLE_KEY`.**
> The legacy `anon`/`service_role` pair is disabled on this project and answers
> `401 Legacy API keys are disabled`. The loader mirrors the secret key onto the
> old variable name, so older tools that read it by name keep working with it
> unset.

---

## 4. Step 1 — the schema (one paste)

**File: `db/SCHEMA-ONLY.sql`** → Supabase SQL Editor → Run.

That is **all 17 migrations concatenated in dependency order**, ~1,900 lines,
which the web editor handles fine. It is idempotent — re-running is safe.

> ### Do not assemble the schema from the individual `db/*.sql` files
>
> The order is load-bearing and **not alphabetical**, and leaving one out fails
> *silently*. Picking a subset typically omits `db/grants.sql`, which must run
> **last** because it assigns privileges over whatever tables exist at the end.
> Without it every table exists and every application query returns
> `42501 permission denied for table games`.
>
> The canonical order is the `ORDER` array in
> [`tools/sync-supabase-migrations.mjs`](../../tools/sync-supabase-migrations.mjs).
> Both `SCHEMA-ONLY.sql` and `supabase/migrations/` are generated from it, so
> they cannot disagree.

### The leaderboard is part of the schema

Earlier versions of this guide said the leaderboard had been retired. **That is
no longer true.** `db/feedback.sql` used to drop the `scores` table; that drop is
commented out, and `db/scores-restore.sql` re-creates it.

The subtlety worth keeping: Supabase tracks migrations **by filename**, so
un-commenting a drop inside an already-applied file changes nothing on a live
database. Only a *new forward migration* can bring a table back. That is why a
separate restore file exists rather than an edit to the original.

---

## 5. Step 2 — the games

### Option A — one command (recommended)

```bash
npm run restore-games
```

Loads every source into Supabase over PostgREST. No database connection string,
no copy-pasting. **This is how the live database was populated.**

### Option B — the SQL editor

Run every `db/load-*.sql` file (63 of them). Large sources are split into
numbered parts so each stays under Supabase's ~1,000-line editor **save** limit —
run the parts in numeric order.

| Loader | Parts | Roughly |
|---|:-:|---|
| `load-master_games-partNN.sql` | 19 | ~11,400 GameMonetize |
| `load-games-export-partNN.sql` | 20 | full catalog snapshot |
| `load-y8-games-partNN.sql` | 4 | ~2,415 Y8 |
| `load-everygame-partNN.sql` | 4 | OnlineGames.io |
| `load-somethingrandom-partNN.sql` | 3 | Famobi |
| `load-api-games-partNN.sql` | 2 | OnlineGames.io / GameDistribution |

**Every loader is an idempotent `ON CONFLICT` upsert**, so re-running one — or
running them slightly out of order — is safe and never duplicates.

---

## 6. Step 3 — verify (the part people skip)

```bash
npm run db:verify
```

This compares the running database against the migrations **and** confirms every
relation is actually **readable**.

> **Why a row count is not enough.** `select count(*)` in the Supabase SQL editor
> runs as the **table owner**, so it succeeds even when the application's role has
> no privileges at all. `db:verify` connects the way the app does. A database that
> counts 16,916 rows in the editor and serves zero games to visitors is exactly
> the failure this catches.

For raw numbers anyway:

```sql
select count(*) from public.games;         -- ~16,900
select count(*) from public.games_public;  -- ~16,780
```

---

## 7. Step 4 — restart and confirm

```bash
npm run restart
```

Watch for this line in the log — it is the real confirmation:

```
[zofhub] catalog refreshed from Supabase: 16920 games
  → catalog upgraded to live Supabase set
```

Until that appears the server is serving its **bundled fallback catalog** (~784
games), which is the correct behaviour when Supabase is unreachable, and is also
why "only a few hundred games show up" almost always means a key problem rather
than a data problem.

The catalog also refreshes on its own every 30 minutes.

---

## 8. Regenerating the SQL from JSON

When you have new game data:

```bash
node tools/generate-sql-from-json.mjs   # rewrite db/load-*.sql from the JSON sources
npm run restore-games                   # or paste the new files in the SQL editor
npm run restart
```

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `42501 permission denied for table games` | `grants.sql` never ran, or ran before a later migration | re-run `db/SCHEMA-ONLY.sql` (idempotent) |
| Only ~784 games show | Supabase unreachable → bundled fallback | check `SUPABASE_URL` / `SUPABASE_SECRET_KEY`; look for `catalog refreshed from Supabase` in the log |
| `401 Legacy API keys are disabled` | using the legacy `service_role` key | use `SUPABASE_SECRET_KEY` (§3) |
| Games loaded but not showing | `is_working = false`, or a curation override | check the row; check `data/catalog-overrides.json`; run `npm run audit-served` |
| A specific game shows a black screen | it is being proxied when it must load direct | see [IFRAME-OPTIMIZATION-GUIDE.md §3](../features/IFRAME-OPTIMIZATION-GUIDE.md) |
| SQL file will not save in the editor | past the ~1,000-line save limit | use the `-partNN.sql` files, or `npm run restore-games` |
| Server audit reports missing tables | a migration was never applied | see [docs/database/RUN-IN-ORDER.md](RUN-IN-ORDER.md); `npm run audit:repo` lists which |

---

## 10. Keeping it healthy on its own

You do not have to maintain the catalog by hand. Ten scheduled jobs do it —
hourly link-checking, weekly Y8 re-sync, gated growth, retention sweeps. See
[HOW-IT-WORKS.md §11](../guides/HOW-IT-WORKS.md).

Useful audits to run by hand:

```bash
npm run audit-served     # what is actually served, and why the rest is not
npm run verify-catalog   # per-row verification against the live database
npm run audit:repo       # repository-wide: schema, env, API, deps, assets
npm run quality          # catalog quality report
```

---

## 11. Adding or hiding one game

Don't run a whole reload for a single game — see
[docs/database/ADDING-A-GAME.md](ADDING-A-GAME.md).
