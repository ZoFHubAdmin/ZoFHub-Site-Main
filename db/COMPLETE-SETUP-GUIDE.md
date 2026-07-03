# Supabase setup — quick guide

This is the short version. For the exact run order see
[RUN-IN-ORDER.md](RUN-IN-ORDER.md); for the full walkthrough (all sources,
regenerating SQL, troubleshooting) see [../GAMES-SETUP.md](../GAMES-SETUP.md).

## Prerequisites
- A Supabase project.
- `.env` filled in with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## The two ways to load

**A) One command (recommended)** — from the project root:

```bash
npm run restore-games
```

Loads every game source into Supabase at once. This is how the live database
(~16,791 working games) was populated.

**B) Supabase SQL Editor (manual)** — paste + Run each file in this order:

1. `schema.sql` — the `games` table + `games_public` view *(required, once)*
2. `community.sql` — `scores` + `recommendations` *(required, once)*
3. `stats.sql` — `game_stats` for persistent play counts *(optional)*
4. `keepalive.sql` — heartbeat row for free-tier uptime *(optional)*
5. Every `load-*.sql` game loader — big ones are split into `-partNN.sql`;
   run the parts in numeric order. All are idempotent upserts, so re-running is safe.

## Verify

```sql
select count(*) from public.games;          -- total rows
select count(*) from public.games_public;   -- working games shown on the site  (~16,791)
```

## After loading
- Restart the server (`npm run restart`) or wait up to 30 min — the catalog
  auto-refreshes from Supabase.
- Games not showing? Confirm `is_working = true` and check the server logs for
  `catalog refreshed from Supabase`.

To add or hide an individual game later, see [ADDING-A-GAME.md](ADDING-A-GAME.md).
