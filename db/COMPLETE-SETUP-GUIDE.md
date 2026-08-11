# Supabase setup — quick guide

This is the short version. For the exact run order see
[RUN-IN-ORDER.md](RUN-IN-ORDER.md); for the full walkthrough (all sources,
regenerating SQL, troubleshooting) see [../GAMES-SETUP.md](../GAMES-SETUP.md).

## Prerequisites
- A Supabase project.
- `.env` filled in with `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (the `sb_secret_…`
  key from Settings → API Keys). The legacy `SUPABASE_SERVICE_ROLE_KEY` pair is
  disabled on this project — it returns `401 Legacy API keys are disabled` — and
  the loader mirrors the secret key onto that name for the older CLI tools.

## The two ways to load

**A) One command (recommended)** — from the project root:

```bash
npm run restore-games
```

Loads every game source into Supabase at once. This is how the live database
(~16,800 games) was populated.

**B) Supabase SQL Editor (manual)** — two pastes:

1. **`SCHEMA-ONLY.sql`** — the entire schema, all 13 migrations in dependency
   order, idempotent *(once; safe to re-run)*.
2. Every `load-*.sql` game loader — big ones are split into `-partNN.sql`;
   run the parts in numeric order. All are idempotent upserts, so re-running is safe.

Do **not** assemble the schema from the individual `db/*.sql` files. The order is
load-bearing and not alphabetical, and picking a subset silently omits
`grants.sql` — which leaves every table existing but unreadable. See
[RUN-IN-ORDER.md](RUN-IN-ORDER.md).

## Verify

```bash
npm run db:verify        # the real check — schema match AND reachability
```

Or in SQL:

```sql
select count(*) from public.games;          -- total rows                       (~16,800)
select count(*) from public.games_public;   -- working games shown on the site  (~16,760)
```

A row count run in the SQL editor executes as the table owner, so it succeeds
even when the application's role has no privileges at all. `db:verify` connects
the way the app does, which is why it catches that and a bare `count(*)` cannot.

## After loading
- Restart the server (`npm run restart`) or wait up to 30 min — the catalog
  auto-refreshes from Supabase.
- Games not showing? Confirm `is_working = true` and check the server logs for
  `catalog refreshed from Supabase`.

To add or hide an individual game later, see [ADDING-A-GAME.md](ADDING-A-GAME.md).
