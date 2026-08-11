# Loading ZoFHub's database into Supabase — run these IN ORDER

Each step: **Supabase → SQL Editor → New query → paste the whole file → Run.**

You'll see **"Success. No rows returned"** for the INSERTs — that's normal. The
last line of each loader runs a `count(*)`, so you also get a **number** — that
number is your real proof the data saved, and it should climb as you go.

> 💡 **Shortcut (no copy-pasting):** with your Supabase keys in `.env`, run
> `npm run restore-games` from the project root — it loads every game source in
> one command over PostgREST, so no database connection string is needed. This is
> how the live database (~16,800 games) was populated.

## 1. Structure first — one file, one paste

Paste **`SCHEMA-ONLY.sql`** and Run. That is the entire schema: all 13 migrations
concatenated in dependency order. It is idempotent, so re-running is safe.

| File | What it is |
|------|------------|
| `SCHEMA-ONLY.sql` | **Use this one.** Every schema migration, in order. ~1,550 lines, which the web editor handles fine. |
| `ALL-IN-ONE.sql` | The same schema **plus the whole catalog** (~6.5 MB). Far too big for the web editor — `psql` restores only. |

> ### Do not run the individual schema files by hand
>
> The order is load-bearing and is **not** alphabetical. `feedback.sql` drops
> tables that `community.sql` creates, and `grants.sql` must run last because it
> assigns privileges over whatever survives the drops.
>
> The canonical order is the `ORDER` array in
> [`tools/sync-supabase-migrations.mjs`](../tools/sync-supabase-migrations.mjs).
> Both `SCHEMA-ONLY.sql` and `supabase/migrations/` are generated from it, which
> is why they cannot disagree with each other — and why this page no longer
> restates the list.
>
> It used to. An earlier version named five files as "the structure"; the schema
> has thirteen. The eight it omitted included `grants.sql`, and a database built
> by following that list came up with every table answering
> `42501 permission denied for table games` — the tables existed, and nothing
> could read them.

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

You should land around **16,800 rows, ~16,760 of them working**.

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
- **`ALL-IN-ONE.sql`:** everything above bundled into one file — but at ~6.7 MB
  it is far too big for the Supabase web editor. It's for direct `psql` restores
  only (`psql "$SUPABASE_DB_URL" -f db/ALL-IN-ONE.sql`); in the web editor, use
  the individual files listed here instead.
