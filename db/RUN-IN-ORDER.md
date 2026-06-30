# Loading the games into Supabase — run these IN THIS ORDER

Each step: **Supabase → SQL Editor → New query → paste the whole file → Run.**

You will see **"Success. No rows returned"** for the INSERTs — that is normal.
The last line of each part runs a `count(*)` so you also see a **number**: that
number is your real proof the data is saved. It should climb with each part.

| Order | File | What it does |
|------:|------|--------------|
| 1 | `schema.sql` | Creates the `games` table + view (run once) |
| 2 | `community.sql` | Creates `scores` + `recommendations` (run once) |
| 3 | `y8-games-01.sql` | Loads games part 1 of 5 |
| 4 | `y8-games-02.sql` | Loads games part 2 of 5 |
| 5 | `y8-games-03.sql` | Loads games part 3 of 5 |
| 6 | `y8-games-04.sql` | Loads games part 4 of 5 |
| 7 | `y8-games-05.sql` | Loads games part 5 of 5 |
| 8 | `stats.sql` | (Optional) makes play counts persist across restarts |
| 9 | `y8-games-check.sql` | (Optional) verify the totals anytime |

## Why it was "not saving" before
The old single 500KB file was too big for one editor tab: the snippet text
couldn't be saved (so it looked gone), and the transaction wrapper could roll
the whole thing back if the giant paste hiccuped. These smaller files paste
cleanly and every INSERT auto-commits the instant it succeeds, so nothing can
be undone later. Re-running any file is harmless (ON CONFLICT upsert).

## Even easier alternative (no SQL at all)
Supabase → **Table Editor → `games` → Insert → Import data from CSV** also works
for a first load. SQL is better here because it can be re-run safely and skips
duplicates automatically; CSV import does not.
