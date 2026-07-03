# Loading ZoFHub's database into Supabase — run these IN ORDER

Each step: **Supabase → SQL Editor → New query → paste the whole file → Run.**

You'll see **"Success. No rows returned"** for the INSERTs — that's normal. The
last line of each loader runs a `count(*)`, so you also get a **number** — that
number is your real proof the data saved, and it should climb as you go.

> 💡 **Shortcut (no copy-pasting):** with your Supabase keys in `.env`, run
> `npm run restore-games` from the project root — it loads every game source in
> one command. This is how the live database (~16,791 games) was populated.

## 1. Structure first (run each once)

| Order | File | What it creates |
|------:|------|-----------------|
| 1 | `schema.sql` | The `games` table + `games_public` view (**required**) |
| 2 | `community.sql` | `scores` + `recommendations` — leaderboard & community (**required**) |
| 3 | `stats.sql` | `game_stats` — makes play counts persist (optional) |
| 4 | `keepalive.sql` | `keepalive` — heartbeat row for free-tier uptime (optional) |

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

You should land around **16,791 working games**.

---

### Notes

- **Why parts?** Supabase's SQL editor won't *save* a snippet past ~1000 lines.
  Keeping each file small means every one saves and runs cleanly.
- **Legacy files:** the older `y8-games-01.sql … y8-games-05.sql` are a small,
  superseded subset now covered by `load-y8-games-partNN.sql`. You can ignore
  them — the `load-*.sql` set is the current, complete catalog.
