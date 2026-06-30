# Adding a game to ZoFHub (e.g. a good community recommendation)

## The one thing to understand
The **live site is powered by the Supabase `games` table** — nothing else.
The JSON files in the repo (`api/games.json`, `master_games.json`, `everygame.json`, …)
are only a **bundled fallback** used when Supabase isn't reachable. So to add a game
that actually shows up and sticks, you **insert one row into the `games` table**.

A community recommendation lives in a *separate* `recommendations` table — it's just a
suggestion. Promoting it = copying its info into `games`.

## Each game row
| column | what to put |
|---|---|
| `slug` | unique URL-safe id, e.g. `slope` → the game opens at `/play/slope` |
| `title` | display name, e.g. `Slope` |
| `game_url` | the embeddable URL (the iframe src) from a trusted host |
| `thumbnail_url` | image URL, or leave `NULL` → a branded tile is shown automatically |
| `category` | one of: arcade, racing, shooting, action, puzzle, sports, adventure, casual, board, simulator |
| `is_working` | `true` |

Trusted embed hosts (same allowlist the recommend form uses): **GameDistribution,
OnlineGames.io, GameMonetize, HTMLGames, y8.com/embed/**.

## Step 1 — find the recommendation's details
Supabase → Table Editor → `recommendations` (or run in SQL Editor):
```sql
select id, title, embed_url, category, author, views
from public.recommendations
order by views desc, created_at desc;
```

## Step 2 — insert it into `games` (Supabase → SQL Editor → Run)
```sql
insert into public.games (slug, title, game_url, thumbnail_url, category, is_working)
values (
  'slope',                                       -- unique slug
  'Slope',                                       -- title
  'https://html5.gamedistribution.com/XXXX/',    -- embed_url from the recommendation
  null,                                          -- thumbnail (null = branded fallback tile)
  'arcade',                                       -- category
  true
)
on conflict (slug) do update set      -- safe to re-run; updates if the slug exists
  title         = excluded.title,
  game_url      = excluded.game_url,
  thumbnail_url = excluded.thumbnail_url,
  category      = excluded.category,
  is_working    = true;
```

## Step 3 — make it appear
The server refreshes the catalog from Supabase **every 30 minutes**, so it shows up
automatically — or to see it instantly, restart:
```bash
npm run restart
```
Then it's live at `/play/<slug>`, searchable, and listed under its category. Even if you
skip the thumbnail, the game still plays and shows a clean branded tile.

## (Optional) clean up the recommendation once promoted
```sql
update public.recommendations set is_visible = false where id = <THE_ID>;
```

## Removing / hiding a bad game later
Don't delete — just hide it (it drops out of `games_public`, which the site reads):
```sql
update public.games set is_working = false where slug = '<slug>';
```
The hourly link-checker does this automatically for games whose URL goes dead.
