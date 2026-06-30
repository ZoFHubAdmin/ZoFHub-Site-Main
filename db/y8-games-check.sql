-- db/y8-games-check.sql — paste & Run anytime to confirm the data is really there.
-- Returns ONE row with three numbers. If they look right, your load worked —
-- no matter what the editor did with the query text afterwards.

select
  count(*)                                                 as total_games,
  count(*) filter (where game_url like '%y8.com/embed/%')  as y8_games,
  count(*) filter (where is_working)                       as working_games
from public.games;

-- Optional: eyeball the 10 most recently touched rows. Run this block on its
-- own — the editor only shows the result of the LAST query you run.
-- select slug, title, category, is_working, last_checked
--   from public.games order by last_checked desc nulls last limit 10;
